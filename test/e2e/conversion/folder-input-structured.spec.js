import { test, expect } from '../support/test.js';
import {
	makeGodDirFixture,
	makeGodDirFixtureWithHeader,
	makeExtractedDirFixture,
	makeExtractedDirFixtureXex,
	makeCorruptExtractedDirFixtureXex,
} from '../../fixtures/index.js';
import { TEXT } from '../../../src/js/constants/messages.js';
import { readZipEntries } from '../support/zip.js';
import fs from 'node:fs';
import path from 'node:path';
import {
	isoBytes,
	untitledIsoBytes,
	makeFixture,
} from '../support/test-data.js';

test.describe('folder / directory input: structured (GoD / extracted) sources', () => {
	test.describe.configure({ mode: 'serial' });

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a folder shaped like a GoD source is detected, inspected, and converts end-to-end', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const dir = await makeGodDirFixture(untitledIsoBytes);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText(path.basename(dir));
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();

		const download = await queuePage.convertAndDownload(item, 'xiso', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(item, { timeout: 60_000 });
	});

	test('a folder shaped like a real GoD dump (Data parts + CON header file) is detected, inspected, and converts end-to-end', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const dir = await makeGodDirFixtureWithHeader(isoBytes);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).toContainText('41560001');

		const download = await queuePage.convertAndDownload(item, 'xiso', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(item, { timeout: 60_000 });
	});

	for (const suffix of ['.DATA', '.Data']) {
		test(`a GoD folder whose ".data" directory is cased "${suffix}" is still detected, inspected, and converts end-to-end`, async ({
			queuePage,
		}) => {
			test.setTimeout(90_000);
			const dir = await makeGodDirFixture(untitledIsoBytes, {
				casedDataFolder: suffix,
			});
			const [item] = await queuePage.addFolder(dir);
			await expect(queuePage.items).toHaveCount(1);
			await queuePage.expectInspected(item, { timeout: 15_000 });
			await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();

			const download = await queuePage.convertAndDownload(item, 'xiso', {
				timeout: 60_000,
			});
			expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
			await queuePage.expectDone(item, { timeout: 60_000 });
		});
	}

	for (const [format, filenamePattern] of /** @type {const} */ ([
		['ciso', /\.cso$/],
		['cci', /\.cci$/],
		['god', /\.zip$/],
		['extracted', /\.zip$/],
		['zar', /\.zar$/],
	])) {
		test(`a GoD-shaped source converts to ${format} end-to-end`, async ({
			queuePage,
		}) => {
			test.setTimeout(90_000);
			const dir = await makeGodDirFixture(isoBytes);
			const [item] = await queuePage.addFolder(dir);
			await expect(queuePage.items).toHaveCount(1);
			await queuePage.expectQueued(item, { timeout: 15_000 });
			await expect(queuePage.error(item)).toBeHidden();

			const download = await queuePage.convertAndDownload(item, format, {
				timeout: 60_000,
			});
			expect(download.suggestedFilename()).toMatch(filenamePattern);
			await queuePage.expectDone(item, { timeout: 60_000 });
		});
	}

	test('a folder shaped like an extracted source is detected, inspected, and converts end-to-end', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const dir = await makeExtractedDirFixture(untitledIsoBytes);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText(path.basename(dir));
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();

		const download = await queuePage.convertAndDownload(item, 'god', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });
	});

	test('a folder with a default.xex at root that is not a genuine XEX file shows a visible inspection error but still queues and converts end-to-end', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const dir = await makeCorruptExtractedDirFixtureXex(isoBytes);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText(path.basename(dir));
		await queuePage.expectError(item, { timeout: 15_000 });
		await expect(queuePage.error(item)).toContainText(/XEX2/);
		await expect(queuePage.sourceMeta(item)).toBeHidden();

		// A failed inspection doesn't block the item - it stays queued
		// with the convert button enabled.
		const download = await queuePage.convertAndDownload(item, 'xiso', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(item, { timeout: 60_000 });
	});

	test('extracted-target conversion from an XEX-shaped source triggers a download', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const x360IsoBytes = makeFixture({ platform: 'x360' });
		const dir = await makeExtractedDirFixtureXex(x360IsoBytes);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		// 'god' would fail here too, since GoD-target conversion parses
		// the launch executable and this fixture's default.xex isn't a
		// genuine XEX2 file. 'xiso' needs no executable parsing, so it
		// confirms conversion still works despite the bad executable.
		const download = await queuePage.convertAndDownload(item, 'xiso', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(item, { timeout: 60_000 });

		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		const stats = fs.statSync(filePath);
		expect(stats.size).toBeGreaterThan(0);
	});

	for (const [format, filenamePattern] of /** @type {const} */ ([
		['xiso', /\.xiso\.iso$/],
		['ciso', /\.cso$/],
		['cci', /\.cci$/],
		['zar', /\.zar$/],
	])) {
		test(`an extracted/XEX-shaped source converts to ${format} end-to-end`, async ({
			queuePage,
		}) => {
			test.setTimeout(90_000);
			const x360IsoBytes = makeFixture({ platform: 'x360' });
			const dir = await makeExtractedDirFixtureXex(x360IsoBytes);
			const [item] = await queuePage.addFolder(dir);

			await expect(queuePage.items).toHaveCount(1);
			await queuePage.expectQueued(item, { timeout: 15_000 });

			const download = await queuePage.convertAndDownload(item, format, {
				timeout: 60_000,
			});
			expect(download.suggestedFilename()).toMatch(filenamePattern);
			await queuePage.expectDone(item, { timeout: 60_000 });
		});
	}

	test('selecting extracted as the target for an already-extracted source performs a full rebuild and converts end-to-end', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const dir = await makeExtractedDirFixture(isoBytes);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		const download = await queuePage.convertAndDownload(item, 'extracted', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });
		await expect(queuePage.status(item)).not.toContainText(TEXT.ERROR);
	});

	test('skip-system-update option excludes the $SystemUpdate entry from the extracted download', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);

		const item = await queuePage.addSource({
			name: 'test.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes.buffer),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.selectFormat(item, 'extracted');

		// Options is a collapsed <details> - open it first.
		await queuePage.optionsSummary(item).click();
		await queuePage.skipSystemUpdateCheckbox(item).check();

		const downloadPromise = queuePage.page.waitForEvent('download', {
			timeout: 60_000,
		});
		await queuePage.convert(item);
		const download = await downloadPromise;
		await queuePage.expectDone(item, { timeout: 60_000 });

		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		const entries = await readZipEntries(filePath, () => true);
		const foundFiles = entries.map((e) => e.filename);
		const hasSystemUpdate = foundFiles.some((name) =>
			name.includes('$SystemUpdate'),
		);
		expect(
			hasSystemUpdate,
			`Expected no $SystemUpdate entry, found: ${foundFiles.join(', ')}`,
		).toBeFalsy();
	});
});
