import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerController } from './WorkerController.js';
import { MSG, EVENTS } from '../../core/protocol.js';
import { createMockSwBridge } from '../../../../test/utils/swBridgeMock.js';

/**
 * @import { SwBridge } from '../../serviceWorker/controller/SwBridge.js'
 * @import { NormalizedConvert, DroppedSource } from '../../../types/global.js'
 * @import { MockInstance, Mock } from 'vitest'
 */

vi.mock('../runtime/converterWorker.js?worker', () => {
	const FakeWorker = vi.fn(function () {
		this.postMessage = vi.fn();
		this.terminate = vi.fn();
		this.addEventListener = vi.fn();
		this.removeEventListener = vi.fn();
	});
	return { default: FakeWorker };
});

describe('WorkerController', () => {
	/** @type {SwBridge} */
	let swBridge;
	/** @type {WorkerController} */
	let controller;
	/** @type {{ postMessage: MockInstance, terminate: MockInstance, addEventListener: MockInstance }} */
	let fakeWorker;

	beforeEach(async () => {
		swBridge = /** @type {any} */ (createMockSwBridge());
		controller = new WorkerController(swBridge, 'game.iso');
		const ConverterWorker = /** @type {MockInstance} */ (
			/** @type {unknown} */ (
				(await import('../runtime/converterWorker.js?worker')).default
			)
		);
		fakeWorker = /** @type {any} */ (
			ConverterWorker.mock.instances[ConverterWorker.mock.instances.length - 1]
		);
	});

	/**
	 * Dispatches to every registered 'message' listener, not just the
	 * first - terminate()/cleanup() each add their own CANCEL_ACK
	 * listener alongside the constructor's main #onMessage one.
	 * @param {string} type
	 * @param {unknown} [payload]
	 */
	function workerPost(type, payload) {
		const calls = fakeWorker.addEventListener.mock.calls;
		const messageHandlers = calls
			.filter(([event]) => event === 'message')
			.map(([, handler]) => handler);
		if (messageHandlers.length === 0)
			throw new Error('No message handler registered on worker');
		const event = new MessageEvent('message', { data: { type, payload } });
		for (const handler of messageHandlers) handler(event);
	}

	describe('inspect()', () => {
		it('stores the source as pendingInspect', () => {
			const files = [new File([''], 'game.iso')];
			/** @type {DroppedSource} */
			const source = { kind: 'files', files };
			controller.inspect(source);
			expect(controller._pendingInspect).toEqual(source);
		});

		it('sends INSPECT with a single-file source when READY arrives after inspect() was called', () => {
			const files = [new File([''], 'game.iso')];
			/** @type {DroppedSource} */
			const source = { kind: 'files', files };
			controller.inspect(source);
			workerPost(MSG.READY);
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({
				type: MSG.INSPECT,
				source,
			});
		});

		it('sends INSPECT with both files for a split pair', () => {
			const files = [new File([''], 'game.1.iso'), new File([''], 'game.2.iso')];
			/** @type {DroppedSource} */
			const source = { kind: 'files', files };
			controller.inspect(source);
			workerPost(MSG.READY);
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({
				type: MSG.INSPECT,
				source,
			});
		});
	});

	describe('start()', () => {
		it('sends CONVERT when READY arrives after start() was called', () => {
			/** @type {NormalizedConvert} */
			const convert = {
				source: { kind: 'files', files: [new File([''], 'game.iso')] },
				gameTitle: 'My Game',
				format: 'god',
				options: { mode: 'full' },
			};
			controller.start(convert);
			workerPost(MSG.READY);
			expect(fakeWorker.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: MSG.CONVERT,
					source: convert.source,
					gameTitle: 'My Game',
					id: expect.any(String),
				}),
			);
		});
	});

	describe('partitionDir()', () => {
		/** Only PARTITION_DIR calls, in order, unwrapped from the mock's [msg] tuples. */
		function partitionDirCalls() {
			return fakeWorker.postMessage.mock.calls
				.map(([msg]) => msg)
				.filter((msg) => msg.type === MSG.PARTITION_DIR);
		}

		it('sends a single chunkIndex 0/totalChunks 1 PARTITION_DIR message when entries fit in one chunk', () => {
			const entries = ['a.iso', 'b.iso'];
			const files = [new File([''], 'a.iso'), new File([''], 'b.iso')];
			controller.partitionDir('MyGame', entries, files);
			workerPost(MSG.READY);
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({
				type: MSG.PARTITION_DIR,
				dirName: 'MyGame',
				entries,
				files,
				chunkIndex: 0,
				totalChunks: 1,
			});
		});

		it('sends a single chunkIndex 0/totalChunks 1 message for an empty tree', () => {
			controller.partitionDir('', [], []);
			workerPost(MSG.READY);
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({
				type: MSG.PARTITION_DIR,
				dirName: '',
				entries: [],
				files: [],
				chunkIndex: 0,
				totalChunks: 1,
			});
		});

		it('splits a large tree into multiple budget-bounded chunks that reassemble to the original input', async () => {
			vi.useFakeTimers();
			try {
				const N = 5000;
				const entries = Array.from(
					{ length: N },
					(_, i) => `dir/subdir/file_${i}.bin`,
				);
				const files = entries.map((e) => new File([''], e));
				controller.partitionDir('BigGame', entries, files);
				workerPost(MSG.READY);

				// Flush every setTimeout(0) yield between chunks.
				await vi.runAllTimersAsync();

				const calls = partitionDirCalls();
				expect(calls.length).toBeGreaterThan(1);

				for (const [i, msg] of calls.entries()) {
					expect(msg.entries.length).toBeLessThanOrEqual(2000);
					const textBytes = msg.entries.reduce(
						(/** @type {number} */ n, /** @type {string} */ e) => n + e.length * 2,
						0,
					);
					expect(textBytes).toBeLessThanOrEqual(100 * 1024);
					expect(msg.chunkIndex).toBe(i);
					expect(msg.totalChunks).toBe(calls.length);
					if (i === 0) expect(msg.dirName).toBe('BigGame');
					else expect(msg.dirName).toBeUndefined();
				}

				// Reassembling every chunk reproduces the original arrays, in order.
				expect(calls.flatMap((m) => m.entries)).toEqual(entries);
				expect(calls.flatMap((m) => m.files)).toEqual(files);
			} finally {
				vi.useRealTimers();
			}
		});

		it('yields to the main thread between chunks instead of posting them all synchronously', async () => {
			vi.useFakeTimers();
			try {
				const N = 5000;
				const entries = Array.from(
					{ length: N },
					(_, i) => `dir/subdir/file_${i}.bin`,
				);
				const files = entries.map((e) => new File([''], e));
				controller.partitionDir('BigGame', entries, files);
				workerPost(MSG.READY);

				// Only the first chunk should have gone out synchronously -
				// the rest are scheduled behind a yieldToMain() await.
				const soFar = partitionDirCalls();
				expect(soFar.length).toBe(1);
				expect(soFar[0].chunkIndex).toBeLessThan(soFar[0].totalChunks - 1);

				await vi.runAllTimersAsync();
				expect(partitionDirCalls().length).toBeGreaterThan(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it('stores pending partitionDir() and flushes it (still chunked) once READY arrives', async () => {
			vi.useFakeTimers();
			try {
				const entries = ['a.iso', 'b.iso'];
				const files = [new File([''], 'a.iso'), new File([''], 'b.iso')];
				controller.partitionDir('MyGame', entries, files);
				expect(controller._pendingPartition).toEqual({
					dirName: 'MyGame',
					entries,
					files,
				});
				workerPost(MSG.READY);
				await vi.runAllTimersAsync();
				expect(controller._pendingPartition).toBeNull();
				expect(partitionDirCalls()).toEqual([
					{
						type: MSG.PARTITION_DIR,
						dirName: 'MyGame',
						entries,
						files,
						chunkIndex: 0,
						totalChunks: 1,
					},
				]);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('pause() / resume()', () => {
		it('sends PAUSE to the worker', () => {
			controller.pause();
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({ type: MSG.PAUSE });
		});

		it('sends RESUME to the worker', () => {
			controller.resume();
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({ type: MSG.RESUME });
		});

		it('does nothing when terminated', () => {
			controller.terminate();
			fakeWorker.postMessage.mockClear();
			controller.pause();
			controller.resume();
			expect(fakeWorker.postMessage).not.toHaveBeenCalled();
		});
	});

	describe('cleanup() / terminate()', () => {
		it('cleanup() sends CANCEL and aborts any open streams', async () => {
			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(controller.streamIds).toHaveLength(1));
			const [streamId] = controller.streamIds;
			controller.cleanup();
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({ type: MSG.CANCEL });
			expect(swBridge.abortStream).toHaveBeenCalledWith(streamId);
		});

		it('cleanup() does not touch swBridge when no stream was ever opened', () => {
			controller.cleanup();
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({ type: MSG.CANCEL });
			expect(swBridge.abortStream).not.toHaveBeenCalled();
		});

		it('terminate() sends CANCEL, aborts open streams, and emits CANCELLED event', async () => {
			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(controller.streamIds).toHaveLength(1));
			const [streamId] = controller.streamIds;
			const handler = vi.fn();
			controller.addEventListener(EVENTS.CANCELLED, handler);
			controller.terminate();
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({ type: MSG.CANCEL });
			expect(swBridge.abortStream).toHaveBeenCalledWith(streamId);
			expect(handler).toHaveBeenCalledOnce();
		});

		it('terminate() aborts every open stream when more than one is active', async () => {
			workerPost(MSG.STREAM_INFO, { filename: 'game.1.cso', totalSize: 100n });
			workerPost(MSG.STREAM_INFO, { filename: 'game.2.cso', totalSize: 200n });
			await vi.waitFor(() => expect(controller.streamIds).toHaveLength(2));
			const [firstId, secondId] = controller.streamIds;
			controller.terminate();
			expect(swBridge.abortStream).toHaveBeenCalledWith(firstId);
			expect(swBridge.abortStream).toHaveBeenCalledWith(secondId);
		});

		it('cleanup() is idempotent', () => {
			controller.cleanup();
			controller.cleanup();
			expect(fakeWorker.postMessage).toHaveBeenCalledTimes(1);
		});

		it('terminate() is idempotent', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.CANCELLED, handler);
			controller.terminate();
			controller.terminate();
			expect(handler).toHaveBeenCalledTimes(1);
		});
	});

	describe("terminate()'s force-kill timeout", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('force-kills the worker after 2000ms if CANCEL_ACK never arrives', () => {
			controller.terminate();
			expect(fakeWorker.terminate).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1999);
			expect(fakeWorker.terminate).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1);
			expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
		});

		it('terminates immediately on CANCEL_ACK and cancels the pending force-kill timer', () => {
			controller.terminate();
			workerPost(MSG.CANCEL_ACK);
			expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(2000);
			expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);
		});

		it('a CANCEL_ACK arriving after the force-kill already fired calls terminate() again (not a no-op)', () => {
			controller.terminate();
			vi.advanceTimersByTime(2000);
			expect(fakeWorker.terminate).toHaveBeenCalledTimes(1);

			workerPost(MSG.CANCEL_ACK);
			expect(fakeWorker.terminate).toHaveBeenCalledTimes(2);
		});
	});

	describe('worker message routing', () => {
		it('SOURCE_INFO dispatches isoinfo event with payload', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.SOURCE_INFO, handler);
			workerPost(MSG.SOURCE_INFO, { titleId: 'ABC123' });
			expect(handler).toHaveBeenCalledOnce();
			expect(/** @type {CustomEvent} */ (handler.mock.calls[0][0]).detail).toEqual(
				{ titleId: 'ABC123' },
			);
		});

		it('SOURCE_ERROR dispatches isoerror event with payload', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.SOURCE_ERROR, handler);
			workerPost(MSG.SOURCE_ERROR, 'bad iso');
			expect(/** @type {CustomEvent} */ (handler.mock.calls[0][0]).detail).toBe(
				'bad iso',
			);
		});

		it('LOG dispatches log event with payload', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.LOG, handler);
			workerPost(MSG.LOG, 'hello from worker');
			expect(/** @type {CustomEvent} */ (handler.mock.calls[0][0]).detail).toBe(
				'hello from worker',
			);
		});

		it('DONE terminates the worker and dispatches done event', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.DONE, handler);
			workerPost(MSG.DONE);
			expect(fakeWorker.terminate).toHaveBeenCalledOnce();
			expect(handler).toHaveBeenCalledOnce();
		});

		it('ERROR dispatches error event with payload', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.ERROR, handler);
			workerPost(MSG.ERROR, 'something broke');
			expect(/** @type {CustomEvent} */ (handler.mock.calls[0][0]).detail).toBe(
				'something broke',
			);
		});

		it('PAUSED dispatches paused event', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.PAUSED, handler);
			workerPost(MSG.PAUSED);
			expect(handler).toHaveBeenCalledOnce();
		});

		it('PROGRESS dispatches progress event with payload', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.PROGRESS, handler);
			workerPost(MSG.PROGRESS, 42);
			expect(/** @type {CustomEvent} */ (handler.mock.calls[0][0]).detail).toBe(
				42,
			);
		});

		it('PROGRESS is suppressed when terminated', () => {
			const handler = vi.fn();
			controller.addEventListener(EVENTS.PROGRESS, handler);
			controller.terminate();
			workerPost(MSG.PROGRESS, 42);
			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe('stream handling', () => {
		it('STREAM_INFO registers the stream and posts STREAM_READY', async () => {
			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(swBridge.registerStream).toHaveBeenCalled());
			const [streamId] = vi.mocked(swBridge.registerStream).mock.calls[0];
			expect(swBridge.registerStream).toHaveBeenCalledWith(
				streamId,
				'game.iso',
				1000n,
			);
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({
				type: MSG.STREAM_READY,
				id: streamId,
				highWaterMark: 2,
			});
		});

		it('STREAM_INFO uses payload.filename when provided, falling back to the constructor filename otherwise', async () => {
			workerPost(MSG.STREAM_INFO, { filename: 'game.1.cso', totalSize: 500n });
			await vi.waitFor(() => expect(swBridge.registerStream).toHaveBeenCalled());
			expect(swBridge.registerStream).toHaveBeenCalledWith(
				expect.any(String),
				'game.1.cso',
				500n,
			);
		});

		it('supports multiple sequential streams (e.g. split output files) with distinct ids', async () => {
			workerPost(MSG.STREAM_INFO, { filename: 'game.1.cso', totalSize: 100n });
			await vi.waitFor(() => expect(controller.streamIds).toHaveLength(1));
			const [firstId] = controller.streamIds;
			workerPost(MSG.STREAM_INFO, { filename: 'game.2.cso', totalSize: 200n });
			await vi.waitFor(() => expect(controller.streamIds).toHaveLength(2));
			const secondId = controller.streamIds.find((id) => id !== firstId);
			expect(firstId).not.toBe(secondId);
			expect(swBridge.registerStream).toHaveBeenNthCalledWith(
				1,
				firstId,
				'game.1.cso',
				100n,
			);
			expect(swBridge.registerStream).toHaveBeenNthCalledWith(
				2,
				secondId,
				'game.2.cso',
				200n,
			);
			workerPost(MSG.STREAM_CLOSE, { id: firstId });
			await vi.waitFor(() => expect(controller.streamIds).toEqual([secondId]));
		});

		it('STREAM_CHUNK sends the chunk to swBridge and posts CHUNK_ACK on success', async () => {
			const chunk = new ArrayBuffer(8);
			const streamId = 'test-stream-id';
			workerPost(MSG.STREAM_CHUNK, { id: streamId, chunk });
			await vi.waitFor(() =>
				expect(fakeWorker.postMessage).toHaveBeenCalledWith({
					type: MSG.CHUNK_ACK,
					id: streamId,
				}),
			);
			expect(swBridge.sendChunk).toHaveBeenCalledWith(streamId, chunk);
		});

		it('STREAM_CHUNK terminates when swBridge rejects the chunk', async () => {
			swBridge.sendChunk = vi.fn().mockResolvedValue(false);
			const handler = vi.fn();
			controller.addEventListener(EVENTS.CANCELLED, handler);
			const chunk = new ArrayBuffer(8);
			workerPost(MSG.STREAM_CHUNK, { id: 'test-stream-id', chunk });
			await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
		});

		it('dispatches error and terminates when registerStream rejects', async () => {
			swBridge.registerStream = vi
				.fn()
				.mockRejectedValue(new Error('SW unavailable'));
			const errorHandler = vi.fn();
			const cancelHandler = vi.fn();
			controller.addEventListener(EVENTS.ERROR, errorHandler);
			controller.addEventListener(EVENTS.CANCELLED, cancelHandler);
			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());
			expect(cancelHandler).toHaveBeenCalledOnce();
		});

		it('a second concurrent STREAM_INFO whose registerStream() rejects errors and terminates the controller, aborting the already-open first stream', async () => {
			swBridge.registerStream = vi
				.fn()
				.mockResolvedValueOnce(2) // first stream succeeds
				.mockRejectedValueOnce(new Error('SW unavailable')); // second fails

			const errorHandler = vi.fn();
			controller.addEventListener(EVENTS.ERROR, errorHandler);

			workerPost(MSG.STREAM_INFO, { filename: 'game.1.cso', totalSize: 100n });
			await vi.waitFor(() => expect(controller.streamIds).toHaveLength(1));
			const [firstId] = controller.streamIds;

			workerPost(MSG.STREAM_INFO, { filename: 'game.2.cso', totalSize: 200n });
			await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());

			expect(swBridge.abortStream).toHaveBeenCalledWith(firstId);
			expect(controller.streamIds).toEqual([]);
		});

		it('STREAM_CLOSE calls swBridge.closeStream and drops the id from streamIds', async () => {
			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(controller.streamIds).toHaveLength(1));
			const [streamId] = controller.streamIds;
			workerPost(MSG.STREAM_CLOSE, { id: streamId });
			await vi.waitFor(() =>
				expect(swBridge.closeStream).toHaveBeenCalledWith(streamId),
			);
			expect(controller.streamIds).toEqual([]);
		});
	});

	describe('download attach watchdog', () => {
		it('passes the new stream id and a timeout to swBridge.waitForAttached', async () => {
			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(swBridge.registerStream).toHaveBeenCalled());
			const [streamId] = vi.mocked(swBridge.registerStream).mock.calls[0];
			await vi.waitFor(() => expect(swBridge.waitForAttached).toHaveBeenCalled());
			expect(swBridge.waitForAttached).toHaveBeenCalledWith(
				streamId,
				expect.any(Number),
			);
		});

		it('does nothing once the download attaches (default mock behavior)', async () => {
			const errorHandler = vi.fn();
			controller.addEventListener(EVENTS.ERROR, errorHandler);
			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(swBridge.waitForAttached).toHaveBeenCalled());
			await Promise.resolve();
			await Promise.resolve();
			expect(errorHandler).not.toHaveBeenCalled();
		});

		it('errors out and tears the worker down if the browser never attaches to the stream', async () => {
			swBridge.waitForAttached = vi.fn().mockResolvedValue(false);
			const errorHandler = vi.fn();
			controller.addEventListener(EVENTS.ERROR, errorHandler);

			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());

			expect(fakeWorker.postMessage).toHaveBeenCalledWith({ type: MSG.CANCEL });
			expect(swBridge.abortStream).toHaveBeenCalled();
		});

		it('does not error a second time if the controller already finished before the watchdog settles', async () => {
			/** @type {(attached: boolean) => void} */
			let resolveAttach = () => {};
			swBridge.waitForAttached = vi.fn(
				() =>
					new Promise((resolve) => {
						resolveAttach = resolve;
					}),
			);
			const errorHandler = vi.fn();
			controller.addEventListener(EVENTS.ERROR, errorHandler);

			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(swBridge.waitForAttached).toHaveBeenCalled());

			workerPost(MSG.DONE);

			resolveAttach(false);
			await Promise.resolve();
			await Promise.resolve();

			expect(errorHandler).not.toHaveBeenCalled();
		});

		it('retries once with a fresh stream id and succeeds if the retry attaches', async () => {
			swBridge.waitForAttached = vi
				.fn()
				.mockResolvedValueOnce(false)
				.mockResolvedValueOnce(true);
			const errorHandler = vi.fn();
			controller.addEventListener(EVENTS.ERROR, errorHandler);

			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() =>
				expect(swBridge.waitForAttached).toHaveBeenCalledTimes(2),
			);

			const [firstId] = vi.mocked(swBridge.registerStream).mock.calls[0];
			const [secondId] = vi.mocked(swBridge.registerStream).mock.calls[1];
			expect(secondId).not.toBe(firstId);
			expect(swBridge.abortStream).toHaveBeenCalledWith(firstId);
			expect(swBridge.abortStream).toHaveBeenCalledTimes(1);
			expect(errorHandler).not.toHaveBeenCalled();
			expect(controller.streamIds).toEqual([secondId]);
		});

		it('gives up and errors only after a second consecutive attach failure', async () => {
			swBridge.waitForAttached = vi.fn().mockResolvedValue(false);
			const errorHandler = vi.fn();
			controller.addEventListener(EVENTS.ERROR, errorHandler);

			workerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce());

			expect(swBridge.registerStream).toHaveBeenCalledTimes(2);
			expect(swBridge.waitForAttached).toHaveBeenCalledTimes(2);
			expect(swBridge.abortStream).toHaveBeenCalledTimes(2);
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({ type: MSG.CANCEL });
		});
	});

	describe('download slot gating', () => {
		/** @type {{ resolve: (value?: void | PromiseLike<void>) => void }} */
		let acquireDeferred;
		/** @type {Mock<() => Promise<void>>} */
		let acquireDownloadSlot;
		/** @type {Mock<() => void>} */
		let releaseDownloadSlot;
		/** @type {Mock<() => void>} */
		let dequeueDownloadSlot;
		/** @type {WorkerController} */
		let gatedController;
		/** @type {{ postMessage: MockInstance, terminate: MockInstance, addEventListener: MockInstance }} */
		let gatedFakeWorker;

		beforeEach(async () => {
			acquireDownloadSlot = vi.fn(
				() =>
					new Promise((resolve) => {
						acquireDeferred = { resolve };
					}),
			);
			releaseDownloadSlot = vi.fn();
			dequeueDownloadSlot = vi.fn();
			gatedController = new WorkerController(swBridge, 'game.iso', {
				acquireDownloadSlot,
				releaseDownloadSlot,
				dequeueDownloadSlot,
			});
			const ConverterWorker = /** @type {MockInstance} */ (
				/** @type {unknown} */ (
					(await import('../runtime/converterWorker.js?worker')).default
				)
			);
			gatedFakeWorker = /** @type {any} */ (
				ConverterWorker.mock.instances[ConverterWorker.mock.instances.length - 1]
			);
		});

		/**
		 * @param {string} type
		 * @param {unknown} [payload]
		 */
		function gatedWorkerPost(type, payload) {
			const calls = gatedFakeWorker.addEventListener.mock.calls;
			const messageHandlers = calls
				.filter(([event]) => event === 'message')
				.map(([, handler]) => handler);
			const event = new MessageEvent('message', { data: { type, payload } });
			for (const handler of messageHandlers) handler(event);
		}

		it('acquires the download slot before registerStream, and registerStream waits for it to resolve', async () => {
			gatedWorkerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(acquireDownloadSlot).toHaveBeenCalledOnce());
			expect(swBridge.registerStream).not.toHaveBeenCalled();

			acquireDeferred.resolve();
			await vi.waitFor(() => expect(swBridge.registerStream).toHaveBeenCalled());
		});

		it('only acquires once across multiple STREAM_INFO messages from the same controller', async () => {
			gatedWorkerPost(MSG.STREAM_INFO, {
				filename: 'game.1.cso',
				totalSize: 100n,
			});
			await vi.waitFor(() => expect(acquireDownloadSlot).toHaveBeenCalledOnce());
			acquireDeferred.resolve();
			await vi.waitFor(() => expect(gatedController.streamIds).toHaveLength(1));

			gatedWorkerPost(MSG.STREAM_INFO, {
				filename: 'game.2.cso',
				totalSize: 200n,
			});
			await vi.waitFor(() => expect(gatedController.streamIds).toHaveLength(2));
			expect(acquireDownloadSlot).toHaveBeenCalledOnce(); // still just once
		});

		it('releases the download slot when the worker reports DONE', async () => {
			gatedWorkerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(acquireDownloadSlot).toHaveBeenCalledOnce());
			acquireDeferred.resolve();
			await vi.waitFor(() => expect(swBridge.registerStream).toHaveBeenCalled());

			gatedWorkerPost(MSG.DONE);
			expect(releaseDownloadSlot).toHaveBeenCalledOnce();
			expect(dequeueDownloadSlot).not.toHaveBeenCalled();
		});

		it('releases the download slot if the attach watchdog fires while the slot is held', async () => {
			swBridge.waitForAttached = vi.fn().mockResolvedValue(false);

			gatedWorkerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(acquireDownloadSlot).toHaveBeenCalledOnce());
			acquireDeferred.resolve();

			await vi.waitFor(() => expect(releaseDownloadSlot).toHaveBeenCalledOnce());
			expect(dequeueDownloadSlot).not.toHaveBeenCalled();
		});

		it('releases an already-held download slot on terminate()', async () => {
			gatedWorkerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(acquireDownloadSlot).toHaveBeenCalledOnce());
			acquireDeferred.resolve();
			await vi.waitFor(() => expect(swBridge.registerStream).toHaveBeenCalled());

			gatedController.terminate();
			expect(releaseDownloadSlot).toHaveBeenCalledOnce();
			expect(dequeueDownloadSlot).not.toHaveBeenCalled();
		});

		it('dequeues (not releases) a slot that is still being awaited when cancelled', async () => {
			gatedWorkerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(acquireDownloadSlot).toHaveBeenCalledOnce());

			gatedController.terminate(); // cancelled while still awaiting the gate

			expect(dequeueDownloadSlot).toHaveBeenCalledOnce();
			expect(releaseDownloadSlot).not.toHaveBeenCalled();

			// An abandoned acquire() resolving later shouldn't resurrect registerStream().
			acquireDeferred.resolve();
			await Promise.resolve();
			expect(swBridge.registerStream).not.toHaveBeenCalled();
		});

		it('hands back a slot that was granted in the same race as a cancel, instead of leaking it', async () => {
			gatedWorkerPost(MSG.STREAM_INFO, { totalSize: 1000n });
			await vi.waitFor(() => expect(acquireDownloadSlot).toHaveBeenCalledOnce());

			// Simulates acquire() resolving right as terminate() runs.
			gatedController.terminate();
			acquireDeferred.resolve();
			await Promise.resolve();

			expect(dequeueDownloadSlot).toHaveBeenCalledOnce();
			expect(releaseDownloadSlot).toHaveBeenCalledOnce();
		});
	});

	describe('inspect() + start() together', () => {
		it('sends both INSPECT and CONVERT when READY arrives with both pending', () => {
			const files = [new File([''], 'game.iso')];
			/** @type {DroppedSource} */
			const source = { kind: 'files', files };
			/** @type {NormalizedConvert} */
			const convert = {
				source,
				gameTitle: 'Game',
				format: 'god',
				options: { mode: 'full' },
			};
			controller.inspect(source);
			controller.start(convert);
			workerPost(MSG.READY);
			expect(fakeWorker.postMessage).toHaveBeenCalledWith({
				type: MSG.INSPECT,
				source,
			});
			expect(fakeWorker.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: MSG.CONVERT }),
			);
		});
	});
});
