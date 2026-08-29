/** @import { ConversionStatus, QueueEntry } from '../../../types/global' */

import { EVENTS } from '../../core/protocol';

/** 'total' covers every entry rather than one status, so it's carried as StatKey and narrowed to TrackedStatus only where a real status is required. */
const STAT_KEYS = /** @type {const} */ ([
	'total',
	'running',
	'done',
	'paused',
	'error',
	'cancelled',
]);
/** @typedef {(typeof STAT_KEYS)[number]} StatKey */
/** @typedef {Exclude<StatKey, 'total'>} TrackedStatus */

/** @type {TrackedStatus[]} */
const TRACKED_STATUSES = /** @type {TrackedStatus[]} */ (
	STAT_KEYS.filter((k) => k !== 'total')
);

/**
 * @template {Element} T
 * @param {string} prefix
 * @returns {Record<StatKey, T>}
 */
function lookupById(prefix) {
	return /** @type {any} */ (
		Object.fromEntries(
			STAT_KEYS.map((key) => [key, document.getElementById(`${prefix}-${key}`)]),
		)
	);
}

const elements = /** @type {Record<StatKey, HTMLButtonElement>} */ (
	lookupById('filter')
);
const statElements = /** @type {Record<StatKey, HTMLElement>} */ (
	lookupById('stat')
);

/** @type {Set<ConversionStatus>} */
const activeFilters = new Set();

function dispatchFilterChange() {
	window.dispatchEvent(
		new CustomEvent(EVENTS.FILTER_CHANGED, { detail: new Set(activeFilters) }),
	);
}

function initFilters() {
	elements.total.addEventListener('click', () => {
		activeFilters.clear();
		Object.values(elements).forEach((btn) =>
			btn.setAttribute('aria-pressed', 'false'),
		);
		dispatchFilterChange();
	});

	for (const status of TRACKED_STATUSES) {
		const btn = elements[status];
		btn.addEventListener('click', () => {
			if (activeFilters.has(status)) {
				activeFilters.delete(status);
				btn.setAttribute('aria-pressed', 'false');
			} else {
				activeFilters.add(status);
				btn.setAttribute('aria-pressed', 'true');
			}
			dispatchFilterChange();
		});
	}
}

/** @param {QueueEntry[]} queue */
export function updateStats(queue) {
	/** @type {Record<TrackedStatus, number>} */
	const counts = { running: 0, done: 0, error: 0, cancelled: 0, paused: 0 };
	for (const item of queue) {
		if (item.status in counts)
			counts[/** @type {TrackedStatus} */ (item.status)]++;
	}

	statElements.total.textContent = String(queue.length);
	elements.total.dataset.zero = queue.length === 0 ? 'true' : 'false';

	for (const status of TRACKED_STATUSES) {
		const count = counts[status];
		statElements[status].textContent = String(count);
		elements[status].dataset.zero = count === 0 ? 'true' : 'false';
	}
}

export function initQueueStats() {
	initFilters();
}

export function getActiveFilters() {
	return new Set(activeFilters);
}
