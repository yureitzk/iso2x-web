/**
 * @import {
 *   QueueEntry,
 *   ConversionOptions,
 *   ConversionStatus,
 *   ScrubMode,
 *   XisoMode,
 *   SourceFormat,
 *   ModeTargetFormat,
 *   StatusPermissions,
 *   ModeConstraint,
 *   SlotQueue,
 * } from '../../types/global'
 */

/** @type {ConversionStatus[]} */
export const STATUSES = [
	'inspecting',
	'idle',
	'running',
	'paused',
	'done',
	'error',
	'cancelled',
	'unresolved',
];

/** @type {QueueEntry[]} */
export const queue = [];

/**
 * Whether a status counts as "active" - currently running or paused,
 * as opposed to not-yet-started or terminal.
 * @param {ConversionStatus} status
 * @returns {boolean}
 */
export function isActiveStatus(status) {
	return status === 'running' || status === 'paused';
}

/**
 * Per-status action permissions for a QueueEntry, plus a synthetic
 * 'awaitingSlot' row for an entry that's 'running' but not yet granted
 * a conversion slot.
 * @type {Record<ConversionStatus | 'awaitingSlot', StatusPermissions>}
 */
export const STATUS_PERMISSIONS = {
	inspecting: { convertible: false, removable: false },
	idle: { convertible: true, removable: true },
	cancelled: { convertible: true, removable: true },
	error: { convertible: true, removable: true },
	// A split/fragment set that never resolved to a valid ordering.
	unresolved: { convertible: false, removable: true },
	done: { convertible: false, removable: true },
	running: {
		convertible: false,
		removable: false,
		pausable: true,
		cancellable: true,
	},
	paused: {
		convertible: false,
		removable: false,
		pausable: true,
		cancellable: true,
	},
	awaitingSlot: { convertible: false, removable: false, cancellable: true },
};

/**
 * @param {QueueEntry} item
 * @returns {ConversionStatus | 'awaitingSlot'}
 */
export function statusKeyFor(item) {
	return item.awaitingSlot ? 'awaitingSlot' : item.status;
}

/** @param {QueueEntry} item */
export function isEditable(item) {
	return STATUS_PERMISSIONS[statusKeyFor(item)].convertible;
}

/** @param {ConversionStatus} status */
export function statusModifierClass(status) {
	return `queue-item__status--${status}`;
}

/** @param {QueueEntry} item */
export function totalFileSize(item) {
	return item.files.reduce((sum, f) => sum + f.size, 0);
}

/**
 * @param {ConversionOptions} opts
 * @returns {ConversionOptions}
 */
export function cloneConversionOptions(opts) {
	return {
		format: opts.format,
		generateAttachXbe: opts.generateAttachXbe,
		god: { ...opts.god },
		xiso: { ...opts.xiso },
		extracted: { ...opts.extracted },
		ciso: { ...opts.ciso },
		cci: { ...opts.cci },
		zar: { ...opts.zar },
	};
}

/**
 * Applies each format's MODE_CONSTRAINTS to `item.sourceFormat`: disables
 * options that aren't allowed, resets the value if it's no longer valid,
 * and disables the select if only one mode remains. Only narrows, so run
 * this after any enable/disable pass, not before.
 * @param {QueueEntry} item
 */
export function applyModeConstraints(item) {
	for (const format of /** @type {ModeTargetFormat[]} */ ([
		'god',
		'xiso',
		'ciso',
		'cci',
	])) {
		const { allowed } = MODE_CONSTRAINTS[format](item.sourceFormat);
		const select = item.modeSelects[format];
		for (const option of Array.from(select.options)) {
			option.disabled = !allowed.includes(
				/** @type {ScrubMode | XisoMode} */ (option.value),
			);
		}
		if (!allowed.includes(/** @type {ScrubMode | XisoMode} */ (select.value))) {
			select.value = allowed[0];
		}
		item.options[format].mode = /** @type {ScrubMode | XisoMode} */ (
			select.value
		);
		if (allowed.length <= 1) select.disabled = true;
	}
}

/**
 * An 'extracted' (XEX) or 'stfs' source only ever allows 'full' - both
 * open as an ExtractedFs with no raw disc image to scrub partially.
 * @type {Record<ModeTargetFormat, (sourceFormat: SourceFormat | undefined) => ModeConstraint>}
 */
export const MODE_CONSTRAINTS = {
	god: (sourceFormat) =>
		sourceFormat === 'extracted' || sourceFormat === 'stfs'
			? { allowed: ['full'] }
			: { allowed: ['none', 'partial', 'full'] },
	xiso: (sourceFormat) =>
		sourceFormat === 'extracted' || sourceFormat === 'stfs'
			? { allowed: ['full'] }
			: { allowed: ['trim', 'zero', 'full'] },
	ciso: (sourceFormat) =>
		sourceFormat === 'extracted' || sourceFormat === 'stfs'
			? { allowed: ['full'] }
			: { allowed: ['none', 'partial', 'full'] },
	cci: (sourceFormat) =>
		sourceFormat === 'extracted' || sourceFormat === 'stfs'
			? { allowed: ['full'] }
			: { allowed: ['none', 'partial', 'full'] },
};

/**
 * Byte-weighted progress for a multi-disc entry mid-conversion.
 * Weights by real byte size rather than discIndex/discCount, since
 * discs are rarely equal in size.
 * @param {number} bytesDoneBeforeCurrentDisc
 * @param {number} currentDiscSize
 * @param {number} currentDiscPercent - 0-100
 * @param {number} totalSize - sum of every disc's byte size in the entry
 * @returns {number} 0-100, rounded
 */
export function computeMultiDiscProgress(
	bytesDoneBeforeCurrentDisc,
	currentDiscSize,
	currentDiscPercent,
	totalSize,
) {
	if (totalSize <= 0) return 0;
	const bytesDone =
		bytesDoneBeforeCurrentDisc + (currentDiscPercent / 100) * currentDiscSize;
	return Math.round((bytesDone / totalSize) * 100);
}

/**
 * @param {QueueEntry[]} queue
 * @returns {number | null}
 */
export function computeOverallProgress(queue) {
	const active = queue.filter((i) => isActiveStatus(i.status));
	if (active.length === 0) return null;
	const totalSize = active.reduce((sum, i) => sum + totalFileSize(i), 0);
	const weighted = active.reduce(
		(sum, i) => sum + (i.progress ?? 0) * totalFileSize(i),
		0,
	);
	return Math.round(weighted / totalSize);
}

/**
 * @param {QueueEntry[]} queue
 * @param {string} id
 * @returns {{ item: QueueEntry, idx: number } | null}
 */
export function findEntry(queue, id) {
	const idx = queue.findIndex((item) => item.id === id);
	if (idx === -1) return null;
	return { item: queue[idx], idx };
}

/**
 * @param {QueueEntry[]} queue
 * @param {string} id
 * @returns {QueueEntry | null}
 */
export function removeEntry(queue, id) {
	const result = findEntry(queue, id);
	if (!result) return null;
	queue.splice(result.idx, 1);
	return result.item;
}

/**
 * @param {QueueEntry[]} queue
 * @returns {string[]}
 */
export function getActiveStreamIds(queue) {
	return queue
		.filter((item) => isActiveStatus(item.status) && item.ctrl)
		.flatMap((item) => item.ctrl?.streamIds ?? []);
}

/**
 * Coerces a requested concurrency cap into something `drain()` can use
 * safely. Fractional caps are floored (`running < cap` needs an
 * integer cap to grant exactly the intended number of slots), and
 * anything non-finite or below 1 (NaN, 0, a negative number) falls
 * back to 1, so the queue always makes progress at a sane rate rather
 * than stalling or granting unlimited slots at once.
 * @param {number} n
 * @returns {number}
 */
function normalizeCap(n) {
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * Concurrency-limited slot queue. Grants slots, as they free up, to
 * whichever waiting entry sits earliest in `priorityList` - not
 * necessarily whoever called acquire() first. `priorityList` is read
 * fresh on every grant, so reordering it externally (e.g. a "move up"
 * action) changes who gets the next slot. A waiter absent from the
 * list sorts first (indexOf === -1).
 * @param {QueueEntry[]} priorityList
 * @param {number} maxConcurrent
 * @returns {SlotQueue}
 */
export function createSlotQueue(priorityList, maxConcurrent) {
	let running = 0;
	let cap = normalizeCap(maxConcurrent);
	/** @type {{ entry: QueueEntry, resolve: () => void }[]} */
	const pending = [];

	function drain() {
		while (running < cap && pending.length > 0) {
			let bestIdx = 0;
			let bestPos = priorityList.indexOf(pending[0].entry);
			for (let i = 1; i < pending.length; i++) {
				const pos = priorityList.indexOf(pending[i].entry);
				if (pos < bestPos) {
					bestPos = pos;
					bestIdx = i;
				}
			}
			const next = pending.splice(bestIdx, 1)[0];
			running++;
			next.resolve();
		}
	}

	return {
		acquire(entry) {
			return new Promise((resolve) => {
				pending.push({ entry, resolve });
				drain();
			});
		},
		dequeue(entry) {
			const idx = pending.findIndex((p) => p.entry === entry);
			if (idx !== -1) pending.splice(idx, 1);
		},
		release() {
			running = Math.max(0, running - 1);
			drain();
		},
		/**
		 * Changes the cap in place. Raising it drains queued waiters
		 * immediately, up to the new cap. Lowering it never touches
		 * slots already granted - drain() simply won't grant a new one
		 * until `running` falls under the new cap on its own.
		 * @param {number} n
		 */
		setMaxConcurrent(n) {
			cap = normalizeCap(n);
			drain();
		},
		get runningCount() {
			return running;
		},
		get pendingCount() {
			return pending.length;
		},
	};
}
