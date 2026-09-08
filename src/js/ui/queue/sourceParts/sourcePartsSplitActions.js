import { TEXT } from '../../../constants/messages.js';
import { EVENTS } from '../../../core/protocol.js';
import { WorkerController } from '../../../workers/controller/WorkerController.js';
import { inspectWorkerPool } from '../../../workers/controller/WorkerPool.js';
import { swapAdjacent } from '../../../lib/helpers.js';

/**
 * @import {
 *   QueueEntry,
 *   DroppedSource,
 *   SingleDroppedSource,
 *   SourceInfoPayload,
 *   CheckedEntry,
 *   SourceFile,
 *   SourcePartsCoreDeps,
 * } from '../../../../types/global'
 */

/**
 * @typedef {SourcePartsCoreDeps & {
 *   beginReinspect: (item: QueueEntry) => void,
 *   renderSourceParts: (item: QueueEntry) => void,
 * }} SplitActionsDeps
 */

/** @param {SplitActionsDeps} deps */
export function createSplitActionsController({
	getSwBridge,
	resolveSource,
	beginReinspect,
	renderSourceParts,
}) {
	/**
	 * Re-derives item.lockedFiles after a round-trip through
	 * PARTITION_RESULT. postMessage structured-clones File objects, so
	 * `resolvedFiles` is never identical to the instances lockedFiles
	 * was built from - match by name+size against the previous locked
	 * set instead, so an originally-inserted file stays locked and a
	 * freshly-attached one stays unlocked.
	 * @param {QueueEntry} item
	 * @param {SourceFile[]} resolvedFiles
	 */
	function relockFiles(item, resolvedFiles) {
		const prevLocked = [...item.lockedFiles];
		item.lockedFiles = new Set(
			resolvedFiles.filter((f) =>
				prevLocked.some((p) => p.name === f.name && p.size === f.size),
			),
		);
	}

	/**
	 * Fire-and-forget inspect: spins up a scratch WorkerController,
	 * wires SOURCE_INFO/SOURCE_ERROR into resolveSource(), and self-
	 * terminates once either fires. Returns the controller so a caller
	 * with a real reason to hold onto it can (e.g. to cancel an
	 * inspection still in flight if the entry is removed early).
	 * @param {QueueEntry} item
	 * @param {SingleDroppedSource} source
	 * @returns {WorkerController}
	 */
	function runInspect(item, source) {
		const inspectCtrl = new WorkerController(getSwBridge(), '', {
			pool: inspectWorkerPool,
		});
		inspectCtrl.addEventListener(EVENTS.SOURCE_INFO, (ev) => {
			resolveSource(item, {
				kind: 'info',
				payload: /** @type {CustomEvent<SourceInfoPayload>} */ (ev).detail,
			});
			inspectCtrl.release();
		});
		inspectCtrl.addEventListener(EVENTS.SOURCE_ERROR, (ev) => {
			resolveSource(item, {
				kind: 'error',
				message: /** @type {CustomEvent<string>} */ (ev).detail,
			});
			inspectCtrl.release();
		});
		inspectCtrl.inspect(source);
		return inspectCtrl;
	}

	/**
	 * Shared tail of attachSibling()/detachSiblingFile()/
	 * removeUnresolvedFile(): re-resolves `files` via the same
	 * partitionDir round-trip a fresh drop uses, rather than trusting
	 * the new file list directly.
	 * @param {QueueEntry} item
	 * @param {SourceFile[]} files
	 */
	function reresolveAndReinspect(item, files) {
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
			const resolved = sources[0];
			if (!resolved || resolved.kind === 'multi-disc') return;
			if (resolved.kind === 'files' && resolved.invalidReason) {
				resolveSource(item, { kind: 'error', message: resolved.invalidReason });
				return;
			}
			if (resolved.kind === 'unresolved') {
				resolveSource(item, { kind: 'unresolved', source: resolved });
				return;
			}
			item.source = resolved;
			item.files = resolved.files;
			relockFiles(item, resolved.files);
			beginReinspect(item);
			runInspect(item, /** @type {SingleDroppedSource} */ (item.source));
		});
		partitionCtrl.partitionDir(
			'',
			files.map((f) => f.name),
			files,
		);
	}

	/**
	 * Re-resolves a split with one extra candidate file attached. Valid
	 * for both a locked 'files'-kind split and an 'unresolved' one.
	 * @param {QueueEntry} item
	 * @param {HTMLInputElement} input
	 */
	function attachSibling(item, input) {
		if (
			(item.source.kind !== 'files' && item.source.kind !== 'unresolved') ||
			!input.files?.length
		)
			return;
		const newFile = input.files[0];
		input.value = '';
		reresolveAndReinspect(item, [...item.source.files, newFile]);
	}

	/**
	 * Detaches one non-locked file (attached earlier via
	 * attachSibling()) from a resolved split, then re-resolves and
	 * re-inspects the remainder.
	 * @param {QueueEntry} item
	 * @param {number} idx
	 */
	function detachSiblingFile(item, idx) {
		if (item.source.kind !== 'files') return;
		const target = item.source.files[idx];
		if (!target || item.lockedFiles.has(target)) return;
		const remaining = item.source.files.filter((_, i) => i !== idx);
		reresolveAndReinspect(item, remaining);
	}

	/**
	 * Reorders one file within an unresolved source's file list. Purely
	 * a display/verify-candidate reorder - it doesn't re-run detection
	 * itself (see verifyOrder(), which sends whatever order is current).
	 * @param {QueueEntry} item
	 * @param {number} idx
	 * @param {1 | -1} direction
	 */
	function moveUnresolvedFile(item, idx, direction) {
		if (item.source.kind !== 'unresolved' || item.status !== 'unresolved') return;
		if (swapAdjacent(item.source.files, idx, direction)) renderSourceParts(item);
	}

	/**
	 * Drops one file out of an unresolved source's set, then
	 * re-resolves the remainder via the same partitionDir round-trip
	 * attachSibling() uses.
	 * @param {QueueEntry} item
	 * @param {number} idx
	 */
	function removeUnresolvedFile(item, idx) {
		if (item.source.kind !== 'unresolved') return;
		const remaining = item.source.files.filter((_, i) => i !== idx);
		if (remaining.length === 0) {
			resolveSource(item, {
				kind: 'error',
				message: TEXT.NO_FILES_REMAINING,
			});
			return;
		}
		reresolveAndReinspect(item, remaining);
	}

	/**
	 * Sends the unresolved source's current file order to the worker for
	 * verification. For `unresolvedOrdering` this is a diagnostic
	 * re-check; for `ambiguousHeaders` it's the actual recovery path -
	 * the person promotes the real header to position 0 via
	 * moveUnresolvedFile() first, then verifies. `duplicateDiscClaim`
	 * never reaches here.
	 * @param {QueueEntry} item
	 */
	function verifyOrder(item) {
		if (item.source.kind !== 'unresolved') return;
		if (item.source.unresolvedKind === 'duplicateDiscClaim') return;
		const { files } = item.source;
		const names = files.map((f) => f.name);
		const verifyCtrl = new WorkerController(getSwBridge(), '', {
			pool: inspectWorkerPool,
		});
		verifyCtrl.addEventListener(EVENTS.VERIFY_RESULT, (e) => {
			const result =
				/** @type {CustomEvent<{ ok: boolean, checkedEntries: CheckedEntry[], reason?: string }>} */ (
					e
				).detail;
			verifyCtrl.release();
			if (item.source.kind !== 'unresolved') return; // Removed/re-resolved mid-check.
			if (result.ok) {
				item.source = { kind: 'files', files: [...files] };
				item.files = item.source.files;
				beginReinspect(item);
				runInspect(item, /** @type {SingleDroppedSource} */ (item.source));
				return;
			}
			item.source = {
				...item.source,
				lastVerifyResult: {
					ok: result.ok,
					checkedEntries: result.checkedEntries,
					reason: result.reason,
				},
			};
			resolveSource(item, { kind: 'unresolved', source: item.source });
			renderSourceParts(item);
		});
		verifyCtrl.verifyOrder(names, files);
	}

	return {
		runInspect,
		attachSibling,
		detachSiblingFile,
		moveUnresolvedFile,
		removeUnresolvedFile,
		verifyOrder,
	};
}
