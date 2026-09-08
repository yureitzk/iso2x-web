import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwBridge } from './SwBridge.js';
import { MSG } from '../../core/protocol.js';

/**
 * @typedef {{ data: unknown, transferables: unknown[] }[]} SentMessages
 */

/**
 * @typedef {{ postMessage: import('vitest').MockInstance, _sent: SentMessages }} FakeSw
 */

/** @returns {FakeSw} */
function makeFakeSw() {
	/** @type {SentMessages} */
	const sentMessages = [];
	return {
		postMessage: vi.fn((data, transferables) => {
			sentMessages.push({ data, transferables });
		}),
		_sent: sentMessages,
	};
}

/** @param {FakeSw} fakeSw */
function makeFakeRegistration(fakeSw) {
	return /** @type {ServiceWorkerRegistration} */ (
		/** @type {unknown} */ ({ active: fakeSw })
	);
}

describe('SwBridge', () => {
	/** @type {FakeSw} */
	let fakeSw;
	/** @type {SwBridge} */
	let bridge;

	beforeEach(() => {
		document.body.innerHTML = '';
		fakeSw = makeFakeSw();
		bridge = new SwBridge(makeFakeRegistration(fakeSw));
	});

	it('registerStream posts STREAM_REGISTER and resolves with highWaterMark', async () => {
		const promise = bridge.registerStream('1', 'file.zip', 1000n);

		const [data, transferables] = fakeSw.postMessage.mock.calls[0];
		expect(data.type).toBe(MSG.STREAM_REGISTER);
		expect(data.id).toBe('1');

		transferables[0].postMessage({ type: MSG.REGISTERED, highWaterMark: 2 });

		expect(await promise).toBe(2);
	});

	it('registerStream attaches a hidden download iframe for the stream id', () => {
		bridge.registerStream('1', 'file.zip', 1000n);

		const iframe = document.body.querySelector('iframe');
		expect(iframe).not.toBeNull();
		expect(iframe?.hidden).toBe(true);
		expect(iframe?.src).toContain('/download/1');
	});

	it('sendChunk posts STREAM_CHUNK and resolves true on success', async () => {
		const buf = new ArrayBuffer(8);
		const promise = bridge.sendChunk('1', buf);

		const [data, transferables] = fakeSw.postMessage.mock.calls[0];
		expect(data.type).toBe(MSG.STREAM_CHUNK);

		transferables[1].postMessage({ success: true });

		expect(await promise).toBe(true);
	});

	it('sendChunk resolves false when SW signals failure', async () => {
		const promise = bridge.sendChunk('1', new ArrayBuffer(4));
		const [, transferables] = fakeSw.postMessage.mock.calls[0];

		transferables[1].postMessage({ success: false });

		expect(await promise).toBe(false);
	});

	it('abortStream posts STREAM_ABORT', () => {
		bridge.abortStream('1');
		const [data] = fakeSw.postMessage.mock.calls[0];
		expect(data).toEqual({ type: MSG.STREAM_ABORT, id: '1' });
	});

	it('closeStream posts STREAM_CLOSE', () => {
		bridge.closeStream('1');
		const [data] = fakeSw.postMessage.mock.calls[0];
		expect(data).toEqual({ type: MSG.STREAM_CLOSE, id: '1' });
	});

	it('emits CANCELLED event when SW sends CANCELLED message', () => {
		const handler = vi.fn();
		bridge.addEventListener(MSG.CANCELLED, handler);

		navigator.serviceWorker.dispatchEvent(
			new MessageEvent('message', {
				data: { type: MSG.CANCELLED, id: '1' },
			}),
		);

		expect(handler).toHaveBeenCalledOnce();
		expect(/** @type {CustomEvent} */ (handler.mock.calls[0][0]).detail).toBe(
			'1',
		);
	});

	it('waitForAttached resolves true when STREAM_ATTACHED arrives for the right id', async () => {
		const promise = bridge.waitForAttached('1', 15000);

		navigator.serviceWorker.dispatchEvent(
			new MessageEvent('message', {
				data: { type: MSG.STREAM_ATTACHED, id: '1' },
			}),
		);

		await expect(promise).resolves.toBe(true);
	});

	it('waitForAttached ignores STREAM_ATTACHED for a different id', async () => {
		vi.useFakeTimers();
		try {
			const promise = bridge.waitForAttached('1', 15000);

			navigator.serviceWorker.dispatchEvent(
				new MessageEvent('message', {
					data: { type: MSG.STREAM_ATTACHED, id: 'other' },
				}),
			);

			vi.advanceTimersByTime(15000);
			await expect(promise).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('waitForAttached resolves false if STREAM_ATTACHED never arrives within timeoutMs', async () => {
		vi.useFakeTimers();
		try {
			const promise = bridge.waitForAttached('1', 15000);

			vi.advanceTimersByTime(14999);
			vi.advanceTimersByTime(1);

			await expect(promise).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('waitForAttached stops listening once it settles, so a later same-id STREAM_ATTACHED is harmless', async () => {
		vi.useFakeTimers();
		try {
			const promise = bridge.waitForAttached('1', 15000);
			vi.advanceTimersByTime(15000);
			await expect(promise).resolves.toBe(false);

			// Must not throw or resolve an already-settled promise.
			expect(() =>
				navigator.serviceWorker.dispatchEvent(
					new MessageEvent('message', {
						data: { type: MSG.STREAM_ATTACHED, id: '1' },
					}),
				),
			).not.toThrow();
		} finally {
			vi.useRealTimers();
		}
	});

	describe('primeMultiDownloadPermission', () => {
		it('attaches two download iframes synchronously, before any await', () => {
			// Not awaited on purpose - iframes must exist immediately to ride user activation.
			bridge.primeMultiDownloadPermission();

			const iframes = document.body.querySelectorAll('iframe');
			expect(iframes.length).toBe(2);
			iframes.forEach((iframe) => expect(iframe.hidden).toBe(true));
		});

		it('registers two real, non-empty decoy payloads with distinct filenames', () => {
			bridge.primeMultiDownloadPermission();

			const registerCalls = fakeSw.postMessage.mock.calls
				.map(([data]) => data)
				.filter((data) => data.type === MSG.STREAM_REGISTER);

			const expectedSize = new TextEncoder().encode(
				'permission-check\n',
			).byteLength;

			expect(registerCalls).toHaveLength(2);

			const filenames = registerCalls.map((data) => data.filename).sort();
			expect(filenames).toEqual([
				'permission-check-1.txt',
				'permission-check-2.txt',
			]);

			const ids = new Set(registerCalls.map((data) => data.id));
			expect(ids.size).toBe(2);

			registerCalls.forEach((data) => {
				expect(data.totalSize).toBe(BigInt(expectedSize));
			});
		});

		it('sends each payload as a chunk after registration completes, then closes both streams', async () => {
			const promise = bridge.primeMultiDownloadPermission();

			const registerCalls = fakeSw.postMessage.mock.calls.filter(
				([data]) => data.type === MSG.STREAM_REGISTER,
			);
			expect(registerCalls).toHaveLength(2);
			const ids = registerCalls.map(([data]) => data.id);

			registerCalls.forEach(([, transferables]) => {
				transferables[0].postMessage({
					type: MSG.REGISTERED,
					highWaterMark: 2,
				});
			});

			await vi.waitFor(() => {
				const chunkCalls = fakeSw.postMessage.mock.calls.filter(
					([data]) => data.type === MSG.STREAM_CHUNK,
				);
				expect(chunkCalls).toHaveLength(2);
			});

			const chunkCalls = fakeSw.postMessage.mock.calls.filter(
				([data]) => data.type === MSG.STREAM_CHUNK,
			);

			chunkCalls.forEach(([data]) => {
				expect(ids).toContain(data.id);
				expect(new TextDecoder().decode(data.chunk)).toBe('permission-check\n');
			});
			expect(new Set(chunkCalls.map(([data]) => data.id)).size).toBe(2);

			chunkCalls.forEach(([, transferables]) => {
				transferables[1].postMessage({ success: true });
			});

			await promise;

			const closeCalls = fakeSw.postMessage.mock.calls.filter(
				([data]) => data.type === MSG.STREAM_CLOSE,
			);
			expect(closeCalls).toHaveLength(2);
			expect(new Set(closeCalls.map(([data]) => data.id))).toEqual(new Set(ids));
		});
	});
});
