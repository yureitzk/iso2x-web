import { TEXT } from '../../../constants/messages.js';
import { EVENTS } from '../../../core/protocol.js';
import { relativeDirEntries, swapAdjacent } from '../../../lib/helpers.js';
import { WorkerController } from '../../../workers/controller/WorkerController.js';
import { inspectWorkerPool } from '../../../workers/controller/WorkerPool.js';
import { isEditable } from '../../../core/queue.js';

/**
 * @import {
 *   QueueEntry,
 *   DroppedSource,
 *   SingleDroppedSource,
 *   MultiDiscEntry,
 *   SourceFile,
 *   SourcePartsCoreDeps,
 * } from '../../../../types/global'
 */

/**
 * @typedef {SourcePartsCoreDeps & {
 *   renderSourceParts: (item: QueueEntry) => void,
 * }} DiscActionsDeps
 */

/** @param {DiscActionsDeps} deps */
export function createDiscActionsController({
	getSwBridge,
	resolveSource,
	renderSourceParts,
}) {
	/** @param {QueueEntry} item */
	function updateFileSizeDisplay(item) {
		item.fileSizeEl.textContent = String(
			item.files.reduce((sum, f) => sum + f.size, 0),
		);
	}

	/**
	 * Moves disc `idx` one slot toward the front (direction -1) or back
	 * (direction 1). Only valid while the entry is editable.
	 * @param {QueueEntry} item
	 * @param {number} idx
	 * @param {1 | -1} direction
	 */
	function moveDisc(item, idx, direction) {
		if (item.source.kind !== 'multi-disc' || !isEditable(item)) return;
		if (swapAdjacent(item.source.discs, idx, direction)) renderSourceParts(item);
	}

	/**
	 * Removes one disc from a multi-disc entry, dissolving back to a
	 * plain single-source entry if only one disc remains. No-op for a
	 * locked disc (the one inspect() actually ran against).
	 * @param {QueueEntry} item
	 * @param {number} idx
	 */
	function removeDisc(item, idx) {
		if (item.source.kind !== 'multi-disc' || !isEditable(item)) return;
		const { discs } = item.source;
		if (discs[idx]?.locked) return;
		discs.splice(idx, 1);
		// Removing a disc doesn't change titleId/contentType, so there's
		// no need to re-inspect; just the file list/size bookkeeping.
		item.files = discs.flatMap((d) => d.files);
		updateFileSizeDisplay(item);
		if (discs.length === 1) {
			item.source = discs[0];
		}
		renderSourceParts(item);
	}

	/**
	 * Full relative entries/files for a plain single (non-multi-disc,
	 * non-unresolved) source, in the shape resolveDiscAddition() needs.
	 * Not valid for a MultiDiscEntry - see multiDiscEntryEntries() below.
	 * @param {SingleDroppedSource} source
	 */
	function singleSourceEntries(source) {
		if (source.kind === 'dir') {
			const prefix = source.parentPath ? `${source.parentPath}/` : '';
			return {
				entries: source.entries.map((e) => `${prefix}${source.dirName}/${e}`),
				files: source.files,
			};
		}
		return { entries: source.files.map((f) => f.name), files: source.files };
	}

	/**
	 * Full relative entries/files for a MultiDiscEntry. Deliberately
	 * distinct from singleSourceEntries(): a MultiDiscEntry's `entries`
	 * already include the disc's own dirName segment (only the
	 * parentPath prefix is stripped), so reusing singleSourceEntries()
	 * here would double-prepend the dirName and never match a fresh
	 * partitionDir() round-trip.
	 * @param {MultiDiscEntry} disc
	 */
	function multiDiscEntryEntries(disc) {
		if (disc.kind === 'dir') {
			const prefix = disc.parentPath ? `${disc.parentPath}/` : '';
			return {
				entries: disc.entries.map((e) => `${prefix}${e}`),
				files: disc.files,
			};
		}
		return { entries: disc.files.map((f) => f.name), files: disc.files };
	}

	/**
	 * Shared partition round-trip for addDisc()/promoteToMultiDisc():
	 * combines existing + new entries/files, re-partitions the lot, and
	 * confirms the result is a multi-disc set with one more disc than
	 * before. Diffs resolved discs by `newEntries` membership, not
	 * filename - GOD discs commonly reuse chunk names across discs.
	 * @param {{
	 *   titleId: string | undefined,
	 *   existingEntries: string[],
	 *   existingFiles: SourceFile[],
	 *   newEntries: string[],
	 *   newFiles: File[],
	 *   expectedDiscCount: number,
	 *   onResolved: (result: { titleId: string, newDisc: MultiDiscEntry }) => void,
	 *   onFailed: () => void,
	 * }} opts
	 */
	function resolveDiscAddition({
		titleId,
		existingEntries,
		existingFiles,
		newEntries,
		newFiles,
		expectedDiscCount,
		onResolved,
		onFailed,
	}) {
		const allEntries = [...existingEntries, ...newEntries];
		const allFiles = [...existingFiles, ...newFiles];
		const newEntrySet = new Set(newEntries);
		const partitionCtrl = new WorkerController(getSwBridge(), '', {
			pool: inspectWorkerPool,
		});
		/** @type {DroppedSource[]} */
		const sources = [];
		partitionCtrl.addEventListener(EVENTS.PARTITION_ITEM, (e) => {
			sources.push(/** @type {CustomEvent<DroppedSource>} */ (e).detail);
		});
		partitionCtrl.addEventListener(EVENTS.PARTITION_RESULT, () => {
			partitionCtrl.release();
			const resolved = sources.find(
				(s) =>
					s.kind === 'multi-disc' &&
					(titleId === undefined || s.titleId === titleId),
			);
			if (
				!resolved ||
				resolved.kind !== 'multi-disc' ||
				resolved.discs.length !== expectedDiscCount
			) {
				onFailed();
				return;
			}
			const newDisc = resolved.discs.find((d) =>
				multiDiscEntryEntries(d).entries.some((entry) => newEntrySet.has(entry)),
			);
			if (!newDisc) {
				onFailed();
				return;
			}
			onResolved({ titleId: resolved.titleId, newDisc });
		});
		partitionCtrl.partitionDir('', allEntries, allFiles);
	}

	/**
	 * Appends one more disc to an existing multi-disc entry. `input` is
	 * a single-file picker for loose image discs, or a folder picker
	 * for GOD discs - inferred from `discs[0].kind`, since every disc
	 * in a real set shares one raw container shape.
	 * @param {QueueEntry} item
	 * @param {HTMLInputElement} input
	 */
	function addDisc(item, input) {
		if (item.source.kind !== 'multi-disc' || !input.files?.length) return;
		const { titleId, discs } = item.source;
		const isGod = discs[0]?.kind === 'dir';
		const existingEntries = discs.flatMap(
			(d) => multiDiscEntryEntries(d).entries,
		);
		const existingFiles = discs.flatMap((d) => multiDiscEntryEntries(d).files);
		/** @type {string[]} */
		let newEntries;
		/** @type {File[]} */
		let newFiles;
		if (isGod) {
			const { dirName, entries, files } = relativeDirEntries(input.files);
			newEntries = entries.map((e) => `${dirName}/${e}`);
			newFiles = files;
		} else {
			newFiles = [input.files[0]];
			newEntries = newFiles.map((f) => f.name);
		}
		input.value = '';
		const failMsg = TEXT.DISC_MISMATCH(newFiles[0]?.name);
		resolveDiscAddition({
			titleId,
			existingEntries,
			existingFiles,
			newEntries,
			newFiles,
			expectedDiscCount: discs.length + 1,
			onResolved: ({ newDisc }) => {
				discs.forEach((d) => {
					d.locked = true;
				});
				discs.push({ ...newDisc, locked: false });
				item.files = discs.flatMap((d) => d.files);
				updateFileSizeDisplay(item);
				renderSourceParts(item);
			},
			onFailed: () => resolveSource(item, { kind: 'error', message: failMsg }),
		});
	}

	/**
	 * Promotes a plain single-file/dir source into a brand-new
	 * multi-disc entry: the existing source becomes locked disc 1, the
	 * newly picked file(s) become disc 2. Disc 2's picker shape is
	 * inferred from disc 1's own shape, same as addDisc().
	 * @param {QueueEntry} item
	 * @param {HTMLInputElement} input
	 */
	function promoteToMultiDisc(item, input) {
		const source = item.source;
		if (source.kind !== 'files' && source.kind !== 'dir') return;
		if (!input.files?.length) return;
		const existingIsGod = source.kind === 'dir';
		const newIsGod = existingIsGod;
		const { entries: existingEntries, files: existingFiles } =
			singleSourceEntries(source);
		/** @type {string[]} */
		let newEntries;
		/** @type {File[]} */
		let newFiles;
		if (newIsGod) {
			const { dirName, entries, files } = relativeDirEntries(input.files);
			newEntries = entries.map((e) => `${dirName}/${e}`);
			newFiles = files;
		} else {
			newFiles = [input.files[0]];
			newEntries = newFiles.map((f) => f.name);
		}
		input.value = '';
		const failMsg = TEXT.DISC_MISMATCH(newFiles[0]?.name);
		resolveDiscAddition({
			titleId: undefined,
			existingEntries,
			existingFiles,
			newEntries,
			newFiles,
			expectedDiscCount: 2,
			onResolved: ({ titleId, newDisc }) => {
				/** @type {MultiDiscEntry} */
				const firstDisc = existingIsGod
					? {
							kind: 'dir',
							dirName: /** @type {Extract<SingleDroppedSource, {kind: 'dir'}>} */ (
								source
							).dirName,
							entries: /** @type {Extract<SingleDroppedSource, {kind: 'dir'}>} */ (
								source
							).entries,
							files: source.files,
							parentPath: /** @type {Extract<SingleDroppedSource, {kind: 'dir'}>} */ (
								source
							).parentPath,
							locked: true,
						}
					: { kind: 'files', files: source.files, locked: true };
				item.source = {
					kind: 'multi-disc',
					titleId,
					discCount: 2,
					discs: [firstDisc, { ...newDisc, locked: false }],
				};
				item.files = [firstDisc, newDisc].flatMap((d) => d.files);
				updateFileSizeDisplay(item);
				renderSourceParts(item);
			},
			onFailed: () => resolveSource(item, { kind: 'error', message: failMsg }),
		});
	}

	return {
		moveDisc,
		removeDisc,
		addDisc,
		promoteToMultiDisc,
		updateFileSizeDisplay,
	};
}
