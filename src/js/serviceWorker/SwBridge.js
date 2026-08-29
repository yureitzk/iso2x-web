import { MSG } from '../core/protocol.js';
import { generateUUID } from '../lib/helpers.js';
import { createLogger } from '../lib/logger.js';
import { PUBLIC_PATH } from '../lib/publicPath.js';

const log = createLogger('SwBridge');

export class SwBridge extends EventTarget {
	/** @type {ServiceWorker} */
	#sw;
	#iframes = new Map();

	/** @param {ServiceWorkerRegistration} swRegistration */
	constructor(swRegistration) {
		super();
		this.#sw = /** @type {ServiceWorker} */ (swRegistration.active);

		navigator.serviceWorker.addEventListener('message', (e) => {
			if (e.data?.type === MSG.CANCELLED) {
				this.dispatchEvent(new CustomEvent(MSG.CANCELLED, { detail: e.data.id }));
			}
		});
	}

	/**
	 * @param {string} id
	 * @param {string} filename
	 * @param {bigint} totalSize
	 * @returns {Promise<number>} the stream's highWaterMark
	 */
	#sendRegister(id, filename, totalSize) {
		return new Promise((resolve) => {
			const { port1, port2 } = new MessageChannel();
			port1.onmessage = (e) => {
				if (e.data.type === MSG.REGISTERED) {
					resolve(e.data.highWaterMark);
				}
			};
			this.#sw.postMessage(
				{ type: MSG.STREAM_REGISTER, id, filename, totalSize },
				[port2],
			);
		});
	}

	/**
	 * Must run synchronously, before any await - the download needs to
	 * ride the triggering click's transient activation or the browser
	 * may not treat it as user-initiated.
	 * @param {string} id
	 */
	#attachDownloadIframe(id) {
		const iframe = document.createElement('iframe');
		iframe.hidden = true;
		iframe.src = `${PUBLIC_PATH}/download/${id}`;
		document.body.appendChild(iframe);
		this.#iframes.set(id, iframe);
	}

	/**
	 * @param {string} id
	 * @param {string} filename
	 * @param {bigint} totalSize
	 * @returns {Promise<number>} the stream's highWaterMark
	 */
	registerStream(id, filename, totalSize) {
		this.#attachDownloadIframe(id);
		return this.#sendRegister(id, filename, totalSize);
	}

	/**
	 * @param {string} id
	 * @param {number} timeoutMs
	 * @returns {Promise<boolean>}
	 */
	waitForAttached(id, timeoutMs) {
		return new Promise((resolve) => {
			/** @param {MessageEvent} e */
			const handler = (e) => {
				if (e.data?.type === MSG.STREAM_ATTACHED && e.data.id === id) {
					settle(true);
				}
			};
			const settle = (/** @type {boolean} */ result) => {
				navigator.serviceWorker.removeEventListener('message', handler);
				clearTimeout(timer);
				resolve(result);
			};
			const timer = setTimeout(() => settle(false), timeoutMs);
			navigator.serviceWorker.addEventListener('message', handler);
		});
	}

	/**
	 * @param {string}      id
	 * @param {ArrayBuffer} chunk
	 * @returns {Promise<boolean>}
	 */
	sendChunk(id, chunk) {
		return new Promise((resolve) => {
			const { port1, port2 } = new MessageChannel();
			port1.onmessage = (e) => resolve(e.data.success === true);
			this.#sw.postMessage({ type: MSG.STREAM_CHUNK, id, chunk }, [chunk, port2]);
		});
	}

	/** @param {string} id */
	abortStream(id) {
		this.#iframes.get(id)?.remove();
		this.#iframes.delete(id);
		this.#sw.postMessage({ type: MSG.STREAM_ABORT, id });
	}

	/** @param {string} id */
	closeStream(id) {
		const iframe = this.#iframes.get(id);
		this.#iframes.delete(id);
		this.#sw.postMessage({ type: MSG.STREAM_CLOSE, id });

		if (iframe) {
			iframe.addEventListener('load', () => iframe.remove(), { once: true });
		}
	}

	/** @param {string[]} streamIds */
	heartbeat(streamIds) {
		this.#sw.postMessage({ type: MSG.HEARTBEAT, streamIds });
	}

	/**
	 * Manual/opt-in only (settings panel "Check" button) - downloads
	 * two visible "permission-check-*.txt" files, so never call this
	 * without the user asking. Iframes attach synchronously to ride
	 * the triggering click's user activation.
	 * @returns {Promise<void>}
	 */
	async primeMultiDownloadPermission() {
		const ids = [generateUUID(), generateUUID()];

		for (const id of ids) {
			this.#attachDownloadIframe(id);
		}

		await Promise.all(
			ids.map(async (id, i) => {
				const payload = new TextEncoder().encode('permission-check\n');
				await this.#sendRegister(
					id,
					`permission-check-${i + 1}.txt`,
					BigInt(payload.byteLength),
				);
				await this.sendChunk(id, payload.buffer);
				this.closeStream(id);
			}),
		);
	}
}

/** @returns {Promise<SwBridge>} */
export async function initServiceWorker() {
	/** @type {RegistrationOptions} */
	const swOptions = import.meta.env.DEV ? { type: 'module' } : {};
	const reg = await navigator.serviceWorker.register(
		`${PUBLIC_PATH}/sw.js`,
		swOptions,
	);

	// navigator.serviceWorker.controller stays null until the next
	// navigation picks up the newly active worker.
	if (reg.active && !navigator.serviceWorker.controller) {
		if (!sessionStorage.getItem('swUncontrolledReload')) {
			sessionStorage.setItem('swUncontrolledReload', '1');
			log.warn('Page is uncontrolled. Forcing normal reload to regain control...');
			window.location.reload();
			return new Promise(() => {});
		}
		log.error(
			'SW is active, but page remains uncontrolled after fallback reload.',
		);
	} else {
		sessionStorage.removeItem('swUncontrolledReload');
	}

	await navigator.serviceWorker.ready;

	log.info('service worker ready and controlling page');
	return new SwBridge(reg);
}
