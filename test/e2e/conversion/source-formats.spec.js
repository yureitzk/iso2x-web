import { test, expect } from '../support/test.js';
import { makeCompressedFixtures } from '../../fixtures/index.js';
import {
	untitledIsoBytes as isoBytes,
	splitIsoPair,
	makeFixture,
	stfsBytes,
} from '../support/test-data.js';
import { readZipEntries } from '../support/zip.js';

/**
 * @import { CompressedFixtures } from '../../../src/types/global'
 */

/** @type {CompressedFixtures} */
let compressed;

test.beforeAll(async () => {
	compressed = await makeCompressedFixtures(isoBytes, 'test');
});

test.describe('single-file source formats', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('adding a cso to queue shows queue item and inspects correctly', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'test.cso',
			mimeType: 'application/octet-stream',
			buffer: compressed.cso,
		});
		await expect(item).toBeVisible();
		await expect(queuePage.title(item)).toContainText('test.cso');
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.sourceMeta(item)).toBeVisible();
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('adding a cci to queue shows queue item and inspects correctly', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'test.cci',
			mimeType: 'application/octet-stream',
			buffer: compressed.cci,
		});
		await expect(item).toBeVisible();
		await expect(queuePage.title(item)).toContainText('test.cci');
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.sourceMeta(item)).toBeVisible();
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('adding a zar to queue shows queue item and inspects correctly', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'test.zar',
			mimeType: 'application/octet-stream',
			buffer: compressed.zar,
		});
		await expect(item).toBeVisible();
		await expect(queuePage.title(item)).toContainText('test.zar');
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.sourceMeta(item)).toBeVisible();
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	// STFS packages have no fixed extension (see LOOSE_IMAGE_EXTENSIONS in
	// src/js/workers/source.js) - unlike cso/cci/zar above, they're only
	// ever recognized by magic bytes. The filename deliberately carries no
	// extension at all, matching a real save/content package's naming and
	// forcing the isStfsMagic() fallback path rather than any extension
	// fast-path.
	test('adding an extensionless stfs package to queue shows queue item and inspects correctly', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: '4D530001',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(stfsBytes),
		});
		await expect(item).toBeVisible();
		await expect(queuePage.title(item)).toContainText('4D530001');
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.sourceMeta(item)).toBeVisible();
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});
});

// Every compressed source format converting to every target format,
// including same-format rebuilds (ciso -> ciso) and cross-compression
// (ciso -> cci). Only filenames are asserted here; XEX payload content
// is verified separately below.
const TARGET_FILENAME_PATTERNS = /** @type {const} */ ({
	xiso: /\.xiso\.iso$/,
	ciso: /\.cso$/,
	cci: /\.cci$/,
	god: /\.zip$/,
	extracted: /\.zip$/,
	zar: /\.zar$/,
});

for (const sourceExt of /** @type {const} */ (['cso', 'cci', 'zar'])) {
	test.describe(`${sourceExt} source: conversion to every target format`, () => {
		test.beforeEach(async ({ queuePage }) => {
			await queuePage.goto();
		});

		for (const target of /** @type {const} */ ([
			'xiso',
			'ciso',
			'cci',
			'god',
			'extracted',
			'zar',
		])) {
			test(`${sourceExt} converts to ${target} end-to-end`, async ({
				queuePage,
			}) => {
				test.setTimeout(90_000);
				const item = await queuePage.addSource({
					name: `test.${sourceExt}`,
					mimeType: 'application/octet-stream',
					buffer: compressed[sourceExt],
				});
				await queuePage.expectQueued(item, { timeout: 15_000 });
				const download = await queuePage.convertAndDownload(item, target, {
					timeout: 60_000,
				});
				expect(download.suggestedFilename()).toMatch(
					TARGET_FILENAME_PATTERNS[target],
				);
				await queuePage.expectDone(item, { timeout: 60_000 });
			});
		}
	});
}

test.describe('split-pair source formats', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	// A split pair is a 'files' source whose full file list is inspected
	// directly, unlike a 'multi-disc' source, so its displayed size must
	// reflect both parts combined.
	test('a split .1.iso/.2.iso pair shows the combined size of both parts, not just the first', async ({
		queuePage,
	}) => {
		const [part1, part2] = splitIsoPair(isoBytes);
		const item = await queuePage.addSource([
			{
				name: 'test.1.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part1),
			},
			{
				name: 'test.2.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part2),
			},
		]);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		// part1/part2 are non-overlapping subarrays of isoBytes, so their
		// combined length is exactly isoBytes.length.
		expect(part1.length + part2.length).toBe(isoBytes.length);
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(isoBytes.length),
		);
	});

	test('adding a split .1.iso/.2.iso pair merges into one queue item', async ({
		queuePage,
	}) => {
		const [part1, part2] = splitIsoPair(isoBytes);
		const item = await queuePage.addSource([
			{
				name: 'test.1.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part1),
			},
			{
				name: 'test.2.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part2),
			},
		]);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText('test.1.iso + test.2.iso');
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.sourceMeta(item)).toBeVisible();
	});

	test('split .1.iso/.2.iso pair converts end-to-end', async ({ queuePage }) => {
		test.setTimeout(90_000);
		const [part1, part2] = splitIsoPair(isoBytes);
		const item = await queuePage.addSource([
			{
				name: 'test.1.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part1),
			},
			{
				name: 'test.2.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part2),
			},
		]);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		const download = await queuePage.convertAndDownload(item, 'god', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });
	});

	// A real .1.cci/.2.cci pair needs a valid CCI header per part and only
	// occurs past ~4.06 GB, so it can't be fixtured directly. This covers
	// the same guard rail with two files matching the split-pair naming
	// convention but content that isn't a valid source.
	test('a malformed .1.cci/.2.cci pair is rejected with a visible error', async ({
		queuePage,
	}) => {
		const garbage = Buffer.alloc(2048, 0);
		const item = await queuePage.addSource([
			{
				name: 'test.1.cci',
				mimeType: 'application/octet-stream',
				buffer: garbage,
			},
			{
				name: 'test.2.cci',
				mimeType: 'application/octet-stream',
				buffer: garbage,
			},
		]);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.error(item)).toBeVisible();
		await expect(queuePage.error(item)).not.toBeEmpty();
	});

	// A lone ".2.iso" with no ".1." partner isn't a pair - it must queue as
	// its own standalone entry.
	test('a lone .2.iso with no .1. partner is queued as its own entry', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'test.2.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes),
		});
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText('test.2.iso');
	});

	// Nothing about a ".1." in a filename is enforced or guaranteed - a
	// complete, standalone file named like a split part (with no real
	// partner) must inspect and queue like any other single-file source.
	test('a complete file named like a split part (no actual partner) inspects and queues normally', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'test.1.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes),
		});
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText('test.1.iso');
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('a complete file named like a split part converts end-to-end as a normal source', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await queuePage.addSource({
			name: 'test.1.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		const download = await queuePage.convertAndDownload(item, 'god', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });
	});
});

test.describe('compressed source formats with an x360/XEX payload', () => {
	/** @type {CompressedFixtures} */
	let compressedXex;

	test.beforeAll(async () => {
		const x360IsoBytes = makeFixture({ titleId: 0x5a5a0002, platform: 'x360' });
		compressedXex = await makeCompressedFixtures(x360IsoBytes, 'test-x360');
	});

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	for (const ext of /** @type {const} */ (['zar', 'cso', 'cci'])) {
		test(`${ext} (x360/XEX) source converts to extracted end-to-end with genuine XEX content`, async ({
			queuePage,
		}) => {
			test.setTimeout(90_000);
			const item = await queuePage.addSource({
				name: `test-x360.${ext}`,
				mimeType: 'application/octet-stream',
				buffer: compressedXex[ext],
			});
			await queuePage.expectQueued(item, { timeout: 15_000 });
			await expect(queuePage.sourceMeta(item)).toBeVisible();
			await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
			const download = await queuePage.convertAndDownload(item, 'extracted', {
				timeout: 60_000,
			});
			// Confirms the decompressed payload was recognized as XEX, not OGX.
			expect(download.suggestedFilename()).toMatch(/\(XEX\)\.zip$/);
			await queuePage.expectDone(item, { timeout: 60_000 });

			const filePath = await download.path();
			if (!filePath) throw new Error('Download path missing');

			const entries = await readZipEntries(filePath, () => true);
			const foundFiles = entries.map((e) => e.filename);
			const hasXex = foundFiles.some((name) => name.endsWith('.xex'));

			expect(
				hasXex,
				`Expected a .xex file, found: ${foundFiles.join(', ')}`,
			).toBeTruthy();
			const hasXbe = foundFiles.some((name) => name.endsWith('.xbe'));
			expect(
				hasXbe,
				`Did not expect a .xbe file, found: ${foundFiles.join(', ')}`,
			).toBeFalsy();
		});
	}

	// stfsBytes' single file is already a genuine XEX2 stub (default.xex,
	// per makeStfsFixture's own default) - same content-verification
	// shape as the cso/cci/zar cases above, but for a magic-only,
	// extensionless source instead of an extension-recognized one.
	test('stfs (x360/XEX) source converts to extracted end-to-end with genuine XEX content', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await queuePage.addSource({
			name: '5A5A0003',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(stfsBytes),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.sourceMeta(item)).toBeVisible();
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
		const download = await queuePage.convertAndDownload(item, 'extracted', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\(XEX\)\.zip$/);
		await queuePage.expectDone(item, { timeout: 60_000 });

		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');

		const entries = await readZipEntries(filePath, () => true);
		const foundFiles = entries.map((e) => e.filename);
		const hasXex = foundFiles.some((name) => name.endsWith('.xex'));

		expect(
			hasXex,
			`Expected a .xex file, found: ${foundFiles.join(', ')}`,
		).toBeTruthy();
		const hasXbe = foundFiles.some((name) => name.endsWith('.xbe'));
		expect(
			hasXbe,
			`Did not expect a .xbe file, found: ${foundFiles.join(', ')}`,
		).toBeFalsy();
	});
});
