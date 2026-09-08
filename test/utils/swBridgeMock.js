import { vi } from 'vitest';

/**
 * @import { SwBridge } from '../../src/js/serviceWorker/controller/SwBridge.js'
 */

/**
 * Real SwBridge has private (#-prefixed) fields, so TypeScript treats it
 * as nominal rather than structural and this mock can never satisfy that
 * type directly. SwBridgeLike is a `Pick` of SwBridge's own public
 * surface, so it tracks the real class automatically instead of being
 * hand-copied out of sync.
 *
 * @typedef {Pick<SwBridge, 'registerStream'|'waitForAttached'|'sendChunk'|'abortStream'|'closeStream'|'heartbeat'|'primeMultiDownloadPermission'>} SwBridgeLike
 */

/**
 * @returns {SwBridgeLike & EventTarget}
 */
export function createMockSwBridge() {
	/** @satisfies {new () => SwBridgeLike} */
	class MockSwBridge extends EventTarget {
		constructor() {
			super();
			this.registerStream = vi.fn().mockResolvedValue(2);
			this.waitForAttached = vi.fn().mockResolvedValue(true);
			this.sendChunk = vi.fn().mockResolvedValue(true);
			this.abortStream = vi.fn();
			this.closeStream = vi.fn();
			this.heartbeat = vi.fn();
			this.primeMultiDownloadPermission = vi.fn().mockResolvedValue(undefined);
		}
	}

	return /** @type {SwBridgeLike & EventTarget} */ (new MockSwBridge());
}
