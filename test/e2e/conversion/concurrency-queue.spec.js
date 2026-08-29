import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect } from '../support/test.js';
import { TEXT } from '../../../src/js/constants/messages.js';
import {
	makeFixture,
	XGD3_ROOT_OFFSET,
	UNKNOWN_TITLE_ID,
} from '../support/test-data.js';
import { installWorkerHarness } from '../../utils/worker-harness.js';

/**
 * @import { Locator } from '@playwright/test'
 * @import { QueuePage } from '../pages/queue-page.js'
 */

/**
 * @typedef {object} AddedItem
 * @property {string} name - the on-disk filename this item was added from.
 * @property {string} id - the item's stable data-item-id.
 * @property {Locator} item - the item, located by id (queuePage.itemById()).
 */

// Pinned so MAX_CONCURRENT matches what the app reads from
// navigator.hardwareConcurrency, regardless of host/CI core count or
// browser engine (Firefox doesn't always mirror Chromium's value).
const PINNED_HARDWARE_CONCURRENCY = 4;
const MAX_CONCURRENT = Math.max(1, PINNED_HARDWARE_CONCURRENCY - 1);

const isoBytes = makeFixture({
	rootOffset: XGD3_ROOT_OFFSET,
	titleId: UNKNOWN_TITLE_ID,
});

/** @type {string} */
let fixtureDir;
/** @type {string} */
let basePath;

test.beforeAll(() => {
	fixtureDir = fs.mkdtempSync(path.join(tmpdir(), 'iso2x-fixtures-'));
	basePath = path.join(fixtureDir, '__base.iso');
	fs.writeFileSync(basePath, isoBytes);
});

test.afterAll(() => {
	fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/** @param {string} name */
function fixturePathFor(name) {
	const namedPath = path.join(fixtureDir, name);
	if (!fs.existsSync(namedPath)) fs.copyFileSync(basePath, namedPath);
	return namedPath;
}

/**
 * Adds one idle queue item from a real on-disk fixture path.
 * Returns { name, id, item } instead of just the item since
 * every item here shares the same detected title once resolved,
 * so text-based lookup (itemByText) stops working -
 * see namesInOrder() below.
 * @param {QueuePage} queuePage
 * @param {string} name
 * @returns {Promise<AddedItem>}
 */
async function addIdleItem(queuePage, name) {
	const [id] = await queuePage.idsAddedBy(async () => {
		await queuePage.sourceInput.setInputFiles(fixturePathFor(name));
		await queuePage.addBtn.click();
	});
	const item = queuePage.itemById(id);
	await queuePage.expectQueued(item, { timeout: 15_000 });
	return { name, id, item };
}

/**
 * Current on-screen item order, by name - resolved via each item's stable
 * id, not displayed title text (which converges once items share a
 * detected game title). `entries` must cover every item in the queue.
 * @param {QueuePage} queuePage
 * @param {AddedItem[]} entries
 * @returns {Promise<(string | undefined)[]>}
 */
async function namesInOrder(queuePage, entries) {
	const nameById = new Map(entries.map((e) => [e.id, e.name]));
	const ids = await queuePage.allItemIds();
	return ids.map((id) => nameById.get(id));
}

/**
 * Items currently holding a conversion slot (running or paused) - a
 * waiting item has no controller yet, so its pause button stays hidden.
 * @param {QueuePage} queuePage
 * @returns {Locator}
 */
function holdsASlot(queuePage) {
	return queuePage.items.filter({
		has: queuePage.page.locator(
			'[data-testid="queue-item-pause-btn"]:not([hidden])',
		),
	});
}

/** @param {number} i */
function isoName(i) {
	return `q${String(i).padStart(2, '0')}.iso`;
}

/** @param {number} count */
function isoNames(count) {
	return Array.from({ length: count }, (_, i) => isoName(i));
}

/**
 * Adds `names.length` items, batch-converts them all, then immediately
 * batch-pauses whatever grabbed a slot. Returns each item's
 * { name, id, item } in `names` order. Waits on holdsASlot() reaching
 * MAX_CONCURRENT rather than a timer - slot grants are synchronous, but
 * this fixture converts in well under a second so a fixed delay would be
 * racy.
 * @param {QueuePage} queuePage
 * @param {string[]} names
 * @returns {Promise<AddedItem[]>}
 */
async function addAndConvertAllFrozen(queuePage, names) {
	/** @type {AddedItem[]} */
	const entries = [];
	for (const name of names) entries.push(await addIdleItem(queuePage, name));
	await queuePage.selectAllCheckbox.check();
	await queuePage.batchConvertBtn.click();
	await expect(holdsASlot(queuePage)).toHaveCount(MAX_CONCURRENT, {
		timeout: 15_000,
	});
	await queuePage.batchPauseBtn.click();
	await expect(queuePage.statusesWithKey('paused')).toHaveCount(MAX_CONCURRENT, {
		timeout: 15_000,
	});
	return entries;
}

/**
 * Snapshots cancellable item ids so each item is cancelled by stable id,
 * avoiding target invalidation as the collection mutates concurrently.
 * @param {QueuePage} queuePage
 */
async function cancelAllRunning(queuePage) {
	const ids = await queuePage.allItemIds();
	const deadline = Date.now() + 20_000;
	/** @type {unknown} */
	let lastError;

	for (const id of ids) {
		const item = queuePage.itemById(id);
		const cancelBtn = item.getByRole('button', { name: 'Cancel' });
		while (await cancelBtn.isVisible().catch(() => false)) {
			if (Date.now() > deadline) {
				throw new Error(
					`cancelAllRunning: still stuck on item ${id} after 20s; ` +
						`last click error: ${lastError}`,
				);
			}
			try {
				await cancelBtn.click({ timeout: 2_000 });
			} catch (err) {
				lastError = err;
			}
		}
	}
}

test.describe('concurrency slot queue', () => {
	test.beforeEach(async ({ page, queuePage }) => {
		// Pin hardwareConcurrency (see above) and delay worker messages so
		// the pause/resume click sequences below have room to land before
		// this fast fixture finishes on its own.
		await page.addInitScript(installWorkerHarness, {
			hardwareConcurrency: PINNED_HARDWARE_CONCURRENCY,
			delayMessagesMs: 250,
		});
		await queuePage.goto();
	});

	test.afterEach(async ({ queuePage }) => {
		await cancelAllRunning(queuePage);
	});

	test('only MAX_CONCURRENT items convert at a time; the rest wait for a slot', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const names = isoNames(MAX_CONCURRENT + 2);
		const entries = await addAndConvertAllFrozen(queuePage, names);
		await expect(holdsASlot(queuePage)).toHaveCount(MAX_CONCURRENT);
		// Every submitted item reads as active: paused (a slot-holder we
		// just froze), running, or awaiting a slot.
		await expect(
			queuePage.statusesWithKey('running', 'paused', 'awaitingSlot'),
		).toHaveCount(names.length);
		for (const { item } of entries.slice(MAX_CONCURRENT)) {
			await expect(queuePage.convertBtn(item)).toBeDisabled();
		}
		// Cancelling the first slot-holder promotes the next item (FIFO);
		// freeze it too so the final count check isn't racing it.
		await queuePage.cancelBtn(entries[0].item).click();
		const promoted = entries[MAX_CONCURRENT].item;
		await expect(queuePage.status(promoted)).toContainText(TEXT.CONVERTING(), {
			timeout: 15_000,
		});
		await queuePage.pauseBtn(promoted).click();
		await expect(queuePage.status(promoted)).toContainText(TEXT.PAUSED(), {
			timeout: 15_000,
		});
		await expect(holdsASlot(queuePage)).toHaveCount(MAX_CONCURRENT);
	});

	test('a waiting item reads as waiting (muted, cancel available, pause hidden), not idle', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const names = isoNames(MAX_CONCURRENT + 1);
		const entries = await addAndConvertAllFrozen(queuePage, names);
		const waiterItem = entries[MAX_CONCURRENT].item;
		const waiterStatus = queuePage.status(waiterItem);
		await expect(waiterStatus).toHaveClass(/queue-item__status--awaiting-slot/);
		await expect(waiterStatus).toContainText(TEXT.WAITING);
		await expect(queuePage.cancelBtn(waiterItem)).toBeVisible();
		await expect(queuePage.pauseBtn(waiterItem)).toBeHidden();
		await expect(queuePage.gameTitleInput(waiterItem)).toBeDisabled();
		// By identity (.and()), not by filtering on name/text - same
		// convergence risk as itemByText().
		await expect(holdsASlot(queuePage).and(waiterItem)).toHaveCount(0);
	});

	test('cancelling a waiting item removes it from the wait line without consuming a slot', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const names = isoNames(MAX_CONCURRENT + 1);
		const entries = await addAndConvertAllFrozen(queuePage, names);
		const waiterItem = entries[MAX_CONCURRENT].item;
		await queuePage.cancelBtn(waiterItem).click();
		await expect(queuePage.status(waiterItem)).toContainText(TEXT.CANCELLED);
		await expect(holdsASlot(queuePage)).toHaveCount(MAX_CONCURRENT);
	});

	test('batch convert on many selected items still honors the concurrency limit', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const names = isoNames(MAX_CONCURRENT + 2);
		await addAndConvertAllFrozen(queuePage, names);
		await expect(holdsASlot(queuePage)).toHaveCount(MAX_CONCURRENT);
	});

	test('a waiting item is not eligible for Batch Remove until it is cancelled first', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const names = isoNames(MAX_CONCURRENT + 1);
		const entries = await addAndConvertAllFrozen(queuePage, names);
		await queuePage.selectAllCheckbox.check();
		await expect(queuePage.batchRemoveBtn).toBeDisabled();
		await expect(queuePage.items).toHaveCount(names.length);
		await queuePage.cancelBtn(entries[MAX_CONCURRENT].item).click();
		await queuePage.selectAllCheckbox.check();
		await queuePage.batchRemoveBtn.click();
		await expect(queuePage.items).toHaveCount(MAX_CONCURRENT);
	});

	// Regression test: cancelling a slot-holder frees its slot
	// synchronously, which can synchronously promote the next waiting
	// item (see queue.js's createSlotQueue) before a batch-cancel loop
	// still in progress has reached that item. Selecting more items than
	// MAX_CONCURRENT guarantees the loop has both slot-holders (paused,
	// from addAndConvertAllFrozen) and waiters in the same click, so this
	// race is reliably exercised.
	test('mass cancel on a selection larger than the concurrency cap cancels everything in a single click', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const names = isoNames(MAX_CONCURRENT + 2);
		const entries = await addAndConvertAllFrozen(queuePage, names);
		await expect(holdsASlot(queuePage)).toHaveCount(MAX_CONCURRENT);

		await queuePage.selectAllCheckbox.check();
		await queuePage.batchCancelBtn.click();

		// One click, no retry: every item - both former slot-holders and
		// former waiters - reads as cancelled. Before the fix, a promoted
		// waiter could resurrect into 'running' instead, requiring a
		// second Cancel click to catch it.
		for (const { item } of entries) {
			await expect(queuePage.status(item)).toContainText(TEXT.CANCELLED, {
				timeout: 10_000,
			});
		}
		await expect(holdsASlot(queuePage)).toHaveCount(0);
		await expect(
			queuePage.statusesWithKey('running', 'awaitingSlot'),
		).toHaveCount(0);
	});
});

test.describe('queue priority reordering', () => {
	test.beforeEach(async ({ page, queuePage }) => {
		// Pin hardwareConcurrency and delay worker messages -
		// 'moving a waiting item...' below freezes real running
		// conversions via addAndConvertAllFrozen(), which converts in
		// well under a second undelayed (see that fixture's docstring),
		// so pause/cancel clicks need room to land.
		await page.addInitScript(installWorkerHarness, {
			hardwareConcurrency: PINNED_HARDWARE_CONCURRENCY,
			delayMessagesMs: 250,
		});
		await queuePage.goto();
	});

	test.afterEach(async ({ queuePage }) => {
		await cancelAllRunning(queuePage);
	});

	test('move-up/move-down reorder the visible list', async ({ queuePage }) => {
		const a = await addIdleItem(queuePage, 'a.iso');
		const b = await addIdleItem(queuePage, 'b.iso');
		const c = await addIdleItem(queuePage, 'c.iso');
		const entries = [a, b, c];
		expect(await namesInOrder(queuePage, entries)).toEqual([
			'a.iso',
			'b.iso',
			'c.iso',
		]);
		await queuePage.moveUpBtn(c.item).click();
		expect(await namesInOrder(queuePage, entries)).toEqual([
			'a.iso',
			'c.iso',
			'b.iso',
		]);
		await queuePage.moveUpBtn(c.item).click();
		expect(await namesInOrder(queuePage, entries)).toEqual([
			'c.iso',
			'a.iso',
			'b.iso',
		]);
		await queuePage.moveDownBtn(c.item).click();
		expect(await namesInOrder(queuePage, entries)).toEqual([
			'a.iso',
			'c.iso',
			'b.iso',
		]);
	});

	test('the top item has move-up disabled and the bottom item has move-down disabled', async ({
		queuePage,
	}) => {
		const { item: itemA } = await addIdleItem(queuePage, 'a.iso');
		const { item: itemB } = await addIdleItem(queuePage, 'b.iso');
		const { item: itemC } = await addIdleItem(queuePage, 'c.iso');
		await expect(queuePage.moveUpBtn(itemA)).toBeDisabled();
		await expect(queuePage.moveDownBtn(itemA)).toBeEnabled();
		await expect(queuePage.moveUpBtn(itemB)).toBeEnabled();
		await expect(queuePage.moveDownBtn(itemB)).toBeEnabled();
		await expect(queuePage.moveUpBtn(itemC)).toBeEnabled();
		await expect(queuePage.moveDownBtn(itemC)).toBeDisabled();
	});

	test('removing the top item promotes the next item to a disabled move-up button', async ({
		queuePage,
	}) => {
		const { item: itemA } = await addIdleItem(queuePage, 'a.iso');
		const { item: itemB } = await addIdleItem(queuePage, 'b.iso');
		await queuePage.removeBtn(itemA).click();
		await expect(queuePage.moveUpBtn(itemB)).toBeDisabled();
		await expect(queuePage.moveDownBtn(itemB)).toBeDisabled();
	});

	test('moveQueueItem refuses to move past the boundary even if the button is force-enabled', async ({
		queuePage,
	}) => {
		const a = await addIdleItem(queuePage, 'a.iso');
		const b = await addIdleItem(queuePage, 'b.iso');
		await queuePage.moveUpBtn(a.item).evaluate(
			/** @param {HTMLButtonElement} btn */
			(btn) => {
				btn.disabled = false;
			},
		);
		await queuePage.moveUpBtn(a.item).click();
		expect(await namesInOrder(queuePage, [a, b])).toEqual(['a.iso', 'b.iso']);
	});

	test('moving a waiting item to the front of the queue gives it priority for the next free slot', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const names = isoNames(MAX_CONCURRENT + 2);
		const waiterB = names[MAX_CONCURRENT];
		const waiterC = names[MAX_CONCURRENT + 1];
		const entries = await addAndConvertAllFrozen(queuePage, names);
		const waiterCItem = entries[MAX_CONCURRENT + 1].item;
		await queuePage.moveUpBtn(waiterCItem).click();
		await queuePage.moveUpBtn(waiterCItem).click();
		expect(await namesInOrder(queuePage, entries)).toEqual([
			...names.slice(0, MAX_CONCURRENT - 1),
			waiterC,
			names[MAX_CONCURRENT - 1],
			waiterB,
		]);
		await queuePage.cancelBtn(entries[0].item).click();
		// Same item just moved to the front, so it's the one promoted here.
		const promoted = waiterCItem;
		await expect(queuePage.status(promoted)).toContainText(TEXT.CONVERTING(), {
			timeout: 15_000,
		});
		await queuePage.pauseBtn(promoted).click();
		await expect(queuePage.status(promoted)).toContainText(TEXT.PAUSED(), {
			timeout: 15_000,
		});
		await expect(
			queuePage.convertBtn(entries[MAX_CONCURRENT].item),
		).toBeDisabled();
		await expect(holdsASlot(queuePage)).toHaveCount(MAX_CONCURRENT);
	});
});
