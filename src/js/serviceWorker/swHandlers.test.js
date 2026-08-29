/// <reference lib="webworker" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createHandlers,
	HEARTBEAT_TIMEOUT_MS,
	STREAM_HIGH_WATER_MARK_BYTES,
	ATTACH_TIMEOUT_MS,
	PULL_TIMEOUT_MS,
} from './swHandlers.js';
import { MSG } from '../core/protocol.js';

/** @returns {ServiceWorkerGlobalScope} */
function makeFakeSw() {
	return /** @type {ServiceWorkerGlobalScope} */ (
		/** @type {unknown} */ ({
			clients: {
				matchAll: vi.fn().mockResolvedValue([]),
				claim: vi.fn().mockResolvedValue(undefined),
			},
		})
	);
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} data
 * @param {MessagePort[]} ports
 * @returns {ExtendableMessageEvent}
 */
function makeMessageEvent(type, data = {}, ports = []) {
	return /** @type {ExtendableMessageEvent} */ (
		/** @type {unknown} */ ({
			data: { type, ...data },
			ports,
		})
	);
}

/** @returns {{ port: MessagePort, messages: unknown[] }} */
function makePort() {
	const messages = /** @type {unknown[]} */ ([]);
	const port = /** @type {MessagePort} */ (
		/** @type {unknown} */ ({
			postMessage: vi.fn((data) => messages.push(data)),
		})
	);
	return { port, messages };
}

describe('onMessage', () => {
	/** @type {ServiceWorkerGlobalScope} */
	let fakeSw;
	/** @type {ReturnType<typeof createHandlers>} */
	let handlers;

	beforeEach(() => {
		fakeSw = makeFakeSw();
		handlers = createHandlers(fakeSw);
	});

	describe('STREAM_REGISTER', () => {
		it('replies with REGISTERED and highWaterMark', () => {
			const { port, messages } = makePort();
			handlers.onMessage(
				makeMessageEvent(
					MSG.STREAM_REGISTER,
					{
						id: '1',
						filename: 'file.zip',
						totalSize: 1000n,
					},
					[port],
				),
			);

			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				type: MSG.REGISTERED,
				highWaterMark: 2,
			});
		});

		it('works without a port', () => {
			expect(() =>
				handlers.onMessage(
					makeMessageEvent(MSG.STREAM_REGISTER, {
						id: '1',
						filename: 'file.zip',
						totalSize: 1000n,
					}),
				),
			).not.toThrow();
		});
	});

	describe('HEARTBEAT', () => {
		it('resets the watchdog for known stream ids', () => {
			vi.useFakeTimers();

			handlers.onMessage(
				makeMessageEvent(MSG.STREAM_REGISTER, {
					id: '1',
					filename: 'f.zip',
					totalSize: null,
				}),
			);

			// Advance close to the timeout without triggering it.
			vi.advanceTimersByTime(4900);

			// A heartbeat restarts the timeout window.
			handlers.onMessage(makeMessageEvent(MSG.HEARTBEAT, { streamIds: ['1'] }));

			// This would have triggered the original watchdog if it had
			// not been reset by the heartbeat.
			vi.advanceTimersByTime(4900);

			expect(fakeSw.clients.matchAll).not.toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('aborts stream when no heartbeat arrives within timeout', async () => {
			vi.useFakeTimers();

			handlers.onMessage(
				makeMessageEvent(MSG.STREAM_REGISTER, {
					id: '1',
					filename: 'f.zip',
					totalSize: null,
				}),
			);

			vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1);
			await Promise.resolve();

			expect(fakeSw.clients.matchAll).toHaveBeenCalled();

			vi.useRealTimers();
		});

		it('ignores unknown stream ids without throwing', () => {
			expect(() =>
				handlers.onMessage(
					makeMessageEvent(MSG.HEARTBEAT, { streamIds: ['unknown'] }),
				),
			).not.toThrow();
		});
	});

	describe('STREAM_CHUNK', () => {
		it('replies not_found when stream is not registered', () => {
			const { port, messages } = makePort();
			handlers.onMessage(makeMessageEvent(MSG.STREAM_CHUNK, { id: '1' }, [port]));
			expect(messages[0]).toMatchObject({ success: false, reason: 'not_found' });
		});

		it('buffers the chunk when stream has no controller yet', () => {
			const { port, messages } = makePort();
			handlers.onMessage(
				makeMessageEvent(MSG.STREAM_REGISTER, {
					id: '1',
					filename: 'f.zip',
					totalSize: null,
				}),
			);
			handlers.onMessage(
				makeMessageEvent(
					MSG.STREAM_CHUNK,
					{
						id: '1',
						chunk: new ArrayBuffer(4),
					},
					[port],
				),
			);

			// Before a download attaches, the chunk is held in the
			// service worker's pendingChunks buffer. No ReadableStream
			// controller exists yet, so no chunk is acknowledged here.
			expect(messages).toHaveLength(0);
		});
	});

	describe('STREAM_ABORT', () => {
		it('removes the entry from pending and notifies clients', async () => {
			const fakeClient = { postMessage: vi.fn() };
			fakeSw.clients.matchAll = vi.fn().mockResolvedValue([fakeClient]);

			handlers.onMessage(
				makeMessageEvent(MSG.STREAM_REGISTER, {
					id: '1',
					filename: 'f.zip',
					totalSize: null,
				}),
			);
			handlers.onMessage(makeMessageEvent(MSG.STREAM_ABORT, { id: '1' }));

			await vi.waitFor(() =>
				expect(fakeClient.postMessage).toHaveBeenCalledWith({
					type: MSG.CANCELLED,
					id: '1',
				}),
			);
		});

		it('does nothing for an unknown id', () => {
			expect(() =>
				handlers.onMessage(makeMessageEvent(MSG.STREAM_ABORT, { id: 'nope' })),
			).not.toThrow();
		});

		// If an abort deletes the stream entry without ever posting to the
		// chunk's MessagePort, SwBridge.sendChunk() on the page never
		// settles and WorkerController's chunk queue stalls forever with
		// no error surfaced.
		it('acks a chunk buffered before attachment as failed instead of leaving it unanswered', async () => {
			handlers.onMessage(
				makeMessageEvent(MSG.STREAM_REGISTER, {
					id: 'pending1',
					filename: 'f.zip',
					totalSize: null,
				}),
			);

			// No controller is attached yet, so this chunk lands in
			// pendingChunks rather than being enqueued.
			const { port, messages } = makePort();
			handlers.onMessage(
				makeMessageEvent(
					MSG.STREAM_CHUNK,
					{ id: 'pending1', chunk: new ArrayBuffer(16) },
					[port],
				),
			);
			expect(messages).toHaveLength(0);

			handlers.onMessage(makeMessageEvent(MSG.STREAM_ABORT, { id: 'pending1' }));

			await vi.waitFor(() => expect(messages).toHaveLength(1));
			expect(messages[0]).toEqual({ success: false, reason: 'aborted' });
		});

		it('acks a chunk queued for release (post-attachment backpressure) as failed on abort', async () => {
			handlers.onMessage(
				makeMessageEvent(MSG.STREAM_REGISTER, {
					id: 'pending2',
					filename: 'f.zip',
					totalSize: null,
				}),
			);

			/** @type {Response | Promise<Response> | undefined} */
			let respondWithArg;
			const fetchEvent = /** @type {FetchEvent} */ (
				/** @type {unknown} */ ({
					request: new Request('https://example.com/download/pending2'),
					respondWith: vi.fn((r) => {
						respondWithArg = r;
					}),
				})
			);
			handlers.onFetch(fetchEvent);
			const res = /** @type {Response} */ (await respondWithArg);
			// Never actually read from the stream below - this keeps
			// desiredSize positive-then-crossing-zero without the SW
			// receiving any pulls, so the oversized chunk's ack lands in
			// resolveAckQueue instead of resolving immediately, exercising
			// the queued (post-attachment) path rather than the
			// pre-attachment pendingChunks path covered above.
			res.body?.getReader();

			// Larger than the stream's byte high-water mark, so its ack
			// is deferred to resolveAckQueue rather than sent immediately.
			const { port, messages } = makePort();
			handlers.onMessage(
				makeMessageEvent(
					MSG.STREAM_CHUNK,
					{
						id: 'pending2',
						chunk: new ArrayBuffer(STREAM_HIGH_WATER_MARK_BYTES + 1024),
					},
					[port],
				),
			);
			expect(messages).toHaveLength(0);

			handlers.onMessage(makeMessageEvent(MSG.STREAM_ABORT, { id: 'pending2' }));

			await vi.waitFor(() => expect(messages).toHaveLength(1));
			expect(messages[0]).toEqual({ success: false, reason: 'aborted' });
		});
	});

	describe('STREAM_CLOSE', () => {
		it('marks entry as closed when no controller is attached', () => {
			handlers.onMessage(
				makeMessageEvent(MSG.STREAM_REGISTER, {
					id: '1',
					filename: 'f.zip',
					totalSize: null,
				}),
			);
			expect(() =>
				handlers.onMessage(makeMessageEvent(MSG.STREAM_CLOSE, { id: '1' })),
			).not.toThrow();
		});

		it('does nothing for an unknown id', () => {
			expect(() =>
				handlers.onMessage(makeMessageEvent(MSG.STREAM_CLOSE, { id: 'nope' })),
			).not.toThrow();
		});
	});

	// A stream may finish before the browser fetches /download/<id> (e.g.
	// a download popup was blocked or the user never clicked Save). Once
	// STREAM_CLOSE clears the heartbeat watchdog, such an entry would
	// otherwise remain in pending indefinitely.
	describe('STREAM_CLOSE without an attached controller', () => {
		it('drops the entry after ATTACH_TIMEOUT_MS if no download ever attaches', async () => {
			vi.useFakeTimers();
			try {
				handlers.onMessage(
					makeMessageEvent(MSG.STREAM_REGISTER, {
						id: 'never-attached',
						filename: 'f.zip',
						totalSize: null,
					}),
				);
				handlers.onMessage(
					makeMessageEvent(MSG.STREAM_CLOSE, { id: 'never-attached' }),
				);

				// The entry remains available until the attach timeout expires.
				vi.advanceTimersByTime(ATTACH_TIMEOUT_MS - 1);
				expect(() =>
					handlers.onMessage(
						makeMessageEvent(MSG.STREAM_CLOSE, { id: 'never-attached' }),
					),
				).not.toThrow();

				vi.advanceTimersByTime(1);

				// After the timeout the entry is gone, so a later download
				// request follows the normal unknown-stream path and returns 404.
				const respondWith = vi.fn();
				const fetchEvent = /** @type {FetchEvent} */ (
					/** @type {unknown} */ ({
						request: new Request('https://example.com/download/never-attached'),
						respondWith,
					})
				);
				handlers.onFetch(fetchEvent);
				await vi.runAllTimersAsync();
				const res = await respondWith.mock.calls[0][0];
				expect(res.status).toBe(404);
			} finally {
				vi.useRealTimers();
			}
		});

		it('does not drop the entry if a download attaches before ATTACH_TIMEOUT_MS', async () => {
			vi.useFakeTimers();
			try {
				handlers.onMessage(
					makeMessageEvent(MSG.STREAM_REGISTER, {
						id: 'attaches-late',
						filename: 'f.zip',
						totalSize: null,
					}),
				);
				handlers.onMessage(
					makeMessageEvent(MSG.STREAM_CLOSE, { id: 'attaches-late' }),
				);

				const respondWith = vi.fn();
				const fetchEvent = /** @type {FetchEvent} */ (
					/** @type {unknown} */ ({
						request: new Request('https://example.com/download/attaches-late'),
						respondWith,
					})
				);
				handlers.onFetch(fetchEvent);
				await vi.runAllTimersAsync();
				const res = await respondWith.mock.calls[0][0];

				// The already-closed stream attaches successfully and
				// produces a response rather than falling through to 404.
				expect(res.status).not.toBe(404);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});

describe('onFetch', () => {
	/** @type {ServiceWorkerGlobalScope} */
	let fakeSw;
	/** @type {ReturnType<typeof createHandlers>} */
	let handlers;

	beforeEach(() => {
		fakeSw = makeFakeSw();
		handlers = createHandlers(fakeSw);
	});

	/**
	 * @param {string} url
	 * @returns {{ event: FetchEvent, getResponse: () => Promise<Response> }}
	 */
	function makeFetchEvent(url) {
		/** @type {Response | Promise<Response> | undefined} */
		let respondWithArg;
		const event = /** @type {FetchEvent} */ (
			/** @type {unknown} */ ({
				request: new Request(url),
				respondWith: vi.fn((/** @type {Response | Promise<Response>} */ r) => {
					respondWithArg = r;
				}),
			})
		);
		return {
			event,
			getResponse: () => {
				if (!respondWithArg) throw new Error('respondWith was never called');
				return Promise.resolve(respondWithArg);
			},
		};
	}

	it('responds 204 to sw-keepalive', async () => {
		const { event, getResponse } = makeFetchEvent(
			'https://example.com/sw-keepalive',
		);
		handlers.onFetch(event);
		const res = await getResponse();
		expect(res.status).toBe(204);
	});

	it('ignores non-download URLs', () => {
		const { event } = makeFetchEvent('https://example.com/something-else');
		handlers.onFetch(event);
		expect(event.respondWith).not.toHaveBeenCalled();
	});

	it('responds 404 when stream id is not registered', async () => {
		vi.useFakeTimers();

		const { event, getResponse } = makeFetchEvent(
			'https://example.com/download/unknown-id',
		);
		handlers.onFetch(event);

		await vi.runAllTimersAsync();

		const res = await getResponse();
		expect(res.status).toBe(404);

		vi.useRealTimers();
	});

	it('responds with a stream and correct headers when stream is registered', async () => {
		const { port } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_REGISTER,
				{
					id: '1',
					filename: 'game.zip',
					totalSize: 5000n,
				},
				[port],
			),
		);

		const fakeClient = { postMessage: vi.fn() };
		fakeSw.clients.matchAll = vi.fn().mockResolvedValue([fakeClient]);

		const { event, getResponse } = makeFetchEvent(
			'https://example.com/download/1',
		);
		handlers.onFetch(event);
		const res = await getResponse();

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/zip');
		expect(res.headers.get('Content-Length')).toBe('5000');
		expect(res.headers.get('Content-Disposition')).toContain('game.zip');
	});

	it('notifies clients with STREAM_ATTACHED when download is attached', async () => {
		const { port } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_REGISTER,
				{
					id: 'dl2',
					filename: 'game.zip',
					totalSize: null,
				},
				[port],
			),
		);

		const fakeClient = { postMessage: vi.fn() };
		fakeSw.clients.matchAll = vi.fn().mockResolvedValue([fakeClient]);

		const { event, getResponse } = makeFetchEvent(
			'https://example.com/download/dl2',
		);
		handlers.onFetch(event);
		await getResponse();

		await vi.waitFor(() =>
			expect(fakeClient.postMessage).toHaveBeenCalledWith({
				type: MSG.STREAM_ATTACHED,
				id: 'dl2',
			}),
		);
	});

	it('returns a response for a second fetch on the same id', async () => {
		const { port } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_REGISTER,
				{
					id: 'dl3',
					filename: 'game.zip',
					totalSize: null,
				},
				[port],
			),
		);

		fakeSw.clients.matchAll = vi.fn().mockResolvedValue([]);

		const { event: e1, getResponse: r1 } = makeFetchEvent(
			'https://example.com/download/dl3',
		);
		const { event: e2, getResponse: r2 } = makeFetchEvent(
			'https://example.com/download/dl3',
		);

		handlers.onFetch(e1);
		await r1();

		handlers.onFetch(e2);
		const res = await r2();

		expect(res).toBeDefined();
	});
});

describe('byte-based backpressure', () => {
	/** @type {ServiceWorkerGlobalScope} */
	let fakeSw;
	/** @type {ReturnType<typeof createHandlers>} */
	let handlers;

	beforeEach(() => {
		fakeSw = makeFakeSw();
		handlers = createHandlers(fakeSw);
	});

	/**
	 * @param {string} url
	 * @returns {{ event: FetchEvent, getResponse: () => Promise<Response> }}
	 */
	function makeFetchEvent(url) {
		/** @type {Response | Promise<Response> | undefined} */
		let respondWithArg;
		const event = /** @type {FetchEvent} */ (
			/** @type {unknown} */ ({
				request: new Request(url),
				respondWith: vi.fn((/** @type {Response | Promise<Response>} */ r) => {
					respondWithArg = r;
				}),
			})
		);
		return {
			event,
			getResponse: () => {
				if (!respondWithArg) throw new Error('respondWith was never called');
				return Promise.resolve(respondWithArg);
			},
		};
	}

	it('does not ack a buffered chunk before a controller attaches, regardless of size', () => {
		const { port: registerPort } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_REGISTER,
				{ id: 'pre1', filename: 'f.zip', totalSize: null },
				[registerPort],
			),
		);

		// This chunk is larger than the ReadableStream high-water mark.
		// That threshold does not apply yet because the download has not
		// attached and the chunk is still in pendingChunks.
		const { port, messages } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_CHUNK,
				{
					id: 'pre1',
					chunk: new ArrayBuffer(STREAM_HIGH_WATER_MARK_BYTES * 4),
				},
				[port],
			),
		);

		// No controller exists yet, so the chunk cannot be enqueued into
		// the ReadableStream and therefore is not acknowledged.
		expect(messages).toHaveLength(0);
	});

	it('applies byte-based backpressure to an attached stream when a chunk exceeds the high-water mark', async () => {
		const { port: registerPort } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_REGISTER,
				{ id: 'big1', filename: 'f.zip', totalSize: null },
				[registerPort],
			),
		);

		// The first chunk is larger than the stream's high-water mark.
		// This deliberately creates a negative desiredSize after enqueue.
		// The second chunk is small enough that it would fit by itself.
		const bigSize = STREAM_HIGH_WATER_MARK_BYTES + 1024;
		const smallSize = 16;

		const { port: bigPort, messages: bigAcks } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_CHUNK,
				{ id: 'big1', chunk: new ArrayBuffer(bigSize) },
				[bigPort],
			),
		);
		const { port: smallPort, messages: smallAcks } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_CHUNK,
				{ id: 'big1', chunk: new ArrayBuffer(smallSize) },
				[smallPort],
			),
		);

		// Neither chunk is acknowledged before the download attaches.
		expect(bigAcks).toHaveLength(0);
		expect(smallAcks).toHaveLength(0);

		const { event, getResponse } = makeFetchEvent(
			'https://example.com/download/big1',
		);
		handlers.onFetch(event);
		const res = await getResponse();
		const reader = /** @type {ReadableStream} */ (res.body).getReader();

		// The oversized chunk is enqueued first. Its size pushes
		// desiredSize below zero, so the second chunk remains pending
		// until a pull creates room.
		const { value: firstValue } = await reader.read();
		expect(firstValue?.byteLength).toBe(bigSize);

		const { value: secondValue } = await reader.read();
		expect(secondValue?.byteLength).toBe(smallSize);

		// Each chunk is acknowledged once the stream has applied enough
		// backpressure/received pulls to release its corresponding ACK.
		await vi.waitFor(() => {
			expect(bigAcks).toHaveLength(1);
			expect(smallAcks).toHaveLength(1);
		});
	});
});

describe('pull timeout', () => {
	/** @type {ServiceWorkerGlobalScope} */
	let fakeSw;
	/** @type {ReturnType<typeof createHandlers>} */
	let handlers;

	beforeEach(() => {
		fakeSw = makeFakeSw();
		handlers = createHandlers(fakeSw);
	});

	/**
	 * @param {string} url
	 * @returns {{ event: FetchEvent, getResponse: () => Promise<Response> }}
	 */
	function makeFetchEvent(url) {
		/** @type {Response | Promise<Response> | undefined} */
		let respondWithArg;
		const event = /** @type {FetchEvent} */ (
			/** @type {unknown} */ ({
				request: new Request(url),
				respondWith: vi.fn((/** @type {Response | Promise<Response>} */ r) => {
					respondWithArg = r;
				}),
			})
		);
		return {
			event,
			getResponse: () => {
				if (!respondWithArg) throw new Error('respondWith was never called');
				return Promise.resolve(respondWithArg);
			},
		};
	}

	// Regression test: a real, still-progressing download - just slow,
	// e.g. behind an on-access antivirus scan or a slow disk - was
	// getting self-aborted by the SW and surfaced to the user as
	// Chrome's generic "Failed - Network error".
	it('does not abort a stream whose pull is merely slow, not abandoned', async () => {
		vi.useFakeTimers();

		const fakeClient = { postMessage: vi.fn() };
		fakeSw.clients.matchAll = vi.fn().mockResolvedValue([fakeClient]);

		handlers.onMessage(
			makeMessageEvent(MSG.STREAM_REGISTER, {
				id: 'slow1',
				filename: 'f.zip',
				totalSize: null,
			}),
		);

		const { event, getResponse } = makeFetchEvent(
			'https://example.com/download/slow1',
		);
		handlers.onFetch(event);
		const res = await getResponse();
		const reader = /** @type {ReadableStream} */ (res.body).getReader();

		// Larger than the byte high-water mark, so its ack is deferred and
		// the pull watchdog arms.
		const bigSize = STREAM_HIGH_WATER_MARK_BYTES + 1024;
		const { port } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_CHUNK,
				{ id: 'slow1', chunk: new ArrayBuffer(bigSize) },
				[port],
			),
		);

		// A slow but still-progressing consumer: this pull arrives well
		// past the old 15s bound, but under HEARTBEAT_TIMEOUT_MS, so a
		// live page's heartbeat wouldn't have timed the stream out either.
		await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS - 2000);
		const { value } = await reader.read();

		expect(value?.byteLength).toBe(bigSize);
		expect(fakeClient.postMessage).not.toHaveBeenCalledWith({
			type: MSG.CANCELLED,
			id: 'slow1',
		});

		vi.useRealTimers();
	});

	it('still aborts a stream whose consumer stops pulling entirely, even with a live page', async () => {
		vi.useFakeTimers();

		const fakeClient = { postMessage: vi.fn() };
		fakeSw.clients.matchAll = vi.fn().mockResolvedValue([fakeClient]);

		handlers.onMessage(
			makeMessageEvent(MSG.STREAM_REGISTER, {
				id: 'dead1',
				filename: 'f.zip',
				totalSize: null,
			}),
		);

		const { event, getResponse } = makeFetchEvent(
			'https://example.com/download/dead1',
		);
		handlers.onFetch(event);
		await getResponse();

		const bigSize = STREAM_HIGH_WATER_MARK_BYTES + 1024;
		const { port } = makePort();
		handlers.onMessage(
			makeMessageEvent(
				MSG.STREAM_CHUNK,
				{ id: 'dead1', chunk: new ArrayBuffer(bigSize) },
				[port],
			),
		);

		// Keep the heartbeat watchdog satisfied throughout, so only the
		// pull watchdog itself can be responsible for the eventual abort -
		// this isolates it from HEARTBEAT_TIMEOUT_MS, which would also
		// catch a genuinely closed/killed page on its own. Nothing ever
		// reads from the stream.
		const heartbeatInterval = setInterval(() => {
			handlers.onMessage(
				makeMessageEvent(MSG.HEARTBEAT, { streamIds: ['dead1'] }),
			);
		}, 5000);
		await vi.advanceTimersByTimeAsync(PULL_TIMEOUT_MS + 1000);
		clearInterval(heartbeatInterval);

		expect(fakeClient.postMessage).toHaveBeenCalledWith({
			type: MSG.CANCELLED,
			id: 'dead1',
		});

		vi.useRealTimers();
	});
});

describe('onActivate', () => {
	it('calls clients.claim()', () => {
		const fakeSw = makeFakeSw();
		const handlers = createHandlers(fakeSw);

		const event = /** @type {ExtendableEvent} */ (
			/** @type {unknown} */ ({
				waitUntil: vi.fn(),
			})
		);

		handlers.onActivate(event);

		expect(event.waitUntil).toHaveBeenCalledOnce();
		expect(fakeSw.clients.claim).toHaveBeenCalledOnce();
	});
});
