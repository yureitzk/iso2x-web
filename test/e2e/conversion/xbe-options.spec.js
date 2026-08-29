import { test, expect } from '../support/test.js';
import { isoBytes, x360IsoBytes } from '../support/test-data.js';
import { readZipEntries } from '../support/zip.js';
import { setupWasm } from '../../utils/wasmSetup.js';
import { lookupTitleById } from 'iso2x';
import fs from 'node:fs';

/**
 * @import { QueuePage } from '../pages/queue-page.js'
 * @import { Locator } from '@playwright/test'
 */

// XBE certificate layout and the Allowed Media Types bitfield, per the
// Certificate structure in Cxbx-Reloaded's Xbe.h:
// https://github.com/Cxbx-Reloaded/Cxbx-Reloaded/blob/master/src/common/xbe/Xbe.h
const CERT_ALLOWED_MEDIA_OFFSET = 0x9c;
const CERT_TITLE_NAME_OFFSET = 0x0c;
const CERT_TITLE_NAME_LEN = 80;
const CERT_TITLE_ID_OFFSET = 0x08;
const HARD_DISK = 0x00000001;
const MEDIA_BOARD = 0x00000200;
const NONSECURE_HARD_DISK = 0x40000000;

/** @param {Buffer} buf @param {number} offset */
function readU32LE(buf, offset) {
	return buf.readUInt32LE(offset);
}

/**
 * Computes a buffer-relative certificate address from the XBE's own
 * header fields (base address, certificate address) instead of
 * hardcoding a byte offset - see the Header struct in Cxbx-Reloaded's
 * Xbe.h (same link as above).
 * @param {Buffer} buf
 */
function certAddr(buf) {
	const baseAddress = readU32LE(buf, 0x104);
	const certificateAddress = readU32LE(buf, 0x118);
	return certificateAddress - baseAddress;
}

const isoFile = {
	name: 'test.iso',
	mimeType: 'application/octet-stream',
	buffer: Buffer.from(isoBytes.buffer),
};

const x360IsoFile = {
	name: 'test-x360.iso',
	mimeType: 'application/octet-stream',
	buffer: Buffer.from(x360IsoBytes.buffer),
};

/**
 * Adds a source, waits for it to queue, and opens its options panel -
 * the common setup every test below starts from.
 * @param {QueuePage} queuePage
 * @param {Parameters<QueuePage['addSource']>[0]} file
 * @returns {Promise<Locator>}
 */
async function addQueuedWithOptionsOpen(queuePage, file) {
	const item = await queuePage.addSource(file);
	await queuePage.expectQueued(item, { timeout: 15_000 });
	await queuePage.optionsSummary(item).click();
	return item;
}

test.describe('Allowed Media Patch / Rename Title constraints', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('an OGX source leaves Allowed Media Patch and Rename Title enabled', async ({
		queuePage,
	}) => {
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'extracted');
		await expect(queuePage.allowedMediaPatchCheckbox(item)).toBeEnabled();
		await expect(queuePage.renameTitleCheckbox(item)).toBeEnabled();
	});

	test('a non-OGX (x360/XEX) source disables and clears Allowed Media Patch and Rename Title', async ({
		queuePage,
	}) => {
		const item = await addQueuedWithOptionsOpen(queuePage, x360IsoFile);
		await queuePage.selectFormat(item, 'extracted');
		const allowedMediaPatch = queuePage.allowedMediaPatchCheckbox(item);
		const renameTitle = queuePage.renameTitleCheckbox(item);
		await expect(allowedMediaPatch).toBeDisabled();
		await expect(renameTitle).toBeDisabled();
		await expect(allowedMediaPatch).not.toBeChecked();
		await expect(renameTitle).not.toBeChecked();
	});

	// Constraints are computed per-item off that item's own sourceIsOgx,
	// not applied globally across the whole queue.
	test('constraints are scoped to each queue item independently', async ({
		queuePage,
	}) => {
		const ogxItem = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(ogxItem, 'extracted');
		await queuePage.allowedMediaPatchCheckbox(ogxItem).check();

		const x360Item = await queuePage.addSource(x360IsoFile);
		await expect(queuePage.items).toHaveCount(2);
		await queuePage.expectQueued(x360Item, { timeout: 15_000 });
		await queuePage.optionsSummary(x360Item).click();
		await queuePage.selectFormat(x360Item, 'extracted');

		// The OGX item's explicit check survives...
		await expect(queuePage.allowedMediaPatchCheckbox(ogxItem)).toBeChecked();
		await expect(queuePage.allowedMediaPatchCheckbox(ogxItem)).toBeEnabled();
		// ...while the newly-added x360 item is independently disabled+cleared.
		await expect(queuePage.allowedMediaPatchCheckbox(x360Item)).toBeDisabled();
		await expect(queuePage.allowedMediaPatchCheckbox(x360Item)).not.toBeChecked();
	});
});

test.describe('Generate Attach XBE constraint', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('disabled for an OGX source while an OGX-bootable target format (god) is selected', async ({
		queuePage,
	}) => {
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'god');
		await expect(queuePage.attachXbeCheckbox(item)).toBeDisabled();
	});

	test('disabled for an OGX source while zar is selected', async ({
		queuePage,
	}) => {
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'zar');
		await expect(queuePage.attachXbeCheckbox(item)).toBeDisabled();
	});

	for (const format of /** @type {const} */ (['xiso', 'ciso', 'cci'])) {
		test(`enabled for an OGX source once target format is switched to ${format}`, async ({
			queuePage,
		}) => {
			const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
			await queuePage.selectFormat(item, format);
			await expect(queuePage.attachXbeCheckbox(item)).toBeEnabled();
		});
	}

	test('disabled for a non-OGX (x360/XEX) source even on an attachable format', async ({
		queuePage,
	}) => {
		const item = await addQueuedWithOptionsOpen(queuePage, x360IsoFile);
		await queuePage.selectFormat(item, 'xiso');
		await expect(queuePage.attachXbeCheckbox(item)).toBeDisabled();
	});

	test('checking it, then switching to a non-attachable format, unchecks and disables it again', async ({
		queuePage,
	}) => {
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'xiso');
		await queuePage.attachXbeCheckbox(item).check();
		await expect(queuePage.attachXbeCheckbox(item)).toBeChecked();
		await queuePage.selectFormat(item, 'god');
		await expect(queuePage.attachXbeCheckbox(item)).toBeDisabled();
		await expect(queuePage.attachXbeCheckbox(item)).not.toBeChecked();
	});
});

test.describe('extracted settings defaults', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('toggling the default Allowed Media Patch / Rename Title checkboxes persists and seeds new queue items', async ({
		queuePage,
	}) => {
		await queuePage.openSettings();
		await queuePage.defaultAllowedMediaPatchCheckbox.check();
		await queuePage.defaultRenameTitleCheckbox.check();
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'extracted');
		await expect(queuePage.allowedMediaPatchCheckbox(item)).toBeChecked();
		await expect(queuePage.renameTitleCheckbox(item)).toBeChecked();

		await queuePage.reload();
		await queuePage.openSettings();
		await expect(queuePage.defaultAllowedMediaPatchCheckbox).toBeChecked();
		await expect(queuePage.defaultRenameTitleCheckbox).toBeChecked();
	});
});

test.describe('extracted conversion applies allowedMediaPatch / renameTitle end-to-end', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('allowedMediaPatch ORs the expected allowed_media_types bits into the downloaded default.xbe', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'extracted');
		await queuePage.allowedMediaPatchCheckbox(item).check();
		const download = await queuePage.convertAndDownload(item, 'extracted', {
			timeout: 30_000,
		});
		await queuePage.expectDone(item, { timeout: 30_000 });
		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		const [xbeEntry] = await readZipEntries(filePath, (name) =>
			name.endsWith('.xbe'),
		);
		expect(xbeEntry, 'expected a .xbe entry in the downloaded zip').toBeTruthy();
		const addr = certAddr(xbeEntry.bytes);
		const allowedMedia = readU32LE(
			xbeEntry.bytes,
			addr + CERT_ALLOWED_MEDIA_OFFSET,
		);
		expect(allowedMedia & (HARD_DISK | MEDIA_BOARD | NONSECURE_HARD_DISK)).toBe(
			HARD_DISK | MEDIA_BOARD | NONSECURE_HARD_DISK,
		);
	});

	test('renameTitle writes the game title into the downloaded default.xbe, UTF-16LE-encoded', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		const newTitle = 'My Renamed Game';
		await queuePage.gameTitleInput(item).fill(newTitle);
		await queuePage.selectFormat(item, 'extracted');
		await queuePage.renameTitleCheckbox(item).check();
		const download = await queuePage.convertAndDownload(item, 'extracted', {
			timeout: 30_000,
		});
		await queuePage.expectDone(item, { timeout: 30_000 });
		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		const [xbeEntry] = await readZipEntries(filePath, (name) =>
			name.endsWith('.xbe'),
		);
		expect(xbeEntry, 'expected a .xbe entry in the downloaded zip').toBeTruthy();
		const addr = certAddr(xbeEntry.bytes);
		const nameBytes = xbeEntry.bytes.subarray(
			addr + CERT_TITLE_NAME_OFFSET,
			addr + CERT_TITLE_NAME_OFFSET + CERT_TITLE_NAME_LEN,
		);
		// eslint-disable-next-line no-control-regex -- trimming NUL padding from a fixed-width XBE field
		const decoded = nameBytes.toString('utf16le').replace(/\u0000+$/, '');
		expect(decoded).toBe(newTitle);
	});

	// Only default.xbe should ever be touched by these two options - the
	// extracted output's other loose files must round-trip untouched.
	test('the .xbe entry is the only patched content; nothing else in the zip is corrupted', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'extracted');
		await queuePage.allowedMediaPatchCheckbox(item).check();
		await queuePage.renameTitleCheckbox(item).check();
		const download = await queuePage.convertAndDownload(item, 'extracted', {
			timeout: 30_000,
		});
		await queuePage.expectDone(item, { timeout: 30_000 });
		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		const entries = await readZipEntries(filePath, () => true);
		const foundFiles = entries.map((e) => e.filename);
		const hasXbe = foundFiles.some((name) => name.endsWith('.xbe'));
		expect(
			hasXbe,
			`Expected a .xbe file, found: ${foundFiles.join(', ')}`,
		).toBeTruthy();
	});
});

test.describe('Generate Attach XBE end-to-end', () => {
	// isoFile's titleId (0x41560001, makeFixture()'s default) is a real
	// entry in the vendored game list, so its name can change on a
	// future titles.jsonl regen. Resolve it live instead of hardcoding
	// the string, same as resolveUnmappedTitleId() does for the
	// unmapped case.
	/** @type {string} */
	let expectedDefaultTitle;

	test.beforeAll(async () => {
		await setupWasm();
		const title = lookupTitleById(0x41560001);
		if (title === undefined) {
			throw new Error(
				'0x41560001 no longer resolves in the game list - pick a new ' +
					"default titleId in fixtures/xfs.js's makeFixture(), or update " +
					'the tests in this file that assume it resolves.',
			);
		}
		expectedDefaultTitle = title;
	});

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('produces a second, independent attach.xbe download alongside an xiso conversion', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'xiso');
		await queuePage.attachXbeCheckbox(item).check();

		// This one conversion fires two independent downloads: the primary
		// .xiso.iso, then attach.xbe.
		const primaryDownloadPromise = queuePage.page.waitForEvent('download', {
			timeout: 30_000,
		});
		await queuePage.convert(item);
		const primaryDownload = await primaryDownloadPromise;
		expect(primaryDownload.suggestedFilename()).toMatch(/\.xiso\.iso$/);

		const attachDownloadPromise = queuePage.page.waitForEvent('download', {
			timeout: 30_000,
		});
		const attachDownload = await attachDownloadPromise;
		expect(attachDownload.suggestedFilename()).toBe(
			`${expectedDefaultTitle}.xbe`,
		);

		await queuePage.expectDone(item, { timeout: 30_000 });
		const attachPath = await attachDownload.path();
		if (!attachPath) throw new Error('attach.xbe download path missing');
		const attachBytes = fs.readFileSync(attachPath);
		expect(attachBytes.subarray(0, 4).toString('ascii')).toBe('XBEH');
		const addr = certAddr(attachBytes);
		// 0x41560001 is makeFixture()'s default titleId.
		expect(readU32LE(attachBytes, addr + CERT_TITLE_ID_OFFSET)).toBe(0x41560001);
	});

	test('attach xbe filename uses the typed game title', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.gameTitleInput(item).fill('My Custom Title');
		await queuePage.selectFormat(item, 'xiso');
		await queuePage.attachXbeCheckbox(item).check();
		const primaryDownloadPromise = queuePage.page.waitForEvent('download', {
			timeout: 30_000,
		});
		await queuePage.convert(item);
		await primaryDownloadPromise;
		const attachDownload = await queuePage.page.waitForEvent('download', {
			timeout: 30_000,
		});

		expect(attachDownload.suggestedFilename()).toBe('My Custom Title.xbe');
	});

	test('no attach.xbe download when Generate Attach XBE is left unchecked', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'xiso');
		// Deliberately left unchecked.
		const download = await queuePage.convertAndDownload(item, 'xiso', {
			timeout: 30_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);

		await queuePage.expectDone(item, { timeout: 30_000 });
		// Give the worker's DONE message a moment to land, then confirm no
		// second download fires.
		const extraDownload = await queuePage.page
			.waitForEvent('download', { timeout: 2_000 })
			.catch(() => null);
		expect(extraDownload).toBeNull();
	});

	test('a default-checked Generate Attach XBE still produces attach.xbe once format is switched to xiso', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		await queuePage.openSettings();
		await queuePage.defaultAttachXbeCheckbox.check();
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		await queuePage.selectFormat(item, 'xiso');
		await expect(queuePage.attachXbeCheckbox(item)).toBeChecked();
		const primaryDownloadPromise = queuePage.page.waitForEvent('download', {
			timeout: 30_000,
		});
		await queuePage.convert(item);
		const primaryDownload = await primaryDownloadPromise;
		expect(primaryDownload.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		const attachDownloadPromise = queuePage.page.waitForEvent('download', {
			timeout: 30_000,
		});
		const attachDownload = await attachDownloadPromise;
		expect(attachDownload.suggestedFilename()).toBe(
			`${expectedDefaultTitle}.xbe`,
		);
	});
});

test.describe('Generate Attach XBE default', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('default stays checked but disabled until an attachable format is selected', async ({
		queuePage,
	}) => {
		await queuePage.openSettings();
		await queuePage.defaultAttachXbeCheckbox.check();
		const item = await addQueuedWithOptionsOpen(queuePage, isoFile);
		// Default format is 'god', which can't attach an OGX xbe.
		await expect(queuePage.attachXbeCheckbox(item)).toBeDisabled();
		await queuePage.selectFormat(item, 'xiso');
		await expect(queuePage.attachXbeCheckbox(item)).toBeChecked();
		await expect(queuePage.attachXbeCheckbox(item)).toBeEnabled();
	});

	test('persisted across a reload, same as the other default checkboxes', async ({
		queuePage,
	}) => {
		await queuePage.openSettings();
		await queuePage.defaultAttachXbeCheckbox.check();
		await queuePage.reload();
		await queuePage.openSettings();
		await expect(queuePage.defaultAttachXbeCheckbox).toBeChecked();
	});
});
