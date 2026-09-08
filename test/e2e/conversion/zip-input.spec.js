import { test, expect } from '../support/test.js';
import {
	makeCompressedFixtures,
	makeGodPartsWithHeader,
	makeZipFixture,
	writeFixtureFile,
} from '../../fixtures/index.js';
import { isoBytes, untitledIsoBytes, stfsBytes } from '../support/test-data.js';

/**
 * @import { CompressedFixtures } from '../../../src/types/global'
 */

/** @type {CompressedFixtures} */
let compressed;

test.beforeAll(async () => {
	compressed = await makeCompressedFixtures(untitledIsoBytes, 'test');
});

test.describe('zip input: dropped/selected .zip files', () => {
	test.describe.configure({ mode: 'serial' });

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a zip containing a single iso is expanded and inspected correctly', async ({
		queuePage,
	}) => {
		const zipPath = makeZipFixture([
			{ name: 'test.iso', bytes: untitledIsoBytes },
		]);
		const item = await queuePage.addSource(zipPath);
		await expect(queuePage.items).toHaveCount(1);
		// A lone loose image isn't a whole GoD/extracted structure, so it
		// becomes its own { kind: 'files' } source - same as a bare .iso
		// dropped directly (see folder-input-batch.spec.js) - but since this
		// zip holds exactly one game, assignZipLabels() labels it with the
		// zip's own filename (sans extension, "test.zip" -> "test") rather
		// than the entry's own internal name (see sourceLabels.js's
		// assignZipLabels() doc comment).
		await expect(queuePage.title(item)).toContainText('test');
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('a zip containing a single cci is expanded and inspected correctly', async ({
		queuePage,
	}) => {
		const zipPath = makeZipFixture([{ name: 'test.cci', bytes: compressed.cci }]);
		const item = await queuePage.addSource(zipPath);
		await expect(queuePage.items).toHaveCount(1);
		// Same zip-name label as above - the zip holds a single game, so the
		// title is the zip's own filename sans extension, not the entry's.
		await expect(queuePage.title(item)).toContainText('test');
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	// The five entries below are all built from the same untitled disc
	// content (see the `compressed` fixture above) - deliberately, since
	// expandZipFiles() is meant to make a zip behave exactly like the
	// equivalent unzipped drop would, and mixed-batch-stress.spec.js's
	// flat-drop equivalent already establishes that same-content entries
	// in different container formats resolve as independent standalone
	// entries rather than getting folded into one multi-disc set.
	test('a zip mixing several different single-file source formats resolves each to its own independently-inspected entry', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const zipPath = makeZipFixture([
			{ name: 'Halo 3.iso', bytes: untitledIsoBytes },
			{ name: 'Crackdown.cso', bytes: compressed.cso },
			{ name: 'Perfect Dark Zero.cci', bytes: compressed.cci },
			{ name: 'Forza Motorsport 4.zar', bytes: compressed.zar },
			// STFS packages have no fixed extension (see LOOSE_IMAGE_EXTENSIONS
			// in src/js/workers/source.js) - same extensionless coverage as
			// source-formats.spec.js's flat-drop equivalent.
			{ name: '4D530001', bytes: Buffer.from(stfsBytes) },
		]);

		const ids = await queuePage.idsAddedBy(async () => {
			await queuePage.sourceInput.setInputFiles(zipPath);
			await queuePage.addBtn.click();
		});
		expect(ids).toHaveLength(5);

		const halo3 = queuePage.itemByText('Halo 3.iso');
		const crackdown = queuePage.itemByText('Crackdown.cso');
		const pdz = queuePage.itemByText('Perfect Dark Zero.cci');
		const forza = queuePage.itemByText('Forza Motorsport 4.zar');
		const stfsItem = queuePage.itemByText('4D530001');

		for (const item of [halo3, crackdown, pdz, forza, stfsItem]) {
			await expect(item).toHaveCount(1);
			await queuePage.expectInspected(item, { timeout: 15_000 });
			await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
		}

		// Proves one specific entry survived as its own live, independently
		// inspected item (not a residual DOM node left over from a sibling
		// entry) by converting it end-to-end - same reasoning as
		// mixed-batch-stress.spec.js's equivalent flat-drop check.
		const download = await queuePage.convertAndDownload(halo3, 'xiso', {
			timeout: 30_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(halo3, { timeout: 30_000 });
	});

	test('a zip shaped like a real GoD dump (Data parts + CON header) resolves, inspects, and converts end-to-end - same as dropping the equivalent unzipped folder would', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const godParts = await makeGodPartsWithHeader(isoBytes);
		const zipPath = makeZipFixture(godParts);
		const item = await queuePage.addSource(zipPath);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectInspected(item, { timeout: 15_000 });
		// Matches folder-input-structured.spec.js's equivalent unzipped-folder
		// assertion for the same fixture.
		await expect(queuePage.sourceMetaTitleId(item)).toContainText('41560001');

		const download = await queuePage.convertAndDownload(item, 'xiso', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(item, { timeout: 60_000 });
	});

	// Real per-entry DEFLATE compression can't be produced by buildZip() (it
	// only labels the method, never actually deflates - see
	// test/utils/zipFixture.js), but the read side only branches on the
	// compressionMethod field itself, so labelling one entry as DEFLATE
	// exercises the same "can't be randomly read" rejection path a
	// genuinely-compressed entry would hit.
	test('a zip mixing a readable STORE entry with a compressed entry is skipped entirely - no queue item for either entry', async ({
		queuePage,
	}) => {
		const zipPath = makeZipFixture([
			{ name: 'valid.iso', bytes: untitledIsoBytes },
			{ name: 'movie.wmv', bytes: new Uint8Array(2048), compressionMethod: 8 },
		]);
		const ids = await queuePage.idsAddedBy(async () => {
			await queuePage.sourceInput.setInputFiles(zipPath);
			await queuePage.addBtn.click();
		});
		expect(ids).toHaveLength(0);
		await expect(queuePage.items).toHaveCount(0);
	});

	// Unlike a per-entry unsupported format (dropped alongside supported
	// ones, which are silently excluded but don't affect their siblings), a
	// compressed entry makes the *whole archive* unreadable by this app's
	// random-access zip reader - so nothing from it is queued, valid
	// sibling entries included.
	test('a zip containing only compressed (DEFLATE) entries is skipped entirely, without a queue item or a visible error', async ({
		queuePage,
	}) => {
		const zipPath = makeZipFixture(
			[
				{ name: 'movie.wmv', bytes: new Uint8Array(2048), compressionMethod: 8 },
				{ name: 'trailer.wmv', bytes: new Uint8Array(1024), compressionMethod: 8 },
			],
			'all-compressed.zip',
		);
		const ids = await queuePage.idsAddedBy(async () => {
			await queuePage.sourceInput.setInputFiles(zipPath);
			await queuePage.addBtn.click();
		});
		expect(ids).toHaveLength(0);
		await expect(queuePage.items).toHaveCount(0);
	});

	// A zip that parses fine but holds nothing this app recognizes as a
	// game file (no god/extracted folder, no loose disc image, no STFS
	// package) resolves the same way an equivalent unzipped drop of the
	// same junk would: nothing worth queuing, so nothing is queued.
	test('a zip with no recognizable game files inside is skipped entirely', async ({
		queuePage,
	}) => {
		const zipPath = makeZipFixture(
			[
				{ name: 'readme.txt', bytes: new Uint8Array(64) },
				{ name: 'cover.png', bytes: new Uint8Array(64) },
			],
			'junk.zip',
		);
		const ids = await queuePage.idsAddedBy(async () => {
			await queuePage.sourceInput.setInputFiles(zipPath);
			await queuePage.addBtn.click();
		});
		expect(ids).toHaveLength(0);
		await expect(queuePage.items).toHaveCount(0);
	});

	test('a corrupt zip (no valid end-of-central-directory) shows a visible error rather than failing silently', async ({
		queuePage,
	}) => {
		const zipPath = writeFixtureFile(
			'corrupt.zip',
			Buffer.from('definitely not a zip file'),
		);

		const item = await queuePage.addSource(zipPath);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.error(item)).toBeVisible();
		await expect(queuePage.error(item)).not.toBeEmpty();
	});

	// Same "Zip Slip" shape a directory-writing extractor would refuse -
	// see isUnsafeEntryName()'s doc comment in zipSource.js for why this
	// app rejects it up front even though it never writes an entry to a
	// real filesystem path.
	test('a zip entry that escapes upward via ".." shows a visible error rather than being expanded', async ({
		queuePage,
	}) => {
		const zipPath = makeZipFixture([
			{ name: '../../../etc/passwd', bytes: untitledIsoBytes },
		]);
		const item = await queuePage.addSource(zipPath);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.error(item)).toBeVisible();
		await expect(queuePage.error(item)).not.toBeEmpty();
	});
});
