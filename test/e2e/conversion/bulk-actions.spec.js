import { test, expect } from '../support/test.js';
import { TEXT } from '../../../src/js/constants/messages.js';
import { isoBytes } from '../support/test-data.js';
import { installWorkerHarness } from '../../utils/worker-harness.js';

/**
 * @import { QueuePage } from '../pages/queue-page.js'
 * @import { Locator } from '@playwright/test'
 */

// Covers the bulk-actions toolbar: the "Select All" checkbox, the derived
// batch buttons (convert/pause/cancel/remove), and their bookkeeping
// around visible (not filtered-out) items.

/**
 * Adds one idle queue item. Every fixture here shares the same isoBytes
 * content, so once inspection resolves every item's title converges on the
 * same wasm-parsed game title and a text filter can no longer tell items
 * apart - addSource() already resolves the added item by its stable id
 * rather than position or title, so no extra bookkeeping is needed here.
 * @param {QueuePage} queuePage
 * @param {string} name
 * @returns {Promise<Locator>}
 */
async function addIdleItem(queuePage, name) {
	return queuePage.addSource({
		name,
		mimeType: 'application/octet-stream',
		buffer: Buffer.from(isoBytes.buffer),
	});
}

test.describe('bulk actions - Select All checkbox', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('is disabled and unchecked on load, with an empty queue', async ({
		queuePage,
	}) => {
		await expect(queuePage.selectAllCheckbox).toBeDisabled();
		await expect(queuePage.selectAllCheckbox).not.toBeChecked();
	});

	test('becomes enabled once an item is queued, and stays unchecked until used', async ({
		queuePage,
	}) => {
		const item = await addIdleItem(queuePage, 'a.iso');
		await expect(queuePage.status(item)).toContainText(TEXT.QUEUED, {
			timeout: 15_000,
		});
		await expect(queuePage.selectAllCheckbox).toBeEnabled();
		await expect(queuePage.selectAllCheckbox).not.toBeChecked();
		await expect(queuePage.selectedCount).toHaveText('(0 selected)');
	});

	test('checking it selects every visible item, and reflects the count', async ({
		queuePage,
	}) => {
		const itemA = await addIdleItem(queuePage, 'a.iso');
		const itemB = await addIdleItem(queuePage, 'b.iso');
		await queuePage.expectAllQueued(queuePage.items, { timeout: 15_000 });

		await queuePage.selectAllCheckbox.check();

		await expect(queuePage.selectCheckbox(itemA)).toBeChecked();
		await expect(queuePage.selectCheckbox(itemB)).toBeChecked();
		await expect(queuePage.selectedCount).toHaveText('(2 selected)');
	});

	test('unchecking one item drops Select All to indeterminate, not unchecked', async ({
		queuePage,
	}) => {
		const itemA = await addIdleItem(queuePage, 'a.iso');
		await addIdleItem(queuePage, 'b.iso');
		await queuePage.expectAllQueued(queuePage.items, { timeout: 15_000 });
		await queuePage.selectAllCheckbox.check();

		await queuePage.selectCheckbox(itemA).uncheck();

		await expect(queuePage.selectAllCheckbox).not.toBeChecked();
		await expect(queuePage.selectAllCheckbox).toHaveJSProperty(
			'indeterminate',
			true,
		);
		await expect(queuePage.selectedCount).toHaveText('(1 selected)');
	});

	test('is disabled when the active filter hides every item, even though the queue is not empty', async ({
		queuePage,
	}) => {
		await addIdleItem(queuePage, 'a.iso');
		await addIdleItem(queuePage, 'b.iso');
		await queuePage.expectAllQueued(queuePage.items, { timeout: 15_000 });
		await expect(queuePage.selectAllCheckbox).toBeEnabled();

		// Both items are 'idle'; a 'done' filter matches neither, hiding both.
		await queuePage.filterDone.click();

		await expect(queuePage.items).toHaveCount(2); // still in the DOM
		await expect(queuePage.selectAllCheckbox).toBeDisabled();
		await expect(queuePage.selectAllCheckbox).not.toBeChecked();
		await expect(queuePage.selectedCount).toHaveText('(0 selected)');

		await queuePage.filterDone.click();
		await expect(queuePage.selectAllCheckbox).toBeEnabled();
	});

	test('checking Select All while filtered only selects the currently visible items', async ({
		queuePage,
	}) => {
		const itemA = await addIdleItem(queuePage, 'a.iso');
		const itemB = await addIdleItem(queuePage, 'b.iso');
		await queuePage.expectAllQueued(queuePage.items, { timeout: 15_000 });

		await queuePage.convert(itemA);
		await expect(queuePage.status(itemA)).toContainText(TEXT.CONVERTING(), {
			timeout: 15_000,
		});
		// Pause immediately so a.iso is deterministically parked, rather than
		// racing real conversion speed against the filter + select-all below.
		await queuePage.pauseBtn(itemA).click();
		await expect(queuePage.status(itemA)).toContainText(TEXT.PAUSED(), {
			timeout: 15_000,
		});

		await queuePage.filterPaused.click();
		await expect(queuePage.selectCheckbox(itemB)).toBeHidden();
		await queuePage.selectAllCheckbox.check();
		await expect(queuePage.selectCheckbox(itemA)).toBeChecked();
		await expect(queuePage.selectedCount).toHaveText('(1 selected)');

		// b.iso reappears unchecked once the filter clears - Select All never
		// touched it while it was hidden.
		await queuePage.filterPaused.click();
		await expect(queuePage.selectCheckbox(itemB)).not.toBeChecked();
		await expect(queuePage.selectAllCheckbox).not.toBeChecked(); // indeterminate, not "all"

		await queuePage.cancelBtn(itemA).click();
	});

	test('removing the only queued item disables Select All again', async ({
		queuePage,
	}) => {
		const item = await addIdleItem(queuePage, 'a.iso');
		await expect(queuePage.status(item)).toContainText(TEXT.QUEUED, {
			timeout: 15_000,
		});
		await queuePage.selectAllCheckbox.check();
		await expect(queuePage.selectAllCheckbox).toBeChecked();

		await queuePage.removeBtn(item).click();

		await expect(queuePage.items).toHaveCount(0);
		await expect(queuePage.selectAllCheckbox).toBeDisabled();
		await expect(queuePage.selectAllCheckbox).not.toBeChecked();
		await expect(queuePage.selectedCount).toHaveText('(0 selected)');
	});
});

test.describe('bulk actions - batch buttons follow selection + status', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('batch buttons stay disabled until an eligible item is selected', async ({
		queuePage,
	}) => {
		const itemA = await addIdleItem(queuePage, 'a.iso');
		await expect(queuePage.status(itemA)).toContainText(TEXT.QUEUED, {
			timeout: 15_000,
		});

		await expect(queuePage.batchConvertBtn).toBeDisabled();
		await expect(queuePage.batchPauseBtn).toBeDisabled();
		await expect(queuePage.batchCancelBtn).toBeDisabled();
		await expect(queuePage.batchRemoveBtn).toBeDisabled();

		await queuePage.selectCheckbox(itemA).check();

		// Idle item selected: convert + remove make sense, pause/cancel don't.
		await expect(queuePage.batchConvertBtn).toBeEnabled();
		await expect(queuePage.batchRemoveBtn).toBeEnabled();
		await expect(queuePage.batchPauseBtn).toBeDisabled();
		await expect(queuePage.batchCancelBtn).toBeDisabled();
	});

	test('Batch Remove only removes selected items and leaves the rest untouched', async ({
		queuePage,
	}) => {
		const itemA = await addIdleItem(queuePage, 'a.iso');
		await addIdleItem(queuePage, 'b.iso');
		await queuePage.expectAllQueued(queuePage.items, { timeout: 15_000 });

		await queuePage.selectCheckbox(itemA).check();
		await queuePage.batchRemoveBtn.click();

		// Removing a.iso shifts b.iso into position 0, so identity is
		// asserted structurally (one survivor, unselected) rather than by
		// title text - both fixtures parse to the same detected title.
		await expect(queuePage.items).toHaveCount(1);
		const survivor = queuePage.itemAt(0);
		await expect(queuePage.selectCheckbox(survivor)).not.toBeChecked();
		await expect(queuePage.selectAllCheckbox).not.toBeChecked();
		await expect(queuePage.selectedCount).toHaveText('(0 selected)');
	});

	// batch-remove filters out running/paused, so a mixed selection must
	// remove only the eligible item.
	test('Batch Remove skips selected items that are mid-conversion', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const itemA = await addIdleItem(queuePage, 'a.iso');
		await addIdleItem(queuePage, 'b.iso');
		await queuePage.expectAllQueued(queuePage.items, { timeout: 15_000 });

		await queuePage.convert(itemA);
		await expect(queuePage.status(itemA)).toContainText(TEXT.CONVERTING(), {
			timeout: 15_000,
		});
		// Pause immediately so a.iso is deterministically parked mid-conversion,
		// instead of racing the worker to completion before batch-remove fires.
		await queuePage.pauseBtn(itemA).click();
		await expect(queuePage.status(itemA)).toContainText(TEXT.PAUSED(), {
			timeout: 15_000,
		});

		await queuePage.selectAllCheckbox.check();
		await queuePage.batchRemoveBtn.click();

		// b.iso is removed and itemA's position is unaffected, so the same
		// Locator (captured at index 0) is still valid.
		await expect(queuePage.items).toHaveCount(1);
		await expect(itemA).toBeVisible();
		await expect(queuePage.status(itemA)).toContainText(TEXT.PAUSED());

		await queuePage.cancelBtn(itemA).click();
	});
});

// #batch-pause-btn applies one uniform action to the whole selection,
// decided once per click from the selection's current state as a whole -
// not each item toggling its own status independently (which would pause
// some and resume others out of the same click on a mixed selection).
test.describe('bulk actions - Batch Pause applies one action to the whole selection', () => {
	// Pinned well above the 2 items used below so both can hold a
	// conversion slot at once - the mixed-selection test needs itemA and
	// itemB genuinely running side by side, not racing each other for a
	// single slot on a low-core host (which would leave the loser stuck
	// 'idle'/awaitingSlot instead of 'converting').
	const PINNED_HARDWARE_CONCURRENCY = 4;

	test.beforeEach(async ({ page, queuePage }) => {
		// Delay worker 'message' delivery so the pause/resume/pause round trip
		// below has slack to land before this fast fixture finishes.
		await page.addInitScript(installWorkerHarness, {
			hardwareConcurrency: PINNED_HARDWARE_CONCURRENCY,
			delayMessagesMs: 250,
		});
		await queuePage.goto();
	});

	test('Batch Pause pauses a running selected item, and clicking it again resumes that same item', async ({
		queuePage,
	}) => {
		test.setTimeout(30_000);
		const itemA = await addIdleItem(queuePage, 'a.iso');
		await expect(queuePage.status(itemA)).toContainText(TEXT.QUEUED, {
			timeout: 15_000,
		});

		await queuePage.selectCheckbox(itemA).check();
		await queuePage.batchConvertBtn.click();
		await expect(queuePage.status(itemA)).toContainText(TEXT.CONVERTING(), {
			timeout: 15_000,
		});
		await expect(queuePage.batchPauseBtn).toHaveText(TEXT.BATCH_PAUSE);

		await queuePage.batchPauseBtn.click();
		await expect(queuePage.status(itemA)).toContainText(TEXT.PAUSED(), {
			timeout: 15_000,
		});
		await expect(queuePage.pauseBtn(itemA)).toHaveText(TEXT.RESUME);
		await expect(queuePage.batchPauseBtn).toHaveText(TEXT.BATCH_RESUME);

		// Same button, same still-checked selection - resumes rather than
		// pausing again, since every selected item is now already paused.
		await queuePage.batchPauseBtn.click();
		await expect(queuePage.status(itemA)).toContainText(TEXT.CONVERTING(), {
			timeout: 15_000,
		});
		await expect(queuePage.pauseBtn(itemA)).toHaveText(TEXT.PAUSE);
		await expect(queuePage.batchPauseBtn).toHaveText(TEXT.BATCH_PAUSE);

		await queuePage.cancelBtn(itemA).click();
	});

	test('a mixed running+paused selection is pulled uniformly to paused, not toggled per item', async ({
		queuePage,
	}) => {
		test.setTimeout(30_000);
		const itemA = await addIdleItem(queuePage, 'a.iso');
		const itemB = await addIdleItem(queuePage, 'b.iso');
		await queuePage.expectAllQueued(queuePage.items, { timeout: 15_000 });

		await queuePage.selectAllCheckbox.check();
		await queuePage.batchConvertBtn.click();
		await expect(queuePage.status(itemA)).toContainText(TEXT.CONVERTING(), {
			timeout: 15_000,
		});
		await expect(queuePage.status(itemB)).toContainText(TEXT.CONVERTING(), {
			timeout: 15_000,
		});

		// This fixture converts in under a second, so freeze only A and
		// fire Batch Pause immediately after, with no assertions in
		// between - B stays genuinely running throughout, giving a real
		// mixed selection without ever resuming anything mid-test (which
		// would race a resumed item's real completion against the next
		// click - not reliably winnable under CPU contention).
		await queuePage.pauseBtn(itemA).click();
		await queuePage.batchPauseBtn.click();

		// Correct: both end up paused. The old per-item toggle bug would
		// instead flip A back to running (it was already paused) and B to
		// paused, swapping their states instead of unifying them.
		await expect(queuePage.status(itemA)).toContainText(TEXT.PAUSED(), {
			timeout: 15_000,
		});
		await expect(queuePage.status(itemB)).toContainText(TEXT.PAUSED(), {
			timeout: 15_000,
		});
		await expect(queuePage.batchPauseBtn).toHaveText(TEXT.BATCH_RESUME);

		// Every selected item is now paused, so the next click resumes both.
		await queuePage.batchPauseBtn.click();
		await expect(queuePage.status(itemA)).toHaveAttribute(
			'data-status',
			'running',
			{ timeout: 15_000 },
		);
		await expect(queuePage.status(itemB)).toHaveAttribute(
			'data-status',
			'running',
			{ timeout: 15_000 },
		);
		await expect(queuePage.batchPauseBtn).toHaveText(TEXT.BATCH_PAUSE);

		await queuePage.cancelBtn(itemA).click();
		await queuePage.cancelBtn(itemB).click();
	});
});
