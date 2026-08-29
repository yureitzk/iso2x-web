import { EVENTS } from '../../core/protocol.js';
import { TEXT } from '../../constants/messages.js';
import {
	copyToClipboard,
	generateUUID,
	initClearableInput,
	parseDeviceId,
	relativeDirEntries,
	setFileInputFromBytes,
	stripWhitespace,
	supportsFolderInput,
} from '../../lib/helpers.js';
import { createLogger } from '../../lib/logger.js';
import { settings } from '../../lib/settings.js';
import { ephemeralSettings } from '../../lib/ephemeralSettings.js';
import {
	bindQueueItemElements,
	moveBlock,
	refreshMoveButtons,
	updateScrollBottomVisibility,
	scheduleScrollCheck,
} from './queueItemDom.js';
import { WorkerController } from '../../workers/WorkerController.js';
import { inspectWorkerPool } from '../../workers/WorkerPool.js';
import { queue, cloneConversionOptions } from '../../queue/queue.js';
import {
	updateOptionsVisibility,
	applyXbePatchConstraints,
	applyAttachXbeConstraint,
	applyGodSigningConstraints,
	isGodDeviceIdValid,
} from './queueItemOptions.js';

/**
 * @import { SwBridge } from '../../serviceWorker/SwBridge.js'
 * @import {
 *   QueueEntry,
 *   ConversionStatus,
 *   DroppedSource,
 *   SingleDroppedSource,
 *   OutputFormat,
 *   ScrubMode,
 *   XisoMode,
 *   ModeTargetFormat,
 *   QueueCommand,
 *   SourceOutcome,
 * } from '../../../types/global'
 */

const log = createLogger('queue');

/**
 * Parameterized on get/set rather than a fixed options path, since one
 * of the checkboxes this backs mirrors into item.generateAttachXbe
 * instead of a ConversionOptions field.
 * @param {HTMLInputElement} el
 * @param {() => boolean} get
 * @param {(checked: boolean) => void} set
 */
function bindCheckbox(el, get, set) {
	el.checked = get();
	el.addEventListener('change', () => set(el.checked));
}

/**
 * `sourceParts` and `queueCommands` are injected rather than imported,
 * so this stays a leaf module with no import cycle back onto the
 * module that owns the UI.
 * @param {{
 *   getSwBridge: () => SwBridge,
 *   sourceParts: { renderSourceParts: (item: QueueEntry) => void, runInspect: (item: QueueEntry, source: SingleDroppedSource) => WorkerController },
 *   queueCommands: { convert: QueueCommand, pause: QueueCommand, cancel: QueueCommand, remove: QueueCommand },
 *   setStatus: (item: QueueEntry, status: ConversionStatus, label?: string) => void,
 *   resolveSource: (item: QueueEntry, outcome: SourceOutcome) => void,
 *   updateBulkActionsUi: () => void,
 * }} deps
 */
export function createFileInputController({
	getSwBridge,
	sourceParts,
	queueCommands,
	resolveSource,
	setStatus,
	updateBulkActionsUi,
}) {
	/**
	 * @param {DroppedSource} source
	 * @returns {QueueEntry | undefined}
	 */
	function addToQueue(source) {
		const queueEl = document.getElementById('queue');
		const queueTemplate = document.getElementById('queue-item-template');

		if (
			!(queueEl instanceof HTMLElement) ||
			!(queueTemplate instanceof HTMLTemplateElement)
		)
			return;

		const id = generateUUID();
		const fragment = /** @type {DocumentFragment} */ (
			queueTemplate.content.cloneNode(true)
		);

		try {
			const dom = bindQueueItemElements(fragment);

			// Stamped before the node enters the document, so e2e tests
			// polling for new items never see one without it.
			dom.section.dataset.itemId = id;

			queueEl.appendChild(fragment);

			const files =
				source.kind === 'multi-disc'
					? source.discs.flatMap((d) => d.files)
					: source.files;

			/** @type {QueueEntry} */
			const item = {
				...dom,
				status: 'inspecting',
				id,
				files,
				lockedFiles: new Set(files),
				source,
				options: cloneConversionOptions(settings.get('defaultConversionOptions')),
				ctrl: null,
				pausing: false,
				sourceFormat: undefined,
				detectedTitle: undefined,
				sourceIsOgx: undefined,
				generateAttachXbe: false,
				awaitingSlot: false,
				godSigningKey: ephemeralSettings.get('godSigningKey'),
			};

			const {
				selectCheckboxEl,
				modeSelects,
				xisoSplitCheckBoxEl,
				skipSystemUpdateCheckBoxEl,
				allowedMediaPatchCheckBoxEl,
				renameTitleCheckBoxEl,
				attachXbeCheckBoxEl,
				godKeyvaultInputEl,
				godSignCheckBoxEl,
				godDeviceIdInputEl,
				godDeviceIdErrorEl,
				godDeviceIdClearBtn,
				formatSelectEl,
				convertBtn,
				removeBtn,
				cancelBtn,
				pauseBtn,
				moveUpBtn,
				moveDownBtn,
				clearBtn,
				copyBtn,
				scrollBottomBtn,
				logEl,
			} = dom;

			selectCheckboxEl.addEventListener('change', () => updateBulkActionsUi());

			for (const format of /** @type {ModeTargetFormat[]} */ ([
				'god',
				'xiso',
				'ciso',
				'cci',
			])) {
				const select = modeSelects[format];
				if (item.options[format].mode) select.value = item.options[format].mode;
				select.addEventListener('change', () => {
					item.options[format].mode = /** @type {ScrubMode | XisoMode} */ (
						select.value
					);
				});
			}

			bindCheckbox(
				xisoSplitCheckBoxEl,
				() => item.options.xiso.split ?? false,
				(v) => {
					item.options.xiso.split = v;
				},
			);
			bindCheckbox(
				skipSystemUpdateCheckBoxEl,
				() => item.options.extracted.skipSystemUpdate ?? false,
				(v) => {
					item.options.extracted.skipSystemUpdate = v;
				},
			);
			bindCheckbox(
				allowedMediaPatchCheckBoxEl,
				() => item.options.extracted.allowedMediaPatch ?? false,
				(v) => {
					item.options.extracted.allowedMediaPatch = v;
				},
			);
			bindCheckbox(
				renameTitleCheckBoxEl,
				() => item.options.extracted.renameTitle ?? false,
				(v) => {
					item.options.extracted.renameTitle = v;
				},
			);

			item.generateAttachXbe = item.options.generateAttachXbe ?? false;
			bindCheckbox(
				attachXbeCheckBoxEl,
				() => item.generateAttachXbe,
				(v) => {
					item.generateAttachXbe = v;
				},
			);

			bindCheckbox(
				godSignCheckBoxEl,
				() => item.options.god.sign ?? false,
				(v) => {
					item.options.god.sign = v;
				},
			);
			godKeyvaultInputEl.addEventListener('change', async () => {
				const file = godKeyvaultInputEl.files?.[0];
				item.godSigningKey = file
					? new Uint8Array(await file.arrayBuffer())
					: undefined;
				applyGodSigningConstraints(item);
			});

			godDeviceIdInputEl.value = item.options.god.deviceId ?? '';
			// Single source of truth for the Convert-button gate: called from
			// every path that can change the field's validity (live typing,
			// blur, and the clear button), so none of them can leave
			// convertBtn.disabled stale relative to the field's actual state.
			const syncGodDeviceIdConvertGate = () => {
				convertBtn.disabled =
					item.options.format === 'god' && !isGodDeviceIdValid(item);
			};
			// Commits into item.options.god.deviceId - what startConversion()
			// actually reads - on every keystroke, not just blur. Convert can
			// be triggered without this field ever losing focus (e.g. a bulk
			// "Convert all"), so a blur-only handler could start with a stale
			// device ID even while the gate above shows it as valid.
			const persistDeviceId = () => {
				try {
					parseDeviceId(godDeviceIdInputEl.value);
				} catch (err) {
					godDeviceIdInputEl.classList.add('is-invalid');
					godDeviceIdErrorEl.textContent =
						err instanceof Error ? err.message : String(err);
					godDeviceIdErrorEl.hidden = false;
					syncGodDeviceIdConvertGate();
					return;
				}
				godDeviceIdInputEl.classList.remove('is-invalid');
				godDeviceIdErrorEl.hidden = true;
				item.options.god.deviceId = stripWhitespace(godDeviceIdInputEl.value);
				syncGodDeviceIdConvertGate();
			};
			// Blur just normalizes what's displayed.
			const formatDeviceIdOnBlur = () => {
				persistDeviceId();
				godDeviceIdInputEl.value = stripWhitespace(godDeviceIdInputEl.value);
			};
			godDeviceIdInputEl.addEventListener('blur', formatDeviceIdOnBlur);
			godDeviceIdInputEl.addEventListener('input', persistDeviceId);
			initClearableInput(
				godDeviceIdInputEl,
				godDeviceIdClearBtn,
				formatDeviceIdOnBlur,
			);

			if (item.godSigningKey) {
				setFileInputFromBytes(
					godKeyvaultInputEl,
					item.godSigningKey,
					ephemeralSettings.get('godSigningKeyName') ?? 'default-keyvault.bin',
					'application/octet-stream',
				);
			}

			formatSelectEl.value = item.options.format;
			formatSelectEl.addEventListener('change', () => {
				item.options.format = /** @type {OutputFormat} */ (formatSelectEl.value);
				updateOptionsVisibility(item.optionsEl, item.options.format);
				applyAttachXbeConstraint(item);
				syncGodDeviceIdConvertGate();
			});

			queue.push(item);
			sourceParts.renderSourceParts(item);
			refreshMoveButtons();
			updateOptionsVisibility(item.optionsEl, item.options.format);
			applyXbePatchConstraints(item);
			applyAttachXbeConstraint(item);
			applyGodSigningConstraints(item);
			setStatus(item, 'inspecting', TEXT.INSPECTING);

			/** @type {WorkerController | null} */
			let inspectCtrl = null;

			if (source.kind === 'unresolved') {
				resolveSource(item, { kind: 'unresolved', source });
			} else {
				const inspectSource =
					source.kind === 'multi-disc' ? source.discs[0] : source;
				if (inspectSource.kind === 'files' && inspectSource.invalidReason) {
					resolveSource(item, {
						kind: 'error',
						message: inspectSource.invalidReason,
					});
				} else {
					// Held onto so removeBtn's handler can cancel an inspection
					// still in flight if the entry is removed early.
					inspectCtrl = sourceParts.runInspect(item, inspectSource);
				}
			}

			convertBtn.addEventListener('click', () => queueCommands.convert.run(item));
			removeBtn.addEventListener('click', () => {
				if (!queueCommands.remove.canRun(item)) return;
				inspectCtrl?.terminate();
				queueCommands.remove.run(item);
			});
			cancelBtn.addEventListener('click', () => queueCommands.cancel.run(item));
			pauseBtn.addEventListener('click', () => queueCommands.pause.run(item));
			moveUpBtn.addEventListener('click', () => moveBlock(item, 'up'));
			moveDownBtn.addEventListener('click', () => moveBlock(item, 'down'));

			clearBtn.addEventListener('click', () => {
				logEl.textContent = '';
			});
			scrollBottomBtn.addEventListener('click', () => {
				logEl.scrollTop = logEl.scrollHeight;
				updateScrollBottomVisibility(item);
			});
			logEl.addEventListener('scroll', () => scheduleScrollCheck(item));

			// New log lines change scrollHeight without firing 'scroll'
			// when the user is scrolled away from the bottom.
			const logObserver = new MutationObserver(() => scheduleScrollCheck(item));
			logObserver.observe(logEl, { childList: true });

			// .log-stream is resize-y - dragging it changes clientHeight
			// without a scroll or mutation event either.
			const logResizeObserver = new ResizeObserver(() =>
				scheduleScrollCheck(item),
			);
			logResizeObserver.observe(logEl);

			copyBtn.addEventListener('click', async () => {
				if (!logEl.textContent?.trim()) return;
				const ok = await copyToClipboard(logEl.textContent ?? '');
				copyBtn.textContent = ok ? TEXT.COPY_SUCCESS : TEXT.COPY_FAIL;
				copyBtn.setAttribute(
					'aria-label',
					ok ? TEXT.COPY_SUCCESS_LABEL : TEXT.COPY_FAIL_LABEL,
				);
				setTimeout(() => {
					copyBtn.textContent = TEXT.COPY;
					copyBtn.setAttribute('aria-label', TEXT.COPY_LABEL);
				}, 2000);
			});

			updateBulkActionsUi();
			return item;
		} catch (e) {
			log.error('Queue item template is missing required elements', e);
		}
	}

	/**
	 * A 'multi-disc' source still becomes exactly one `.queue-item`:
	 * addToQueue()'s inspect step inspects the first disc only, and the
	 * conversion controller chains the rest sequentially.
	 * @param {DroppedSource} source
	 * @returns {string | undefined} the new entry's id
	 */
	function addSourceToQueue(source) {
		return addToQueue(source)?.id;
	}

	function initFileInput() {
		const input = document.getElementById('source-input');
		const addBtn = document.getElementById('add-btn');

		if (
			!(input instanceof HTMLInputElement) ||
			!(addBtn instanceof HTMLButtonElement)
		)
			return;

		input.addEventListener('change', () => {
			addBtn.disabled = !input.files?.length;
		});

		addBtn.addEventListener('click', () => {
			if (!input.files?.length) return;
			const files = Array.from(input.files);

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
			partitionCtrl.partitionDir(
				'',
				files.map((f) => f.name),
				files,
			);

			input.value = '';
			addBtn.disabled = true;
		});
	}

	function initFolderInput() {
		const input = document.getElementById('folder-input');
		const addBtn = document.getElementById('add-folder-btn');
		if (
			!(input instanceof HTMLInputElement) ||
			!(addBtn instanceof HTMLButtonElement)
		)
			return;

		if (!supportsFolderInput()) {
			input.disabled = true;
			addBtn.disabled = true;
			return;
		}

		input.addEventListener('change', () => {
			addBtn.disabled = !input.files?.length;
		});
		addBtn.addEventListener('click', () => {
			if (!input.files?.length) return;
			const { dirName, entries, files } = relativeDirEntries(input.files);

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
			partitionCtrl.addEventListener(EVENTS.PARTITION_RESULT, (e) => {
				const { count } = /** @type {CustomEvent<{ count: number }>} */ (e).detail;
				if (count === 0) {
					log.warn(
						`no god/extracted game folders or .iso/.cso/.cci files found under "${dirName}"`,
					);
				}
				partitionCtrl.release();
				window.dispatchEvent(
					new CustomEvent(EVENTS.QUEUE_ITEMS_ADDED, { detail: { ids: addedIds } }),
				);
			});
			partitionCtrl.partitionDir(dirName, entries, files);

			input.value = '';
			addBtn.disabled = true;
		});
	}

	return { initFileInput, initFolderInput, addSourceToQueue };
}
