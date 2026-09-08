import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	ScheduledSourceReader,
	WindowPool,
	makeScheduledReadFn,
	parseFlatSchedule,
} from './scheduledWindowedFileReader.js';
import { SEQUENTIAL_WINDOW_BYTES } from '../../constants/reading.js';
import {
	patternByte,
	makeFile,
	asSourceFile,
	installFileReaderSyncStub,
} from '../../../../test/utils/windowedFileFixture.js';

// Tests going through makeScheduledReadFn() directly can pick their
// own window size; this one is deliberately small to keep fixtures
// cheap.
const WINDOW_BYTES = 4 * 1024 * 1024;

// Tests going through the ScheduledSourceReader/converterWorker.js
// path can't - that class always uses the real fixed window size
// internally (same as production), so any offsets meant to land in a
// second window must be measured against this, not the local
// WINDOW_BYTES above.
const REAL_WINDOW_BYTES = SEQUENTIAL_WINDOW_BYTES;

describe('scheduledWindowedFileReader.js', () => {
	/** @type {() => void} */
	let restoreFileReaderSync;

	beforeEach(() => {
		restoreFileReaderSync = installFileReaderSyncStub();
	});

	afterEach(() => {
		restoreFileReaderSync();
	});

	describe('WindowPool sharing (regression: unbounded per-part memory)', () => {
		it('caps total resident windows at maxWindows across many parts, not per part', () => {
			// Reproduces the extracted-folder-zip shape: many small parts,
			// each with its own ScheduledSourceReader, sharing one pool -
			// exactly how converterWorker.js's convertSource() wires them
			// up. Before the fix, each part got its own private cache with
			// no shared cap, so resident memory grew with part count.
			const PART_COUNT = 200;
			const PART_SIZE = 64 * 1024; // small - fits in a single window each
			const pool = new WindowPool(8);
			const readers = Array.from({ length: PART_COUNT }, (_, i) => {
				const file = makeFile(PART_SIZE);
				return new ScheduledSourceReader(asSourceFile(file), i, pool);
			});

			for (const reader of readers) {
				reader.read(0, PART_SIZE);
			}

			// No matter how many parts were touched, at most `maxWindows`
			// windows are resident in the shared pool at once.
			expect(pool.slots.length).toBeLessThanOrEqual(8);
		});

		it("keeps two parts sharing a pool from reading each other's bytes", () => {
			const fileA = makeFile(1024);
			const fileB = makeFile(1024);
			fileB.slice = (start = 0, end = 1024) => ({
				bytes: new Uint8Array(end - start).fill(0xff),
			});
			const pool = new WindowPool();
			const readerA = new ScheduledSourceReader(asSourceFile(fileA), 0, pool);
			const readerB = new ScheduledSourceReader(asSourceFile(fileB), 1, pool);

			expect(readerA.read(0, 16)[0]).toBe(patternByte(0));
			expect(readerB.read(0, 16)[0]).toBe(0xff);
			// Interleaved re-reads still resolve to the right part, even
			// though both readers' windows live in the same `pool.slots`.
			expect(readerA.read(0, 16)[0]).toBe(patternByte(0));
			expect(readerB.read(0, 16)[0]).toBe(0xff);
		});

		it('evicts across parts once the shared budget is exceeded, LRU-first', () => {
			// With only 2 slots and 3 parts in play, at most 2 can ever be
			// resident at once - so this drives the pool through a full
			// LRU cycle (fill, evict-oldest, revisit-to-refresh,
			// evict-new-oldest) rather than asserting a state that would
			// require 3 windows resident in a 2-window pool.
			const pool = new WindowPool(2); // deliberately small shared budget
			const files = Array.from({ length: 3 }, () => makeFile(WINDOW_BYTES));
			const spies = files.map((f) => vi.spyOn(f, 'slice'));
			const readers = files.map(
				(f, i) => new ScheduledSourceReader(asSourceFile(f), i, pool),
			);

			readers[0].read(0, 16); // fills part 0 - pool: [p0]
			readers[1].read(0, 16); // fills part 1 - pool full: [p0, p1]
			readers[2].read(0, 16); // evicts p0 (LRU) - pool: [p1, p2]
			expect(spies[0].mock.calls.length).toBe(1);
			expect(spies[1].mock.calls.length).toBe(1);
			expect(spies[2].mock.calls.length).toBe(1);

			// Touching part 1 again makes it MRU, not part 2, before the
			// next eviction - pool order becomes [p2, p1].
			readers[1].read(0, 16);
			expect(spies[1].mock.calls.length).toBe(1); // still a cache hit

			// Part 0 was evicted earlier, so reviving it is a real
			// re-fetch, which evicts the current LRU slot - part 2, not
			// part 1 (which was just refreshed above).
			readers[0].read(0, 16);
			expect(spies[0].mock.calls.length).toBe(2);

			// Part 1 survives (it was MRU going into that eviction).
			readers[1].read(0, 16);
			expect(spies[1].mock.calls.length).toBe(1);

			// Part 2 does not - it was the LRU slot when part 0 came back.
			readers[2].read(0, 16);
			expect(spies[2].mock.calls.length).toBe(2);
		});

		it("still gives each part its own eager full-window fill on that part's first read", () => {
			// Guards the `everFilled` (per-part, not per-pool) promotion
			// flag: every part's own first read should be treated as
			// "promoted" (full-window fill), not just the pool's very
			// first fill overall.
			const pool = new WindowPool(8);
			const bigFile = makeFile(WINDOW_BYTES * 2);
			/** @type {number[]} */
			const fillsA = [];
			/** @type {number[]} */
			const fillsB = [];
			const readA = makeScheduledReadFn(
				asSourceFile(bigFile),
				WINDOW_BYTES,
				[],
				0,
				pool,
				(n) => fillsA.push(n),
				0,
			);
			const readB = makeScheduledReadFn(
				asSourceFile(bigFile),
				WINDOW_BYTES,
				[],
				1,
				pool,
				(n) => fillsB.push(n),
				0,
			);

			readA(0, 16); // part 0's first read - promoted
			readB(0, 16); // part 1's first read - ALSO promoted, even though
			// the pool already has a resident window from part 0.

			expect(fillsA).toEqual([WINDOW_BYTES]);
			expect(fillsB).toEqual([WINDOW_BYTES]);
		});

		it('defaults to a private single-part pool when none is passed (unshared use stays unaffected)', () => {
			const file = makeFile(8 * REAL_WINDOW_BYTES);
			const spy = vi.spyOn(file, 'slice');
			const reader = new ScheduledSourceReader(asSourceFile(file));

			reader.read(0, 16);
			reader.read(REAL_WINDOW_BYTES, 16);
			expect(spy.mock.calls.length).toBe(2);

			// Revisiting the first window must still be served from cache.
			reader.read(0, 16);
			expect(spy.mock.calls.length).toBe(2);
		});
	});

	describe('setSchedule() / Belady eviction (no regression for the single-part case)', () => {
		it('keeps windows already resident (from before setSchedule()) instead of discarding them', () => {
			const file = makeFile(8 * REAL_WINDOW_BYTES);
			const spy = vi.spyOn(file, 'slice');
			const reader = new ScheduledSourceReader(asSourceFile(file));

			reader.read(0, 16); // plain-LRU fill, window 0
			expect(spy.mock.calls.length).toBe(1);

			reader.setSchedule([{ offset: 0, size: REAL_WINDOW_BYTES }]);

			// Window 0 is still resident post-upgrade - no re-fetch needed.
			reader.read(0, 16);
			expect(spy.mock.calls.length).toBe(1);
		});

		it('evicts the window with the furthest-away next use, not plain LRU, once scheduled', () => {
			// ScheduledSourceReader always uses the real fixed window size
			// internally (REAL_WINDOW_BYTES), regardless of any local
			// WINDOW_BYTES constant - the file and offsets here must be
			// sized off that, or every offset below would land inside a
			// single cached window and never actually exercise eviction.
			const pool = new WindowPool(2);
			const file = makeFile(4 * REAL_WINDOW_BYTES);
			const spy = vi.spyOn(file, 'slice');
			const reader = new ScheduledSourceReader(asSourceFile(file), 0, pool);

			// Schedule says: window 0 is used again soon (index 2), window 1
			// is never used again within the lookahead.
			reader.setSchedule([
				{ offset: 0, size: 16 },
				{ offset: REAL_WINDOW_BYTES, size: 16 },
				{ offset: 0, size: 16 },
			]);

			reader.read(0, 16); // fills window 0, scheduleIndex resyncs to 0
			reader.read(REAL_WINDOW_BYTES, 16); // fills window 1, pool full (2/2)
			reader.read(2 * REAL_WINDOW_BYTES, 16); // triggers eviction with 2 candidates

			// Window 1 (no future use in the schedule) should have been
			// evicted, not window 0 (used again at schedule index 2) - a
			// plain-LRU cache would have evicted window 0 instead, since it
			// was touched least recently.
			spy.mockClear();
			reader.read(0, 16); // should be a cache hit if Belady picked correctly
			expect(spy.mock.calls.length).toBe(0);
		});
	});

	describe('parseFlatSchedule()', () => {
		it('unpacks a flat [offset, size, ...] array into {offset, size} pairs', () => {
			expect(parseFlatSchedule([0, 100, 100, 200])).toEqual([
				{ offset: 0, size: 100 },
				{ offset: 100, size: 200 },
			]);
		});
	});
});
