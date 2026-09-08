import { vi } from 'vitest';

/**
 * @import { WorkerController } from '../../src/js/workers/controller/WorkerController.js'
 */

/**
 * Shared `WorkerController` test double - any suite that constructs queue
 * items should get its double from here rather than hand-rolling one, so
 * there's a single place to update when WorkerController's public surface
 * changes.
 *
 * Real WorkerController has private (#-prefixed) fields, so TypeScript
 * treats it as nominal rather than structural, and this mock can never
 * satisfy that type directly. WorkerControllerLike is a `Pick` of the
 * real class's public surface, so a mock missing a method fails
 * `@satisfies` at typecheck time instead of failing silently at first
 * use - and the typedef tracks WorkerController automatically instead of
 * needing to be kept in sync by hand.
 *
 * `streamIds` is picked out separately and re-declared as mutable: on
 * the real class it's a read-only getter, but tests need to set it
 * directly on the mock to simulate stream state.
 *
 * @typedef {Pick<WorkerController, 'inspect'|'partitionDir'|'verifyOrder'|'start'|'cleanup'|'terminate'|'release'|'pause'|'resume'> & { streamIds: string[] }} WorkerControllerLike
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
