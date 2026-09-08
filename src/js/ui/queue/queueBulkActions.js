import { TEXT } from '../../constants/messages.js';
import { queue } from '../../core/queue.js';

/**
 * @import { QueueCommand, QueueEntry } from '../../../types/global'
 */

/**
 * Owns the "N selected" bulk toolbar: per-row checkboxes, select-all,
 * and the four batch action buttons. `queueCommands` is injected
 * rather than imported directly, so this stays a leaf module with no
 * import back onto queueUi.js.
 * @param {{
 *   queueCommands: { convert: QueueCommand, pause: QueueCommand, cancel: QueueCommand, remove: QueueCommand },
 *   updateProgressDisplay: () => void,
 * }} deps
 */
export function createBulkActionsController({
	queueCommands,
	updateProgressDisplay,
}) {
	/** @type {HTMLInputElement | null} */
	let _selectAllCheckbox = null;
	/** @type {HTMLButtonElement | null} */
	let _batchConvertBtn = null;
	/** @type {HTMLButtonElement | null} */
	let _batchPauseBtn = null;
	/** @type {HTMLButtonElement | null} */
	let _batchCancelBtn = null;
	/** @type {HTMLButtonElement | null} */
	let _batchRemoveBtn = null;
	/** @type {HTMLElement | null} */
	let _selectedCountEl = null;

	/**
	 * Visible, checkbox-selected entries eligible to run `command` right
	 * now - the shared predicate behind every batch toolbar button below.
	 * @param {QueueCommand} command
	 * @returns {QueueEntry[]}
	 */
	function selectedFor(command) {
		return queue.filter(
			(i) => !i.section.hidden && i.selectCheckboxEl?.checked && command.canRun(i),
		);
	}

	/**
	 * The single action Batch Pause should apply to the whole selection,
	 * rather than letting each item toggle its own current status (which
	 * would pause some and resume others out of the same click on a
	 * mixed selection - confusing, and not what a single button press
	 * should mean). Any selected item that isn't already paused means
	 * there's still something to pause, so 'pause' wins; only once every
	 * eligible item is already paused does the action flip to 'resume'.
	 * @param {QueueEntry[]} pausableSelected
	 * @returns {'pause' | 'resume' | null}
	 */
	function pauseBatchTarget(pausableSelected) {
		if (pausableSelected.length === 0) return null;
		return pausableSelected.some((item) => item.status !== 'paused')
			? 'pause'
			: 'resume';
	}

	/** Updates state and interactive status of all batch action buttons */
	function update() {
		const visibleItems = queue.filter((item) => !item.section.hidden);
		const selectedItems = visibleItems.filter(
			(item) => item.selectCheckboxEl?.checked,
		);

		if (_selectedCountEl) {
			_selectedCountEl.textContent = TEXT.SELECTED_COUNT(selectedItems.length);
		}

		if (_selectAllCheckbox) {
			const allSelected =
				visibleItems.length > 0 && selectedItems.length === visibleItems.length;
			const noneSelected = selectedItems.length === 0;
			_selectAllCheckbox.checked = allSelected;
			_selectAllCheckbox.indeterminate = !allSelected && !noneSelected;
			_selectAllCheckbox.disabled = visibleItems.length === 0;
		}

		const canConvertAny = selectedItems.some((i) =>
			queueCommands.convert.canRun(i),
		);
		const pausableSelected = selectedItems.filter((i) =>
			queueCommands.pause.canRun(i),
		);
		const pauseTarget = pauseBatchTarget(pausableSelected);
		const canCancelAny = selectedItems.some((i) =>
			queueCommands.cancel.canRun(i),
		);
		const canRemoveAny = selectedItems.some((i) =>
			queueCommands.remove.canRun(i),
		);

		if (_batchConvertBtn) _batchConvertBtn.disabled = !canConvertAny;
		if (_batchPauseBtn) {
			_batchPauseBtn.disabled = pauseTarget === null;
			_batchPauseBtn.textContent =
				pauseTarget === 'pause'
					? TEXT.BATCH_PAUSE
					: pauseTarget === 'resume'
						? TEXT.BATCH_RESUME
						: TEXT.BATCH_PAUSE_RESUME;
		}
		if (_batchCancelBtn) _batchCancelBtn.disabled = !canCancelAny;
		if (_batchRemoveBtn) _batchRemoveBtn.disabled = !canRemoveAny;
	}

	/** Binds global bulk action toolbar logic */
	function init() {
		_selectAllCheckbox = /** @type {HTMLInputElement | null} */ (
			document.getElementById('select-all-checkbox')
		);
		_batchConvertBtn = /** @type {HTMLButtonElement | null} */ (
			document.getElementById('batch-convert-btn')
		);
		_batchPauseBtn = /** @type {HTMLButtonElement | null} */ (
			document.getElementById('batch-pause-btn')
		);
		_batchCancelBtn = /** @type {HTMLButtonElement | null} */ (
			document.getElementById('batch-cancel-btn')
		);
		_batchRemoveBtn = /** @type {HTMLButtonElement | null} */ (
			document.getElementById('batch-remove-btn')
		);
		_selectedCountEl = document.getElementById('selected-count');

		update();

		_selectAllCheckbox?.addEventListener('change', (e) => {
			const target = /** @type {HTMLInputElement} */ (e.currentTarget);
			const checkAll = target.checked;
			for (const item of queue) {
				if (!item.section.hidden && item.selectCheckboxEl) {
					item.selectCheckboxEl.checked = checkAll;
				}
			}
			update();
		});

		_batchConvertBtn?.addEventListener('click', () => {
			// Fine to fire all at once; the slot queue caps concurrency.
			selectedFor(queueCommands.convert).forEach((item) =>
				queueCommands.convert.run(item),
			);
		});

		_batchPauseBtn?.addEventListener('click', () => {
			const eligible = selectedFor(queueCommands.pause);
			const target = pauseBatchTarget(eligible);
			if (target === null) return;

			// commands.pause.run() unconditionally toggles each item, so
			// skip anything already in the target state. Otherwise a
			// paused item caught in a 'pause' pass (or a running item in a
			// 'resume' pass) would flip the wrong way.
			for (const item of eligible) {
				const alreadyThere =
					(target === 'pause' && item.status === 'paused') ||
					(target === 'resume' && item.status !== 'paused');
				if (!alreadyThere) queueCommands.pause.run(item);
			}
			updateProgressDisplay();
			update();
		});

		_batchCancelBtn?.addEventListener('click', () => {
			selectedFor(queueCommands.cancel).forEach((item) =>
				queueCommands.cancel.run(item),
			);
		});

		_batchRemoveBtn?.addEventListener('click', () => {
			selectedFor(queueCommands.remove).forEach((item) =>
				queueCommands.remove.run(item),
			);
			update();
		});
	}

	return { init, update, selectedFor };
}
