import { TEXT } from '../../constants/messages.js';
import { bindPartRowElements } from './queueItemDom.js';
import { isEditable, statusModifierClass } from '../../queue/queue.js';
import {
	splitSiblingAccept,
	discAdditionAccept,
	isPromotableSource,
	isSplitCapableSource,
} from './sourcePartsAccept.js';

/**
 * @import {
 *   QueueEntry,
 *   ConversionStatus,
 *   DroppedSource,
 *   MultiDiscEntry,
 * } from '../../../types/global'
 */

/**
 * 'converting' isn't listed here - it carries a percent, so
 * renderSourceParts() handles it as its own case.
 * @type {Record<'queued' | 'done' | 'error' | 'cancelled' | 'no-match', { text: string, colorStatus: ConversionStatus }>}
 */
const PART_ROW_STATUS = {
	queued: { text: TEXT.QUEUED, colorStatus: 'idle' },
	done: { text: TEXT.DONE, colorStatus: 'done' },
	error: { text: TEXT.ERROR, colorStatus: 'error' },
	cancelled: { text: TEXT.CANCELLED, colorStatus: 'cancelled' },
	'no-match': { text: TEXT.PART_NO_MATCH, colorStatus: 'unresolved' },
};

/**
 * Leads with the disc's 1-based position since the picked folder is
 * often a GOD title-hash directory one level below what the person
 * selected.
 * @param {MultiDiscEntry} disc
 * @param {number} index - 0-based position within source.discs
 */
function discRowName(disc, index) {
	if (disc.kind === 'dir') {
		const position = `${index + 1}/`;
		return disc.dirName ? `${position} ${disc.dirName}` : position;
	}
	return disc.files.map((f) => f.name).join(' + ');
}

/**
 * @typedef {object} SourcePartsActions
 * @property {(item: QueueEntry, idx: number, direction: 1 | -1) => void} moveDisc
 * @property {(item: QueueEntry, idx: number) => void} removeDisc
 * @property {(item: QueueEntry, input: HTMLInputElement) => void} addDisc
 * @property {(item: QueueEntry, input: HTMLInputElement) => void} promoteToMultiDisc
 * @property {(item: QueueEntry, idx: number, direction: 1 | -1) => void} moveUnresolvedFile
 * @property {(item: QueueEntry, idx: number) => void} removeUnresolvedFile
 * @property {(item: QueueEntry, idx: number) => void} detachSiblingFile
 * @property {(item: QueueEntry, input: HTMLInputElement) => void} attachSibling
 * @property {(item: QueueEntry) => void} verifyOrder
 */

/**
 * @param {{
 *   actions: SourcePartsActions,
 *   displayFileName: (source: DroppedSource) => string,
 * }} deps
 */
export function createSourcePartsRenderer({ actions, displayFileName }) {
	/**
	 * Recomputed on every call, not decided once, since the entry's
	 * source/status can change between renders of the same DOM nodes.
	 * @param {QueueEntry} item
	 */
	function wireAddControl(item) {
		const { source } = item;
		const addWrap = item.partsEl.querySelector('.queue-item__parts-add');
		if (!(addWrap instanceof HTMLElement)) return;
		const addBtn = addWrap.querySelector('.queue-item__parts-add-btn');
		const addInput = addWrap.querySelector('.queue-item__parts-add-input');
		if (
			!(addBtn instanceof HTMLButtonElement) ||
			!(addInput instanceof HTMLInputElement)
		) {
			return;
		}
		if (!addBtn.dataset.wired) {
			addBtn.dataset.wired = 'true';
			addBtn.addEventListener('click', () => addInput.click());
		}
		const isMultiDisc = source.kind === 'multi-disc';
		const isUnresolved = source.kind === 'unresolved';
		const isPromotable =
			!isMultiDisc && !isUnresolved && isPromotableSource(item);
		const discs = source.kind === 'multi-disc' ? source.discs : [];
		const isGod = isMultiDisc
			? discs[0]?.kind === 'dir'
			: isPromotable && source.kind === 'dir';
		const canAddNow = isMultiDisc
			? isEditable(item)
			: isUnresolved
				? item.status === 'unresolved'
				: (isPromotable ||
						(source.kind === 'files' && isSplitCapableSource(item))) &&
					isEditable(item);
		const disallowed = !canAddNow;
		addWrap.hidden = false;
		const offersContainerChoice = isMultiDisc || isPromotable;
		addBtn.textContent = isGod
			? TEXT.ADD_DISC_FOLDER
			: offersContainerChoice
				? TEXT.ADD_DISC_FILE
				: TEXT.ADD_FILE;
		addBtn.disabled = disallowed;
		addInput.disabled = disallowed;
		addInput.accept = isGod
			? ''
			: offersContainerChoice
				? discAdditionAccept(item)
				: splitSiblingAccept(item);
		addInput.toggleAttribute('webkitdirectory', isGod);
		addInput.toggleAttribute('directory', isGod);
		addInput.toggleAttribute('mozdirectory', isGod);
		addInput.multiple = isGod;
		addInput.onchange = () => {
			if (isMultiDisc) actions.addDisc(item, addInput);
			else if (isPromotable) actions.promoteToMultiDisc(item, addInput);
			else actions.attachSibling(item, addInput);
		};
	}

	/** @param {QueueEntry} item */
	function renderSourceParts(item) {
		const { source } = item;
		item.titleHeaderEl.textContent =
			item.detectedTitle || displayFileName(source);
		const isMultiDisc = source.kind === 'multi-disc';
		const isUnresolved = source.kind === 'unresolved';
		const isSingleGodDir = source.kind === 'dir' && item.sourceFormat === 'god';
		const isUnresolvedDir = isUnresolved && !!source.dirName;
		const files = source.kind === 'files' || isUnresolved ? source.files : [];
		const discs = isMultiDisc ? source.discs : [];
		const rowCount = isMultiDisc
			? discs.length
			: isSingleGodDir || isUnresolvedDir
				? 1
				: files.length;
		const isRecoverableSingle =
			!isMultiDisc &&
			!isUnresolved &&
			source.kind === 'files' &&
			item.status === 'error' &&
			isSplitCapableSource(item);
		const isPromotable = isPromotableSource(item);
		if (
			rowCount <= 1 &&
			!isMultiDisc &&
			!isUnresolved &&
			!isRecoverableSingle &&
			!isSingleGodDir &&
			!isPromotable
		) {
			item.partsListEl.innerHTML = '';
			item.partsCountEl.textContent = '0';
			item.partsEl.hidden = true;
			return;
		}
		item.partsListEl.innerHTML = '';
		item.partsCountEl.textContent = String(rowCount);
		const rowTemplate = document.getElementById('queue-item-part-row-template');
		if (!(rowTemplate instanceof HTMLTemplateElement)) return;
		const rows = isMultiDisc
			? discs.map((disc, i) => ({
					name: discRowName(disc, i),
					size: disc.files.reduce((sum, f) => sum + f.size, 0),
					status: item.discRun?.statuses[i] ?? 'queued',
				}))
			: isSingleGodDir
				? [
						{
							name: source.dirName
								? `${source.dirName}/`
								: `${source.files.length} files`,
							size: source.files.reduce((sum, f) => sum + f.size, 0),
							status: undefined,
						},
					]
				: isUnresolvedDir
					? [
							{
								name: `${source.dirName}/`,
								size: source.files.reduce((sum, f) => sum + f.size, 0),
								status: undefined,
							},
						]
					: files.map((f) => ({
							name: f.name,
							size: f.size,
							status:
								isUnresolved &&
								source.lastVerifyResult?.checkedEntries.find((c) => c.path === f.name)
									?.matched === false
									? /** @type {const} */ ('no-match')
									: undefined,
						}));
		rows.forEach((row, idx) => {
			const frag = /** @type {DocumentFragment} */ (
				rowTemplate.content.cloneNode(true)
			);
			const {
				row: li,
				dragEl,
				upBtn,
				downBtn,
				nameEl,
				sizeEl,
				statusEl,
				removeBtn,
			} = bindPartRowElements(frag);
			li.dataset.locked = String(
				!isMultiDisc && !(isUnresolved && !isUnresolvedDir),
			);
			nameEl.textContent = row.name;
			sizeEl.textContent = TEXT.PART_SIZE(row.size);
			if (!row.status) {
				statusEl.textContent = '';
				delete statusEl.dataset.status;
			} else if (row.status === 'converting') {
				statusEl.textContent = TEXT.CONVERTING(item.discRun?.current ?? 0);
				statusEl.classList.add(statusModifierClass('running'));
				statusEl.dataset.status = 'converting';
			} else {
				const { text, colorStatus } = PART_ROW_STATUS[row.status];
				statusEl.textContent = text;
				statusEl.classList.add(statusModifierClass(colorStatus));
				statusEl.dataset.status = row.status;
			}
			if (isMultiDisc) {
				dragEl.hidden = false;
				upBtn.disabled = idx === 0 || !isEditable(item);
				downBtn.disabled = idx === rows.length - 1 || !isEditable(item);
				upBtn.addEventListener('click', () => actions.moveDisc(item, idx, -1));
				downBtn.addEventListener('click', () => actions.moveDisc(item, idx, 1));
				const disc = discs[idx];
				removeBtn.hidden = disc.locked;
				removeBtn.disabled = !isEditable(item);
				removeBtn.addEventListener('click', () => actions.removeDisc(item, idx));
			} else if (isUnresolved && !isUnresolvedDir) {
				dragEl.hidden = false;
				upBtn.disabled = idx === 0 || item.status !== 'unresolved';
				downBtn.disabled = idx === rows.length - 1 || item.status !== 'unresolved';
				upBtn.addEventListener('click', () =>
					actions.moveUnresolvedFile(item, idx, -1),
				);
				downBtn.addEventListener('click', () =>
					actions.moveUnresolvedFile(item, idx, 1),
				);
				removeBtn.hidden = false;
				removeBtn.disabled = item.status !== 'unresolved';
				removeBtn.addEventListener('click', () =>
					actions.removeUnresolvedFile(item, idx),
				);
			} else if (source.kind === 'files' && files.length > 1) {
				// files not in lockedFiles were attached later via attachSibling().
				const isLocked = item.lockedFiles.has(files[idx]);
				removeBtn.hidden = isLocked;
				removeBtn.disabled = !isEditable(item);
				removeBtn.addEventListener('click', () =>
					actions.detachSiblingFile(item, idx),
				);
			}
			item.partsListEl.appendChild(frag);
		});
		// duplicateDiscClaim has no ordering to verify.
		const isVerifiableUnresolved =
			isUnresolved && source.unresolvedKind !== 'duplicateDiscClaim';
		const verifyWrap = item.partsEl.querySelector('.queue-item__parts-verify');
		if (verifyWrap instanceof HTMLElement) {
			verifyWrap.hidden = !isVerifiableUnresolved;
		}
		if (isVerifiableUnresolved && !item.verifyOrderBtn.dataset.wired) {
			item.verifyOrderBtn.dataset.wired = 'true';
			item.verifyOrderBtn.addEventListener('click', () =>
				actions.verifyOrder(item),
			);
		}
		item.verifyOrderBtn.disabled =
			!isVerifiableUnresolved || item.status !== 'unresolved';
		wireAddControl(item);
		item.partsEl.hidden = false;
	}

	return { renderSourceParts };
}
