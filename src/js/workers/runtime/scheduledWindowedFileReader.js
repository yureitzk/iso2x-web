/**
 * Schedule-aware windowed read cache for Full-mode XDVDFS reauthors
 * (GOD/CCI/CISO conversions, and xISO's `full` mode).
 *
 * Knows the future read order ahead of time (`schedule`, from
 * `core/read_schedule.rs`) and uses Belady's OPT eviction: evict
 * whichever resident window's next use is furthest away. Falls back to
 * plain LRU wherever `schedule` is empty or the actual call sequence
 * drifts from it - just a cache miss, never a correctness issue. This
 * is the only windowed read cache in the codebase - the empty-schedule
 * fallback above already covers the plain-LRU case, so don't add a
 * second implementation.
 *
 * Every `ScheduledSourceReader` for the parts of one source shares a
 * single `WindowPool` (see below) so their combined resident cache
 * stays bounded regardless of part count.
 */

import { sliceSourceFile } from './zipSource.js';
import { trackRead } from '../../lib/readTracker.js';
import {
	SEQUENTIAL_WINDOW_BYTES,
	SEQUENTIAL_WINDOW_COUNT,
	SEQUENTIAL_MIN_FILL_BYTES,
} from '../../constants/reading.js';

/**
 * @import { SourceReadFn } from 'iso2x'
 * @import { SourceFile } from '../../../types/global'
 */

/**
 * @typedef {{ partKey: number, start: number, len: number, view: Uint8Array }} PoolWindow
 */

const STREAK_THRESHOLD = 3;

/** How far ahead in `schedule` to look when scoring eviction
 * candidates, so a mismatched schedule can't force an O(n) scan. */
const LOOKAHEAD_ENTRIES = 4096;

/**
 * Shared, globally-bounded pool of resident read-cache windows for
 * every part of one source. `maxWindows` windows are kept resident
 * *in total across every part sharing this pool*, LRU/Belady-evicted
 * past that - not `maxWindows` per part.
 *
 * Without this, a source with N parts (each with its own private
 * cache) can end up with N independent windows resident at once -
 * effectively the whole source's content in RAM simultaneously,
 * defeating the point of windowing. One `WindowPool` per
 * `convertSource()` call, shared by every `ScheduledSourceReader`
 * built for that conversion's parts, keeps the real ceiling at
 * `maxWindows * windowBytes` regardless of how many parts there are.
 */
export class WindowPool {
	/** @type {PoolWindow[]} MRU-last; slots[0] is next to evict. */
	slots = [];

	/** @param {number} [maxWindows] */
	constructor(maxWindows = SEQUENTIAL_WINDOW_COUNT) {
		this.maxWindows = maxWindows;
	}
}

/**
 * @param {PoolWindow[]} slots
 * @param {number} partKey
 * @param {number} offset
 * @param {number} length
 */
function findCoveringSlot(slots, partKey, offset, length) {
	for (let i = slots.length - 1; i >= 0; i--) {
		const s = slots[i];
		if (
			s.partKey === partKey &&
			offset >= s.start &&
			offset + length <= s.start + s.len
		) {
			return i;
		}
	}
	return -1;
}

/**
 * Finds the schedule entry containing `offset`, searching near
 * `fromIndex` (reads can be sub-file chunks, so this isn't an exact
 * match against the schedule's per-file entries).
 * @param {{offset: number, size: number}[]} schedule
 * @param {number} fromIndex
 * @param {number} offset
 */
function resync(schedule, fromIndex, offset) {
	const searchRadius = 64; // bounded local search; call sequence tracks schedule closely
	const start = Math.max(0, fromIndex - searchRadius);
	const end = Math.min(schedule.length, fromIndex + searchRadius);
	for (let i = start; i < end; i++) {
		const e = schedule[i];
		if (offset >= e.offset && offset < e.offset + e.size) return i;
	}
	return -1;
}

/**
 * @param {{offset: number, size: number}[]} schedule
 * @param {number} scheduleIndex - first not-yet-consumed schedule entry
 * @param {PoolWindow} window
 * @returns {number} index into `schedule` of the window's next
 *   overlapping reference, or `Infinity` if none found within the
 *   lookahead budget
 */
function nextUseWithinLookahead(schedule, scheduleIndex, window) {
	const end = Math.min(schedule.length, scheduleIndex + LOOKAHEAD_ENTRIES);
	for (let i = scheduleIndex; i < end; i++) {
		const e = schedule[i];
		if (
			e.offset < window.start + window.len &&
			e.offset + e.size > window.start
		) {
			return i;
		}
	}
	return Infinity;
}

/**
 * @param {SourceFile} file
 * @param {number} windowBytes
 * @param {{offset: number, size: number}[]} schedule - predicted
 *   (offset, size) read sequence, from `OpenedSource.fullModeReadSchedule()`.
 *   Only ever non-empty for the single-part case (see
 *   `tryGetFullModeSchedule()` in converterWorker.js) - empty here
 *   just means every eviction candidate ties on "no known next use",
 *   which degrades cleanly to plain LRU (oldest-touched slot first).
 * @param {number} partKey - identifies which part of `pool` this
 *   reader owns; must be unique per reader sharing `pool`. Reads never
 *   match a slot tagged with a different `partKey`, so sharing a pool
 *   across parts is safe even though eviction picks victims from any
 *   part.
 * @param {WindowPool} pool - shared window budget, see `WindowPool`.
 * @param {(fillBytes: number) => void} [onFill]
 * @param {number} [minFillBytes]
 * @returns {SourceReadFn}
 */
export function makeScheduledReadFn(
	file,
	windowBytes,
	schedule,
	partKey,
	pool,
	onFill,
	minFillBytes = SEQUENTIAL_MIN_FILL_BYTES,
) {
	const slots = pool.slots;
	let prevEnd = -1;
	let streak = 0;
	// Tracks whether *this part* has ever been filled. This is
	// independent of whether the shared pool already holds other parts'
	// windows, so every part still gets one eager full-window fill on
	// its own first read, rather than only the pool's very first fill
	// overall getting it.
	let everFilled = false;
	/** Best-known position in `schedule` matching "now". */
	let scheduleIndex = 0;

	return (/** @type {number} */ offset, /** @type {number} */ length) => {
		const continuesPreviousRead = offset === prevEnd;
		streak = continuesPreviousRead ? streak + 1 : 0;
		prevEnd = offset + length;

		if (schedule.length > 0) {
			const resynced = resync(schedule, scheduleIndex, offset);
			// +1 because `resynced` is the entry we're servicing *right
			// now*. It must not still count as a pending "future use"
			// once eviction scoring runs below, or a window can look
			// artificially likely to be needed again soon purely because
			// it hasn't been advanced past its own defining entry yet,
			// and survive an eviction pass it should have lost.
			if (resynced !== -1) scheduleIndex = resynced + 1;
			// else: prediction drifted; eviction degrades to LRU below.
		}

		let idx = findCoveringSlot(slots, partKey, offset, length);
		/** @type {PoolWindow} */
		let slot;

		if (idx === -1) {
			const promoted = !everFilled || streak >= STREAK_THRESHOLD;
			const fillTarget = promoted
				? Math.max(windowBytes, length)
				: Math.max(length, minFillBytes);
			const end = Math.min(offset + fillTarget, file.size);
			const view = new Uint8Array(
				new FileReaderSync().readAsArrayBuffer(
					sliceSourceFile(file, offset, end - offset),
				),
			);
			slot = { partKey, start: offset, len: view.byteLength, view };
			everFilled = true;
			onFill?.(slot.len);

			if (slots.length >= pool.maxWindows) {
				// Belady: evict the resident window (from any part
				// sharing this pool) with the furthest-away (or no) next
				// use within the lookahead budget.
				let victimPos = -1;
				let victimNextUse = -1;
				for (let i = 0; i < slots.length; i++) {
					const nu =
						schedule.length > 0
							? nextUseWithinLookahead(schedule, scheduleIndex, slots[i])
							: Infinity; // no schedule -> ties fall back to first slot (LRU order)
					if (nu > victimNextUse) {
						victimNextUse = nu;
						victimPos = i;
					}
				}
				slots.splice(victimPos, 1);
			}
			slots.push(slot);
		} else {
			slot = /** @type {PoolWindow} */ (slots.splice(idx, 1)[0]);
			slots.push(slot);
		}

		const relStart = offset - slot.start;
		const actualLength = Math.min(length, slot.len - relStart);

		if (actualLength < length && offset + actualLength < file.size) {
			throw new Error(
				`scheduledWindowedFileReader: short read of ${actualLength} of ${length} requested bytes ` +
					`at offset ${offset} (window [${slot.start}, ${slot.start + slot.len}), ` +
					`file size ${file.size})`,
			);
		}

		return slot.view.slice(relStart, relStart + actualLength);
	};
}

/**
 * Unpacks `OpenedSource.fullModeReadSchedule()`'s flat
 * `[offset0, size0, offset1, size1, ...]` array into the
 * `{offset, size}[]` shape `makeScheduledReadFn` takes.
 *
 * Offsets are absolute (whole-source), not relative to a part of a
 * split/multi-part source - `ScheduledSourceReader.setSchedule()`
 * relies on this.
 * @param {Float64Array | number[]} flat
 * @returns {{offset: number, size: number}[]}
 */
export function parseFlatSchedule(flat) {
	const schedule = new Array(flat.length / 2);
	for (let i = 0; i < flat.length; i += 2) {
		schedule[i / 2] = { offset: flat[i], size: flat[i + 1] };
	}
	return schedule;
}

/**
 * A single source file's read path, upgradeable from plain windowed
 * LRU to schedule-aware Belady eviction after the fact (like
 * `posix_fadvise` advising an already-open handle).
 *
 * Every part of one source should share a single `WindowPool` (pass
 * it explicitly) so their combined resident cache stays bounded at
 * `maxWindows` windows total instead of `maxWindows` *per part* - see
 * `WindowPool`'s doc comment. Omitting `pool` gives this reader a
 * private one-part pool, which is only appropriate for a genuinely
 * standalone reader (e.g. tests).
 *
 * Usage:
 * ```js
 * const pool = new WindowPool();
 * const readers = files.map((file, i) => new ScheduledSourceReader(file, i, pool));
 * const opened = openSource(readers[0].read, fileSize, ...);
 * const schedule = tryGetFullModeSchedule(opened, format, options, sourceParts);
 * if (schedule) readers[0].setSchedule(schedule);
 * ```
 */
export class ScheduledSourceReader {
	/** @type {(offset: number, length: number) => Uint8Array} */
	#windowedRead;

	/** @type {SourceFile} */
	#file;

	/** @type {number} */
	#partKey;

	/** @type {WindowPool} */
	#pool;

	/**
	 * @param {SourceFile} file
	 * @param {number} [partKey] - unique key for this part within
	 *   `pool`. Defaults to 0, correct as long as this is the only
	 *   reader using `pool` (or `pool` is left to its private default).
	 * @param {WindowPool} [pool] - shared window budget across every
	 *   part of one source; see `WindowPool`. Defaults to a private,
	 *   single-part pool for a standalone reader.
	 */
	constructor(file, partKey = 0, pool = new WindowPool()) {
		this.file = file;
		this.#file = file;
		this.#partKey = partKey;
		this.#pool = pool;
		// Starts with an empty schedule, which makeScheduledReadFn
		// treats as plain LRU (see its doc comment).
		this.#windowedRead = makeScheduledReadFn(
			file,
			SEQUENTIAL_WINDOW_BYTES,
			[],
			partKey,
			pool,
		);
	}

	/**
	 * Conversion's main read path: a windowed FileReaderSync cache,
	 * schedule-aware once `setSchedule()` has been called. Also feeds
	 * readTracker.js for WorkerController's recycle sizing and
	 * fetch-amplification logging.
	 * @type {SourceReadFn}
	 */
	read = (/** @type {number} */ offset, /** @type {number} */ length) => {
		const bytes = this.#windowedRead(offset, length);
		trackRead(bytes.length);
		return bytes;
	};

	/**
	 * Switches this reader from plain LRU to schedule-aware Belady
	 * eviction for the rest of this conversion. Safe to never call.
	 * Windows already resident in the shared pool from before this call
	 * (this part's own, or another part's) are kept, not discarded.
	 * @param {{offset: number, size: number}[]} schedule - unpacked via
	 *   `parseFlatSchedule()`; must be in whole-source offset space
	 *   (never a single part of a split source).
	 */
	setSchedule(schedule) {
		this.#windowedRead = makeScheduledReadFn(
			this.#file,
			SEQUENTIAL_WINDOW_BYTES,
			schedule,
			this.#partKey,
			this.#pool,
		);
	}
}
