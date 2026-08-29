import { test, expect } from '../support/test.js';
import fs from 'node:fs';
import path from 'node:path';
import {
	makeFixture,
	makeBatchDirFixture,
	makeGodDirFixture,
	makeExtractedDirFixture,
	makeCompressedFixtures,
} from '../../fixtures/index.js';
import {
	untitledIsoBytes as isoBytes,
	splitIsoPair,
} from '../support/test-data.js';

/**
 * @import { CompressedFixtures } from '../../../src/types/global'
 */

// Batch classification must key each file's split resolution to the file
// it was actually asked about, not to whatever split pair happens to
// exist anywhere in the batch. These tests run the real wasm layer
// through #source-input / #folder-input, unlike the mocked coverage in
// source.test.js, with file orderings designed to expose misattribution.

test.describe('flat multi-file drop: many extensions, a split pair, a malformed pair, and corrupt bytes all classify independently', () => {
	/** @type {CompressedFixtures} */
	let compressed;

	test.beforeAll(async () => {
		compressed = await makeCompressedFixtures(isoBytes, 'stress');
	});

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a single batch mixing loose images, a valid split pair, a malformed named pair, and outright corrupt bytes resolves every file to its own correct entry', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const [part1, part2] = splitIsoPair(isoBytes);
		// Independently-random buffers: the split scanner matches by
		// content, so corrupt.iso and the Gears of War 2 pair must never
		// byte-match each other.
		const gow2Garbage = crypto.getRandomValues(new Uint8Array(2048));
		const corruptGarbage = crypto.getRandomValues(new Uint8Array(2048));
		// Fable II needs its own fixture: reusing `isoBytes` would make it
		// byte-for-byte identical to the Forza split pair below (both built
		// from splitIsoPair(isoBytes)), and the content-based split scanner
		// would fold it into that same split instead of leaving it standalone.
		const fable2Bytes = makeFixture({ titleId: 0x7abc0001 });

		// `Halo 3.zar` and the malformed `Gears of War 2.*.cci` pair are
		// placed before the real `Forza Motorsport 4.*.iso` split pair, so
		// classification visits them while Forza's genuine parts still sit
		// unclaimed - the ordering most likely to misattribute a split.
		await queuePage.idsAddedBy(async () => {
			await queuePage.sourceInput.setInputFiles([
				{
					name: 'Halo 3.zar',
					mimeType: 'application/octet-stream',
					buffer: compressed.zar,
				},
				{
					name: 'Gears of War 2.1.cci',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(gow2Garbage),
				},
				{
					name: 'Gears of War 2.2.cci',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(gow2Garbage),
				},
				{
					name: 'Forza Motorsport 4.1.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(part1),
				},
				{
					name: 'Forza Motorsport 4.2.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(part2),
				},
				{
					name: 'Fable II.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(fable2Bytes),
				},
				{
					name: 'Crackdown.cso',
					mimeType: 'application/octet-stream',
					buffer: compressed.cso,
				},
				{
					name: 'Perfect Dark Zero.cci',
					mimeType: 'application/octet-stream',
					buffer: compressed.cci,
				},
				{
					name: 'corrupt.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(corruptGarbage),
				},
			]);
			await queuePage.addBtn.click();
		});

		// 4 standalone entries + 1 verified split pair (Forza) + 1 corrupt
		// file + 1 malformed named pair (Gears of War 2) = 7 entries.
		await expect(queuePage.items).toHaveCount(7);

		const halo3 = queuePage.itemByText('Halo 3.zar');
		const forza4 = queuePage.itemByText(
			'Forza Motorsport 4.1.iso + Forza Motorsport 4.2.iso',
		);
		const fable2 = queuePage.itemByText('Fable II.iso');
		const crackdown = queuePage.itemByText('Crackdown.cso');
		const pdz = queuePage.itemByText('Perfect Dark Zero.cci');
		const corrupt = queuePage.itemByText('corrupt.iso');
		const gow2 = queuePage.itemByText('Gears of War 2.1.cci');

		for (const item of [halo3, forza4, crackdown, pdz]) {
			await expect(item).toHaveCount(1);
			await queuePage.expectInspected(item, { timeout: 15_000 });
			await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
		}

		// Unlike the others in this batch (built from isoBytes/compressed.*,
		// which resolve to the untitled fixture with no fixed titleId to
		// assert), fable2Bytes was built with an explicit titleId - so this
		// entry can be pinned to its real value instead of just presence.
		// Case-insensitive: the display casing convention isn't re-verified
		// here, only the digits.
		await expect(fable2).toHaveCount(1);
		await queuePage.expectInspected(fable2, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(fable2)).toContainText(/7abc0001/i);

		// corrupt.iso: inspected, but the payload itself doesn't parse -
		// surfaces its own visible error without disappearing or stalling,
		// same as the single-format case in folder-input-batch.spec.js.
		await expect(corrupt).toHaveCount(1);
		await queuePage.expectError(corrupt, { timeout: 15_000 });

		// Gears of War 2.1.cci/.2.cci: named like a split pair, but never
		// verifies - it must stay its own 2-file entry, not get merged
		// into or swapped out for Forza's genuine split.
		await expect(gow2).toHaveCount(1);
		await expect(queuePage.error(gow2)).toBeVisible();
		await expect(queuePage.error(gow2)).not.toBeEmpty();

		// Proves Halo 3 specifically survived as its own live, independently
		// inspected entry (not a residual DOM node, not merged into Forza's
		// split) by converting it end-to-end.
		const download = await queuePage.convertAndDownload(halo3, 'xiso', {
			timeout: 30_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(halo3, { timeout: 30_000 });
	});
});

/**
 * Recursively reads every file under `dir` and returns it as a
 * `{ name, bytes }` entry with a forward-slash relative path - the shape
 * makeBatchDirFixture() expects. Lets a directory produced by
 * makeGodDirFixture()/makeExtractedDirFixture() be re-homed inside a
 * larger combined drop instead of being dropped on its own.
 * @param {string} dir
 * @param {string} [relPrefix]
 * @returns {{ name: string, bytes: Uint8Array }[]}
 */
function collectFileEntries(dir, relPrefix = '') {
	/** @type {{ name: string, bytes: Uint8Array }[]} */
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...collectFileEntries(abs, rel));
		} else {
			out.push({ name: rel, bytes: fs.readFileSync(abs) });
		}
	}
	return out;
}

/**
 * Re-homes every file under `dir` beneath `prefix/` in a combined batch.
 * @param {string} dir
 * @param {string} prefix
 */
function underPrefix(dir, prefix) {
	return collectFileEntries(dir).map(({ name, bytes }) => ({
		name: `${prefix}/${name}`,
		bytes,
	}));
}

test.describe('folder drop: GoD + extracted directories, and same-title discs in two different container shapes, never merge into one mixed multi-disc set', () => {
	const MULTI_DISC_TITLE_ID = 0x5a5a0099;

	/** @param {{ discNumber: number, discCount: number, mediaId: number }} opts */
	function discBytes(opts) {
		return makeFixture({
			titleId: MULTI_DISC_TITLE_ID,
			platform: 'x360',
			...opts,
		});
	}

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	// Same-title, same-discCount images that live in different container
	// shapes (a GoD folder vs. a flat .iso) still content-match as a
	// disc pair, but a real multi-disc release always ships its discs in
	// one shared container shape - so a match spanning two different
	// container kinds must stay two independent standalone entries
	// instead of folding into one multi-disc set. This drops a
	// standalone GoD folder, a standalone extracted folder, and such a
	// mismatched-container pair all in one folder drop, exercising the
	// grouping, the shape check, and per-subfolder recursion together.
	test('a single dropped folder mixing a standalone GoD folder, a standalone extracted folder, and same-title discs in two different container shapes resolves to 4 independent standalone entries', async ({
		queuePage,
	}) => {
		test.setTimeout(150_000);

		const [godSoloDir, extractedSoloDir, disc1GodDir] = await Promise.all([
			makeGodDirFixture(isoBytes),
			makeExtractedDirFixture(isoBytes),
			makeGodDirFixture(discBytes({ discNumber: 1, discCount: 2, mediaId: 0x1 })),
		]);
		const disc2Bytes = discBytes({ discNumber: 2, discCount: 2, mediaId: 0x2 });

		const combined = [
			...underPrefix(godSoloDir, 'SoloGame (GoD)'),
			...underPrefix(extractedSoloDir, 'SoloGame (XEX)'),
			...underPrefix(disc1GodDir, 'MultiGame/Disc1'),
			{ name: 'MultiGame/Disc2.iso', bytes: disc2Bytes },
		];
		const dir = makeBatchDirFixture(combined, 'mixed-dir-stress');

		await queuePage.addFolder(dir);

		// 4 independent entries: MultiGame's GoD-folder disc 1 and flat-iso
		// disc 2 must not fold into one 2-disc multi-disc entry.
		await expect(queuePage.items).toHaveCount(4);

		const items = await queuePage.items.all();
		/** @type {{ item: import('@playwright/test').Locator, titleId: string, isDirShaped: boolean }[]} */
		const summarized = [];

		for (const item of items) {
			await queuePage.expectQueued(item, { timeout: 30_000 });
			await expect(queuePage.error(item)).toBeHidden();
			await expect(queuePage.sourceMeta(item)).toBeVisible();
			await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
			const titleId =
				(await queuePage.sourceMetaTitleId(item).textContent()) ?? '';

			const partsPanel = queuePage.partsPanel(item);
			let isDirShaped;
			if (await partsPanel.isVisible()) {
				await queuePage.openParts(item);
				await expect(queuePage.partsCount(item)).toHaveText('1');
				// A dir-shaped source's sole part row ends with '/' (its
				// dirName); a flat-file source's row is just its filename.
				const rowName = await queuePage
					.partRowName(queuePage.partRows(item))
					.textContent();
				isDirShaped = (rowName ?? '').endsWith('/');
			} else {
				isDirShaped = true;
			}
			summarized.push({ item, titleId, isDirShaped });
		}

		// Group by titleId: SoloGame's GoD + extracted folders share one
		// titleId (both built from `isoBytes`); MultiGame's two discs
		// share MULTI_DISC_TITLE_ID. Exactly two pairs are expected.
		const byTitleId = new Map();
		for (const s of summarized) {
			const group = byTitleId.get(s.titleId) ?? [];
			group.push(s);
			byTitleId.set(s.titleId, group);
		}
		expect(byTitleId.size).toBe(2);
		for (const group of byTitleId.values()) expect(group.length).toBe(2);

		// SoloGame's pair is GoD + extracted, both 'dir' container shapes,
		// so both are dir-shaped. MultiGame's pair mixes a GoD-folder disc
		// with a flat-.iso disc, so its two entries disagree - finding
		// exactly one such group confirms both halves survived as
		// independent entries.
		const mixedGroups = [...byTitleId.values()].filter(
			(group) => group[0].isDirShaped !== group[1].isDirShaped,
		);
		expect(mixedGroups).toHaveLength(1);
		const [discA, discB] = mixedGroups[0];
		const godDiscItem = discA.isDirShaped ? discA.item : discB.item;
		const isoDiscItem = discA.isDirShaped ? discB.item : discA.item;

		// Confirm both halves of that pair convert independently.
		const godDownload = await queuePage.convertAndDownload(
			godDiscItem,
			'extracted',
			{ timeout: 60_000 },
		);
		expect(godDownload.suggestedFilename()).toMatch(/\.zip$/);
		await queuePage.expectDone(godDiscItem, { timeout: 60_000 });

		const isoDownload = await queuePage.convertAndDownload(
			isoDiscItem,
			'extracted',
			{ timeout: 60_000 },
		);
		expect(isoDownload.suggestedFilename()).toMatch(/\.zip$/);
		await queuePage.expectDone(isoDiscItem, { timeout: 60_000 });
	});
});
