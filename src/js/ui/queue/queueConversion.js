import { EVENTS, MSG } from '../../core/protocol.js';
import { TEXT } from '../../constants/messages.js';
import { createLogger } from '../../lib/logger.js';
import { notify } from '../../lib/notify.js';
import { notifyFaviconOutcome } from '../../lib/favicon.js';
import { notifyBadgeOutcome } from '../../lib/badge.js';
import { PUBLIC_PATH } from '../../lib/publicPath.js';
import {
	notifyConversionStarted,
	notifyConversionFinished,
} from '../../lib/wakeLock.js';
import {
	notifyConversionStarted as notifyAudioKeepAliveStarted,
	notifyConversionFinished as notifyAudioKeepAliveFinished,
} from '../../lib/audioKeepAlive.js';
import { WorkerController } from '../../workers/controller/WorkerController.js';
import { settings } from '../../lib/settings.js';
import {
	queue,
	computeMultiDiscProgress,
	createSlotQueue,
	getActiveStreamIds,
	isEditable,
	isActiveStatus,
} from '../../core/queue.js';
import {
	baseNameForFiles,
	displayFileName,
	outputFilenameFor,
	resolveGameTitle,
} from '../../lib/sourceLabels.js';
import { updateScrollBottomVisibility } from './queueItemDom.js';

/**
 * @import { SwBridge } from '../../serviceWorker/controller/SwBridge.js'
 * @import {
 *   QueueEntry,
 *   ConversionStatus,
 *   DiscRunProgress,
 *   SingleDroppedSource,
 *   Logger,
 * } from '../../../types/global'
 */

/** Lets startMultiDiscConversion()'s catch distinguish cancellation from failure. */
class DiscCancelledError extends Error {}

/** @param {BeforeUnloadEvent} e */
function onBeforeUnload(e) {
	e.preventDefault();
}

/**
 * Status/progress functions are injected rather than imported, to
 * avoid a circular import back onto the module that owns the UI.
 * @param {{
 *   getSwBridge: () => SwBridge,
 *   setStatus: (item: QueueEntry, status: ConversionStatus, label?: string) => void,
 *   updateProgressDisplay: () => void,
 * }} deps
 */
export function createConversionController({
	getSwBridge,
	setStatus,
	updateProgressDisplay,
}) {
	/**
	 * Falls back to leaving one core free for the UI thread when the
	 * user hasn't overridden it (setting is null/invalid).
	 * @returns {number}
	 */
	function effectiveConversionConcurrency() {
		const override = settings.get('maxConcurrentConversions');
		if (typeof override === 'number' && override >= 1) return override;
		return Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
	}

	/** @returns {number} */
	function effectiveDownloadConcurrency() {
		const value = settings.get('maxConcurrentDownloadStreams');
		return typeof value === 'number' && value >= 1 ? value : 1;
	}

	const _slotQueue = createSlotQueue(queue, effectiveConversionConcurrency());

	/** Gates concurrent download phases, separately from `_slotQueue`. */
	const _downloadSlotQueue = createSlotQueue(
		queue,
		effectiveDownloadConcurrency(),
	);

	/** Applies immediately to future slot grants; never disturbs running work. */
	function updateConcurrencySettings() {
		_slotQueue.setMaxConcurrent(effectiveConversionConcurrency());
		_downloadSlotQueue.setMaxConcurrent(effectiveDownloadConcurrency());
	}

	let _activeConversions = 0;
	/** @type {Worker | undefined} */
	let _timerWorker;

	/**
	 * `awaitingSlot` distinguishes queued-waiting from actually converting.
	 * @param {QueueEntry} entry
	 * @returns {Promise<void>}
	 */
	function _acquireConversionSlot(entry) {
		entry.awaitingSlot = true;
		setStatus(entry, 'running', TEXT.WAITING);
		return _slotQueue.acquire(entry).then(() => {
			entry.awaitingSlot = false;
		});
	}

	/** @param {QueueEntry} entry */
	function dequeueFromSlotQueue(entry) {
		_slotQueue.dequeue(entry);
		entry.awaitingSlot = false;
	}

	function _releaseConversionSlot() {
		_slotQueue.release();
	}

	/**
	 * Lets a WorkerController hold one download slot across its whole
	 * download phase, however many streams that involves.
	 * @param {QueueEntry} entry
	 * @returns {Promise<void>}
	 */
	function acquireDownloadSlot(entry) {
		return _downloadSlotQueue.acquire(entry);
	}

	/** @param {QueueEntry} entry */
	function dequeueDownloadSlot(entry) {
		_downloadSlotQueue.dequeue(entry);
	}

	function releaseDownloadSlot() {
		_downloadSlotQueue.release();
	}

	/** @type {ConversionStatus[]} */
	const TERMINAL_STATUSES = ['done', 'error', 'cancelled'];

	/**
	 * Shared done/error/cancelled bookkeeping. No-ops if already terminal.
	 * @param {QueueEntry} entry
	 * @param {ConversionStatus} status
	 * @param {string} label
	 * @param {'success' | 'error' | 'cancelled'} notifyKind
	 * @param {string} notifyName
	 */
	function finishConversion(entry, status, label, notifyKind, notifyName) {
		if (TERMINAL_STATUSES.includes(entry.status)) return;
		conversionFinished();
		_releaseConversionSlot();
		setStatus(entry, status, label);
		updateProgressDisplay();
		notify(notifyKind, notifyName);
		notifyFaviconOutcome(notifyKind);
		notifyBadgeOutcome(notifyKind);
	}

	/**
	 * @param {WorkerController} ctrl
	 * @param {Logger} logger
	 */
	function wireLog(ctrl, logger) {
		ctrl.addEventListener(EVENTS.LOG, (e) => {
			logger.info(/** @type {CustomEvent<string>} */ (e).detail);
		});
	}

	/** @param {QueueEntry} entry @param {string} label */
	function handlePaused(entry, label) {
		entry.pausing = false;
		setStatus(entry, 'paused', label);
		updateProgressDisplay();
	}

	function conversionStarted() {
		_activeConversions++;
		if (_activeConversions === 1) {
			window.addEventListener('beforeunload', onBeforeUnload);
			notifyConversionStarted();
			notifyAudioKeepAliveStarted();

			// Works around Firefox suspending setInterval in hidden tabs.
			const blob = new Blob(
				[
					`let ids = [];
					self.onmessage = (e) => { ids = e.data.streamIds ?? []; };
					setInterval(() => {
						self.postMessage('tick');
						if (ids.length > 0) {
							const qs = encodeURIComponent(ids.join(','));
							fetch('${PUBLIC_PATH}/sw-keepalive?ids=' + qs, { method: 'POST' }).catch(() => {});
						}
					}, 2000);`,
				],
				{ type: 'application/javascript' },
			);
			const url = URL.createObjectURL(blob);
			_timerWorker = new Worker(url, { name: 'timer-worker' });
			URL.revokeObjectURL(url);
			_timerWorker.onmessage = () => {
				const streamIds = getActiveStreamIds(queue);
				_timerWorker?.postMessage({ streamIds });
				if (streamIds.length > 0) {
					getSwBridge().heartbeat(streamIds);
				}
			};
		}
	}

	function conversionFinished() {
		_activeConversions = Math.max(0, _activeConversions - 1);
		if (_activeConversions === 0) {
			window.removeEventListener('beforeunload', onBeforeUnload);
			notifyConversionFinished();
			notifyAudioKeepAliveFinished();
			if (_timerWorker) {
				_timerWorker.terminate();
				_timerWorker = undefined;
			}
		}
	}

	/** @param {QueueEntry} entry */
	function revealLogPanel(entry) {
		entry.logEl.removeAttribute('hidden');
		entry.clearBtn.removeAttribute('hidden');
		entry.copyBtn.removeAttribute('hidden');
		entry.clearBtn.disabled = false;
		entry.copyBtn.disabled = false;
		updateScrollBottomVisibility(entry);
	}

	/** @param {QueueEntry} item */
	function resumeConversion(item) {
		if (!item.ctrl) return;
		item.ctrl.resume();
		if (item.source.kind === 'multi-disc') {
			const discIndex = item.discRun?.statuses.indexOf('converting') ?? 0;
			setStatus(
				item,
				'running',
				TEXT.DISC_CONVERTING(
					discIndex + 1,
					item.source.discs.length,
					item.discRun?.current,
				),
			);
		} else {
			setStatus(item, 'running', TEXT.CONVERTING(item.progress));
		}
		updateProgressDisplay();
	}

	/** @param {QueueEntry} entry */
	async function startConversion(entry) {
		if (!isEditable(entry)) return;

		await _acquireConversionSlot(entry);

		// May have been removed/cancelled while waiting for a slot.
		if (!queue.includes(entry) || entry.status === 'cancelled') {
			_releaseConversionSlot();
			return;
		}

		if (entry.ctrl) {
			entry.ctrl.terminate();
		}

		if (entry.source.kind === 'multi-disc') {
			return startMultiDiscConversion(entry);
		}

		if (entry.source.kind === 'unresolved') {
			// Unreachable (isEditable() already returned above); narrows the type.
			return;
		}

		revealLogPanel(entry);

		const gameTitle = resolveGameTitle(
			entry.titleEl.value,
			baseNameForFiles(entry.source),
		);
		const gameFileName = displayFileName(entry.source);
		const { format } = entry.options;
		const formatOptions = entry.options[format];

		const filename = outputFilenameFor(gameTitle, format, formatOptions);

		const swBridge = getSwBridge();
		const ctrl = new WorkerController(swBridge, filename, {
			acquireDownloadSlot: () => acquireDownloadSlot(entry),
			releaseDownloadSlot,
			dequeueDownloadSlot: () => dequeueDownloadSlot(entry),
		});
		entry.ctrl = ctrl;

		const log = createLogger(gameTitle, { logEl: entry.logEl, level: 'info' });
		conversionStarted();

		/** @param {Event} e */
		const onSwCancelled = (e) => {
			const ce = /** @type {CustomEvent<string>} */ (e);
			if (ctrl.streamIds.includes(ce.detail)) {
				swBridge.removeEventListener(MSG.CANCELLED, onSwCancelled);
				if (isActiveStatus(entry.status)) {
					ctrl.terminate();
				}
			}
		};
		swBridge.addEventListener(MSG.CANCELLED, onSwCancelled);

		wireLog(ctrl, log);
		ctrl.addEventListener(EVENTS.PROGRESS, (e) => {
			entry.progress = /** @type {CustomEvent<number>} */ (e).detail;
			if (entry.status !== 'running') return;
			setStatus(entry, 'running', TEXT.CONVERTING(entry.progress));
			updateProgressDisplay();
		});
		ctrl.addEventListener(EVENTS.DONE, () => {
			entry.progress = undefined;
			swBridge.removeEventListener(MSG.CANCELLED, onSwCancelled);
			if (entry.ctrl) entry.ctrl.cleanup();
			log.info('Done');
			finishConversion(entry, 'done', TEXT.DONE, 'success', gameFileName);
		});
		ctrl.addEventListener(EVENTS.ERROR, (e) => {
			entry.progress = undefined;
			swBridge.removeEventListener(MSG.CANCELLED, onSwCancelled);
			log.error(/** @type {CustomEvent<string>} */ (e).detail);
			finishConversion(entry, 'error', TEXT.ERROR, 'error', gameFileName);
		});
		ctrl.addEventListener(EVENTS.CANCELLED, () => {
			entry.progress = undefined;
			swBridge.removeEventListener(MSG.CANCELLED, onSwCancelled);
			log.info('Cancelled');
			finishConversion(
				entry,
				'cancelled',
				TEXT.CANCELLED,
				'cancelled',
				gameFileName,
			);
		});
		ctrl.addEventListener(EVENTS.PAUSED, () =>
			handlePaused(entry, TEXT.PAUSED()),
		);

		setStatus(entry, 'running', TEXT.CONVERTING());
		updateProgressDisplay();

		ctrl.start({
			source: entry.source,
			gameTitle,
			format,
			options: formatOptions,
			generateAttachXbe: entry.generateAttachXbe && !!entry.sourceIsOgx,
			godSigningKey: resolveGodSigningKey(entry),
		});
	}

	/**
	 * Converts each disc in sequence; stops on first error or cancellation.
	 * @param {QueueEntry} entry
	 */
	async function startMultiDiscConversion(entry) {
		if (entry.source.kind !== 'multi-disc') return;
		const { discs, titleId } = entry.source;
		revealLogPanel(entry);
		const discRun = /** @type {DiscRunProgress} */ ({
			statuses: discs.map(() => 'queued'),
		});
		entry.discRun = discRun;
		// Weights entry.progress by each disc's actual byte share.
		const discSizes = discs.map((d) =>
			d.files.reduce((sum, f) => sum + f.size, 0),
		);
		const totalSize = discSizes.reduce((sum, s) => sum + s, 0) || 1;
		let bytesDoneBeforeCurrentDisc = 0;
		conversionStarted();
		setStatus(entry, 'running', TEXT.DISC_CONVERTING(1, discs.length));
		updateProgressDisplay();
		for (let i = 0; i < discs.length; i++) {
			if (!queue.includes(entry)) break; // Removed mid-chain.
			if (entry.status === 'cancelled') break;
			discRun.statuses[i] = 'converting';
			discRun.current = 0;
			setStatus(entry, 'running', TEXT.DISC_CONVERTING(i + 1, discs.length, 0));
			try {
				await convertOneDisc(
					entry,
					discs[i],
					i,
					titleId,
					discs.length,
					bytesDoneBeforeCurrentDisc,
					totalSize,
				);
				discRun.statuses[i] = 'done';
				bytesDoneBeforeCurrentDisc += discSizes[i];
			} catch (err) {
				if (err instanceof DiscCancelledError) {
					discRun.statuses[i] = 'cancelled';
					finishConversion(
						entry,
						'cancelled',
						TEXT.DISC_CANCELLED(i + 1),
						'cancelled',
						`${displayFileName(discs[i])} (disc ${i + 1})`,
					);
					return;
				}
				discRun.statuses[i] = 'error';
				finishConversion(
					entry,
					'error',
					TEXT.DISC_ERROR(i + 1),
					'error',
					`${displayFileName(discs[i])} (disc ${i + 1})`,
				);
				return;
			}
		}
		if (entry.status !== 'cancelled') {
			entry.progress = undefined;
			finishConversion(
				entry,
				'done',
				TEXT.DONE,
				'success',
				displayFileName(entry.source),
			);
		} else {
			conversionFinished();
			_releaseConversionSlot();
			updateProgressDisplay();
		}
	}

	/**
	 * Signing is rejected server-side for OGX sources.
	 * @param {QueueEntry} entry
	 * @returns {Uint8Array | undefined}
	 */
	function resolveGodSigningKey(entry) {
		if (entry.options.format !== 'god') return undefined;
		if (!entry.options.god.sign) return undefined;
		if (entry.sourceIsOgx) return undefined;
		return entry.godSigningKey;
	}

	/**
	 * Resolves on DONE; rejects with DiscCancelledError on CANCELLED,
	 * or a plain Error on ERROR.
	 * @param {QueueEntry} entry
	 * @param {SingleDroppedSource} disc
	 * @param {number} index
	 * @param {string} titleId
	 * @param {number} discCount
	 * @param {number} bytesDoneBeforeThisDisc
	 * @param {number} totalSize
	 * @returns {Promise<void>}
	 */
	function convertOneDisc(
		entry,
		disc,
		index,
		titleId,
		discCount,
		bytesDoneBeforeThisDisc,
		totalSize,
	) {
		return new Promise((resolve, reject) => {
			const gameTitle = TEXT.DISC_LOG_TITLE(
				resolveGameTitle(entry.titleEl.value, titleId),
				index + 1,
			);
			const { format } = entry.options;
			const formatOptions = entry.options[format];
			const thisDiscSize = disc.files.reduce((sum, f) => sum + f.size, 0);
			const filename = outputFilenameFor(gameTitle, format, formatOptions);
			const swBridge = getSwBridge();
			const ctrl = new WorkerController(swBridge, filename, {
				acquireDownloadSlot: () => acquireDownloadSlot(entry),
				releaseDownloadSlot,
				dequeueDownloadSlot: () => dequeueDownloadSlot(entry),
			});
			entry.ctrl = ctrl;
			const discLog = createLogger(gameTitle, {
				logEl: entry.logEl,
				level: 'info',
			});
			const discRun = /** @type {DiscRunProgress} */ (entry.discRun);

			// Without this, an SW abort with no chunk in flight can't reach
			// this disc's controller.
			/** @param {Event} e */
			const onSwCancelled = (e) => {
				const ce = /** @type {CustomEvent<string>} */ (e);
				if (ctrl.streamIds.includes(ce.detail)) {
					swBridge.removeEventListener(MSG.CANCELLED, onSwCancelled);
					if (isActiveStatus(entry.status)) {
						ctrl.terminate();
					}
				}
			};
			swBridge.addEventListener(MSG.CANCELLED, onSwCancelled);

			wireLog(ctrl, discLog);
			ctrl.addEventListener(EVENTS.PROGRESS, (e) => {
				discRun.current = /** @type {CustomEvent<number>} */ (e).detail;
				entry.progress = computeMultiDiscProgress(
					bytesDoneBeforeThisDisc,
					thisDiscSize,
					discRun.current,
					totalSize,
				);
				if (entry.status === 'running') {
					setStatus(
						entry,
						'running',
						TEXT.DISC_CONVERTING(index + 1, discCount, discRun.current),
					);
				}
				updateProgressDisplay();
			});
			ctrl.addEventListener(EVENTS.DONE, () => {
				swBridge.removeEventListener(MSG.CANCELLED, onSwCancelled);
				ctrl.cleanup();
				resolve();
			});
			ctrl.addEventListener(EVENTS.ERROR, (e) => {
				swBridge.removeEventListener(MSG.CANCELLED, onSwCancelled);
				discLog.error(/** @type {CustomEvent<string>} */ (e).detail);
				reject(new Error(/** @type {CustomEvent<string>} */ (e).detail));
			});
			ctrl.addEventListener(EVENTS.CANCELLED, () => {
				swBridge.removeEventListener(MSG.CANCELLED, onSwCancelled);
				reject(new DiscCancelledError());
			});
			ctrl.addEventListener(EVENTS.PAUSED, () =>
				handlePaused(
					entry,
					TEXT.DISC_PAUSED(index + 1, discCount, discRun.current),
				),
			);
			ctrl.start({
				source: disc,
				gameTitle,
				format,
				options: formatOptions,
				generateAttachXbe: entry.generateAttachXbe && !!entry.sourceIsOgx,
				godSigningKey: resolveGodSigningKey(entry),
			});
		});
	}

	return {
		startConversion,
		resumeConversion,
		dequeueFromSlotQueue,
		updateConcurrencySettings,
	};
}
