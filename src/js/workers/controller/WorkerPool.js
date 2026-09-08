import ConverterWorker from '../runtime/converterWorker.js?worker';
import { MSG } from '../../core/protocol.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('WorkerPool');

// Capped at 4 regardless of core count: probing is I/O-bound, not
// CPU-bound, so more workers wouldn't add throughput, only more
// compiled wasm modules sitting idle.
const DEFAULT_POOL_SIZE = Math.max(
	1,
	Math.min(navigator.hardwareConcurrency || 4, 4),
);

// A worker that has ever touched a File at or above this size gets
// recycled (terminated + replaced) on its next release() instead of
// being reused. Large-File reads leave resident, worker-realm-scoped
// memory that nothing short of tearing the realm down reclaims. Below
// this size, reused workers stay flat/bounded, so there's no reason
// to pay the wasm-init cost recycling them.
const RECYCLE_SIZE_BYTES = 300 * 1024 * 1024; // 300 MiB

// Safety net for the case a worker never crosses RECYCLE_SIZE_BYTES on
// any single release, but accumulates history across many
// medium-sized files over its lifetime. Recycled after this many uses
// regardless of size.
const RECYCLE_AFTER_USES = 8;

// A worker sitting in `_free` with nothing to do for this long gets
// terminated rather than kept warm forever. Keeps a bulk add from
// leaving 1-4 idle wasm-instantiated workers resident for the rest of
// the tab's life after the person is done adding files.
const IDLE_TIMEOUT_MS = 60 * 1000;

/**
 * Fixed-size pool of persistent `ConverterWorker`s for short, cheap
 * probe tasks (INSPECT / PARTITION_DIR / VERIFY_ORDER), so a bulk add
 * of N files doesn't pay N full worker + wasm-init costs back to back.
 *
 * CONVERT tasks do NOT go through this pool - they're long-running and
 * already concurrency-limited by queueConversion.js's own slot queue
 * (MAX_CONCURRENT_CONVERSIONS). Mixing them would let a slow conversion
 * camp on a slot that probe tasks need to stay responsive.
 */
export class WorkerPool {
	/** @param {number} [size] */
	constructor(size = DEFAULT_POOL_SIZE) {
		this.size = size;
		/** @type {Worker[]} */
		this._free = [];
		/**
		 * Queued acquire() callers waiting for a worker to free up. Stores
		 * both resolve and reject: release()/discard() may need to spawn a
		 * fresh replacement to hand a waiter (when recycling/discarding
		 * left no free worker), and that spawn can itself fail - the
		 * waiter needs a reject path too, or a failed respawn leaves its
		 * acquire() promise settled neither way, forever.
		 * @type {{ resolve: (worker: Worker) => void, reject: (err: unknown) => void }[]}
		 */
		this._waiters = [];
		this._created = 0;
		/**
		 * Use count per live worker, so a worker that's never crossed
		 * RECYCLE_SIZE_BYTES on any single release still gets recycled
		 * after enough cumulative uses. Cleared implicitly when a
		 * worker is terminated (WeakMap - no explicit delete needed).
		 * @type {WeakMap<Worker, number>}
		 */
		this._uses = new WeakMap();
		/**
		 * Pending idle-eviction timer for each worker currently parked in
		 * `_free`, keyed so `acquire()` can cancel it the instant that
		 * worker is handed back out. Only ever has entries for workers
		 * that are actually in `_free` right now.
		 * @type {WeakMap<Worker, ReturnType<typeof setTimeout>>}
		 */
		this._idleTimers = new WeakMap();
	}

	/**
	 * @returns {Promise<Worker>} a worker that has already completed its
	 *   iso2x init handshake, so callers never wait for a MSG.READY
	 *   a reused worker won't send again.
	 */
	acquire() {
		const idle = this._free.pop();
		if (idle) {
			this._clearIdleTimer(idle);
			return Promise.resolve(idle);
		}
		if (this._created < this.size) {
			this._created++;
			return this._spawn();
		}
		return new Promise((resolve, reject) =>
			this._waiters.push({ resolve, reject }),
		);
	}

	/**
	 * Cancels `worker`'s pending idle-eviction timer, if it has one.
	 * Safe to call on a worker that never had a timer set.
	 * @param {Worker} worker
	 */
	_clearIdleTimer(worker) {
		const timer = this._idleTimers.get(worker);
		if (timer !== undefined) {
			clearTimeout(timer);
			this._idleTimers.delete(worker);
		}
	}

	/**
	 * Pushes `worker` onto `_free` and arms an idle-eviction timer: if
	 * nothing calls `acquire()` to claim it within IDLE_TIMEOUT_MS, it's
	 * terminated and dropped rather than kept warm indefinitely.
	 * @param {Worker} worker
	 */
	_parkIdle(worker) {
		this._free.push(worker);
		const timer = setTimeout(() => {
			this._idleTimers.delete(worker);
			const idx = this._free.indexOf(worker);
			if (idx === -1) {
				// The timer fired but this worker was already claimed by
				// acquire() before this callback ran, so there's nothing to evict.
				return;
			}
			this._free.splice(idx, 1);
			log.debug('idle timeout: terminating unused worker');
			try {
				worker.terminate();
			} catch (err) {
				log.debug('idle timeout: terminate failed (already dead)', err);
			}
			this._created--;
		}, IDLE_TIMEOUT_MS);
		this._idleTimers.set(worker, timer);
	}

	/** @returns {Promise<Worker>} */
	_spawn() {
		const worker = new ConverterWorker();
		return new Promise((resolve, reject) => {
			/** @param {MessageEvent} e */
			const onMessage = (e) => {
				if (e.data?.type === MSG.READY) {
					worker.removeEventListener('message', onMessage);
					worker.removeEventListener('error', onError);
					resolve(worker);
				}
			};
			/** @param {ErrorEvent} e */
			const onError = (e) => {
				worker.removeEventListener('message', onMessage);
				worker.removeEventListener('error', onError);
				this._created--;
				reject(e);
			};
			worker.addEventListener('message', onMessage);
			worker.addEventListener('error', onError);
		});
	}

	/**
	 * Returns a worker that finished its task cleanly, for reuse by the
	 * next `acquire()` instead of being torn down. Only safe for probe
	 * tasks (INSPECT/PARTITION_DIR/VERIFY_ORDER), since those never touch
	 * converterWorker.js's module-level conversion state.
	 *
	 * A worker that read a large File keeps that memory resident until its
	 * realm is torn down, so it's recycled (terminated + replaced) once
	 * `sizeBytes` crosses RECYCLE_SIZE_BYTES, or after RECYCLE_AFTER_USES
	 * regardless of size (catches accumulation across many medium files).
	 * Otherwise it's reused, to avoid wasm-init cost on every probe task.
	 * @param {Worker} worker
	 * @param {number} [sizeBytes] total bytes of every File this
	 *   release's task just read; omit for tasks that touched none.
	 */
	release(worker, sizeBytes = 0) {
		const uses = (this._uses.get(worker) ?? 0) + 1;
		const shouldRecycle =
			sizeBytes >= RECYCLE_SIZE_BYTES || uses >= RECYCLE_AFTER_USES;

		if (!shouldRecycle) {
			this._uses.set(worker, uses);
			const waiter = this._waiters.shift();
			if (waiter) {
				// Handed straight to a waiter without ever touching `_free`,
				// so there was never an idle timer to clear.
				waiter.resolve(worker);
				return;
			}
			this._parkIdle(worker);
			return;
		}

		log.debug(`release: recycling worker (sizeBytes=${sizeBytes}, uses=${uses})`);
		this._uses.delete(worker);
		this._clearIdleTimer(worker);
		try {
			worker.terminate();
		} catch (err) {
			log.debug('release: terminate failed (already dead)', err);
		}
		this._created--;
		const waiter = this._waiters.shift();
		if (waiter) {
			this._created++;
			// If this eager respawn itself fails, reject the waiter
			// instead of leaving its acquire() promise unsettled forever.
			// See the note on `_waiters` for why both callbacks are
			// needed here. (_spawn()'s own onError already decrements
			// `_created` on failure, so there's nothing extra to undo here.)
			this._spawn().then(waiter.resolve, waiter.reject);
			return;
		}
		// Don't eagerly respawn idle capacity. Let the next acquire()
		// spawn on demand, same as the normal cold-start path.
	}

	/**
	 * Discards a worker that was cut off mid-task (its item was removed
	 * from the queue before inspection finished) instead of returning it
	 * to the pool. There's no cancel/ack handshake for a probe task, so
	 * it's killed and a fresh replacement takes its pool slot.
	 * @param {Worker} worker
	 */
	discard(worker) {
		this._uses.delete(worker);
		this._clearIdleTimer(worker);
		try {
			worker.terminate();
		} catch (err) {
			log.debug('discard: terminate failed (already dead)', err);
		}
		this._created--;
		const waiter = this._waiters.shift();
		if (waiter) {
			this._created++;
			this._spawn().then(waiter.resolve, waiter.reject);
		}
	}
}

// Shared by every probe call site: runInspect(), bulk file/folder-add
// partition handlers, split-order verification, and multi-disc addition.
export const inspectWorkerPool = new WorkerPool();
