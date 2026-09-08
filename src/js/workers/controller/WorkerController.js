import { EVENTS, MSG } from '../../core/protocol.js';
import ConverterWorker from '../runtime/converterWorker.js?worker';
import { createLogger } from '../../lib/logger.js';
import { generateUUID, yieldToMain } from '../../lib/helpers.js';

/**
 * @import { SwBridge } from '../../serviceWorker/controller/SwBridge.js'
 * @import { WorkerPool } from './WorkerPool.js'
 * @import {
 *   SingleDroppedSource,
 *   WorkerMessage,
 *   NormalizedConvert,
 *   PendingPartition,
 *   PendingVerify,
 *   SourceFile
 * } from '../../../types/global'
 */

const log = createLogger('WorkerController');

/** Time to wait for the SW to confirm STREAM_ATTACHED before treating the attempt as stalled. */
const ATTACH_TIMEOUT_MS = 15000;
/** Attach attempts per download, including the initial try. */
const MAX_ATTACH_ATTEMPTS = 2;

/**
 * A large/deep tree's entries[] (paths) can be multi-MB of text, which
 * would structured-clone synchronously and block the main thread if
 * sent in one postMessage(). 100KiB/msg keeps that under a 100ms
 * budget (source: https://surma.dev/things/is-postmessage-slow/).
 * MAX_FILES caps files[] separately, since its size doesn't
 * track entries[]'s text size 1:1.
 */
const PARTITION_CHUNK_TEXT_BUDGET_BYTES = 100 * 1024;
/** @see PARTITION_CHUNK_TEXT_BUDGET_BYTES */
const PARTITION_CHUNK_MAX_FILES = 2000;

/**
 * Slices `entries`/`files` into chunks that each stay under both the
 * text-size and file-count budgets. Always makes progress - even a
 * single oversized entry gets its own chunk rather than looping
 * forever.
 * @param {string[]} entries
 * @param {File[]} files
 * @returns {{ entries: string[], files: File[] }[]}
 */
function chunkPartitionInput(entries, files) {
	if (entries.length === 0) return [{ entries: [], files: [] }];

	/** @type {{ entries: string[], files: File[] }[]} */
	const chunks = [];
	/** @type {string[]} */
	let curEntries = [];
	/** @type {File[]} */
	let curFiles = [];
	let curBytes = 0;

	for (let i = 0; i < entries.length; i++) {
		// UTF-16 code units, matching how V8 actually stores JS strings.
		const entryBytes = entries[i].length * 2;
		if (
			curEntries.length > 0 &&
			(curBytes + entryBytes > PARTITION_CHUNK_TEXT_BUDGET_BYTES ||
				curEntries.length >= PARTITION_CHUNK_MAX_FILES)
		) {
			chunks.push({ entries: curEntries, files: curFiles });
			curEntries = [];
			curFiles = [];
			curBytes = 0;
		}
		curEntries.push(entries[i]);
		curFiles.push(files[i]);
		curBytes += entryBytes;
	}
	if (curEntries.length > 0)
		chunks.push({ entries: curEntries, files: curFiles });
	return chunks;
}

/**
 * Messages that are forwarded to the controller's EventTarget without
 * additional side effects. The worker's `payload` becomes the
 * CustomEvent's `detail`.
 *
 * @type {Map<string, string>}
 */
const FORWARDED_EVENTS = new Map([
	[MSG.SOURCE_INFO, EVENTS.SOURCE_INFO],
	[MSG.SOURCE_ERROR, EVENTS.SOURCE_ERROR],
	[MSG.PARTITION_ITEM, EVENTS.PARTITION_ITEM],
	[MSG.PARTITION_RESULT, EVENTS.PARTITION_RESULT],
	[MSG.VERIFY_RESULT, EVENTS.VERIFY_RESULT],
	[MSG.LOG, EVENTS.LOG],
	// MSG.ERROR is handled explicitly in #onMessage, since it must also reclaim the worker.
]);

export class WorkerController extends EventTarget {
	/** @type {SwBridge} */
	#swBridge;
	/** @type {string} */
	#id;
	/** @type {string} - fallback filename for formats that only ever open one stream */
	#filename;
	#terminated = false;

	/**
	 * Gates the download phase against a separate concurrency limit
	 * from the compute one. Optional: probe-task controllers never emit
	 * STREAM_INFO, so they're constructed without these.
	 * @type {(() => Promise<void>) | undefined}
	 */
	#acquireDownloadSlot;
	/** @type {(() => void) | undefined} */
	#releaseDownloadSlot;
	/** @type {(() => void) | undefined} */
	#dequeueDownloadSlot;
	/**
	 * 'none' until the first STREAM_INFO; 'acquiring' while awaiting the
	 * gate; 'held' once granted; 'released' after teardown. Only ever
	 * set once for 'released', making every teardown call idempotent.
	 * @type {'none' | 'acquiring' | 'held' | 'released'}
	 */
	#downloadSlotState = 'none';

	/**
	 * Bytes actually read across inspect()/partitionDir()/verifyOrder(),
	 * as reported by the worker - not File.size, since a probe may only
	 * touch small ranges of a large file. Used by release() so
	 * WorkerPool can decide whether to reuse the worker.
	 * @type {number}
	 */
	#bytesTouched = 0;

	/**
	 * True once the worker can receive protocol messages: immediately
	 * for an injected worker, on pool.acquire() for a pooled one, or on
	 * MSG.READY for a newly created one.
	 * @type {boolean}
	 */
	#ready = false;

	/** @type {Worker | undefined} */
	#worker;
	/** @type {WorkerPool | null} */
	#pool;
	/** @type {(e: MessageEvent) => void} */
	#messageHandler;
	/** @type {(e: ErrorEvent) => void} */
	#errorHandler;
	/** @type {NormalizedConvert | null} */
	_pendingConvert = null;
	/** @type {SingleDroppedSource | null} */
	_pendingInspect = null;
	/** @type {PendingPartition | null} */
	_pendingPartition = null;
	/** @type {PendingVerify | null} */
	_pendingVerify = null;

	/**
	 * Ordering queue only - the actual backpressure signal comes from
	 * the Service Worker through sendChunk() itself.
	 * @type {Promise<void>}
	 */
	#chunkQueue = Promise.resolve();

	/**
	 * Most formats use one stream; some open several sequentially.
	 * @type {Set<string>}
	 */
	#activeStreamIds = new Set();

	/**
	 * If `worker` is supplied, attach it immediately and assume it's
	 * ready. If `pool` is supplied, acquire a worker asynchronously;
	 * operations requested before acquisition completes are held until
	 * the worker becomes ready.
	 * @param {SwBridge} swBridge
	 * @param {string}   filename
	 * @param {{
	 *   worker?: Worker,
	 *   pool?: WorkerPool,
	 *   acquireDownloadSlot?: () => Promise<void>,
	 *   releaseDownloadSlot?: () => void,
	 *   dequeueDownloadSlot?: () => void,
	 * }} [opts]
	 */
	constructor(
		swBridge,
		filename,
		{
			worker,
			pool,
			acquireDownloadSlot,
			releaseDownloadSlot,
			dequeueDownloadSlot,
		} = {},
	) {
		super();
		this.#id = generateUUID();
		this.#swBridge = swBridge;
		this.#filename = filename;
		this.#chunkQueue = Promise.resolve();
		this.#pool = pool ?? null;
		this.#acquireDownloadSlot = acquireDownloadSlot;
		this.#releaseDownloadSlot = releaseDownloadSlot;
		this.#dequeueDownloadSlot = dequeueDownloadSlot;
		this.#messageHandler = (e) => this.#onMessage(e);
		this.#errorHandler = (e) => {
			if (this.#terminated) return;
			this.dispatchEvent(
				new CustomEvent(EVENTS.LOG, {
					detail: 'Worker error: ' + (e.message || 'Unknown error'),
				}),
			);
			this.dispatchEvent(
				new CustomEvent(EVENTS.ERROR, {
					detail: e.message || 'Worker thread crashed.',
				}),
			);
		};

		if (worker) {
			this.#attachWorker(worker);
			this.#ready = true;
		} else if (pool) {
			pool.acquire().then(
				(acquired) => {
					if (this.#terminated) {
						// Terminated while acquisition was pending.
						pool.release(acquired);
						return;
					}
					this.#attachWorker(acquired);
					this.#ready = true;
					this.#flushPending();
				},
				(err) => {
					if (this.#terminated) return;
					this.#terminated = true;
					this.dispatchEvent(
						new CustomEvent(EVENTS.ERROR, {
							detail: err?.message || 'Worker failed to start.',
						}),
					);
				},
			);
		} else {
			// #ready is set when the worker sends MSG.READY.
			this.#attachWorker(new ConverterWorker());
		}
	}

	/** @param {Worker} worker */
	#attachWorker(worker) {
		this.#worker = worker;
		worker.addEventListener(EVENTS.ERROR, this.#errorHandler);
		worker.addEventListener('message', this.#messageHandler);
	}

	/** @returns {Worker} */
	#requireWorker() {
		if (!this.#worker)
			throw new Error('WorkerController: worker not attached yet');
		return this.#worker;
	}

	/** @param {SingleDroppedSource} source */
	inspect(source) {
		if (this.#ready) {
			this.#requireWorker().postMessage({ type: MSG.INSPECT, source });
		} else {
			this._pendingInspect = source;
		}
	}

	/**
	 * Runs in the worker because detectDirFormat() depends on iso2x's
	 * WASM initialization.
	 * @param {string} dirName
	 * @param {string[]} entries
	 * @param {SourceFile[]} files
	 */
	partitionDir(dirName, entries, files) {
		if (this.#ready) {
			this.#postPartitionDir(dirName, entries, files);
		} else {
			this._pendingPartition = { dirName, entries, files };
		}
	}

	/**
	 * Posts entries/files as a series of chunked PARTITION_DIR messages
	 * (see chunkPartitionInput()) instead of one large one, yielding to
	 * the main thread between chunks so a large/deep tree can't freeze
	 * the page while it's being handed to the worker. The worker
	 * reassembles them before running partition logic, so this is
	 * purely a transport change - see converterWorker.js's PARTITION_DIR
	 * handler.
	 * @param {string} dirName
	 * @param {string[]} entries
	 * @param {SourceFile[]} files
	 */
	#postPartitionDir(dirName, entries, files) {
		const chunks = chunkPartitionInput(entries, /** @type {File[]} */ (files));
		(async () => {
			for (let i = 0; i < chunks.length; i++) {
				if (this.#terminated) return;
				const chunk = chunks[i];
				this.#worker?.postMessage({
					type: MSG.PARTITION_DIR,
					...(i === 0 ? { dirName } : {}),
					entries: chunk.entries,
					files: chunk.files,
					chunkIndex: i,
					totalChunks: chunks.length,
				});
				if (i < chunks.length - 1) await yieldToMain();
			}
		})();
	}

	/**
	 * `names[0]` is the candidate header file.
	 * @param {string[]} names
	 * @param {SourceFile[]} files
	 */
	verifyOrder(names, files) {
		if (this.#ready) {
			this.#requireWorker().postMessage({ type: MSG.VERIFY_ORDER, names, files });
		} else {
			this._pendingVerify = { names, files };
		}
	}

	/** @param {NormalizedConvert} convert */
	start(convert) {
		if (this.#ready) {
			this.#postConvert(convert);
		} else {
			this._pendingConvert = convert;
		}
	}

	/** @param {NormalizedConvert} convert */
	#postConvert(convert) {
		const {
			source,
			gameTitle,
			format,
			options,
			generateAttachXbe,
			godSigningKey,
		} = convert;
		this.#requireWorker().postMessage({
			type: MSG.CONVERT,
			source,
			gameTitle,
			format,
			options,
			generateAttachXbe: generateAttachXbe ?? false,
			godSigningKey,
			id: this.#id,
		});
	}

	/**
	 * Acquires this controller's one download slot on the first
	 * STREAM_INFO it sees; a no-op on subsequent ones (formats like
	 * 'ciso' open one SW stream per manifest entry, all sharing the one
	 * slot held for the whole download phase).
	 * @returns {Promise<void>}
	 */
	async #ensureDownloadSlot() {
		if (this.#downloadSlotState !== 'none') return;
		if (!this.#acquireDownloadSlot) {
			this.#downloadSlotState = 'held';
			return;
		}
		this.#downloadSlotState = 'acquiring';
		await this.#acquireDownloadSlot();
		if (this.#downloadSlotState === 'acquiring') {
			this.#downloadSlotState = 'held';
		} else if (this.#downloadSlotState === 'released') {
			// Teardown ran while acquire() was still in flight, and it
			// resolved anyway. Hand the slot back rather than leak it.
			this.#releaseDownloadSlot?.();
		}
	}

	/** Idempotent past the first call - safe from every teardown path. */
	#releaseDownloadSlotIfHeld() {
		if (this.#downloadSlotState === 'held') {
			this.#downloadSlotState = 'released';
			this.#releaseDownloadSlot?.();
		} else if (this.#downloadSlotState === 'acquiring') {
			this.#downloadSlotState = 'released';
			this.#dequeueDownloadSlot?.();
		} else {
			this.#downloadSlotState = 'released';
		}
	}

	/**
	 * Registers a new SW download stream, tells the worker its id and
	 * highWaterMark, and arms a background attach watchdog (see
	 * #watchForAttach).
	 * @param {string} filename
	 * @param {bigint} totalSize
	 * @param {number} [attempt]
	 * @returns {Promise<void>}
	 */
	async #attachStream(filename, totalSize, attempt = 1) {
		const streamId = generateUUID();
		const highWaterMark = await this.#swBridge.registerStream(
			streamId,
			filename,
			totalSize,
		);
		if (this.#terminated) return;
		this.#activeStreamIds.add(streamId);

		this.#worker?.postMessage({
			type: MSG.STREAM_READY,
			id: streamId,
			highWaterMark,
		});

		// Fire-and-forget: STREAM_READY above isn't gated on this.
		this.#watchForAttach(streamId, filename, totalSize, attempt);
	}

	/**
	 * A first miss is treated as transient and retried once with a
	 * fresh stream id; only a second consecutive miss is a terminal
	 * error that tears the worker down.
	 * @param {string} streamId
	 * @param {string} filename
	 * @param {bigint} totalSize
	 * @param {number} attempt
	 */
	async #watchForAttach(streamId, filename, totalSize, attempt) {
		const attached = await this.#swBridge.waitForAttached(
			streamId,
			ATTACH_TIMEOUT_MS,
		);
		// Nothing to do if terminated, or already closed normally via another path.
		if (this.#terminated || !this.#activeStreamIds.has(streamId)) return;
		if (attached) return;

		this.#activeStreamIds.delete(streamId);
		this.#swBridge.abortStream(streamId);

		if (attempt < MAX_ATTACH_ATTEMPTS) {
			this.dispatchEvent(
				new CustomEvent(EVENTS.LOG, {
					detail: `Download stream never attached, retrying (attempt ${attempt + 1}/${MAX_ATTACH_ATTEMPTS})...`,
				}),
			);
			try {
				await this.#attachStream(filename, totalSize, attempt + 1);
			} catch (err) {
				this.dispatchEvent(new CustomEvent(EVENTS.ERROR, { detail: String(err) }));
				this.terminate();
			}
			return;
		}

		this.dispatchEvent(
			new CustomEvent(EVENTS.ERROR, {
				detail: 'Download stream failed to attach.',
			}),
		);
		if (!this.#terminated) this.#teardownWorker();
	}

	/**
	 * Callers are responsible for setting #terminated and deciding how
	 * the worker itself is ultimately reclaimed.
	 */
	#beginTeardown() {
		this.#worker?.postMessage({ type: MSG.CANCEL });
		for (const id of this.#activeStreamIds) this.#swBridge.abortStream(id);
		this.#activeStreamIds.clear();
	}

	#detach() {
		this.#requireWorker().removeEventListener('message', this.#messageHandler);
		this.#requireWorker().removeEventListener(EVENTS.ERROR, this.#errorHandler);
	}

	cleanup() {
		this.#teardownWorker();
	}

	/**
	 * Pool-backed controllers discard their worker rather than running
	 * the CANCEL/CANCEL_ACK handshake. Standalone workers use that
	 * handshake, with a timeout fallback that force-terminates.
	 */
	#teardownWorker() {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#releaseDownloadSlotIfHeld();
		if (this.#pool) {
			// If acquisition is still pending, the constructor's callback
			// observes #terminated and returns the worker untouched.
			if (this.#worker) {
				this.#detach();
				this.#pool.discard(this.#worker);
			}
			return;
		}
		this.#beginTeardown();
		const forceKill = setTimeout(() => {
			log.debug('teardown: no CANCEL_ACK within 2s, force-killing worker');
			this.#worker?.terminate();
		}, 2000);
		this.#worker?.addEventListener('message', (e) => {
			if (e.data.type === MSG.CANCEL_ACK) {
				log.debug('teardown: clean CANCEL_ACK, terminating worker');
				clearTimeout(forceKill);
				this.#worker?.terminate();
			}
		});
	}

	terminate() {
		if (this.#terminated) return;
		this.#teardownWorker();
		this.dispatchEvent(new CustomEvent(EVENTS.CANCELLED));
	}

	/**
	 * Returns a completed pool-backed worker to WorkerPool for reuse.
	 * Only call after a task completes normally; use terminate() otherwise.
	 */
	release() {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#releaseDownloadSlotIfHeld();
		if (!this.#pool) {
			this.#worker?.terminate();
			return;
		}
		if (this.#worker) {
			this.#detach();
			this.#pool.release(this.#worker, this.#bytesTouched);
		}
	}

	pause() {
		if (this.#terminated) return;
		this.#worker?.postMessage({ type: MSG.PAUSE });
	}

	resume() {
		if (this.#terminated) return;
		this.#worker?.postMessage({ type: MSG.RESUME });
	}

	get streamIds() {
		return [...this.#activeStreamIds];
	}

	/** Only the most recent of each pending operation is retained. */
	#flushPending() {
		if (this._pendingInspect) {
			this.#worker?.postMessage({
				type: MSG.INSPECT,
				source: this._pendingInspect,
			});
			this._pendingInspect = null;
		}
		if (this._pendingPartition) {
			const { dirName, entries, files } = this._pendingPartition;
			this.#postPartitionDir(dirName, entries, files);
			this._pendingPartition = null;
		}
		if (this._pendingVerify) {
			this.#worker?.postMessage({
				type: MSG.VERIFY_ORDER,
				...this._pendingVerify,
			});
			this._pendingVerify = null;
		}
		if (this._pendingConvert) {
			this.#postConvert(this._pendingConvert);
			this._pendingConvert = null;
		}
	}

	/** @param {MessageEvent<WorkerMessage>} e */
	async #onMessage(e) {
		const data = e.data;
		const forwardedEvent = FORWARDED_EVENTS.get(data.type);

		if (forwardedEvent) {
			// Map.get() doesn't narrow the WorkerMessage union.
			const payload = /** @type {{ payload: unknown }} */ (data).payload;

			// LOG and PARTITION_ITEM don't normally carry bytesRead.
			const bytesRead = /** @type {{ bytesRead?: number }} */ (data).bytesRead;
			if (typeof bytesRead === 'number') this.#bytesTouched += bytesRead;

			this.dispatchEvent(new CustomEvent(forwardedEvent, { detail: payload }));
			return;
		}

		if (data.type === MSG.READY) {
			log.debug('worker ready, id:', this.#id);
			this.#ready = true;
			this.#flushPending();
		} else if (data.type === MSG.DONE) {
			this.#terminated = true;
			this.#releaseDownloadSlotIfHeld();
			this.#worker?.terminate();
			this.dispatchEvent(new CustomEvent(EVENTS.DONE));
		} else if (data.type === MSG.ERROR) {
			if (this.#terminated) return;
			this.dispatchEvent(new CustomEvent(EVENTS.ERROR, { detail: data.payload }));
			this.#teardownWorker();
			return;
		} else if (data.type === MSG.PAUSED) {
			this.dispatchEvent(new CustomEvent(EVENTS.PAUSED));
		} else if (data.type === MSG.PROGRESS) {
			if (!this.#terminated) {
				this.dispatchEvent(
					new CustomEvent(EVENTS.PROGRESS, { detail: data.payload }),
				);
			}
		} else if (data.type === MSG.STREAM_INFO) {
			await this.#ensureDownloadSlot();
			if (this.#terminated) return;

			const { filename, totalSize } = data.payload;
			try {
				await this.#attachStream(filename ?? this.#filename, totalSize);
			} catch (err) {
				this.dispatchEvent(new CustomEvent(EVENTS.ERROR, { detail: String(err) }));
				this.terminate();
			}
		} else if (data.type === MSG.STREAM_CHUNK) {
			if (this.#terminated) return;

			const { id, chunk } = data.payload;

			// Serializes delivery: each chunk waits for the previous sendChunk()
			// to resolve, which is what actually carries backpressure.
			this.#chunkQueue = this.#chunkQueue.then(async () => {
				if (this.#terminated) return;
				const accepted = await this.#swBridge.sendChunk(id, chunk);
				if (!accepted) {
					this.terminate();
				} else {
					this.#worker?.postMessage({ type: MSG.CHUNK_ACK, id });
				}
			});
		} else if (data.type === MSG.STREAM_CLOSE) {
			const { id } = data.payload;

			// Processed only after earlier queued sendChunk() calls have settled.
			this.#chunkQueue = this.#chunkQueue.then(() => {
				this.#swBridge.closeStream(id);
				this.#activeStreamIds.delete(id);
			});
		}
	}
}
