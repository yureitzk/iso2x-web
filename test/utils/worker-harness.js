/**
 * @typedef {object} WorkerHarnessOptions
 * @property {number} [delayMessagesMs] - Delay delivery of the worker's
 *   'message' events by this many ms (computation still runs at full speed).
 * @property {boolean} [trackLive] - Expose live Worker instances as
 *   `window.__liveWorkers` so a test can assert one was torn down.
 * @property {number} [hardwareConcurrency] - Pin `navigator.hardwareConcurrency`
 *   so concurrency-dependent logic is independent of the host machine.
 */

/**
 * Installed via `page.addInitScript(installWorkerHarness, options)` -
 * Playwright serializes this function on its own, so it must not close
 * over outer scope.
 * @param {WorkerHarnessOptions} options
 */
export function installWorkerHarness(options) {
	const { delayMessagesMs, trackLive, hardwareConcurrency } = options;
	if (hardwareConcurrency !== undefined) {
		Object.defineProperty(navigator, 'hardwareConcurrency', {
			get: () => hardwareConcurrency,
			configurable: true,
		});
	}
	const OriginalWorker = window.Worker;
	if (trackLive) window.__liveWorkers = new Set();

	window.Worker = class extends OriginalWorker {
		/** @param {ConstructorParameters<typeof OriginalWorker>} args */
		constructor(...args) {
			super(...args);
			if (trackLive) window.__liveWorkers.add(this);
			// Maps each original 'message' listener to the delayed wrapper
			// actually registered with the real EventTarget, so
			// removeEventListener() below can find and remove it.
			/** @type {Map<EventListenerOrEventListenerObject, EventListener>} */
			this._delayedListeners = new Map();
		}

		terminate() {
			if (trackLive) window.__liveWorkers.delete(this);
			return super.terminate();
		}

		/**
		 * Declared as the same two overloads lib.dom.d.ts gives
		 * Worker#postMessage - a merged single signature isn't assignable
		 * where TS expects an overloaded one, which broke the subclass.
		 * @overload
		 * @param {any} message
		 * @param {Transferable[]} transfer
		 * @returns {void}
		 */
		/**
		 * @overload
		 * @param {any} message
		 * @param {StructuredSerializeOptions} [options]
		 * @returns {void}
		 */
		/**
		 * @param {any} message
		 * @param {Transferable[] | StructuredSerializeOptions} [transferOrOptions]
		 */
		postMessage(message, transferOrOptions) {
			// Counts messages sent *to* a worker, not just live Worker
			// instances - a pooled worker can be reused for a real task
			// without a new Worker ever being constructed, so
			// __liveWorkers.size alone can't prove a given action drove a
			// real worker round trip.
			if (trackLive)
				window.__workerPostCount = (window.__workerPostCount ?? 0) + 1;
			// @ts-expect-error - forwarding whichever overload was called
			return super.postMessage(message, transferOrOptions);
		}

		/**
		 * @param {string} type
		 * @param {EventListenerOrEventListenerObject} listener
		 * @param {boolean | AddEventListenerOptions} [options]
		 */
		addEventListener(type, listener, options) {
			if (type !== 'message' || !delayMessagesMs) {
				return super.addEventListener(type, listener, options);
			}
			/**
			 * @param {Event} event - always a MessageEvent at runtime; typed
			 *   as plain Event to satisfy the EventListener type below.
			 * @returns {void}
			 */
			const delayed = (event) => {
				setTimeout(() => {
					if (typeof listener === 'function') listener.call(this, event);
					else listener.handleEvent(event);
				}, delayMessagesMs);
			};
			this._delayedListeners.set(listener, delayed);
			return super.addEventListener(type, delayed, options);
		}

		/**
		 * @param {string} type
		 * @param {EventListenerOrEventListenerObject} listener
		 * @param {boolean | EventListenerOptions} [options]
		 */
		removeEventListener(type, listener, options) {
			if (type !== 'message' || !delayMessagesMs) {
				return super.removeEventListener(type, listener, options);
			}
			const delayed = this._delayedListeners.get(listener);
			if (!delayed) return; // never wrapped (or already removed) - nothing to do
			this._delayedListeners.delete(listener);
			return super.removeEventListener(type, delayed, options);
		}
	};
}
