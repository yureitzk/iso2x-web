import { queryElement } from '../../lib/helpers.js';
import { isScrolledToBottom } from '../../lib/logger.js';
import { queue } from '../../core/queue.js';

/**
 * @import { QueueEntry } from '../../../types/global'
 */

/**
 * Selector/type table for every named element in #queue-item-template.
 * Keys match the QueueEntry property names they're assigned to, except
 * the four mode selects, which bindQueueItemElements nests separately.
 * @satisfies {Record<string, [string, new (...a: any[]) => Element]>}
 */
const QUEUE_ITEM_ELEMENTS = {
	section: ['.queue-item', HTMLElement],
	selectCheckboxEl: ['.queue-item__select-checkbox', HTMLInputElement],
	titleHeaderEl: ['.queue-item__title', HTMLElement],
	titleEl: ['.queue-item__game-title', HTMLInputElement],
	metaEl: ['.source-meta', HTMLElement],
	iconEl: ['.queue-item__icon', HTMLImageElement],
	iconSpinnerEl: ['.queue-item__icon-spinner', SVGElement],
	iconFallbackEl: ['.queue-item__icon-fallback', SVGElement],
	optionsEl: ['.queue-item__options', HTMLElement],
	titleIdEl: ['.source-meta__title-id', HTMLElement],
	contentTypeEl: ['.source-meta__content-type', HTMLElement],
	fileSizeEl: ['.source-meta__size', HTMLElement],
	errorEl: ['.queue-item__error', HTMLElement],
	statusEl: ['.queue-item__status', HTMLElement],
	convertBtn: ['.queue-item__convert-btn', HTMLButtonElement],
	removeBtn: ['.queue-item__remove-btn', HTMLButtonElement],
	pauseBtn: ['.queue-item__pause-btn', HTMLButtonElement],
	cancelBtn: ['.queue-item__cancel-btn', HTMLButtonElement],
	moveUpBtn: ['.queue-item__move-up-btn', HTMLButtonElement],
	moveDownBtn: ['.queue-item__move-down-btn', HTMLButtonElement],
	partsEl: ['.queue-item__parts', HTMLElement],
	partsCountEl: ['.queue-item__parts-count', HTMLElement],
	partsListEl: ['.queue-item__parts-list', HTMLElement],
	verifyOrderBtn: ['.queue-item__verify-order-btn', HTMLButtonElement],
	logEl: ['.log-stream', HTMLPreElement],
	scrollBottomBtn: ['.log-stream__scroll-bottom-btn', HTMLButtonElement],
	formatSelectEl: ['.queue-item__format-select', HTMLSelectElement],
	clearBtn: ['.queue-item__clear-btn', HTMLButtonElement],
	copyBtn: ['.queue-item__copy-btn', HTMLButtonElement],
	// Nested into `.modeSelects` below, keyed by ModeTargetFormat.
	godModeSelectEl: ['.queue-item__god-mode', HTMLSelectElement],
	xisoModeSelectEl: ['.queue-item__xiso-mode', HTMLSelectElement],
	cisoModeSelectEl: ['.queue-item__ciso-mode', HTMLSelectElement],
	cciModeSelectEl: ['.queue-item__cci-mode', HTMLSelectElement],
	xisoSplitCheckBoxEl: ['.queue-item__split-xiso', HTMLInputElement],
	skipSystemUpdateCheckBoxEl: [
		'.queue-item__skip-system-update',
		HTMLInputElement,
	],
	allowedMediaPatchCheckBoxEl: [
		'.queue-item__allowed-media-patch',
		HTMLInputElement,
	],
	renameTitleCheckBoxEl: ['.queue-item__rename-title', HTMLInputElement],
	attachXbeCheckBoxEl: ['.queue-item__attach-xbe', HTMLInputElement],
	godKeyvaultInputEl: ['.queue-item__god-keyvault', HTMLInputElement],
	godSignCheckBoxEl: ['.queue-item__god-sign', HTMLInputElement],
	godDeviceIdInputEl: ['.queue-item__god-device-id', HTMLInputElement],
	godDeviceIdErrorEl: ['.queue-item__god-device-id-error', HTMLElement],
	godDeviceIdClearBtn: [
		'.queue-item__god-device-id-clear-btn',
		HTMLButtonElement,
	],
};

/**
 * Selector/type table for one `.queue-item__part-row` clone
 * (#queue-item-part-row-template), resolved once per row.
 * @satisfies {Record<string, [string, new (...a: any[]) => Element]>}
 */
const PART_ROW_ELEMENTS = {
	row: ['.queue-item__part-row', HTMLElement],
	dragEl: ['.queue-item__part-row-drag', HTMLElement],
	upBtn: ['.queue-item__part-row-up-btn', HTMLButtonElement],
	downBtn: ['.queue-item__part-row-down-btn', HTMLButtonElement],
	nameEl: ['.queue-item__part-row-name', HTMLElement],
	sizeEl: ['.queue-item__part-row-size', HTMLElement],
	statusEl: ['.queue-item__part-row-status', HTMLElement],
	removeBtn: ['.queue-item__part-row-remove-btn', HTMLButtonElement],
};

/**
 * @template {Record<string, [string, new (...a: any[]) => Element]>} M
 * @param {DocumentFragment} fragment
 * @param {M} map
 * @returns {{ [K in keyof M]: InstanceType<M[K][1]> }}
 */
function bind(fragment, map) {
	return /** @type {any} */ (
		Object.fromEntries(
			Object.entries(map).map(([key, [selector, Type]]) => [
				key,
				queryElement(fragment, selector, Type),
			]),
		)
	);
}

/** @param {DocumentFragment} fragment */
export function bindQueueItemElements(fragment) {
	const els = bind(fragment, QUEUE_ITEM_ELEMENTS);
	const {
		godModeSelectEl,
		xisoModeSelectEl,
		cisoModeSelectEl,
		cciModeSelectEl,
		...rest
	} = els;
	return {
		...rest,
		modeSelects: {
			god: godModeSelectEl,
			xiso: xisoModeSelectEl,
			ciso: cisoModeSelectEl,
			cci: cciModeSelectEl,
		},
	};
}

/** @param {DocumentFragment} fragment */
export function bindPartRowElements(fragment) {
	return bind(fragment, PART_ROW_ELEMENTS);
}

/**
 * The set of entries a move operates over: everything not hidden by the
 * active status filter. When no filter is applied every entry's `.section`
 * is visible, so this is equivalent to the full `queue`.
 * @returns {QueueEntry[]}
 */
function visibleQueue() {
	return queue.filter((item) => !item.section.hidden);
}

/**
 * Moves an entry one spot earlier/later relative to the currently visible
 * (filtered) list, both in `queue` (which drives conversion slot order)
 * and in the DOM. "Adjacent" means nearest visible neighbor, not nearest
 * array entry, so a move button stays meaningful even when the active
 * filter hides some entries in between.
 * @param {QueueEntry} item
 * @param {'up' | 'down'} direction
 */
export function moveBlock(item, direction) {
	const visible = visibleQueue();
	const vIndex = visible.indexOf(item);
	if (vIndex === -1) return;
	const neighbor = visible[direction === 'up' ? vIndex - 1 : vIndex + 1];
	if (!neighbor) return;

	const from = queue.indexOf(item);
	let to = queue.indexOf(neighbor);
	if (from === -1 || to === -1) return;

	const logScrollTop = item.logEl.scrollTop;

	queue.splice(from, 1);

	if (to > from) to -= 1;

	if (direction === 'down') to += 1;

	queue.splice(to, 0, item);

	if (direction === 'up') {
		neighbor.section.before(item.section);
	} else {
		neighbor.section.after(item.section);
	}

	item.logEl.scrollTop = logScrollTop;

	refreshMoveButtons();
}

/**
 * Sets disabled state on every entry's move buttons based on position
 * within the currently visible (filtered) list, not the raw `queue`
 * array. An entry hidden by the active filter, or one that's first/last
 * among visible entries, gets both/the relevant button disabled - so a
 * filter that leaves only one item on screen disables both buttons for
 * it, even though its real index in `queue` may be neither first nor
 * last.
 */
export function refreshMoveButtons() {
	const visible = visibleQueue();
	const positionOf = new Map(visible.map((item, i) => [item, i]));
	const lastIndex = visible.length - 1;
	queue.forEach((item) => {
		const index = positionOf.get(item);
		const isVisible = index !== undefined;
		item.moveUpBtn.disabled = !isVisible || index === 0;
		item.moveDownBtn.disabled = !isVisible || index === lastIndex;
	});
}

/** Pending rAF-batched scroll-visibility checks, keyed by item. */
const _scrollCheckScheduled = new WeakMap();

/** @param {QueueEntry} item */
export function updateScrollBottomVisibility(item) {
	const { logEl, scrollBottomBtn } = item;
	if (logEl.hidden) {
		scrollBottomBtn.hidden = true;
		return;
	}
	// 8px tolerance so sub-pixel rounding doesn't flag false overflow.
	const hasOverflow = logEl.scrollHeight - logEl.clientHeight > 8;
	scrollBottomBtn.hidden = !hasOverflow || isScrolledToBottom(logEl);
}

/**
 * Same as updateScrollBottomVisibility, but collapses multiple calls within
 * the same frame into a single layout read/write.
 * @param {QueueEntry} item
 */
export function scheduleScrollCheck(item) {
	if (_scrollCheckScheduled.get(item)) return;
	_scrollCheckScheduled.set(item, true);
	requestAnimationFrame(() => {
		_scrollCheckScheduled.set(item, false);
		updateScrollBottomVisibility(item);
	});
}
