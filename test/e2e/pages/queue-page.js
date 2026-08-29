import { expect } from '@playwright/test';
import { TEXT } from '../../../src/js/constants/messages.js';
import { EVENTS } from '../../../src/js/core/protocol.js';

/**
 * @import { Page, Locator } from '@playwright/test'
 * @import { OutputFormat, ModeTargetFormat } from '../../../src/types/global'
 */

/** @param {string[]} ids */
function assertSingleId(ids) {
	expect(
		ids,
		'addSource() expects exactly one item - use idsAddedBy() directly for a multi-item add',
	).toHaveLength(1);
}

export class QueuePage {
	/** @param {Page} page */
	constructor(page) {
		this.page = page;

		this.sourceInput = page.locator('#source-input');
		this.addBtn = page.locator('#add-btn');
		this.folderInput = page.locator('#folder-input');
		this.addFolderBtn = page.locator('#add-folder-btn');

		this.selectAllCheckbox = page.locator('#select-all-checkbox');
		this.selectedCount = page.locator('#selected-count');
		this.batchConvertBtn = page.locator('#batch-convert-btn');
		this.batchPauseBtn = page.locator('#batch-pause-btn');
		this.batchCancelBtn = page.locator('#batch-cancel-btn');
		this.batchRemoveBtn = page.locator('#batch-remove-btn');

		this.filterDone = page.locator('#filter-done');
		this.filterPaused = page.locator('#filter-paused');

		this.defaultAttachXbeCheckbox = page.locator('#default-attach-xbe');
		this.defaultAllowedMediaPatchCheckbox = page.locator(
			'#default-extracted-allowed-media-patch',
		);
		this.defaultRenameTitleCheckbox = page.locator(
			'#default-extracted-rename-title',
		);
		this.defaultGodKeyvaultInput = page.locator('#ephemeral-god-keyvault');
		this.defaultGodSignCheckbox = page.locator('#default-god-sign');
		this.defaultGodDeviceIdInput = page.locator('#default-god-device-id');
		this.defaultGodDeviceIdError = page.locator('.default-god-device-id-error');
		this.defaultGodDeviceIdClearBtn = page
			.locator('.clearable-input', {
				has: page.locator('#default-god-device-id'),
			})
			.locator('.clearable-input__clear-btn');
		// Settings panel has no id - targeted by its <summary> text.
		this.settingsSummary = page
			.locator('details', {
				has: page.locator('summary', { hasText: 'Settings' }),
			})
			.locator('summary');

		this.items = page.getByTestId('queue-item');
	}

	async goto() {
		await this.page.goto('/');
		await this.page.evaluate(() => navigator.serviceWorker.ready);
	}

	/** Reloads the app and waits for the service worker to be ready again. */
	async reload() {
		await this.page.reload();
		await this.page.evaluate(() => navigator.serviceWorker.ready);
	}

	/** Opens the (initially collapsed) global Settings panel. */
	async openSettings() {
		await this.settingsSummary.click();
	}

	// -- Item identity ----------------------------------------------------------
	//
	// Every queue item carries a stable data-item-id (see queueFileInput.js).
	// Prefer itemById() over itemAt()/itemByText() in new tests: an id
	// survives reordering and filtering, which position/text-matching can't.

	/** @returns {Promise<string[]>} every current item's data-item-id, in DOM order */
	async allItemIds() {
		return this.items.evaluateAll((els) =>
			els.map((el) => /** @type {HTMLElement} */ (el).dataset.itemId ?? ''),
		);
	}

	/**
	 * A queue item by its stable id. Preferred over itemAt()/itemByText().
	 * @param {string} id
	 */
	itemById(id) {
		return this.items.and(this.page.locator(`[data-item-id="${id}"]`));
	}

	/**
	 * Runs `action` and returns the id(s) of whatever it added, driven by
	 * the app's QUEUE_ITEMS_ADDED signal rather than a before/after DOM
	 * diff - `action()` resolves as soon as the click fires, well before
	 * addToQueue() has actually run, so a diff taken right after can miss
	 * items. The listener is attached before `action()` runs to close
	 * that race.
	 * @param {() => Promise<void>} action
	 * @returns {Promise<string[]>}
	 */
	async idsAddedBy(action) {
		await this.page.evaluate((eventName) => {
			window.__queueItemsAdded = new Promise((resolve) => {
				window.addEventListener(
					eventName,
					(e) =>
						resolve(/** @type {CustomEvent<{ ids: string[] }>} */ (e).detail.ids),
					{ once: true },
				);
			});
		}, EVENTS.QUEUE_ITEMS_ADDED);

		await action();

		return /** @type {Promise<string[]>} */ (
			this.page.evaluate(() => window.__queueItemsAdded)
		);
	}

	/**
	 * Substring-matches, so it can over-match against another item whose
	 * title contains this one as a prefix. Prefer itemById() once an id
	 * is available.
	 * @param {string | RegExp} text
	 */
	itemByText(text) {
		return this.items.filter({ hasText: text });
	}

	/**
	 * Position-based; doesn't survive reordering/removal - prefer itemById().
	 * @param {number} index
	 */
	itemAt(index) {
		return this.items.nth(index);
	}

	// -- Per-item locators ----------------------------------------------------

	/** @param {Locator} item */
	status(item) {
		return item.getByTestId('queue-item-status');
	}
	/** @param {Locator} item */
	title(item) {
		return item.getByTestId('queue-item-title');
	}
	/** @param {Locator} item */
	error(item) {
		return item.getByTestId('queue-item-error');
	}
	/** @param {Locator} item */
	sourceMeta(item) {
		return item.getByTestId('source-meta');
	}
	/** @param {Locator} item */
	sourceMetaTitleId(item) {
		return item.getByTestId('source-meta-title-id');
	}
	/** @param {Locator} item */
	sourceMetaContentType(item) {
		return item.getByTestId('source-meta-content-type');
	}
	/** @param {Locator} item */
	sourceMetaSize(item) {
		return item.getByTestId('source-meta-size');
	}
	/** @param {Locator} item */
	formatSelect(item) {
		return item.getByTestId('queue-item-format-select');
	}
	/** @param {Locator} item */
	gameTitleInput(item) {
		return item.getByTestId('queue-item-game-title');
	}
	/** @param {Locator} item */
	convertBtn(item) {
		return item.getByRole('button', { name: 'Convert' });
	}
	/** @param {Locator} item */
	cancelBtn(item) {
		return item.getByRole('button', { name: 'Cancel' });
	}
	/**
	 * Located by testid, not role name - its accessible name flips between "Pause" and "Resume".
	 * @param {Locator} item
	 */
	pauseBtn(item) {
		return item.getByTestId('queue-item-pause-btn');
	}
	/** @param {Locator} item */
	removeBtn(item) {
		return item.getByRole('button', { name: 'Remove' });
	}
	/** @param {Locator} item */
	moveUpBtn(item) {
		return item.getByRole('button', { name: 'Move up in queue' });
	}
	/** @param {Locator} item */
	moveDownBtn(item) {
		return item.getByRole('button', { name: 'Move down in queue' });
	}
	/** @param {Locator} item */
	selectCheckbox(item) {
		return item.getByTestId('queue-item-select-checkbox');
	}
	/** @param {Locator} item */
	optionsSummary(item) {
		return item.locator('.queue-item__options summary');
	}

	// -- Per-target conversion options ------------------------------------------
	//
	// `data-formats` is a stable, test-and-production-shared contract, not
	// a styling hook.

	/**
	 * @param {Locator} item
	 * @param {ModeTargetFormat | 'extracted'} format
	 */
	optionFor(item, format) {
		return item.locator(`.queue-item__option[data-formats="${format}"]`);
	}
	/**
	 * @param {Locator} item
	 * @param {ModeTargetFormat} format
	 */
	modeSelect(item, format) {
		return this.optionFor(item, format).locator(`.queue-item__${format}-mode`);
	}

	/** @param {Locator} item */
	godKeyvaultInput(item) {
		return this.optionFor(item, 'god').locator('.queue-item__god-keyvault');
	}
	/** @param {Locator} item */
	godSignCheckbox(item) {
		return this.optionFor(item, 'god').locator('.queue-item__god-sign');
	}
	/** @param {Locator} item */
	godDeviceIdInput(item) {
		return this.optionFor(item, 'god').locator('.queue-item__god-device-id');
	}
	/** @param {Locator} item */
	godDeviceIdError(item) {
		return this.optionFor(item, 'god').locator(
			'.queue-item__god-device-id-error',
		);
	}
	/** @param {Locator} item */
	godDeviceIdClearBtn(item) {
		return this.optionFor(item, 'god').locator(
			'.queue-item__god-device-id-clear-btn',
		);
	}

	/**
	 * Reads the selected file's name directly off the input's `.files`.
	 * @param {Locator} item
	 * @returns {Promise<string | undefined>}
	 */
	async godKeyvaultFileName(item) {
		return this.godKeyvaultInput(item).evaluate(
			(el) => /** @type {HTMLInputElement} */ (el).files?.[0]?.name,
		);
	}

	/** @param {Locator} item */
	skipSystemUpdateCheckbox(item) {
		return this.optionFor(item, 'extracted').locator(
			'.queue-item__skip-system-update',
		);
	}
	/** @param {Locator} item */
	attachXbeCheckbox(item) {
		return item.locator('.queue-item__attach-xbe');
	}
	/** @param {Locator} item */
	allowedMediaPatchCheckbox(item) {
		return item.locator('.queue-item__allowed-media-patch');
	}
	/** @param {Locator} item */
	renameTitleCheckbox(item) {
		return item.locator('.queue-item__rename-title');
	}

	// -- Split/multi-part source management ------------------------------------

	/** @param {Locator} item */
	partsPanel(item) {
		return item.getByTestId('queue-item-parts');
	}
	/** @param {Locator} item */
	partsCount(item) {
		return item.getByTestId('queue-item-parts-count');
	}
	/** @param {Locator} item */
	partsVerifyWrap(item) {
		return item.locator('.queue-item__parts-verify');
	}
	/**
	 * Requires index.html's parts-add div to carry data-testid="parts-add".
	 * @param {Locator} item
	 */
	partsAddWrap(item) {
		return item.getByTestId('parts-add');
	}
	/** @param {Locator} item */
	partRows(item) {
		return item.getByTestId('part-row');
	}
	/** @param {Locator} row */
	partRowName(row) {
		return row.getByTestId('part-row-name');
	}
	/** @param {Locator} row */
	partRowStatus(row) {
		return row.getByTestId('part-row-status');
	}
	/** @param {Locator} row */
	partRowRemoveBtn(row) {
		return row.getByTestId('part-row-remove-btn');
	}
	/** @param {Locator} row */
	partRowUpBtn(row) {
		return row.getByRole('button', { name: 'Move earlier' });
	}
	/** @param {Locator} row */
	partRowDownBtn(row) {
		return row.getByRole('button', { name: 'Move later' });
	}
	/** @param {Locator} row */
	partRowDrag(row) {
		return row.getByTestId('part-row-drag');
	}
	/** @param {Locator} item */
	verifyOrderBtn(item) {
		return item.getByTestId('verify-order-btn');
	}
	/** @param {Locator} item */
	partsAddInput(item) {
		return item.getByTestId('parts-add-input');
	}
	/** @param {Locator} item */
	partsAddBtn(item) {
		return item.getByTestId('parts-add-btn');
	}

	/**
	 * Opens an item's (initially collapsed) "Source Files" details panel.
	 * @param {Locator} item
	 */
	async openParts(item) {
		await expect(this.partsPanel(item)).toBeVisible();
		await this.partsPanel(item).locator('summary').click();
	}

	/** @param {Locator} item */
	partRowNames(item) {
		return this.partRows(item).getByTestId('part-row-name').allTextContents();
	}

	// -- Actions ----------------------------------------------------------------

	/**
	 * @param {Parameters<Locator['setInputFiles']>[0]} files
	 * @returns {Promise<Locator>} the newly added item, located by its stable id
	 */
	async addSource(files) {
		const ids = await this.idsAddedBy(async () => {
			await this.sourceInput.setInputFiles(files);
			await this.addBtn.click();
		});
		assertSingleId(ids);
		return this.itemById(ids[0]);
	}

	/**
	 * A folder can resolve to more than one entry, so this returns an array.
	 * @param {Parameters<Locator['setInputFiles']>[0]} dirPath
	 * @returns {Promise<Locator[]>} items in creation order, each by stable id
	 */
	async addFolder(dirPath) {
		const ids = await this.idsAddedBy(async () => {
			await this.folderInput.setInputFiles(dirPath);
			await this.addFolderBtn.click();
		});
		return ids.map((id) => this.itemById(id));
	}

	/**
	 * @param {Locator} item
	 * @param {OutputFormat} format
	 */
	async selectFormat(item, format) {
		await this.formatSelect(item).selectOption(format);
	}

	/** @param {Locator} item */
	async convert(item) {
		await this.convertBtn(item).click();
	}

	/**
	 * Selects a format, clicks convert, and waits for the resulting
	 * download - the common path most conversion tests want.
	 * @param {Locator} item
	 * @param {OutputFormat} format
	 * @param {{ timeout?: number }} [opts]
	 */
	async convertAndDownload(item, format, opts = {}) {
		await this.selectFormat(item, format);
		const downloadPromise = this.page.waitForEvent('download', opts);
		await this.convert(item);
		return downloadPromise;
	}

	/**
	 * Locator matching every queue item's status element whose
	 * `data-status` is one of `statusKeys` - for asserting/counting
	 * across the whole queue rather than one known item. Matching key
	 * set to expectStatusKey()'s per-item version.
	 * @param {...string} statusKeys
	 * @returns {Locator}
	 */
	statusesWithKey(...statusKeys) {
		const selector = statusKeys
			.map((key) => `[data-testid="queue-item-status"][data-status="${key}"]`)
			.join(', ');
		return this.page.locator(selector);
	}

	// -- Assertions ---------------------------------------------------------------

	/**
	 * @param {Locator} item
	 * @param {{ timeout?: number }} [opts]
	 */
	async expectQueued(item, opts = {}) {
		await expect(this.status(item)).toContainText(TEXT.QUEUED, opts);
	}

	/**
	 * @param {Locator} item
	 * @param {{ timeout?: number }} [opts]
	 */
	async expectDone(item, opts = {}) {
		await expect(this.status(item)).toContainText(TEXT.DONE, opts);
	}

	/**
	 * @param {Locator} item
	 * @param {{ timeout?: number }} [opts]
	 */
	async expectError(item, opts = {}) {
		await expect(this.status(item)).toContainText(TEXT.ERROR, opts);
		await expect(this.error(item)).toBeVisible();
		await expect(this.error(item)).not.toBeEmpty();
	}

	/**
	 * @param {Locator} item
	 * @param {{ timeout?: number }} [opts]
	 */
	async expectUnresolved(item, opts = {}) {
		await expect(this.status(item)).toContainText(TEXT.UNRESOLVED, opts);
	}

	/**
	 * Asserts data-status directly, matching statusKeyFor()'s camelCase
	 * keys. Prefer over expectQueued()/expectDone() when distinguishing
	 * states that display similarly, e.g. 'running' vs 'awaitingSlot'.
	 * @param {Locator} item
	 * @param {string} statusKey
	 * @param {{ timeout?: number }} [opts]
	 */
	async expectStatusKey(item, statusKey, opts = {}) {
		await expect(this.status(item)).toHaveAttribute(
			'data-status',
			statusKey,
			opts,
		);
	}

	/**
	 * A successful inspection: queued, no error, and source metadata shown.
	 * @param {Locator} item
	 * @param {{ timeout?: number }} [opts]
	 */
	async expectInspected(item, opts = {}) {
		await this.expectQueued(item, opts);
		await expect(this.error(item)).toBeHidden();
		await expect(this.sourceMeta(item)).toBeVisible();
	}

	/**
	 * @param {Locator} [items] defaults to the whole current queue
	 * @param {{ timeout?: number }} [opts]
	 */
	async expectAllQueued(items = this.items, opts = {}) {
		const count = await items.count();
		await expect(this.status(items)).toContainText(
			Array(count).fill(TEXT.QUEUED),
			opts,
		);
	}
}
