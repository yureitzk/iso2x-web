import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EVENTS } from '../../core/protocol.js';
import {
	supportsDragAsEntries,
	toPartitionInput,
	createDragDropController,
} from './queueDragDrop.js';
import {
	file,
	dispatchPartitionResult,
} from '../../../../test/utils/queueTestHelpers.js';

/**
 * @import { DroppedSource } from '../../../types/global'
 * @import { FileWithPath } from 'file-selector'
 */

// fromEvent's own traversal correctness is file-selector's responsibility,
// not this app's - mocked so this suite only exercises queueDragDrop.js
// against whatever it resolves to.
const { fromEvent } = vi.hoisted(() => ({ fromEvent: vi.fn() }));
vi.mock('file-selector', () => ({ fromEvent }));

const { MockWorkerController, mockControllers } = await vi.hoisted(async () => {
	const { createMockWorkerController } =
		await import('../../../../test/utils/workerControllerMock.js');
	return createMockWorkerController();
});
vi.mock('../../workers/controller/WorkerController.js', () => ({
	WorkerController: MockWorkerController,
}));
const { lastController: lastControllerOf } =
	await import('../../../../test/utils/workerControllerMock.js');
const lastController = () => lastControllerOf(mockControllers);

/**
 * A plain, hand-shaped `dataTransfer` rather than a real `DataTransfer`,
 * since the code under test only ever reads `.types`/`.files` off it.
 * @param {string} type
 * @param {{ types?: string[], files?: File[] } | null} [dataTransfer]
 * @returns {Event}
 */
function dragEvent(type, dataTransfer = { types: ['Files'], files: [] }) {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(ev, 'dataTransfer', {
		value: dataTransfer,
		configurable: true,
	});
	return ev;
}

/**
 * @param {string} name
 * @param {string} [relativePath]
 * @returns {FileWithPath}
 */
function fileWithPath(name, relativePath) {
	const f = file(name);
	if (relativePath !== undefined) {
		Object.defineProperty(f, 'relativePath', {
			value: relativePath,
			configurable: true,
		});
	}
	return /** @type {FileWithPath} */ (/** @type {unknown} */ (f));
}

describe('supportsDragAsEntries', () => {
	afterEach(() => {
		delete (/** @type {any} */ (DataTransferItem.prototype).webkitGetAsEntry);
	});

	it('returns false when DataTransferItem has no webkitGetAsEntry (this suite runs under happy-dom, which lacks it)', () => {
		expect(supportsDragAsEntries()).toBe(false);
	});

	it('returns true once webkitGetAsEntry is present on the prototype', () => {
		Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', {
			value: () => null,
			configurable: true,
		});
		expect(supportsDragAsEntries()).toBe(true);
	});

	it('returns false when DataTransferItem itself is unavailable', () => {
		const original = globalThis.DataTransferItem;
		// @ts-expect-error - deliberately simulating a browser without it
		delete globalThis.DataTransferItem;
		try {
			expect(supportsDragAsEntries()).toBe(false);
		} finally {
			globalThis.DataTransferItem = original;
		}
	});
});

describe('toPartitionInput', () => {
	it('strips a leading slash from a fullPath-style relativePath (the normal drag case)', () => {
		const { entries, files } = toPartitionInput([
			fileWithPath('default.xex', '/MyGame/default.xex'),
		]);
		expect(entries).toEqual(['MyGame/default.xex']);
		expect(files).toHaveLength(1);
	});

	it('strips the leading slash from a loose top-level file the same way', () => {
		const { entries } = toPartitionInput([
			fileWithPath('Halo2.iso', '/Halo2.iso'),
		]);
		expect(entries).toEqual(['Halo2.iso']);
	});

	it('leaves a webkitRelativePath-style path (no leading slash) unchanged', () => {
		const { entries } = toPartitionInput([
			fileWithPath('default.xex', 'MyGame/default.xex'),
		]);
		expect(entries).toEqual(['MyGame/default.xex']);
	});

	it('strips the "./" prefix from the no-entry fallback shape', () => {
		const { entries } = toPartitionInput([fileWithPath('0', './0')]);
		expect(entries).toEqual(['0']);
	});

	it('falls back to file.name when relativePath is empty/missing', () => {
		const { entries } = toPartitionInput([fileWithPath('loose.iso', '')]);
		expect(entries).toEqual(['loose.iso']);
	});

	it('keeps each dropped item under its own name as its own prefix when several are dropped together', () => {
		const { entries } = toPartitionInput([
			fileWithPath('default.xex', '/GameOne/default.xex'),
			fileWithPath('loose.iso', '/loose.iso'),
			fileWithPath('save.bin', '/GameTwo/saves/save.bin'),
		]);
		expect(entries).toEqual([
			'GameOne/default.xex',
			'loose.iso',
			'GameTwo/saves/save.bin',
		]);
	});

	it('returns the same File objects, in the same order, alongside the normalized entries', () => {
		const a = fileWithPath('a.iso', '/a.iso');
		const b = fileWithPath('b.iso', '/b.iso');
		const { files } = toPartitionInput([a, b]);
		expect(files).toEqual([a, b]);
	});

	it('returns empty arrays for an empty input', () => {
		expect(toPartitionInput([])).toEqual({ entries: [], files: [] });
	});
});

describe('createDragDropController', () => {
	/** @type {HTMLElement} */
	let zone;
	/** @type {import('vitest').Mock} */
	let addSourceToQueue;
	/** @type {unknown} */
	let swBridgeSentinel;

	beforeEach(() => {
		document.body.innerHTML = `
			<div id="source-dropzone"></div>
			<p id="dropzone-fallback-note" hidden></p>
		`;
		zone = /** @type {HTMLElement} */ (
			document.getElementById('source-dropzone')
		);
		addSourceToQueue = vi.fn(
			(/** @type {DroppedSource} */ source) =>
				`id-${source && 'dirName' in source ? source.dirName : 'file'}-${addSourceToQueue.mock.calls.length}`,
		);
		swBridgeSentinel = { id: 'bridge' };
		mockControllers.length = 0;
		fromEvent.mockReset();

		const dragDrop = createDragDropController({
			getSwBridge: () => /** @type {any} */ (swBridgeSentinel),
			addSourceToQueue,
		});
		dragDrop.initDragDrop();
	});

	describe('hover state', () => {
		it('marks the zone as hovering on dragenter and prevents the default (browser) handling', () => {
			const ev = dragEvent('dragenter');
			zone.dispatchEvent(ev);
			expect(zone.classList.contains('is-dragover')).toBe(true);
			expect(zone.classList.contains('is-dragover-active')).toBe(false);
			expect(ev.defaultPrevented).toBe(true);
		});

		it('ignores a dragenter that is not carrying files, and does not prevent its default', () => {
			const ev = dragEvent('dragenter', { types: ['text/plain'] });
			zone.dispatchEvent(ev);
			expect(zone.classList.contains('is-dragover')).toBe(false);
			expect(ev.defaultPrevented).toBe(false);
		});

		it('confirms the hover (adds is-dragover-active) once a dragover actually lands', () => {
			zone.dispatchEvent(dragEvent('dragenter'));
			zone.dispatchEvent(dragEvent('dragover'));
			expect(zone.classList.contains('is-dragover-active')).toBe(true);
		});

		it('still prevents the default on dragover so the drop can fire, even before a confirming dragenter', () => {
			const ev = dragEvent('dragover');
			zone.dispatchEvent(ev);
			expect(ev.defaultPrevented).toBe(true);
			expect(zone.classList.contains('is-dragover-active')).toBe(false);
		});

		it('clears all hover state after a genuine dragleave with no re-entry', async () => {
			zone.dispatchEvent(dragEvent('dragenter'));
			zone.dispatchEvent(dragEvent('dragover'));
			zone.dispatchEvent(dragEvent('dragleave'));

			await Promise.resolve();

			expect(zone.classList.contains('is-dragover')).toBe(false);
			expect(zone.classList.contains('is-dragover-active')).toBe(false);
		});

		it('does not flicker to idle on a dragleave/dragenter bounce across a child element', async () => {
			zone.dispatchEvent(dragEvent('dragenter'));
			zone.dispatchEvent(dragEvent('dragover'));
			zone.dispatchEvent(dragEvent('dragleave'));
			zone.dispatchEvent(dragEvent('dragenter'));

			await Promise.resolve();

			expect(zone.classList.contains('is-dragover')).toBe(true);
		});

		it('re-confirms with a fresh dragover after a bounce, instead of staying stuck unconfirmed', async () => {
			zone.dispatchEvent(dragEvent('dragenter'));
			zone.dispatchEvent(dragEvent('dragover'));
			expect(zone.classList.contains('is-dragover-active')).toBe(true);

			zone.dispatchEvent(dragEvent('dragleave'));
			zone.dispatchEvent(dragEvent('dragenter'));
			await Promise.resolve();
			expect(zone.classList.contains('is-dragover-active')).toBe(false);

			zone.dispatchEvent(dragEvent('dragover'));
			expect(zone.classList.contains('is-dragover-active')).toBe(true);
		});

		it('never lets dragCounter go negative from a stray dragleave with no matching dragenter', async () => {
			zone.dispatchEvent(dragEvent('dragleave'));
			zone.dispatchEvent(dragEvent('dragenter'));
			expect(zone.classList.contains('is-dragover')).toBe(true);
		});
	});

	describe('drop - no FileSystemEntry support (dt.files fallback)', () => {
		it('partitions the flat file list and reveals the fallback note', async () => {
			const files = [file('Halo2.iso'), file('save.bin')];
			zone.dispatchEvent(dragEvent('drop', { types: ['Files'], files }));

			await vi.waitFor(() => expect(mockControllers).toHaveLength(1));

			const ctrl = lastController();
			expect(ctrl.partitionDir).toHaveBeenCalledWith(
				'',
				['Halo2.iso', 'save.bin'],
				files,
			);
			expect(/** @type {any} */ (ctrl).swBridge).toBe(swBridgeSentinel);

			const note = document.getElementById('dropzone-fallback-note');
			expect(note?.hidden).toBe(false);
		});

		it("never calls file-selector's fromEvent when it falls back to dt.files", async () => {
			zone.dispatchEvent(
				dragEvent('drop', { types: ['Files'], files: [file('a.iso')] }),
			);
			await vi.waitFor(() => expect(mockControllers).toHaveLength(1));
			expect(fromEvent).not.toHaveBeenCalled();
		});

		it('reveals the fallback note only once across multiple drops', async () => {
			const note = /** @type {HTMLElement} */ (
				document.getElementById('dropzone-fallback-note')
			);
			zone.dispatchEvent(
				dragEvent('drop', { types: ['Files'], files: [file('a.iso')] }),
			);
			await vi.waitFor(() => expect(mockControllers).toHaveLength(1));
			expect(note.hidden).toBe(false);

			note.hidden = true; // simulate the user having re-hidden it
			zone.dispatchEvent(
				dragEvent('drop', { types: ['Files'], files: [file('b.iso')] }),
			);
			await vi.waitFor(() => expect(mockControllers).toHaveLength(2));
			expect(note.hidden).toBe(true);
		});

		it('resets hover state synchronously on drop, before any async partitioning work', () => {
			zone.dispatchEvent(dragEvent('dragenter'));
			zone.dispatchEvent(dragEvent('dragover'));
			zone.dispatchEvent(
				dragEvent('drop', { types: ['Files'], files: [file('a.iso')] }),
			);
			expect(zone.classList.contains('is-dragover')).toBe(false);
			expect(zone.classList.contains('is-dragover-active')).toBe(false);
		});

		it('ignores a drop that is not carrying files - never constructs a WorkerController', async () => {
			zone.dispatchEvent(dragEvent('drop', { types: ['text/plain'] }));
			await Promise.resolve();
			expect(mockControllers).toHaveLength(0);
		});

		it('does nothing at all when the flat file list is empty', async () => {
			zone.dispatchEvent(dragEvent('drop', { types: ['Files'], files: [] }));
			await Promise.resolve();
			expect(mockControllers).toHaveLength(0);
		});

		it('forwards each partitioned source to addSourceToQueue and announces the added ids on window', async () => {
			/** @type {string[]} */
			const announced = [];
			const onAdded = (/** @type {Event} */ e) => {
				announced.push(.../** @type {CustomEvent} */ (e).detail.ids);
			};
			window.addEventListener(EVENTS.QUEUE_ITEMS_ADDED, onAdded);

			zone.dispatchEvent(
				dragEvent('drop', { types: ['Files'], files: [file('a.iso')] }),
			);
			await vi.waitFor(() => expect(mockControllers).toHaveLength(1));

			/** @type {DroppedSource[]} */
			const sources = [
				{ kind: 'files', files: [file('a.iso')] },
				{ kind: 'files', files: [file('b.iso')] },
			];
			dispatchPartitionResult(lastController(), sources);

			expect(addSourceToQueue).toHaveBeenCalledTimes(2);
			expect(announced).toEqual([
				addSourceToQueue.mock.results[0].value,
				addSourceToQueue.mock.results[1].value,
			]);

			window.removeEventListener(EVENTS.QUEUE_ITEMS_ADDED, onAdded);
		});

		it('does not announce an id for a source addSourceToQueue declines (returns undefined)', async () => {
			addSourceToQueue.mockReturnValueOnce(undefined);
			/** @type {string[]} */
			const announced = [];
			const onAdded = (/** @type {Event} */ e) => {
				announced.push(.../** @type {CustomEvent} */ (e).detail.ids);
			};
			window.addEventListener(EVENTS.QUEUE_ITEMS_ADDED, onAdded);

			zone.dispatchEvent(
				dragEvent('drop', { types: ['Files'], files: [file('a.iso')] }),
			);
			await vi.waitFor(() => expect(mockControllers).toHaveLength(1));

			dispatchPartitionResult(lastController(), [
				{ kind: 'files', files: [file('declined.iso')] },
				{ kind: 'files', files: [file('accepted.iso')] },
			]);

			expect(announced).toEqual([addSourceToQueue.mock.results[1].value]);
			window.removeEventListener(EVENTS.QUEUE_ITEMS_ADDED, onAdded);
		});
	});

	describe('drop - with FileSystemEntry support (real traversal via file-selector)', () => {
		beforeEach(() => {
			Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', {
				value: () => null,
				configurable: true,
			});
		});
		afterEach(() => {
			delete (/** @type {any} */ (DataTransferItem.prototype).webkitGetAsEntry);
		});

		it('normalizes what fromEvent() resolves and partitions it, without touching dt.files or the fallback note', async () => {
			fromEvent.mockResolvedValue([
				fileWithPath('default.xex', '/MyGame/default.xex'),
			]);
			const files = [file('Halo2.iso')]; // dt.files - should be ignored on this path
			zone.dispatchEvent(dragEvent('drop', { types: ['Files'], files }));

			await vi.waitFor(() => expect(mockControllers).toHaveLength(1));

			expect(fromEvent).toHaveBeenCalledTimes(1);
			const ctrl = lastController();
			expect(ctrl.partitionDir).toHaveBeenCalledWith(
				'',
				['MyGame/default.xex'],
				expect.any(Array),
			);

			const note = document.getElementById('dropzone-fallback-note');
			expect(note?.hidden).toBe(true);
		});

		it('filters out any non-File results fromEvent() might resolve (e.g. raw DataTransferItems)', async () => {
			fromEvent.mockResolvedValue([
				fileWithPath('default.xex', '/MyGame/default.xex'),
				{ kind: 'file' }, // not a File instance - should be dropped
			]);
			zone.dispatchEvent(dragEvent('drop', { types: ['Files'], files: [] }));

			await vi.waitFor(() => expect(mockControllers).toHaveLength(1));
			expect(lastController().partitionDir).toHaveBeenCalledWith(
				'',
				['MyGame/default.xex'],
				expect.any(Array),
			);
		});

		it('constructs no WorkerController when fromEvent() resolves to nothing usable', async () => {
			fromEvent.mockResolvedValue([]);
			zone.dispatchEvent(dragEvent('drop', { types: ['Files'], files: [] }));
			await Promise.resolve();
			await Promise.resolve();
			expect(mockControllers).toHaveLength(0);
		});

		it('logs rather than throws when fromEvent() rejects', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			fromEvent.mockRejectedValue(new Error('traversal failed'));

			expect(() =>
				zone.dispatchEvent(dragEvent('drop', { types: ['Files'], files: [] })),
			).not.toThrow();

			await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
			expect(mockControllers).toHaveLength(0);

			consoleError.mockRestore();
		});
	});

	describe('window-level guard against navigating away with the dropped file', () => {
		it('prevents default on a file dragover anywhere on the window, independent of the dropzone', () => {
			const ev = dragEvent('dragover');
			window.dispatchEvent(ev);
			expect(ev.defaultPrevented).toBe(true);
		});

		it('prevents default on a file drop anywhere on the window', () => {
			const ev = dragEvent('drop');
			window.dispatchEvent(ev);
			expect(ev.defaultPrevented).toBe(true);
		});

		it('leaves a non-file dragover/drop alone', () => {
			const overEv = dragEvent('dragover', { types: ['text/uri-list'] });
			const dropEv = dragEvent('drop', { types: ['text/uri-list'] });
			window.dispatchEvent(overEv);
			window.dispatchEvent(dropEv);
			expect(overEv.defaultPrevented).toBe(false);
			expect(dropEv.defaultPrevented).toBe(false);
		});
	});
});
