import { test, expect } from '../support/test.js';
import { x360IsoBytes } from '../support/test-data.js';
import { readZipEntryPrefix } from '../support/zip.js';

/**
 * @import { QueuePage } from '../pages/queue-page.js'
 * @import { Locator } from '@playwright/test'
 */

// Covers the GoD Device ID field (STFS metadata offset 0x3FD, 20 bytes -
// see https://free60.org/System-Software/Formats/STFS/#metadata).
// Independent of console-signing (see god-signing.spec.js) - this file
// only exercises the Device ID input itself, its validation, its
// settings-panel default, and that a converted output really carries the
// bytes that were typed in.

// 40 lowercase hex chars = 20 bytes. Kept lowercase deliberately - one of
// the per-item tests below covers uppercase input separately.
const VALID_DEVICE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const VALID_DEVICE_ID_BYTES = Buffer.from(VALID_DEVICE_ID, 'hex');

const STFS_DEVICE_ID_OFFSET = 0x3fd;
const STFS_DEVICE_ID_LEN = 0x14;

/**
 * Adds an x360/XEX (GamesOnDemand-shaped) queue item and selects the
 * 'god' format - same reasoning as god-signing.spec.js's own copy of this
 * helper: the .queue-item__option[data-formats="god"] block (which holds
 * the Device ID field) is hidden until the item's format is actually
 * 'god'.
 * @param {QueuePage} queuePage
 * @returns {Promise<Locator>}
 */
async function addX360GodItem(queuePage) {
	const item = await queuePage.addSource({
		name: 'x360.iso',
		mimeType: 'application/octet-stream',
		buffer: Buffer.from(x360IsoBytes.buffer),
	});
	await queuePage.expectQueued(item, { timeout: 15_000 });
	await queuePage.selectFormat(item, 'god');
	return item;
}

test.describe('device id - per-item validation & Convert gating', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('is empty by default and does not block Convert', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await expect(queuePage.godDeviceIdInput(item)).toHaveValue('');
		await expect(queuePage.convertBtn(item)).toBeEnabled();
	});

	test('an invalid value disables Convert and shows an inline error on blur', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godDeviceIdInput(item).fill('not-a-device-id');
		await queuePage.godDeviceIdInput(item).blur();

		await expect(queuePage.godDeviceIdError(item)).toBeVisible();
		await expect(queuePage.godDeviceIdError(item)).not.toBeEmpty();
		await expect(queuePage.convertBtn(item)).toBeDisabled();
	});

	test('a valid 40-char hex value is accepted, keeping Convert enabled', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godDeviceIdInput(item).fill(VALID_DEVICE_ID);
		await queuePage.godDeviceIdInput(item).blur();

		await expect(queuePage.godDeviceIdError(item)).toBeHidden();
		await expect(queuePage.convertBtn(item)).toBeEnabled();
	});

	test('accepts uppercase hex digits as well as lowercase', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godDeviceIdInput(item).fill(VALID_DEVICE_ID.toUpperCase());
		await queuePage.godDeviceIdInput(item).blur();

		await expect(queuePage.godDeviceIdError(item)).toBeHidden();
		await expect(queuePage.convertBtn(item)).toBeEnabled();
	});

	test('correcting an invalid value back to a valid one re-enables Convert', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godDeviceIdInput(item).fill('deadbeef');
		await queuePage.godDeviceIdInput(item).blur();
		await expect(queuePage.convertBtn(item)).toBeDisabled();

		await queuePage.godDeviceIdInput(item).fill(VALID_DEVICE_ID);
		await queuePage.godDeviceIdInput(item).blur();
		await expect(queuePage.godDeviceIdError(item)).toBeHidden();
		await expect(queuePage.convertBtn(item)).toBeEnabled();
	});

	test('the clear button empties the field, clears the error, and re-enables Convert', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godDeviceIdInput(item).fill('deadbeef');
		await queuePage.godDeviceIdInput(item).blur();
		await expect(queuePage.convertBtn(item)).toBeDisabled();

		await queuePage.godDeviceIdClearBtn(item).click();

		await expect(queuePage.godDeviceIdInput(item)).toHaveValue('');
		await expect(queuePage.godDeviceIdError(item)).toBeHidden();
		await expect(queuePage.convertBtn(item)).toBeEnabled();
	});

	// Mirrors god-signing.spec.js's "per-item keyvault/sign state is scoped
	// independently across items" - proves an invalid value on one item
	// doesn't leak into (or block Convert on) an unrelated item.
	test('validation state is scoped independently across items', async ({
		queuePage,
	}) => {
		const itemA = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(itemA).click();
		await queuePage.godDeviceIdInput(itemA).fill('not-valid');
		await queuePage.godDeviceIdInput(itemA).blur();
		await expect(queuePage.convertBtn(itemA)).toBeDisabled();

		const itemB = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(itemB).click();
		await expect(queuePage.godDeviceIdInput(itemB)).toHaveValue('');
		await expect(queuePage.convertBtn(itemB)).toBeEnabled();

		await queuePage.godDeviceIdInput(itemB).fill(VALID_DEVICE_ID);
		await queuePage.godDeviceIdInput(itemB).blur();
		await expect(queuePage.convertBtn(itemB)).toBeEnabled();
		// itemA's invalid state and disabled Convert are untouched.
		await expect(queuePage.convertBtn(itemA)).toBeDisabled();
	});

	// Switching away from 'god' hides the field but must not let a stale
	// invalid value block Convert for an otherwise-unrelated format.
	test('an invalid value stops blocking Convert once the format is switched off god', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godDeviceIdInput(item).fill('not-valid');
		await queuePage.godDeviceIdInput(item).blur();
		await expect(queuePage.convertBtn(item)).toBeDisabled();

		await queuePage.selectFormat(item, 'xiso');
		await expect(queuePage.convertBtn(item)).toBeEnabled();
	});
});

test.describe('device id - settings panel defaults', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
		await queuePage.openSettings();
	});

	test('a default Device ID seeds new queue items', async ({ queuePage }) => {
		await queuePage.defaultGodDeviceIdInput.fill(VALID_DEVICE_ID);
		await queuePage.defaultGodDeviceIdInput.blur();

		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await expect(queuePage.godDeviceIdInput(item)).toHaveValue(VALID_DEVICE_ID);
	});

	test('an invalid default shows its own inline error, scoped to the settings panel', async ({
		queuePage,
	}) => {
		await queuePage.defaultGodDeviceIdInput.fill('nope');
		await queuePage.defaultGodDeviceIdInput.blur();
		await expect(queuePage.defaultGodDeviceIdError).toBeVisible();
		await expect(queuePage.defaultGodDeviceIdError).not.toBeEmpty();
	});

	test('persists across a reload, same as the other GoD defaults', async ({
		queuePage,
	}) => {
		await queuePage.defaultGodDeviceIdInput.fill(VALID_DEVICE_ID);
		await queuePage.defaultGodDeviceIdInput.blur();

		await queuePage.reload();
		await queuePage.openSettings();

		await expect(queuePage.defaultGodDeviceIdInput).toHaveValue(VALID_DEVICE_ID);
	});

	test('the clear button on the settings default empties and unpersists it', async ({
		queuePage,
	}) => {
		await queuePage.defaultGodDeviceIdInput.fill(VALID_DEVICE_ID);
		await queuePage.defaultGodDeviceIdInput.blur();

		await queuePage.defaultGodDeviceIdClearBtn.click();
		await expect(queuePage.defaultGodDeviceIdInput).toHaveValue('');

		await queuePage.reload();
		await queuePage.openSettings();
		await expect(queuePage.defaultGodDeviceIdInput).toHaveValue('');
	});
});

test.describe('device id - embedded in output', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a GoD conversion embeds the entered Device ID at STFS offset 0x3FD', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godDeviceIdInput(item).fill(VALID_DEVICE_ID);
		await queuePage.godDeviceIdInput(item).blur();

		const download = await queuePage.convertAndDownload(item, 'god');
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });
		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');

		// Same header-entry selection as god-signing.spec.js: the header is
		// its own manifest entry (keyed by output_path_prefix() alone, no
		// `.data` segment), never a `Data%04d` chunk.
		const headerPrefix = await readZipEntryPrefix(
			filePath,
			(name) => !name.includes('.data/'),
			STFS_DEVICE_ID_OFFSET + STFS_DEVICE_ID_LEN,
		);
		const deviceIdBytes = headerPrefix.subarray(
			STFS_DEVICE_ID_OFFSET,
			STFS_DEVICE_ID_OFFSET + STFS_DEVICE_ID_LEN,
		);
		expect(deviceIdBytes).toEqual(VALID_DEVICE_ID_BYTES);
	});

	// Regression guard: Device ID is documented as independent of
	// signingKey (see the GodOptions.deviceId doc comment) - an unsigned
	// (LIVE) conversion must still embed it, not only a console-signed one.
	test('an unsigned GoD conversion still embeds the Device ID', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godDeviceIdInput(item).fill(VALID_DEVICE_ID);
		await queuePage.godDeviceIdInput(item).blur();
		// Deliberately no keyvault upload / sign checkbox here.

		const download = await queuePage.convertAndDownload(item, 'god');
		await queuePage.expectDone(item, { timeout: 60_000 });
		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');

		const headerPrefix = await readZipEntryPrefix(
			filePath,
			(name) => !name.includes('.data/'),
			4,
		);
		expect(headerPrefix.toString('ascii')).toBe('LIVE');

		const fullHeaderPrefix = await readZipEntryPrefix(
			filePath,
			(name) => !name.includes('.data/'),
			STFS_DEVICE_ID_OFFSET + STFS_DEVICE_ID_LEN,
		);
		const deviceIdBytes = fullHeaderPrefix.subarray(
			STFS_DEVICE_ID_OFFSET,
			STFS_DEVICE_ID_OFFSET + STFS_DEVICE_ID_LEN,
		);
		expect(deviceIdBytes).toEqual(VALID_DEVICE_ID_BYTES);
	});

	// Regression guard for the opposite direction: leaving the field empty
	// must not accidentally write a non-zero Device ID (e.g. leftover
	// buffer garbage) into the header.
	test('an empty Device ID field leaves the header field zeroed', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await addX360GodItem(queuePage);
		// Deliberately left blank.
		const download = await queuePage.convertAndDownload(item, 'god');
		await queuePage.expectDone(item, { timeout: 60_000 });
		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');

		const headerPrefix = await readZipEntryPrefix(
			filePath,
			(name) => !name.includes('.data/'),
			STFS_DEVICE_ID_OFFSET + STFS_DEVICE_ID_LEN,
		);
		const deviceIdBytes = headerPrefix.subarray(
			STFS_DEVICE_ID_OFFSET,
			STFS_DEVICE_ID_OFFSET + STFS_DEVICE_ID_LEN,
		);
		expect(deviceIdBytes).toEqual(Buffer.alloc(STFS_DEVICE_ID_LEN));
	});
});
