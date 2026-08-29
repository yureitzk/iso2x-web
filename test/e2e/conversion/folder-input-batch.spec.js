import { test, expect } from '../support/test.js';
import {
	makeCompressedFixtures,
	makeBatchDirFixture,
	makeGodPartsWithHeader,
} from '../../fixtures/index.js';
import {
	untitledIsoBytes as isoBytes,
	splitIsoPair,
	stfsBytes,
	makeFixture,
} from '../support/test-data.js';

/**
 * @import { CompressedFixtures } from '../../../src/types/global'
 */

/** @type {CompressedFixtures} */
let compressed;

test.beforeAll(async () => {
	compressed = await makeCompressedFixtures(isoBytes, 'test');
});

test.describe('folder / directory input: loose files & batches', () => {
	test.describe.configure({ mode: 'serial' });

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a folder containing a single iso is added and inspected correctly', async ({
		queuePage,
	}) => {
		const dir = makeBatchDirFixture([{ name: 'test.iso', bytes: isoBytes }]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		// A lone loose image isn't a whole GoD/extracted structure, so it
		// becomes its own { kind: 'files' } source named after the file.
		await expect(queuePage.title(item)).toContainText('test.iso');
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('a folder containing a single cso (ciso) is added and inspected correctly', async ({
		queuePage,
	}) => {
		const dir = makeBatchDirFixture([
			{ name: 'test.cso', bytes: compressed.cso },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText('test.cso');
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('a folder containing a single cci is added and inspected correctly', async ({
		queuePage,
	}) => {
		const dir = makeBatchDirFixture([
			{ name: 'test.cci', bytes: compressed.cci },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText('test.cci');
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('a folder containing a single zar is added and inspected correctly', async ({
		queuePage,
	}) => {
		const dir = makeBatchDirFixture([
			{ name: 'test.zar', bytes: compressed.zar },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText('test.zar');
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	// STFS packages have no fixed extension - the fixture's filename
	// deliberately carries no extension at all (not even .stfs), the
	// realistic shape, which forces partitionDirEntries -> looseImageSourcesAt's
	// isStfsMagic() fallback rather than any extension regex fast-path.
	test('a folder containing a single stfs package (no extension) is added and inspected correctly', async ({
		queuePage,
	}) => {
		const dir = makeBatchDirFixture([{ name: '4D530001', bytes: stfsBytes }]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.title(item)).toContainText('4D530001');
		await queuePage.expectInspected(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
	});

	test('a folder containing a valid split .1.iso/.2.iso pair resolves to one queue item and converts end-to-end', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const [part1, part2] = splitIsoPair(isoBytes);
		const dir = makeBatchDirFixture([
			{ name: 'test.1.iso', bytes: part1 },
			{ name: 'test.2.iso', bytes: part2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectInspected(item, { timeout: 15_000 });

		const download = await queuePage.convertAndDownload(item, 'god', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });
	});

	// A real .1.cci/.2.cci split needs a valid CCI header per part and only
	// occurs past ~4.06 GB, so it can't be fixtured. This covers the same
	// guard rail via a folder drop instead of the multi-file #source-input
	// path: two files matching the split-pair naming convention, but with
	// content that doesn't actually form a valid split, must error loudly.
	test('a folder with a malformed .1.cci/.2.cci pair shows a visible error', async ({
		queuePage,
	}) => {
		const garbage = new Uint8Array(2048);
		const dir = makeBatchDirFixture([
			{ name: 'test.1.cci', bytes: garbage },
			{ name: 'test.2.cci', bytes: garbage },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.error(item)).toBeVisible();
		await expect(queuePage.error(item)).not.toBeEmpty();
	});

	// STFS detection must survive when mixed with other formats, not
	// just tested in isolation - an unrecognized magic-only file could
	// otherwise get silently swept into the "no convertible files"
	// bucket (see the test below).
	test('a folder containing multiple different-format loose images plus a split pair each becomes its own queue item', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const [part1, part2] = splitIsoPair(isoBytes);
		const dir = makeBatchDirFixture([
			{ name: 'alpha.iso', bytes: isoBytes },
			{ name: 'bravo.cso', bytes: compressed.cso },
			{ name: 'charlie.cci', bytes: compressed.cci },
			{ name: 'delta.1.iso', bytes: part1 },
			{ name: 'delta.2.iso', bytes: part2 },
			{ name: '4D530001', bytes: stfsBytes },
		]);
		await queuePage.addFolder(dir);

		await expect(queuePage.items).toHaveCount(5);

		const alpha = queuePage.itemByText('alpha.iso');
		const bravo = queuePage.itemByText('bravo.cso');
		const charlie = queuePage.itemByText('charlie.cci');
		const delta = queuePage.itemByText('delta.1.iso + delta.2.iso');
		const echo = queuePage.itemByText('4D530001');

		for (const item of [alpha, bravo, charlie, delta, echo]) {
			await expect(item).toHaveCount(1);
			await queuePage.expectInspected(item, { timeout: 15_000 });
		}
	});

	test('a folder with no convertible files inside is not added to the queue', async ({
		queuePage,
	}) => {
		const dir = makeBatchDirFixture([
			{
				name: 'readme.txt',
				bytes: new TextEncoder().encode('just some notes, nothing here'),
			},
			{ name: 'cover.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
		]);
		await queuePage.folderInput.setInputFiles(dir);
		await queuePage.addFolderBtn.click();

		await expect(queuePage.items).toHaveCount(0);
		await expect(queuePage.addFolderBtn).toBeDisabled();
	});

	test('a folder mixing valid images with one corrupt file queues all three, flagging only the corrupt one', async ({
		queuePage,
	}) => {
		const corrupt = new Uint8Array(2048); // matches no known source format
		const dir = makeBatchDirFixture([
			{ name: 'valid.iso', bytes: isoBytes },
			{ name: 'valid.cso', bytes: compressed.cso },
			{ name: 'corrupt.iso', bytes: corrupt },
		]);
		await queuePage.addFolder(dir);

		await expect(queuePage.items).toHaveCount(3);

		const validIso = queuePage.itemByText('valid.iso');
		const validCso = queuePage.itemByText('valid.cso');
		const corruptItem = queuePage.itemByText('corrupt.iso');

		await queuePage.expectInspected(validIso, { timeout: 15_000 });
		await queuePage.expectInspected(validCso, { timeout: 15_000 });

		// A failed inspection surfaces its own 'error' status - the item
		// stays convertible/removable rather than being removed or stalled.
		await queuePage.expectError(corruptItem, { timeout: 15_000 });
	});

	test('a folder containing a split pair alongside unrelated files still resolves and converts correctly', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const [part1, part2] = splitIsoPair(isoBytes);
		const dir = makeBatchDirFixture([
			{ name: 'test.1.iso', bytes: part1 },
			{ name: 'test.2.iso', bytes: part2 },
			{ name: 'readme.txt', bytes: new TextEncoder().encode('unrelated notes') },
			{ name: 'cover.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectInspected(item, { timeout: 15_000 });

		const download = await queuePage.convertAndDownload(item, 'xiso', {
			timeout: 60_000,
		});
		expect(download.suggestedFilename()).toMatch(/\.xiso\.iso$/);
		await queuePage.expectDone(item, { timeout: 60_000 });
	});

	// Regression test: a GoD .data folder's header stub sits beside the
	// folder and shares STFS's magic bytes but has no allocated blocks,
	// so it always fails to open standalone (see discSourceFor()'s doc
	// comment in src/js/workers/source.js). Mixed into the same batch
	// drop as an unrelated loose file, it used to leak into the magic-
	// detection fallback as a bogus third "invalid stfs" item.
	test('a folder mixing an unrelated loose game with a GoD .data folder plus its header stub queues exactly one item per source, with no phantom stfs error', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const godIso = makeFixture({ titleId: 0x7a7a1001 });
		const unrelatedIso = makeFixture({ titleId: 0x7a7a1002 });
		const godParts = await makeGodPartsWithHeader(godIso);
		const dir = makeBatchDirFixture([
			{ name: 'unrelated.iso', bytes: unrelatedIso },
			...godParts,
		]);
		await queuePage.addFolder(dir);

		await expect(queuePage.items).toHaveCount(2);

		const unrelated = queuePage.itemByText('unrelated.iso');
		await expect(unrelated).toHaveCount(1);
		await queuePage.expectInspected(unrelated, { timeout: 15_000 });

		// Named after its ".data" folder (see discSourceFor()).
		const godItem = queuePage.items.filter({ hasNotText: 'unrelated.iso' });
		await expect(godItem).toHaveCount(1);
		await queuePage.expectInspected(godItem, { timeout: 15_000 });
	});
});
