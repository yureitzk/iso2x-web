import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerPool } from './WorkerPool.js';
import { MSG } from '../../core/protocol.js';

/**
 * @import { MockInstance } from 'vitest'
 */

// Mirrors the private constants in WorkerPool.js - not exported, so kept in
// sync here deliberately. If these ever drift, the "boundary" tests below
// will start failing loudly rather than silently testing the wrong number.
const RECYCLE_SIZE_BYTES = 300 * 1024 * 1024;
const RECYCLE_AFTER_USES = 8;
const IDLE_TIMEOUT_MS = 60 * 1000;

vi.mock('../runtime/converterWorker.js?worker', () => {
	const FakeWorker = vi.fn(function () {
		this.postMessage = vi.fn();
		this.terminate = vi.fn();
		this.addEventListener = vi.fn();
		this.removeEventListener = vi.fn();
	});
	return { default: FakeWorker };
});

/**
 * Fires MSG.READY on the given fake worker instance, resolving whichever
 * _spawn() call is waiting on it.
 * @param {any} fakeWorker
 */
function sendReady(fakeWorker) {
	const handler = fakeWorker.addEventListener.mock.calls.find(
		(/** @type {[string, Function]} */ call) => call[0] === 'message',
	)?.[1];
	if (!handler) throw new Error('No message handler registered on worker');
	handler({ data: { type: MSG.READY } });
}

/**
 * Fires a plain 'error' event on the given fake worker instance, rejecting
 * whichever _spawn() call is waiting on it.
 * @param {any} fakeWorker
 */
function sendError(fakeWorker) {
	const handler = fakeWorker.addEventListener.mock.calls.find(
		(/** @type {[string, Function]} */ call) => call[0] === 'error',
	)?.[1];
	if (!handler) throw new Error('No error handler registered on worker');
	handler(new Event('error'));
}

/** @returns {Promise<any[]>} every fake worker instance constructed so far */
async function allFakeWorkers() {
	const ConverterWorker = /** @type {MockInstance} */ (
		/** @type {unknown} */ (
			(await import('../runtime/converterWorker.js?worker')).default
		)
	);
	return /** @type {any} */ (ConverterWorker.mock.instances);
}

/** @returns {Promise<any>} the most recently constructed fake worker instance */
async function lastFakeWorker() {
	const instances = await allFakeWorkers();
	return instances[instances.length - 1];
}

describe('WorkerPool', () => {
	beforeEach(async () => {
		const ConverterWorker = /** @type {MockInstance} */ (
			/** @type {unknown} */ (
				(await import('../runtime/converterWorker.js?worker')).default
			)
		);
		ConverterWorker.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('spawns a fresh worker up to size, then queues further acquire() calls', async () => {
		const pool = new WorkerPool(2);

		const p1 = pool.acquire();
		const w1 = await lastFakeWorker();
		sendReady(w1);
		await expect(p1).resolves.toBe(w1);

		const p2 = pool.acquire();
		const w2 = await lastFakeWorker();
		sendReady(w2);
		await expect(p2).resolves.toBe(w2);

		// Pool is at capacity (size=2) - a third acquire() must not spawn a
		// third worker, it should queue as a waiter instead.
		const instancesBefore = (await allFakeWorkers()).length;
		const p3 = pool.acquire();
		expect((await allFakeWorkers()).length).toBe(instancesBefore);

		pool.release(w1, 0);
		await expect(p3).resolves.toBe(w1);
	});

	it('reuses a small, lightly-used worker instead of recycling it', async () => {
		const pool = new WorkerPool(1);
		const p1 = pool.acquire();
		const w1 = await lastFakeWorker();
		sendReady(w1);
		await p1;

		pool.release(w1, 1024);
		expect(w1.terminate).not.toHaveBeenCalled();

		const p2 = pool.acquire();
		await expect(p2).resolves.toBe(w1);
		expect((await allFakeWorkers()).length).toBe(1);
	});

	it('recycles a worker that touched a File at/above RECYCLE_SIZE_BYTES', async () => {
		const pool = new WorkerPool(1);
		const p1 = pool.acquire();
		const w1 = await lastFakeWorker();
		sendReady(w1);
		await p1;

		pool.release(w1, RECYCLE_SIZE_BYTES);
		expect(w1.terminate).toHaveBeenCalledTimes(1);

		// No replacement is spawned eagerly - only on the next acquire().
		expect((await allFakeWorkers()).length).toBe(1);
		const p2 = pool.acquire();
		const w2 = await lastFakeWorker();
		expect(w2).not.toBe(w1);
		sendReady(w2);
		await expect(p2).resolves.toBe(w2);
	});

	it('does not recycle just under the size threshold', async () => {
		const pool = new WorkerPool(1);
		const p1 = pool.acquire();
		const w1 = await lastFakeWorker();
		sendReady(w1);
		await p1;

		pool.release(w1, RECYCLE_SIZE_BYTES - 1);
		expect(w1.terminate).not.toHaveBeenCalled();
	});

	it('recycles a worker after RECYCLE_AFTER_USES releases even if each is small', async () => {
		const pool = new WorkerPool(1);
		const p1 = pool.acquire();
		let worker = await lastFakeWorker();
		sendReady(worker);
		await p1;

		for (let use = 1; use < RECYCLE_AFTER_USES; use++) {
			pool.release(worker, 1024);
			expect(worker.terminate).not.toHaveBeenCalled();
			const p = pool.acquire();
			await expect(p).resolves.toBe(worker);
		}

		// The RECYCLE_AFTER_USES-th release crosses the use-count safety net.
		pool.release(worker, 1024);
		expect(worker.terminate).toHaveBeenCalledTimes(1);
	});

	it('immediately hands a recycled worker slot to a queued waiter by spawning a replacement', async () => {
		const pool = new WorkerPool(1);
		const p1 = pool.acquire();
		const w1 = await lastFakeWorker();
		sendReady(w1);
		await p1;

		// Pool is full (size=1) - this queues as a waiter.
		const p2 = pool.acquire();

		pool.release(w1, RECYCLE_SIZE_BYTES);
		expect(w1.terminate).toHaveBeenCalledTimes(1);

		const w2 = await lastFakeWorker();
		expect(w2).not.toBe(w1);
		sendReady(w2);
		await expect(p2).resolves.toBe(w2);
	});

	it('discard() always terminates, never reuses, and can serve a queued waiter', async () => {
		const pool = new WorkerPool(1);
		const p1 = pool.acquire();
		const w1 = await lastFakeWorker();
		sendReady(w1);
		await p1;

		const p2 = pool.acquire();
		pool.discard(w1);
		expect(w1.terminate).toHaveBeenCalledTimes(1);

		const w2 = await lastFakeWorker();
		expect(w2).not.toBe(w1);
		sendReady(w2);
		await expect(p2).resolves.toBe(w2);
	});

	describe('idle-timeout eviction', () => {
		it('terminates a worker left in the free list for IDLE_TIMEOUT_MS', async () => {
			vi.useFakeTimers();
			const pool = new WorkerPool(1);
			const p1 = pool.acquire();
			const w1 = await lastFakeWorker();
			sendReady(w1);
			await p1;

			pool.release(w1, 0);
			expect(w1.terminate).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
			expect(w1.terminate).toHaveBeenCalledTimes(1);
		});

		it('does not evict a worker claimed before the idle timeout fires', async () => {
			vi.useFakeTimers();
			const pool = new WorkerPool(1);
			const p1 = pool.acquire();
			const w1 = await lastFakeWorker();
			sendReady(w1);
			await p1;

			pool.release(w1, 0);
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);

			const p2 = pool.acquire();
			await expect(p2).resolves.toBe(w1);

			// Advancing well past the original deadline must not retroactively
			// terminate a worker that's already back in active use.
			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
			expect(w1.terminate).not.toHaveBeenCalled();
		});

		it('does not arm an idle timer for a worker handed straight to a waiter', async () => {
			vi.useFakeTimers();
			const pool = new WorkerPool(1);
			const p1 = pool.acquire();
			const w1 = await lastFakeWorker();
			sendReady(w1);
			await p1;

			// Queue a waiter before releasing, so release() hands w1 straight
			// to it instead of parking it in `_free`.
			const p2 = pool.acquire();
			pool.release(w1, 0);
			await expect(p2).resolves.toBe(w1);

			await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
			expect(w1.terminate).not.toHaveBeenCalled();
		});
	});

	describe('waiter rejection on failed eager respawn', () => {
		it('rejects a queued acquire() instead of hanging when release()-triggered respawn fails', async () => {
			const pool = new WorkerPool(1);
			const p1 = pool.acquire();
			const w1 = await lastFakeWorker();
			sendReady(w1);
			await p1;

			const p2 = pool.acquire();
			const rejectionSpy = vi.fn();
			p2.catch(rejectionSpy);

			pool.release(w1, RECYCLE_SIZE_BYTES);
			const w2 = await lastFakeWorker();
			sendError(w2);

			await expect(p2).rejects.toBeDefined();
			expect(rejectionSpy).toHaveBeenCalled();
		});

		it('rejects a queued acquire() instead of hanging when discard()-triggered respawn fails', async () => {
			const pool = new WorkerPool(1);
			const p1 = pool.acquire();
			const w1 = await lastFakeWorker();
			sendReady(w1);
			await p1;

			const p2 = pool.acquire();
			const rejectionSpy = vi.fn();
			p2.catch(rejectionSpy);

			pool.discard(w1);
			const w2 = await lastFakeWorker();
			sendError(w2);

			await expect(p2).rejects.toBeDefined();
			expect(rejectionSpy).toHaveBeenCalled();
		});
	});
});
