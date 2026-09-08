import { describe, it, expect, vi } from 'vitest';

/**
 * @import { ConversionStatus } from '../../../types/global'
 */

const { settings: mockSettings } = await vi.hoisted(async () => {
	const { createMockSettings } =
		await import('../../../../test/utils/settingsMock.js');
	return createMockSettings();
});
vi.mock('../../lib/settings.js', () => ({ settings: mockSettings }));

const { statusUpdateDecision } = await import('./queueUi.js');

describe('statusUpdateDecision', () => {
	it('does not skip on the very first call for an item (no previous key)', () => {
		const { skip } = statusUpdateDecision(undefined, 'running', false);
		expect(skip).toBe(false);
	});

	it('skips a repeat call with the same status and awaitingSlot (a pure progress tick)', () => {
		const first = statusUpdateDecision(undefined, 'running', false);
		const second = statusUpdateDecision(first.key, 'running', false);
		expect(second.skip).toBe(true);
	});

	it('does not skip when the status changes', () => {
		const first = statusUpdateDecision(undefined, 'idle', false);
		const second = statusUpdateDecision(first.key, 'running', false);
		expect(second.skip).toBe(false);
	});

	it('does not skip when awaitingSlot flips while status stays the same', () => {
		// The "slot granted while still running" case - status never
		// changes, but the waiting-dependent UI (cancel/pause buttons,
		// the 'awaiting-slot' class, dataset.status) still needs refreshing.
		const first = statusUpdateDecision(undefined, 'running', true);
		const second = statusUpdateDecision(first.key, 'running', false);
		expect(second.skip).toBe(false);
	});

	it('produces distinct keys for every (status, awaitingSlot) combination', () => {
		/** @type {ConversionStatus[]} */
		const statuses = ['idle', 'running', 'paused', 'done', 'error'];
		const keys = new Set();
		for (const status of statuses) {
			for (const awaitingSlot of [true, false]) {
				keys.add(statusUpdateDecision(undefined, status, awaitingSlot).key);
			}
		}
		expect(keys.size).toBe(statuses.length * 2);
	});

	it('a realistic progress-tick sequence only stops skipping on real transitions', () => {
		/** @type {string | undefined} */
		let key;
		/** @type {boolean[]} */
		const results = [];

		/** @param {ConversionStatus} status @param {boolean} awaitingSlot */
		const apply = (status, awaitingSlot) => {
			const decision = statusUpdateDecision(key, status, awaitingSlot);
			key = decision.key;
			results.push(decision.skip);
		};

		apply('idle', false); // queued
		apply('running', true); // waiting for a slot
		apply('running', false); // slot granted
		apply('running', false); // progress tick
		apply('running', false); // progress tick
		apply('running', false); // progress tick
		apply('done', false); // finished

		expect(results).toEqual([
			false, // idle -> running: real transition
			false, // awaitingSlot true -> ...: still a change from idle's false, real transition
			false, // awaitingSlot true -> false while running: real transition
			true, // progress tick
			true, // progress tick
			true, // progress tick
			false, // running -> done: real transition
		]);
	});
});
