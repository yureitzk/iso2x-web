import { describe, it, expect } from 'vitest';

import {
	STATUSES,
	STATUS_PERMISSIONS,
	statusKeyFor,
	isEditable,
	statusModifierClass,
	computeOverallProgress,
	findEntry,
	removeEntry,
	getActiveStreamIds,
	createSlotQueue,
	MODE_CONSTRAINTS,
} from './queue.js';

/**
 * @import { QueueEntry, ConversionStatus } from '../../types/global'
 */

describe('Queue Logic Utilities', () => {
	/**
	 * @param {string} id
	 * @param {ConversionStatus} status
	 * @param {number} [size=100]
	 * @param {number} [progress]
	 * @param {string[]} [streamIds] - ids of the ctrl's currently open
	 *   download streams; omit for no ctrl, pass [] for a ctrl with none
	 *   open yet (e.g. mid-sizing, before the first STREAM_INFO).
	 * @param {boolean} [awaitingSlot]
	 * @returns {QueueEntry}
	 */
	const createMockItem = (
		id,
		status,
		size = 100,
		progress,
		streamIds,
		awaitingSlot,
	) => {
		const item = /** @type {QueueEntry} */ ({
			id,
			status,
			files: [{ size }],
			progress,
			ctrl: streamIds ? { streamIds } : null,
			awaitingSlot,
		});
		return item;
	};

	describe('STATUSES', () => {
		it('should contain all the required queue statuses', () => {
			/** @type {ConversionStatus[]} */
			const expectedStatuses = [
				'inspecting',
				'idle',
				'running',
				'paused',
				'done',
				'error',
				'cancelled',
				'unresolved',
			];
			expect(STATUSES).toEqual(expectedStatuses);
		});
	});

	describe('STATUS_PERMISSIONS', () => {
		it('has a row for every status in STATUSES, plus the synthetic awaitingSlot row', () => {
			for (const status of STATUSES) {
				expect(STATUS_PERMISSIONS).toHaveProperty(status);
			}
			expect(STATUS_PERMISSIONS).toHaveProperty('awaitingSlot');
		});

		it('marks idle/cancelled/error convertible and removable, and nothing else convertible', () => {
			for (const status of /** @type {const} */ (['idle', 'cancelled', 'error'])) {
				expect(STATUS_PERMISSIONS[status].convertible).toBe(true);
				expect(STATUS_PERMISSIONS[status].removable).toBe(true);
			}
			for (const status of /** @type {const} */ ([
				'inspecting',
				'running',
				'paused',
				'done',
				'unresolved',
				'awaitingSlot',
			])) {
				expect(STATUS_PERMISSIONS[status].convertible).toBe(false);
			}
		});

		it('marks running/paused/awaitingSlot cancellable but not removable', () => {
			for (const status of /** @type {const} */ ([
				'running',
				'paused',
				'awaitingSlot',
			])) {
				expect(STATUS_PERMISSIONS[status].cancellable).toBe(true);
				expect(STATUS_PERMISSIONS[status].removable).toBe(false);
			}
		});

		it('marks only running/paused pausable', () => {
			expect(STATUS_PERMISSIONS.running.pausable).toBe(true);
			expect(STATUS_PERMISSIONS.paused.pausable).toBe(true);
			expect(STATUS_PERMISSIONS.awaitingSlot.pausable).toBeFalsy();
			expect(STATUS_PERMISSIONS.idle.pausable).toBeFalsy();
		});

		it('marks unresolved removable but not convertible', () => {
			expect(STATUS_PERMISSIONS.unresolved.convertible).toBe(false);
			expect(STATUS_PERMISSIONS.unresolved.removable).toBe(true);
		});
	});

	describe('statusKeyFor', () => {
		it('returns the entry status when awaitingSlot is not set', () => {
			const item = createMockItem('1', 'idle');
			expect(statusKeyFor(item)).toBe('idle');
		});

		it('returns "awaitingSlot" whenever awaitingSlot is true, regardless of status', () => {
			const item = createMockItem('1', 'running', 100, undefined, undefined, true);
			expect(statusKeyFor(item)).toBe('awaitingSlot');
		});
	});

	describe('isEditable', () => {
		it('is true for idle/cancelled/error', () => {
			expect(isEditable(createMockItem('1', 'idle'))).toBe(true);
			expect(isEditable(createMockItem('2', 'cancelled'))).toBe(true);
			expect(isEditable(createMockItem('3', 'error'))).toBe(true);
		});

		it('is false for running/paused/done/unresolved/inspecting', () => {
			expect(isEditable(createMockItem('1', 'running'))).toBe(false);
			expect(isEditable(createMockItem('2', 'paused'))).toBe(false);
			expect(isEditable(createMockItem('3', 'done'))).toBe(false);
			expect(isEditable(createMockItem('4', 'unresolved'))).toBe(false);
			expect(isEditable(createMockItem('5', 'inspecting'))).toBe(false);
		});

		it('is false for an otherwise-idle entry that is awaitingSlot', () => {
			const item = createMockItem('1', 'idle', 100, undefined, undefined, true);
			expect(isEditable(item)).toBe(false);
		});
	});

	describe('statusModifierClass', () => {
		it('should append the status to the modifier class', () => {
			expect(statusModifierClass('running')).toBe('queue-item__status--running');
			expect(statusModifierClass('idle')).toBe('queue-item__status--idle');
		});
	});

	describe('computeOverallProgress', () => {
		it('should return null if there are no active (running/paused) items', () => {
			/** @type {QueueEntry[]} */
			const queue = [
				createMockItem('1', 'idle'),
				createMockItem('2', 'done'),
				createMockItem('3', 'error'),
			];
			expect(computeOverallProgress(queue)).toBeNull();
		});

		it('should calculate the correctly weighted overall progress', () => {
			/** @type {QueueEntry[]} */
			const queue = [
				createMockItem('1', 'running', 100, 50),
				createMockItem('2', 'paused', 300, 10),
				createMockItem('3', 'idle', 500, 99),
			];

			expect(computeOverallProgress(queue)).toBe(20);
		});

		it('should handle missing (undefined) progress values safely as 0', () => {
			/** @type {QueueEntry[]} */
			const queue = [
				createMockItem('1', 'running', 100, undefined),
				createMockItem('2', 'running', 100, 100),
			];

			expect(computeOverallProgress(queue)).toBe(50);
		});
	});

	describe('findEntry', () => {
		it('should return the item and index if the id exists', () => {
			/** @type {QueueEntry[]} */
			const queue = [createMockItem('1', 'idle'), createMockItem('2', 'running')];

			const result = findEntry(queue, '2');
			expect(result).not.toBeNull();
			expect(result?.idx).toBe(1);
			expect(result?.item.id).toBe('2');
		});

		it('should return null if the id does not exist', () => {
			/** @type {QueueEntry[]} */
			const queue = [createMockItem('1', 'idle')];
			expect(findEntry(queue, 'non-existent')).toBeNull();
		});
	});

	describe('removeEntry', () => {
		it('should remove the entry from the queue and return it', () => {
			/** @type {QueueEntry[]} */
			const queue = [
				createMockItem('1', 'idle'),
				createMockItem('2', 'running'),
				createMockItem('3', 'done'),
			];

			const removed = removeEntry(queue, '2');
			expect(removed).not.toBeNull();
			expect(removed?.id).toBe('2');

			expect(queue.length).toBe(2);
			expect(queue[0].id).toBe('1');
			expect(queue[1].id).toBe('3');
		});

		it('should return null and not modify the array if id is not found', () => {
			/** @type {QueueEntry[]} */
			const queue = [createMockItem('1', 'idle')];
			const removed = removeEntry(queue, 'non-existent');

			expect(removed).toBeNull();
			expect(queue.length).toBe(1);
		});
	});

	describe('getActiveStreamIds', () => {
		it('should return streamIds for active items that possess a ctrl object', () => {
			/** @type {QueueEntry[]} */
			const queue = [
				createMockItem('1', 'running', 100, 0, ['stream-a']),
				createMockItem('2', 'paused', 100, 0, ['stream-b']),
			];
			const ids = getActiveStreamIds(queue);
			expect(ids).toEqual(['stream-a', 'stream-b']);
		});

		it('should ignore items that are not active or lack a ctrl object', () => {
			/** @type {QueueEntry[]} */
			const queue = [
				createMockItem('1', 'running'),
				createMockItem('2', 'idle', 100, 0, ['stream-c']),
				createMockItem('3', 'running', 100, 0, ['stream-d']),
			];

			const ids = getActiveStreamIds(queue);
			expect(ids).toEqual(['stream-d']);
		});

		it('should flatten multiple concurrent streams from a single controller', () => {
			/** @type {QueueEntry[]} */
			const queue = [
				createMockItem('1', 'running', 100, 0, ['game.1.cso-id', 'game.2.cso-id']),
			];
			const ids = getActiveStreamIds(queue);
			expect(ids).toEqual(['game.1.cso-id', 'game.2.cso-id']);
		});

		it('should skip active items whose ctrl has no streams open yet', () => {
			/** @type {QueueEntry[]} */
			const queue = [createMockItem('1', 'running', 100, 0, [])];
			const ids = getActiveStreamIds(queue);
			expect(ids).toEqual([]);
		});

		it('should return an empty array for an empty queue', () => {
			expect(getActiveStreamIds([])).toEqual([]);
		});
	});

	describe('createSlotQueue', () => {
		/**
		 * @param {string} id
		 * @returns {QueueEntry}
		 */
		const entry = (id) => /** @type {QueueEntry} */ ({ id });

		it('grants up to maxConcurrent slots immediately, queues the rest', async () => {
			const a = entry('a');
			const b = entry('b');
			const c = entry('c');
			const list = [a, b, c];
			const sq = createSlotQueue(list, 1);

			/** @type {string[]} */
			const granted = [];
			sq.acquire(a).then(() => granted.push('a'));
			sq.acquire(b).then(() => granted.push('b'));
			sq.acquire(c).then(() => granted.push('c'));
			await Promise.resolve();

			expect(granted).toEqual(['a']);
			expect(sq.runningCount).toBe(1);
			expect(sq.pendingCount).toBe(2);
		});

		it('reordering priorityList changes who gets the next freed slot', async () => {
			const a = entry('a');
			const b = entry('b');
			const c = entry('c');
			const list = [a, b, c];
			const sq = createSlotQueue(list, 1);

			/** @type {string[]} */
			const granted = [];
			sq.acquire(a).then(() => granted.push('a'));
			sq.acquire(b).then(() => granted.push('b'));
			sq.acquire(c).then(() => granted.push('c'));
			await Promise.resolve();
			expect(granted).toEqual(['a']);

			// Move c ahead of b, as a "move up" UI action would.
			list.splice(list.indexOf(c), 1);
			list.splice(1, 0, c);

			sq.release();
			await Promise.resolve();
			expect(granted).toEqual(['a', 'c']);
		});

		it('honors maxConcurrent > 1', async () => {
			const a = entry('a');
			const b = entry('b');
			const c = entry('c');
			const list = [a, b, c];
			const sq = createSlotQueue(list, 2);

			/** @type {string[]} */
			const granted = [];
			sq.acquire(a).then(() => granted.push('a'));
			sq.acquire(b).then(() => granted.push('b'));
			sq.acquire(c).then(() => granted.push('c'));
			await Promise.resolve();

			expect(granted).toEqual(['a', 'b']);
			expect(sq.runningCount).toBe(2);
			expect(sq.pendingCount).toBe(1);
		});

		it('dequeue removes a waiter without granting it a slot', async () => {
			const a = entry('a');
			const b = entry('b');
			const list = [a, b];
			const sq = createSlotQueue(list, 1);

			/** @type {string[]} */
			const granted = [];
			sq.acquire(a).then(() => granted.push('a'));
			sq.acquire(b).then(() => granted.push('b'));
			await Promise.resolve();

			sq.dequeue(b);
			expect(sq.pendingCount).toBe(0);

			sq.release();
			await Promise.resolve();
			expect(granted).toEqual(['a']); // b never granted, despite the freed slot
		});

		it('dequeue is a no-op for an entry that is not waiting', () => {
			const a = entry('a');
			const b = entry('b');
			const sq = createSlotQueue([a, b], 1);
			sq.acquire(a);
			expect(() => sq.dequeue(b)).not.toThrow();
			expect(sq.pendingCount).toBe(0);
		});

		it('release lowers runningCount and immediately drains the next waiter', async () => {
			const a = entry('a');
			const b = entry('b');
			const list = [a, b];
			const sq = createSlotQueue(list, 1);

			/** @type {string[]} */
			const granted = [];
			sq.acquire(a).then(() => granted.push('a'));
			sq.acquire(b).then(() => granted.push('b'));
			await Promise.resolve();
			expect(sq.runningCount).toBe(1);

			sq.release();
			expect(sq.runningCount).toBe(1); // freed then immediately re-granted to b
			await Promise.resolve();
			expect(granted).toEqual(['a', 'b']);
		});

		it('release never drops runningCount below zero', () => {
			const sq = createSlotQueue([], 1);
			sq.release();
			sq.release();
			expect(sq.runningCount).toBe(0);
		});

		describe('setMaxConcurrent', () => {
			it('raising the cap immediately drains queued waiters up to the new cap', async () => {
				const a = entry('a');
				const b = entry('b');
				const c = entry('c');
				const list = [a, b, c];
				const sq = createSlotQueue(list, 1);

				/** @type {string[]} */
				const granted = [];
				sq.acquire(a).then(() => granted.push('a'));
				sq.acquire(b).then(() => granted.push('b'));
				sq.acquire(c).then(() => granted.push('c'));
				await Promise.resolve();
				expect(granted).toEqual(['a']);

				sq.setMaxConcurrent(3);
				await Promise.resolve();

				expect(granted).toEqual(['a', 'b', 'c']);
				expect(sq.runningCount).toBe(3);
				expect(sq.pendingCount).toBe(0);
			});

			it('lowering the cap never disturbs slots already granted', async () => {
				const a = entry('a');
				const b = entry('b');
				const list = [a, b];
				const sq = createSlotQueue(list, 2);

				/** @type {string[]} */
				const granted = [];
				sq.acquire(a).then(() => granted.push('a'));
				sq.acquire(b).then(() => granted.push('b'));
				await Promise.resolve();
				expect(granted).toEqual(['a', 'b']);
				expect(sq.runningCount).toBe(2);

				sq.setMaxConcurrent(1);

				// Neither already-running slot is revoked by lowering the cap.
				expect(sq.runningCount).toBe(2);
				expect(granted).toEqual(['a', 'b']);
			});

			it('after lowering the cap, releasing waits until running drops under the new cap before granting the next slot', async () => {
				const a = entry('a');
				const b = entry('b');
				const c = entry('c');
				const list = [a, b, c];
				const sq = createSlotQueue(list, 2);

				/** @type {string[]} */
				const granted = [];
				sq.acquire(a).then(() => granted.push('a'));
				sq.acquire(b).then(() => granted.push('b'));
				sq.acquire(c).then(() => granted.push('c'));
				await Promise.resolve();
				expect(granted).toEqual(['a', 'b']);

				sq.setMaxConcurrent(1);
				sq.release(); // running: 2 -> 1, still at the new cap - c not granted yet
				await Promise.resolve();
				expect(granted).toEqual(['a', 'b']);
				expect(sq.runningCount).toBe(1);

				sq.release(); // running: 1 -> 0, now under cap - c is granted
				await Promise.resolve();
				expect(granted).toEqual(['a', 'b', 'c']);
				expect(sq.runningCount).toBe(1);
			});
		});

		describe('cap normalization', () => {
			it('floors a fractional cap at construction', async () => {
				const a = entry('a');
				const b = entry('b');
				const c = entry('c');
				const list = [a, b, c];
				const sq = createSlotQueue(list, 2.5);

				/** @type {string[]} */
				const granted = [];
				sq.acquire(a).then(() => granted.push('a'));
				sq.acquire(b).then(() => granted.push('b'));
				sq.acquire(c).then(() => granted.push('c'));
				await Promise.resolve();

				expect(granted).toEqual(['a', 'b']);
				expect(sq.runningCount).toBe(2);
			});

			it('floors a fractional cap passed to setMaxConcurrent', async () => {
				const a = entry('a');
				const b = entry('b');
				const c = entry('c');
				const list = [a, b, c];
				const sq = createSlotQueue(list, 1);

				/** @type {string[]} */
				const granted = [];
				sq.acquire(a).then(() => granted.push('a'));
				sq.acquire(b).then(() => granted.push('b'));
				sq.acquire(c).then(() => granted.push('c'));
				await Promise.resolve();
				expect(granted).toEqual(['a']);

				sq.setMaxConcurrent(2.9);
				await Promise.resolve();

				expect(granted).toEqual(['a', 'b']);
				expect(sq.runningCount).toBe(2);
			});

			it.each([0, -1, NaN, Infinity, -Infinity])(
				'falls back to a cap of 1 (serial) for an invalid construction value: %s',
				async (bad) => {
					const a = entry('a');
					const b = entry('b');
					const list = [a, b];
					const sq = createSlotQueue(list, bad);

					/** @type {string[]} */
					const granted = [];
					sq.acquire(a).then(() => granted.push('a'));
					sq.acquire(b).then(() => granted.push('b'));
					await Promise.resolve();

					expect(granted).toEqual(['a']);
					expect(sq.runningCount).toBe(1);
				},
			);

			it.each([0, -1, NaN, Infinity, -Infinity])(
				'falls back to a cap of 1 for an invalid setMaxConcurrent value: %s',
				async (bad) => {
					const a = entry('a');
					const b = entry('b');
					const c = entry('c');
					const list = [a, b, c];
					const sq = createSlotQueue(list, 2);

					/** @type {string[]} */
					const granted = [];
					sq.acquire(a).then(() => granted.push('a'));
					sq.acquire(b).then(() => granted.push('b'));
					sq.acquire(c).then(() => granted.push('c'));
					await Promise.resolve();
					expect(granted).toEqual(['a', 'b']);

					sq.setMaxConcurrent(bad);
					sq.release(); // running: 2 -> 1
					await Promise.resolve();

					// Cap fell back to 1, so the freed slot isn't handed to c.
					expect(granted).toEqual(['a', 'b']);
					expect(sq.runningCount).toBe(1);
				},
			);
		});
	});

	describe('MODE_CONSTRAINTS', () => {
		it("an 'stfs' source is 'full'-only for every mode target, same as 'extracted' - both back onto ExtractedFs with no raw disc image to scrub", () => {
			for (const target of /** @type {const} */ (['god', 'xiso', 'ciso', 'cci'])) {
				expect(MODE_CONSTRAINTS[target]('stfs')).toEqual({
					allowed: ['full'],
				});
				expect(MODE_CONSTRAINTS[target]('stfs')).toEqual(
					MODE_CONSTRAINTS[target]('extracted'),
				);
			}
		});

		it("a raw-image source (e.g. 'xiso') still gets the full mode range, unaffected by the 'stfs' constraint", () => {
			expect(MODE_CONSTRAINTS.god('xiso')).toEqual({
				allowed: ['none', 'partial', 'full'],
			});
			expect(MODE_CONSTRAINTS.xiso('xiso')).toEqual({
				allowed: ['trim', 'zero', 'full'],
			});
		});
	});
});
