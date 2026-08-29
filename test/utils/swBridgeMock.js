import { vi } from 'vitest';

/**
 * Real SwBridge has private (#-prefixed) fields, so TypeScript treats it
 * as nominal rather than structural and this mock can never satisfy that
 * type directly.
 *
 * @typedef {object} SwBridgeLike
 * @property {(id: string, filename: string, totalSize: bigint) => Promise<number>} registerStream
 * @property {(id: string, timeoutMs: number) => Promise<boolean>} waitForAttached
 * @property {(id: string, chunk: ArrayBuffer) => Promise<boolean>} sendChunk
 * @property {(id: string) => void} abortStream
 * @property {(id: string) => void} closeStream
 * @property {(streamIds: string[]) => void} heartbeat
 * @property {() => Promise<void>} primeMultiDownloadPermission
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
