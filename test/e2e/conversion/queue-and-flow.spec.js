import { test, expect } from '../support/test.js';
import {
	makeFixture,
	XGD3_ROOT_OFFSET,
	untitledIsoBytes as isoBytes,
} from '../support/test-data.js';
import { readZipEntries } from '../support/zip.js';
import { installWorkerHarness } from '../../utils/worker-harness.js';
import { TEXT } from '../../../src/js/constants/messages.js';
import fs from 'node:fs';

test.describe('conversion flow', () => {
	const isoFile = {
		name: 'test.iso',
		mimeType: 'application/octet-stream',
		buffer: Buffer.from(isoBytes.buffer),
	};

	test.beforeEach(async ({ page, queuePage }) => {
		await page.addInitScript(installWorkerHarness, { trackLive: true });
		await queuePage.goto();
	});

	test('adding an iso to queue shows a queue item', async ({ queuePage }) => {
		// Keeps the addBtn-enabled check inline with the actual click, so
		// idsAddedBy() wraps the whole triggering action rather than
		// reaching for addSource() (which would hide that intermediate
		// assertion).
		const [id] = await queuePage.idsAddedBy(async () => {
			await queuePage.sourceInput.setInputFiles(isoFile);
			await expect(queuePage.addBtn).not.toBeDisabled();
			await queuePage.addBtn.click();
		});
		const item = queuePage.itemById(id);
		await expect(item).toBeVisible();
		await expect(queuePage.title(item)).toContainText('test.iso');
	});

	test('queue item shows iso metadata after inspection', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource(isoFile);
		await queuePage.expectQueued(item, { timeout: 10_000 });
		await expect(queuePage.sourceMeta(item)).toBeVisible();
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('convert button starts conversion', async ({ queuePage }) => {
		const item = await queuePage.addSource(isoFile);
		await queuePage.expectQueued(item, { timeout: 10_000 });
		await queuePage.convert(item);
		await expect(queuePage.status(item)).toContainText(TEXT.CONVERTING(), {
			timeout: 5_000,
		});
		await expect(queuePage.cancelBtn(item)).toBeVisible();
		await expect(queuePage.pauseBtn(item)).toBeVisible();
	});

	test('conversion can be cancelled', async ({ queuePage }) => {
		const item = await queuePage.addSource(isoFile);
		await queuePage.expectQueued(item, { timeout: 10_000 });
		await queuePage.convert(item);
		await expect(queuePage.cancelBtn(item)).toBeVisible();
		await queuePage.cancelBtn(item).click();
		await expect(queuePage.status(item)).toContainText(TEXT.CANCELLED, {
			timeout: 10_000,
		});
	});

	test('god conversion completes, triggers a download, and produces a valid streamable zip', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await queuePage.addSource(isoFile);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		const download = await queuePage.convertAndDownload(item, 'god');
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });

		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		expect(fs.statSync(filePath).size).toBeGreaterThan(0);
		const entries = await readZipEntries(filePath, () => true);
		const foundFiles = entries.map((e) => e.filename);
		expect(foundFiles.length).toBeGreaterThan(0);
		const hasDataPart = foundFiles.some((name) =>
			name.includes('.data/Data0000'),
		);
		expect(
			hasDataPart,
			`Expected archive to contain .data/Data0000, but found: ${foundFiles.join(', ')}`,
		).toBeTruthy();
	});

	test('xiso conversion completes and triggers an iso download', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await queuePage.addSource(isoFile);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		const download = await queuePage.convertAndDownload(item, 'xiso', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(item, { timeout: 60_000 });

		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		expect(fs.statSync(filePath).size).toBeGreaterThan(0);
	});

	test('extracted conversion completes and triggers a zip download with xbe content', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await queuePage.addSource(isoFile);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		const download = await queuePage.convertAndDownload(item, 'extracted', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\(XEX\)\.zip$/);
		await queuePage.expectDone(item, { timeout: 60_000 });

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

	test.describe('xiso conversion with an offset (redump-style) fixture', () => {
		const offsetIsoFile = {
			name: 'test-offset.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(makeFixture({ rootOffset: XGD3_ROOT_OFFSET }).buffer),
		};

		test('xiso conversion completes for an ISO with a nonzero root_offset', async ({
			queuePage,
		}) => {
			test.setTimeout(120_000);
			const item = await queuePage.addSource(offsetIsoFile);
			await queuePage.expectQueued(item, { timeout: 30_000 });
			const download = await queuePage.convertAndDownload(item, 'xiso', {
				timeout: 90_000,
			});
			expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);

			await queuePage.expectDone(item, { timeout: 90_000 });
			const filePath = await download.path();
			if (!filePath) throw new Error('Download path missing');
			expect(fs.statSync(filePath).size).toBeGreaterThan(0);
		});
	});

	for (const [format, extPattern] of /** @type {const} */ ([
		['ciso', /\.cso$/],
		['zar', /\.zar$/],
		['cci', /\.cci$/],
	])) {
		test(`${format} conversion completes and triggers a download`, async ({
			queuePage,
		}) => {
			test.setTimeout(90_000);
			const item = await queuePage.addSource(isoFile);
			await queuePage.expectQueued(item, { timeout: 15_000 });
			const download = await queuePage.convertAndDownload(item, format, {
				timeout: 60_000,
			});
			expect(download.suggestedFilename()).toMatch(extPattern);
			await queuePage.expectDone(item, { timeout: 60_000 });

			const filePath = await download.path();
			if (!filePath) throw new Error('Download path missing');
			expect(fs.statSync(filePath).size).toBeGreaterThan(0);
		});
	}

	test('worker is actually terminated on cancel', async ({
		page,
		queuePage,
	}) => {
		const item = await queuePage.addSource(isoFile);
		await queuePage.expectQueued(item, { timeout: 10_000 });
		// Baseline taken after queuing/inspection, not 0: adding a source
		// runs its partition + inspect probes through inspectWorkerPool,
		// which intentionally releases those workers back to the pool for
		// reuse instead of terminating them (see WorkerPool.js). Those
		// pooled, idle workers are expected to stay alive - this test only
		// cares that the *conversion* worker itself gets torn down.
		const baseline = await page.evaluate(() => window.__liveWorkers.size);
		await queuePage.convert(item);
		await expect(queuePage.cancelBtn(item)).toBeVisible();
		await expect
			.poll(() => page.evaluate(() => window.__liveWorkers.size))
			.toBeGreaterThan(baseline);
		await queuePage.cancelBtn(item).click();
		await expect(queuePage.status(item)).toContainText(TEXT.CANCELLED, {
			timeout: 10_000,
		});
		await expect
			.poll(() => page.evaluate(() => window.__liveWorkers.size), {
				timeout: 15_000,
			})
			.toBe(baseline);
	});
});
