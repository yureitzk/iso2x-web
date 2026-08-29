import { vi } from 'vitest';

/**
 * @import {
 *   SingleDroppedSource,
 *   NormalizedConvert,
 * } from '../../src/types/global'
 */

/**
 * Shared `WorkerController` test double - any suite that constructs queue
 * items should get its double from here rather than hand-rolling one, so
 * there's a single place to update when WorkerController's public surface
 * changes.
 *
 * Real WorkerController has private (#-prefixed) fields, so TypeScript
 * treats it as nominal rather than structural, and this mock can never
 * satisfy that type directly. WorkerControllerLike is a hand-maintained
 * stand-in for its *public* surface: a mock missing a method fails
 * `@satisfies` at typecheck time instead of failing silently at first
 * use. Keep this typedef in sync with WorkerController's own public
 * methods/getters by hand.
 *
 * @typedef {object} WorkerControllerLike
 * @property {(source: SingleDroppedSource) => void} inspect
 * @property {(dirName: string, entries: string[], files: File[]) => void} partitionDir
 * @property {(names: string[], files: File[]) => void} verifyOrder
 * @property {(convert: NormalizedConvert) => void} start
 * @property {() => void} cleanup
 * @property {() => void} terminate
 * @property {() => void} release
 * @property {() => void} pause
 * @property {() => void} resume
 * @property {string[]} streamIds
 */

/**
 * @returns {{
 *   MockWorkerController: new (swBridge: unknown, filename: string) => WorkerControllerLike & EventTarget,
 *   mockControllers: (WorkerControllerLike & EventTarget)[],
 * }}
 */
export function createMockWorkerController() {
	/** @type {(WorkerControllerLike & EventTarget)[]} */
	const mockControllers = [];

	/** @satisfies {new (...args: any[]) => WorkerControllerLike} */
	class MockWorkerController extends EventTarget {
		/**
		 * @param {unknown} swBridge
		 * @param {string} filename
		 */
		constructor(swBridge, filename) {
			super();
			this.swBridge = swBridge;
			this.filename = filename;
			this.inspect = vi.fn();
			this.partitionDir = vi.fn();
			this.verifyOrder = vi.fn();
			this.start = vi.fn();
			this.cleanup = vi.fn();
			this.terminate = vi.fn();
			this.release = vi.fn();
			this.pause = vi.fn();
			this.resume = vi.fn();
			/** @type {string[]} */
			this.streamIds = [];
			mockControllers.push(/** @type {any} */ (this));
		}
	}

	return { MockWorkerController, mockControllers };
}

/**
 * Most-recently-constructed controller double.
 * @param {(WorkerControllerLike & EventTarget)[]} mockControllers
 */
export function lastController(mockControllers) {
	const ctrl = mockControllers[mockControllers.length - 1];
	if (!ctrl) throw new Error('no WorkerController constructed yet');
	return ctrl;
}
