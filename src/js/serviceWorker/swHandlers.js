/// <reference lib="webworker" />

import { MSG } from '../core/protocol.js';
import { PUBLIC_PATH } from '../lib/publicPath.js';
import { createLogger } from '../lib/logger.js';

/**
 * @import { SwMessage } from '../../types/global.js'
 */

const log = createLogger('SW');

// Number of unacknowledged STREAM_CHUNK messages the producer may have
// in flight. This is producer-side flow control and counts chunks, not
// bytes: a chunk may be a fixed-size slice, a variable-size buffer, or
// an entire small file.
const PRODUCER_HIGH_WATER_MARK = 2;

// High-water mark for the ReadableStream's internal queue, measured in
// bytes. This applies after the download has attached to the stream.
// Backpressure is exposed through controller.desiredSize: when it is
// zero or negative, this code stops acknowledging additional chunks
// until the consumer makes room.
// https://developer.mozilla.org/en-US/docs/Web/API/ByteLengthQueuingStrategy
export const STREAM_HIGH_WATER_MARK_BYTES = 8 * 1024 * 1024; // 8 MiB

// Maximum time between heartbeats before the stream is considered
// abandoned and aborted.
export const HEARTBEAT_TIMEOUT_MS = 20000;

// Maximum time to wait for the browser to pull more data after the
// stream has started applying backpressure. A last-resort safety net
// for a stream the browser has silently walked away from without ever
// calling cancel() - not a liveness check on the page, which the
// heartbeat above already covers independently of pull cadence. Kept
// generous because pull() is paced by whatever's downstream of the
// browser (antivirus/Safe Browsing scanning, slow disks), which can
// stall a real, still-progressing download well past a short bound.
export const PULL_TIMEOUT_MS = 120000;

// Maximum time a stream may remain closed before a download request
// attaches to it. This covers the case where STREAM_CLOSE arrives
// before /download/<id> is fetched.
export const ATTACH_TIMEOUT_MS = 30000;

/**
 * @typedef {Object} StreamEntry
 * @property {ReadableStreamDefaultController<Uint8Array> | null} controller
 * @property {boolean} cancelled
 * @property {boolean} [closed]
 * @property {string} filename
 * @property {bigint | null} totalSize
 * @property {ReturnType<typeof setTimeout> | null} watchdog
 * @property {ReturnType<typeof setTimeout> | null} pullWatchdog
 * @property {ReturnType<typeof setTimeout> | null} attachTimeout
 * @property {Array<(success: boolean) => void>} resolveAckQueue
 * @property {Array<{chunk: Uint8Array, ack: (success: boolean) => void}>} pendingChunks
 */

/** @param {ServiceWorkerGlobalScope} sw */
export function createHandlers(sw) {
	/** @type {Map<string, StreamEntry>} */
	const pending = new Map();

	/**
	 * @param {number} ms
	 * @returns {Promise<void>}
	 */
	const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	/** @param {string} id */
	function resetWatchdog(id) {
		const entry = pending.get(id);
		if (!entry) return;
		if (entry.watchdog) clearTimeout(entry.watchdog);
		entry.watchdog = setTimeout(() => {
			log.warn(`heartbeat timeout, aborting stream ${id}`);
			abortStream(id);
		}, HEARTBEAT_TIMEOUT_MS);
	}

	/** @param {string} id */
	function clearWatchdog(id) {
		const entry = pending.get(id);
		if (entry?.watchdog) {
			clearTimeout(entry.watchdog);
			entry.watchdog = null;
		}
	}

	/**
	 * Arms a one-shot timeout that removes a closed stream which has not
	 * yet been attached to a download. Streams with an attached controller
	 * are cleaned up by the normal close path.
	 *
	 * @param {string} id
	 */
	function armAttachTimeout(id) {
		const entry = pending.get(id);
		if (!entry || entry.controller) return;
		if (entry.attachTimeout) clearTimeout(entry.attachTimeout);
		entry.attachTimeout = setTimeout(() => {
			log.warn(`closed stream ${id} never attached, dropping entry`);
			pending.delete(id);
		}, ATTACH_TIMEOUT_MS);
	}

	/** @param {string} id */
	function clearAttachTimeout(id) {
		const entry = pending.get(id);
		if (entry?.attachTimeout) {
			clearTimeout(entry.attachTimeout);
			entry.attachTimeout = null;
		}
	}

	/**
	 * Moves pre-attachment chunks into the ReadableStream while its
	 * internal queue still has positive desiredSize. Chunks that do not
	 * fit remain in pendingChunks and their acknowledgements are deferred
	 * until the consumer pulls enough data to create room.
	 *
	 * @param {StreamEntry} entry
	 * @param {ReadableStreamDefaultController<Uint8Array>} controller
	 */
	function drainPendingChunks(entry, controller) {
		while (
			entry.pendingChunks.length > 0 &&
			(controller.desiredSize === null || controller.desiredSize > 0)
		) {
			const next = entry.pendingChunks.shift();
			if (!next) break;
			controller.enqueue(next.chunk);
			entry.resolveAckQueue.push(next.ack);
		}
	}

	/**
	 * Resolves every chunk acknowledgement still outstanding for a stream
	 * as failed, so an abort can't leave SwBridge.sendChunk() on the page
	 * waiting on a port message that will never arrive.
	 * @param {StreamEntry} entry
	 */
	function flushPendingAcksAsFailed(entry) {
		for (const resolveAck of entry.resolveAckQueue) resolveAck(false);
		entry.resolveAckQueue = [];
		for (const { ack } of entry.pendingChunks) ack(false);
		entry.pendingChunks = [];
	}

	/** @param {string} id */
	async function abortStream(id) {
		const entry = pending.get(id);
		if (!entry) return;
		clearWatchdog(id);
		clearAttachTimeout(id);
		if (entry.pullWatchdog) {
			clearTimeout(entry.pullWatchdog);
			entry.pullWatchdog = null;
		}
		entry.cancelled = true;
		if (entry.controller) {
			try {
				entry.controller.error(new Error('Stream aborted'));
			} catch {
				// The controller may already be closed or errored.
			}
		}
		flushPendingAcksAsFailed(entry);
		pending.delete(id);

		const clients = await sw.clients.matchAll();
		for (const client of clients) {
			client.postMessage({ type: MSG.CANCELLED, id });
		}
	}

	/** @param {string} id */
	async function handleDownload(id) {
		let entry = pending.get(id);
		for (let i = 0; !entry && i < 40; i++) {
			log.debug(`waiting for entry ${id}, attempt ${i}`);
			await delay(50);
			entry = pending.get(id);
		}
		log.debug(`entry found:`, !!entry);
		if (!entry) return new Response('Stream not found', { status: 404 });

		const stream = new ReadableStream(
			{
				/** @param {ReadableStreamDefaultController<Uint8Array>} controller */
				start(controller) {
					if (entry.controller) {
						controller.error(new Error('Download already attached'));
						return;
					}
					entry.controller = controller;
					entry.pullWatchdog = null;
					clearAttachTimeout(id);

					drainPendingChunks(entry, controller);

					if (
						entry.closed &&
						entry.pendingChunks.length === 0 &&
						entry.resolveAckQueue.length === 0
					) {
						controller.close();
						pending.delete(id);
						return;
					}

					sw.clients.matchAll().then((clients) => {
						for (const client of clients) {
							client.postMessage({ type: MSG.STREAM_ATTACHED, id });
						}
					});
				},
				pull(controller) {
					if (entry.pullWatchdog) {
						clearTimeout(entry.pullWatchdog);
						entry.pullWatchdog = null;
					}

					if (
						entry.resolveAckQueue.length > 0 &&
						controller.desiredSize !== null &&
						controller.desiredSize > 0
					) {
						const releaseWorker = entry.resolveAckQueue.shift();
						releaseWorker?.(true);
					}

					// A pull may have freed queue capacity. Fill that capacity
					// from any chunks that were buffered before attachment or
					// held back by the stream's byte-based high-water mark.
					drainPendingChunks(entry, controller);

					if (
						entry.pendingChunks.length === 0 &&
						entry.resolveAckQueue.length === 0 &&
						entry.closed
					) {
						controller.close();
						pending.delete(id);
						return;
					}

					if (entry.resolveAckQueue.length > 0 && !entry.pullWatchdog) {
						entry.pullWatchdog = setTimeout(() => {
							log.warn(`pull timeout, browser stopped consuming, aborting ${id}`);
							abortStream(id);
						}, PULL_TIMEOUT_MS);
					}
				},
				cancel() {
					if (entry.pullWatchdog) clearTimeout(entry.pullWatchdog);
					abortStream(id);
				},
			},
			new ByteLengthQueuingStrategy({
				highWaterMark: STREAM_HIGH_WATER_MARK_BYTES,
			}),
		);

		let filename = entry.filename ?? 'god.zip';
		filename = encodeURIComponent(filename.replace(/\//g, ':'))
			.replace(/['()]/g, escape)
			.replace(/\*/g, '%2A');

		const contentType = filename.endsWith('.zip')
			? 'application/zip'
			: 'application/octet-stream';

		const headers = /** @type {Record<string, string>} */ ({
			'Content-Type': contentType,
			'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
			'Cache-Control': 'no-store',
			// The page enforces COEP, so this response - loaded in the hidden
			// download iframe - must declare it too or it gets blocked.
			'Cross-Origin-Embedder-Policy': 'require-corp',
		});
		if (entry.totalSize != null) {
			headers['Content-Length'] = String(entry.totalSize);
		}
		return new Response(stream, { headers });
	}

	/** @param {ExtendableEvent} e */
	function onActivate(e) {
		e.waitUntil(sw.clients.claim());
	}

	/** @param {ExtendableMessageEvent} e */
	function onMessage(e) {
		const data = /** @type {SwMessage} */ (e.data);
		const { type } = data;

		if (type === MSG.STREAM_REGISTER) {
			const { id, filename, totalSize } = data;

			log.debug(`registering stream ${id}, totalSize: ${totalSize}`);
			pending.set(id, {
				controller: null,
				cancelled: false,
				filename: filename,
				totalSize: totalSize ?? null,
				watchdog: null,
				pullWatchdog: null,
				attachTimeout: null,
				resolveAckQueue: [],
				pendingChunks: [],
			});
			resetWatchdog(id);

			e.ports[0]?.postMessage({
				type: MSG.REGISTERED,
				highWaterMark: PRODUCER_HIGH_WATER_MARK,
			});
			return;
		}

		if (type === MSG.HEARTBEAT) {
			for (const streamId of data.streamIds ?? []) {
				resetWatchdog(streamId);
			}
			return;
		}

		const { id } = data;
		const entry = pending.get(id);

		if (!entry) {
			if (type === MSG.STREAM_CHUNK) {
				e.ports[0]?.postMessage({ success: false, reason: 'not_found' });
			}
			return;
		}

		if (type === MSG.STREAM_CHUNK) {
			resetWatchdog(id);
			if (!entry.controller) {
				const port = e.ports[0];
				entry.pendingChunks.push({
					chunk: new Uint8Array(data.chunk),
					ack: (success = true) =>
						port?.postMessage(
							success ? { success: true } : { success: false, reason: 'aborted' },
						),
				});
				return;
			}
			if (entry.cancelled) {
				e.ports[0]?.postMessage({ success: false, reason: 'cancelled' });
				pending.delete(id);
				return;
			}
			try {
				const { chunk } = data;
				entry.controller.enqueue(new Uint8Array(chunk));
				const port = e.ports[0];
				const ack = (success = true) =>
					port?.postMessage(
						success ? { success: true } : { success: false, reason: 'aborted' },
					);

				if (
					entry.controller.desiredSize !== null &&
					entry.controller.desiredSize > 0 &&
					entry.resolveAckQueue.length === 0
				) {
					ack();
				} else {
					entry.resolveAckQueue.push(ack);

					if (!entry.pullWatchdog) {
						entry.pullWatchdog = setTimeout(() => {
							log.warn(`pull timeout, browser stopped consuming, aborting ${id}`);
							abortStream(id);
						}, PULL_TIMEOUT_MS);
					}
				}
			} catch {
				pending.delete(id);
				e.ports[0]?.postMessage({ success: false, reason: 'stream_closed' });
			}

			return;
		}

		if (type === MSG.STREAM_ABORT) {
			abortStream(id);
			return;
		}

		if (type === MSG.STREAM_CLOSE) {
			clearWatchdog(id);
			if (entry.controller) {
				if (entry.resolveAckQueue.length === 0) {
					entry.controller.close();
					pending.delete(id);
				} else {
					entry.closed = true;
				}
			} else if (!entry.closed) {
				entry.closed = true;

				// No download has attached yet, so no future heartbeat is
				// expected for this stream. Bound how long the closed entry
				// remains in pending instead of retaining it indefinitely.
				//
				// Only arm this timer on the first close. Repeated
				// STREAM_CLOSE messages must not extend the cleanup deadline.
				armAttachTimeout(id);
			}
		}
	}

	/** @param {FetchEvent} e */
	function onFetch(e) {
		const url = new URL(e.request.url);

		if (url.pathname === `${PUBLIC_PATH}/sw-keepalive`) {
			const ids = url.searchParams.get('ids');
			if (ids) {
				for (const id of ids.split(',')) resetWatchdog(id);
			}

			e.respondWith(new Response(null, { status: 204 }));
			return;
		}

		if (url.pathname.startsWith(`${PUBLIC_PATH}/download/`)) {
			const id = url.pathname.replace(`${PUBLIC_PATH}/download/`, '');
			e.respondWith(handleDownload(id));
			return;
		}

		if (
			e.request.cache === 'only-if-cached' &&
			e.request.mode !== 'same-origin'
		) {
			return;
		}
	}

	return { onMessage, onFetch, onActivate };
}
