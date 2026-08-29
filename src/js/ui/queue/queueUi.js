import { TEXT } from '../../constants/messages.js';
import { EVENTS } from '../../core/protocol.js';
import { contentTypeLabels } from 'iso2x';
import { formatTitle } from '../../lib/helpers.js';
import { setFaviconActivity } from '../../lib/favicon.js';
import { setBadgeActiveCount } from '../../lib/badge.js';
import { getActiveFilters, updateStats } from './queueStats.js';
import { refreshMoveButtons } from './queueItemDom.js';
import { createSourcePartsController } from './sourcePartsUi.js';
import { baseNameForFiles, displayFileName } from './queueNaming.js';
import {
	applyXbePatchConstraints,
	applyAttachXbeConstraint,
	applyGodSigningConstraints,
	isGodDeviceIdValid,
} from './queueItemOptions.js';
import { createConversionController } from './queueConversion.js';
import { createBulkActionsController } from './queueBulkActions.js';
import { createFileInputController } from './queueFileInput.js';
import { createDragDropController } from './queueDragDrop.js';
import {
	STATUSES,
	STATUS_PERMISSIONS,
	statusKeyFor,
	isEditable,
	statusModifierClass,
	computeOverallProgress,
	removeEntry,
	applyModeConstraints,
	isActiveStatus,
	queue,
} from '../../queue/queue.js';
import * as pkg from '../../../../package.json';

/**
 * @import { SwBridge } from '../../serviceWorker/SwBridge.js'
 * @import { WorkerController } from '../../workers/WorkerController.js'
 * @import {
 *   QueueEntry,
 *   QueueCommand,
 *   SourceOutcome,
 *   SingleDroppedSource,
 *   ConversionStatus,
 * } from '../../../types/global'
 */

/** @type {SwBridge} */
let _swBridge;
/**
 * Bound once initQueue() has a real _swBridge to hand it.
 * @type {{ renderSourceParts: (item: QueueEntry) => void, runInspect: (item: QueueEntry, source: SingleDroppedSource) => WorkerController }}
 */
let sourceParts;
/** @type {ReturnType<typeof createConversionController>} */
let _conversion;

/**
 * Lets settingsPanel.js push a live concurrency-setting change into the
 * conversion controller. A no-op if called before initQueue() has run -
 * settingsPanel.js only ever calls this from a user-driven input event,
 * which can't happen before init() finishes wiring everything up.
 */
export function applyConcurrencySettings() {
	_conversion?.updateConcurrencySettings();
}
/** @type {ReturnType<typeof createBulkActionsController>} */
let _bulkActions;

/** @type {HTMLElement | null} */
let _progressEl = null;

const baseTitle = pkg.displayName;

/**
 * Drives both a row's action button and the matching batch toolbar button.
 * Built here rather than as a module-level const because it needs
 * `_conversion`, which only exists once initQueue() has run.
 * @returns {{ convert: QueueCommand, pause: QueueCommand, cancel: QueueCommand, remove: QueueCommand }}
 */
function buildQueueCommands() {
	return {
		convert: {
			canRun: (item) => isEditable(item),
			run: (item) => {
				_conversion.startConversion(item);
			},
		},
		pause: {
			canRun: (item) => !!STATUS_PERMISSIONS[statusKeyFor(item)].pausable,
			run: (item) => {
				if (!item.ctrl) return;
				if (item.status === 'paused') {
					_conversion.resumeConversion(item);
				} else {
					item.pausing = true;
					updateItemUi(item);
					item.ctrl.pause();
				}
			},
		},
		cancel: {
			canRun: (item) => !!STATUS_PERMISSIONS[statusKeyFor(item)].cancellable,
			run: (item) => {
				if (item.awaitingSlot) {
					_conversion.dequeueFromSlotQueue(item);
					setStatus(item, 'cancelled', TEXT.CANCELLED);
					updateProgressDisplay();
					return;
				}
				item.ctrl?.terminate();
			},
		},
		remove: {
			canRun: (item) => STATUS_PERMISSIONS[statusKeyFor(item)].removable,
			run: (item) => removeFromQueue(item.id),
		},
	};
}

/**
 * SVGElement has no `.hidden` property in the DOM lib types, unlike
 * HTMLElement, though the attribute works the same way.
 * @param {SVGElement} el
 * @param {boolean} hidden
 */
function setSvgHidden(el, hidden) {
	el.toggleAttribute('hidden', hidden);
}

/**
 * Revokes the objectURL backing item.iconEl.src, if any. Callers that
 * replace/discard an entry's icon must call this first.
 * @param {QueueEntry} item
 */
function revokeIconUrl(item) {
	if (item.iconObjectUrl) {
		URL.revokeObjectURL(item.iconObjectUrl);
		item.iconObjectUrl = undefined;
	}
}

/** @param {QueueEntry} item */
function setIconLoading(item) {
	revokeIconUrl(item);
	item.iconEl.hidden = true;
	setSvgHidden(item.iconFallbackEl, true);
	setSvgHidden(item.iconSpinnerEl, false);
}

/**
 * @param {QueueEntry} item
 * @param {string} url
 * @param {boolean} [isObjectUrl] - true when `url` is a blob: URL this
 *   entry should own and revoke once replaced/removed.
 */
function setIcon(item, url, isObjectUrl = false) {
	revokeIconUrl(item);
	if (isObjectUrl) item.iconObjectUrl = url;
	item.iconEl.src = url;
	item.iconEl.hidden = false;
	setSvgHidden(item.iconSpinnerEl, true);
	setSvgHidden(item.iconFallbackEl, true);
}

/** @param {QueueEntry} item */
function setFallbackIcon(item) {
	revokeIconUrl(item);
	item.iconEl.hidden = true;
	setSvgHidden(item.iconSpinnerEl, true);
	setSvgHidden(item.iconFallbackEl, false);
}

/** @param {QueueEntry} item */
function updateItemUi(item) {
	const running = item.status === 'running';
	const paused = item.status === 'paused';
	const waiting = !!item.awaitingSlot;
	const idle = isEditable(item);
	const done = item.status === 'done';
	const deviceIdOk = item.options.format !== 'god' || isGodDeviceIdValid(item);
	item.optionsEl.querySelectorAll('input, select').forEach((el) => {
		/** @type {HTMLInputElement} */ (el).disabled = !idle;
	});
	if (idle) {
		applyModeConstraints(item);
		applyXbePatchConstraints(item);
		applyAttachXbeConstraint(item);
		applyGodSigningConstraints(item);
	}
	item.titleEl.disabled = !idle;
	item.formatSelectEl.disabled = !idle;
	item.convertBtn.disabled = !idle || !deviceIdOk;
	item.convertBtn.hidden = done;
	item.pauseBtn.hidden = (!running && !paused) || waiting;
	item.pauseBtn.textContent = paused ? TEXT.RESUME : TEXT.PAUSE;
	item.pauseBtn.disabled = item.pausing;
	item.cancelBtn.hidden = !running && !paused && !waiting;
	item.removeBtn.hidden = running || paused || waiting;
	item.statusEl.classList.toggle(
		'queue-item__status--running',
		running && !waiting,
	);
	item.statusEl.classList.toggle('queue-item__status--awaiting-slot', waiting);
	item.statusEl.dataset.status = statusKeyFor(item);
	sourceParts.renderSourceParts(item);
	_bulkActions.update();
}

function applyFilters() {
	const active = getActiveFilters();
	for (const item of queue) {
		item.section.hidden = active.size > 0 && !active.has(item.status);
	}
	// Move buttons are scoped to the visible list, so hiding/showing rows
	// can change which ones should be enabled.
	refreshMoveButtons();
	_bulkActions.update();
}

function updateProgressDisplay() {
	const percent = computeOverallProgress(queue);
	document.title =
		percent === null ? baseTitle : formatTitle(baseTitle, percent);
	setFaviconActivity(percent !== null);
	setBadgeActiveCount(queue.filter((i) => isActiveStatus(i.status)).length);
	if (!_progressEl) return;
	_progressEl.hidden = percent === null;
	if (percent !== null) _progressEl.textContent = TEXT.PROGRESS_PERCENT(percent);
}

/**
 * @param {QueueEntry}       item
 * @param {ConversionStatus} status
 * @param {string}           [label]
 */
function setStatus(item, status, label) {
	item.status = status;
	if (label) item.statusEl.textContent = ` ${label}`;
	item.statusEl.classList.remove(...STATUSES.map(statusModifierClass));
	item.statusEl.classList.add(statusModifierClass(status));
	updateItemUi(item);
	updateStats(queue);
	applyFilters();
}

/**
 * Clears an item's error display and puts it back into 'inspecting',
 * ahead of a fresh runInspect() call.
 * @param {QueueEntry} item
 */
function beginReinspect(item) {
	item.errorEl.setAttribute('hidden', '');
	item.errorEl.textContent = '';
	setIconLoading(item);
	setStatus(item, 'inspecting', TEXT.INSPECTING);
}

/**
 * Single landing point for every way source inspection can conclude:
 * success, error, or a split that never resolved to a valid ordering.
 * @param {QueueEntry} item
 * @param {SourceOutcome} outcome
 */
function resolveSource(item, outcome) {
	item.errorEl.setAttribute('hidden', '');
	item.errorEl.textContent = '';
	// Only set from a real parsed title, never the baseNameForFiles() fallback.
	item.detectedTitle =
		outcome.kind === 'info' ? outcome.payload.detectedTitle : undefined;
	item.titleEl.value =
		outcome.kind === 'info'
			? (outcome.payload.detectedTitle ?? baseNameForFiles(item.source))
			: baseNameForFiles(item.source);
	item.titleEl.placeholder = TEXT.TITLE_PLACEHOLDER;

	switch (outcome.kind) {
		case 'info': {
			const { payload } = outcome;
			item.titleIdEl.textContent = payload.titleId;
			item.contentTypeEl.textContent = contentTypeLabels[payload.contentType];
			// item.files is the total across all discs; payload.fileSize
			// would only cover the first (inspected) disc.
			item.fileSizeEl.textContent = String(
				item.files.reduce((sum, f) => sum + f.size, 0),
			);
			item.metaEl.removeAttribute('hidden');
			item.formatSelectEl.disabled = false;
			item.sourceFormat = payload.sourceFormat;
			item.sourceIsOgx = payload.contentType === 'xboxOriginal';
			// No icon isn't an error - e.g. encrypted retail XEX.
			if (payload.icon) {
				const blobUrl = URL.createObjectURL(
					// payload.icon's structured-clone-transferred buffer
					// doesn't satisfy BlobPart's typing on its own.
					new Blob([new Uint8Array(payload.icon)], { type: 'image/png' }),
				);
				setIcon(item, blobUrl, true);
			} else {
				setFallbackIcon(item);
			}
			applyModeConstraints(item);
			applyXbePatchConstraints(item);
			applyAttachXbeConstraint(item);
			applyGodSigningConstraints(item);
			// Must run before renderSourceParts(), which keys `disabled`
			// off item.status === 'idle'.
			setStatus(item, 'idle', TEXT.QUEUED);
			sourceParts.renderSourceParts(item);
			return;
		}
		case 'error': {
			item.errorEl.textContent = outcome.message;
			item.errorEl.removeAttribute('hidden');
			setFallbackIcon(item);
			setStatus(item, 'error', TEXT.ERROR);
			sourceParts.renderSourceParts(item);
			return;
		}
		case 'unresolved': {
			item.errorEl.textContent = outcome.source.reason;
			item.errorEl.removeAttribute('hidden');
			setFallbackIcon(item);
			setStatus(item, 'unresolved', TEXT.UNRESOLVED);
			// Must run after the status flip - verifyOrderBtn.disabled is
			// computed from item.status !== 'unresolved'.
			sourceParts.renderSourceParts(item);
			return;
		}
	}
}

/** @param {string} id */
function removeFromQueue(id) {
	const item = removeEntry(queue, id);
	if (!item) return;
	// Pull it out of the wait line so it can't be granted a slot after removal.
	_conversion.dequeueFromSlotQueue(item);
	if (item.ctrl) {
		item.ctrl.terminate();
	}
	revokeIconUrl(item);
	item.section.remove();

	updateStats(queue);
	refreshMoveButtons();
	_bulkActions.update();
}

/** @param {SwBridge} swBridge */
export function initQueue(swBridge) {
	_swBridge = swBridge;

	sourceParts = createSourcePartsController({
		getSwBridge: () => _swBridge,
		resolveSource,
		beginReinspect,
		displayFileName,
	});

	_conversion = createConversionController({
		getSwBridge: () => _swBridge,
		setStatus,
		updateProgressDisplay,
	});

	const queueCommands = buildQueueCommands();

	_bulkActions = createBulkActionsController({
		queueCommands,
		updateProgressDisplay,
	});

	const fileInput = createFileInputController({
		getSwBridge: () => _swBridge,
		sourceParts,
		queueCommands,
		resolveSource,
		setStatus,
		updateBulkActionsUi: () => _bulkActions.update(),
	});

	const dragDrop = createDragDropController({
		getSwBridge: () => _swBridge,
		addSourceToQueue: fileInput.addSourceToQueue,
	});

	_progressEl = document.getElementById('queue-progress');
	fileInput.initFileInput();
	fileInput.initFolderInput();
	dragDrop.initDragDrop();
	_bulkActions.init();

	window.addEventListener(EVENTS.FILTER_CHANGED, () => applyFilters());

	document.addEventListener('freeze', () => {
		for (const item of queue) {
			if (item.status === 'running' && item.ctrl) {
				item.ctrl.pause();
			}
		}
	});

	document.addEventListener('resume', () => {
		for (const item of queue) {
			if (item.status === 'paused' && item.ctrl) {
				_conversion.resumeConversion(item);
			}
		}
	});
}
