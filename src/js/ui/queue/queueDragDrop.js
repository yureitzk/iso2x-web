import { fromEvent } from 'file-selector';
import { EVENTS } from '../../core/protocol.js';
import { TEXT } from '../../constants/messages.js';
import { createLogger } from '../../lib/logger.js';
import { WorkerController } from '../../workers/controller/WorkerController.js';
import { inspectWorkerPool } from '../../workers/controller/WorkerPool.js';

/**
 * @import { SwBridge } from '../../serviceWorker/controller/SwBridge.js'
 * @import { DroppedSource } from '../../../types/global'
 * @import { FileWithPath } from 'file-selector'
 */

const log = createLogger('queue');

/**
 * Whether the browser can give us `FileSystemEntry` objects for a drag -
 * the only way to see into a dropped folder.
 * @returns {boolean}
 */
export function supportsDragAsEntries() {
	return (
		typeof DataTransferItem !== 'undefined' &&
		'webkitGetAsEntry' in DataTransferItem.prototype
	);
}

/**
 * @param {DataTransfer | null} dt
 * @returns {boolean}
 */
function isFileDrag(dt) {
	return !!dt && Array.from(dt.types ?? []).includes('Files');
}

/**
 * Maps file-selector's flattened `FileWithPath[]` into the
 * `(entries[], files[])` shape `WorkerController#partitionDir()` expects.
 *
 * Uses `.relativePath` rather than `.path` (which file-selector leaves
 * untouched when already a string, e.g. an Electron File's absolute
 * path). `.relativePath` comes in one of three shapes: a `/`-rooted
 * `FileSystemEntry.fullPath`, a slash-less `File.webkitRelativePath`,
 * or `"./<name>"`. Stripping the leading `/` or `./` normalizes all
 * three to what `partitionDirEntries()` (source.js) expects.
 * @param {FileWithPath[]} filesWithPath
 * @returns {{ entries: string[], files: File[] }}
 */
export function toPartitionInput(filesWithPath) {
	/** @type {string[]} */
	const entries = [];
	/** @type {File[]} */
	const files = [];
	for (const file of filesWithPath) {
		const relativePath = file.relativePath || file.name;
		entries.push(relativePath.replace(/^\.?\/+/, ''));
		files.push(file);
	}
	return { entries, files };
}

/**
 * `addSourceToQueue` is injected from `createFileInputController` so a
 * drop and a native `<input>` selection both go through the same
 * queue-item creation path.
 * @param {{
 *   getSwBridge: () => SwBridge,
 *   addSourceToQueue: (source: DroppedSource) => string | undefined,
 * }} deps
 */
export function createDragDropController({ getSwBridge, addSourceToQueue }) {
	/** Crossing onto a child element fires a bubbling dragleave/dragenter
	 * pair even though the drag is still over the zone; an enter/leave
	 * counter toggled only at 0/positive coalesces that away. */
	let dragCounter = 0;
	/** True once a dragover has landed while `dragCounter > 0`,
	 * distinguishing a real hover from a dragleave/dragenter bounce. */
	let dragoverConfirmed = false;
	let fallbackNoteShown = false;

	/**
	 * @param {HTMLElement} zone
	 * @param {boolean} hovering
	 * @param {boolean} confirmed
	 */
	function setVisualState(zone, hovering, confirmed) {
		zone.classList.toggle('is-dragover', hovering);
		zone.classList.toggle('is-dragover-active', hovering && confirmed);
	}

	const SUCCESS_FLASH_MS = 900;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let successFlashTimer = null;

	/**
	 * Briefly confirms a drop landed before the hint fades back to idle.
	 * @param {HTMLElement} zone
	 */
	function flashSuccess(zone) {
		const hint = zone.querySelector('.dropzone__hint');
		const originalHint = hint?.textContent ?? '';

		if (successFlashTimer) clearTimeout(successFlashTimer);
		zone.classList.add('is-success');
		if (hint) hint.textContent = TEXT.DROPZONE_ADDED;

		successFlashTimer = setTimeout(() => {
			zone.classList.remove('is-success');
			if (hint) hint.textContent = originalHint;
			successFlashTimer = null;
		}, SUCCESS_FLASH_MS);
	}

	/**
	 * Deferred to a microtask so a same-task dragleave/dragenter bounce
	 * has already re-incremented `dragCounter` by the time this runs.
	 * @param {HTMLElement} zone
	 */
	function scheduleIdleCheck(zone) {
		queueMicrotask(() => {
			if (dragCounter > 0) return;
			dragoverConfirmed = false;
			setVisualState(zone, false, false);
		});
	}

	function showFallbackNoteOnce() {
		if (fallbackNoteShown) return;
		fallbackNoteShown = true;
		const note = document.getElementById('dropzone-fallback-note');
		if (note) note.hidden = false;
	}

	/**
	 * @param {string[]} entries
	 * @param {File[]} files
	 */
	function runPartition(entries, files) {
		if (entries.length === 0) return;
		const partitionCtrl = new WorkerController(getSwBridge(), '', {
			pool: inspectWorkerPool,
		});
		/** @type {string[]} */
		const addedIds = [];
		partitionCtrl.addEventListener(EVENTS.PARTITION_ITEM, (e) => {
			const source = /** @type {CustomEvent<DroppedSource>} */ (e).detail;
			const newId = addSourceToQueue(source);
			if (newId) addedIds.push(newId);
		});
		partitionCtrl.addEventListener(EVENTS.PARTITION_RESULT, () => {
			partitionCtrl.release();
			window.dispatchEvent(
				new CustomEvent(EVENTS.QUEUE_ITEMS_ADDED, { detail: { ids: addedIds } }),
			);
		});
		partitionCtrl.partitionDir('', entries, files);
	}

	/**
	 * @param {DragEvent} e
	 */
	async function handleDrop(e) {
		const dt = e.dataTransfer;
		if (!isFileDrag(dt) || !dt) return;

		if (!supportsDragAsEntries()) {
			// No FileSystemEntry access, so fall back to a flat DataTransfer.files read.
			showFallbackNoteOnce();
			const files = Array.from(dt.files ?? []);
			runPartition(
				files.map((f) => f.name),
				files,
			);
			return;
		}

		// file-selector's fromEvent() does the actual folder traversal.
		const results = await fromEvent(e);
		const filesWithPath = /** @type {FileWithPath[]} */ (
			results.filter((r) => r instanceof File)
		);
		const { entries, files } = toPartitionInput(filesWithPath);
		runPartition(entries, files);
	}

	function initDragDrop() {
		const zone = document.getElementById('source-dropzone');
		if (!(zone instanceof HTMLElement)) return;

		// Otherwise a file dropped anywhere else on the page navigates the tab to it.
		window.addEventListener('dragover', (e) => {
			if (isFileDrag(e.dataTransfer)) e.preventDefault();
		});
		window.addEventListener('drop', (e) => {
			if (isFileDrag(e.dataTransfer)) e.preventDefault();
		});

		zone.addEventListener('dragenter', (e) => {
			if (!isFileDrag(e.dataTransfer)) return;
			e.preventDefault();
			dragCounter++;
			if (dragCounter === 1) {
				// Reset in lockstep with the visual state below, or a bounce
				// leaves this stuck `true` and blocks the confirmed style.
				dragoverConfirmed = false;
				setVisualState(zone, true, false);
			}
		});

		// Without preventDefault() here, the browser rejects the drop and `drop` never fires.
		zone.addEventListener('dragover', (e) => {
			if (!isFileDrag(e.dataTransfer)) return;
			e.preventDefault();
			if (dragCounter > 0 && !dragoverConfirmed) {
				dragoverConfirmed = true;
				setVisualState(zone, true, true);
			}
		});

		zone.addEventListener('dragleave', () => {
			dragCounter = Math.max(0, dragCounter - 1);
			if (dragCounter === 0) scheduleIdleCheck(zone);
		});

		zone.addEventListener('drop', (e) => {
			e.preventDefault();
			dragCounter = 0;
			dragoverConfirmed = false;
			setVisualState(zone, false, false);
			flashSuccess(zone);
			handleDrop(e).catch((err) => {
				log.error('drag-and-drop intake failed', err);
			});
		});
	}

	return { initDragDrop };
}
