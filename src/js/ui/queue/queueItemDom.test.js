import { describe, it, expect, beforeEach } from 'vitest';
import { queue } from '../../core/queue.js';
import { refreshMoveButtons, moveBlock } from './queueItemDom.js';

/**
 * @import { QueueEntry } from '../../../types/global'
 */

/**
 * Minimal stand-in for a QueueEntry - only the fields refreshMoveButtons()/
 * moveBlock() actually touch.
 * @param {string} id
 * @param {boolean} [hidden]
 * @returns {QueueEntry}
 */
function makeItem(id, hidden = false) {
	return /** @type {QueueEntry} */ ({
		id,
		section: {
			hidden,
			before: () => {},
			after: () => {},
		},
		moveUpBtn: { disabled: false },
		moveDownBtn: { disabled: false },
		logEl: { scrollTop: 0 },
	});
}

beforeEach(() => {
	queue.length = 0;
});

describe('refreshMoveButtons', () => {
	it('disables both buttons on a single-item queue', () => {
		const a = makeItem('a');
		queue.push(a);
		refreshMoveButtons();
		expect(a.moveUpBtn.disabled).toBe(true);
		expect(a.moveDownBtn.disabled).toBe(true);
	});

	it('only enables the inward-facing button at each end of a multi-item queue', () => {
		const [a, b, c] = [makeItem('a'), makeItem('b'), makeItem('c')];
		queue.push(a, b, c);
		refreshMoveButtons();
		expect(a.moveUpBtn.disabled).toBe(true);
		expect(a.moveDownBtn.disabled).toBe(false);
		expect(b.moveUpBtn.disabled).toBe(false);
		expect(b.moveDownBtn.disabled).toBe(false);
		expect(c.moveUpBtn.disabled).toBe(false);
		expect(c.moveDownBtn.disabled).toBe(true);
	});

	it('disables both buttons for an item hidden by the active filter', () => {
		const [a, b, c] = [makeItem('a'), makeItem('b', true), makeItem('c')];
		queue.push(a, b, c);
		refreshMoveButtons();
		expect(b.moveUpBtn.disabled).toBe(true);
		expect(b.moveDownBtn.disabled).toBe(true);
	});

	it('scopes first/last to the visible list, not the raw queue', () => {
		// b is hidden, so amongst the *visible* items a is first and c is last -
		// even though c isn't last in the raw `queue` array.
		const [a, b, c, d] = [
			makeItem('a'),
			makeItem('b', true),
			makeItem('c'),
			makeItem('d', true),
		];
		queue.push(a, b, c, d);
		refreshMoveButtons();
		expect(a.moveUpBtn.disabled).toBe(true);
		expect(c.moveDownBtn.disabled).toBe(true);
		expect(c.moveUpBtn.disabled).toBe(false);
	});

	it('correctly disables move buttons across a large, realistic mix of hidden/visible items', () => {
		// Independently recomputes expected disabled state per item, so a
		// future edit to refreshMoveButtons() can't silently change which
		// buttons get disabled.
		const items = Array.from({ length: 40 }, (_, i) =>
			makeItem(`item-${i}`, i % 3 === 0),
		);
		queue.push(...items);
		refreshMoveButtons();

		const visible = items.filter((item) => !item.section.hidden);
		for (const item of items) {
			const index = visible.indexOf(item);
			const isVisible = index !== -1;
			expect(item.moveUpBtn.disabled).toBe(!isVisible || index === 0);
			expect(item.moveDownBtn.disabled).toBe(
				!isVisible || index === visible.length - 1,
			);
		}
	});
});

describe('moveBlock', () => {
	it('swaps two adjacent visible items and updates their move buttons', () => {
		const [a, b, c] = [makeItem('a'), makeItem('b'), makeItem('c')];
		queue.push(a, b, c);
		refreshMoveButtons();

		moveBlock(b, 'up');

		expect(queue.map((i) => i.id)).toEqual(['b', 'a', 'c']);
		expect(b.moveUpBtn.disabled).toBe(true);
		expect(a.moveDownBtn.disabled).toBe(false);
	});

	it('moves relative to the nearest visible neighbor, skipping hidden items', () => {
		const [a, b, c] = [makeItem('a'), makeItem('b', true), makeItem('c')];
		queue.push(a, b, c);
		refreshMoveButtons();

		moveBlock(c, 'up');

		// c's nearest *visible* neighbor is a, not b - b stays where it was
		// relative to the move.
		expect(queue.map((i) => i.id)).toEqual(['c', 'a', 'b']);
	});

	it('is a no-op at the visible boundary', () => {
		const [a, b] = [makeItem('a'), makeItem('b')];
		queue.push(a, b);
		refreshMoveButtons();

		moveBlock(a, 'up');

		expect(queue.map((i) => i.id)).toEqual(['a', 'b']);
	});
});
