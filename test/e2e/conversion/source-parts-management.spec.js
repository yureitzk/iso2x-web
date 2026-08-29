import { test, expect } from '../support/test.js';
import {
	makeBatchDirFixture,
	makeCompressedFixtures,
	makeExtractedDirFixture,
	makeGodDirFixture,
	makeUnresolvedSplitFragments,
} from '../../fixtures/index.js';
import {
	untitledIsoBytes as isoBytes,
	splitIsoPair,
	makeFixture,
	stfsBytes,
} from '../support/test-data.js';
import { installWorkerHarness } from '../../utils/worker-harness.js';

/**
 * @import { CompressedFixtures } from '../../../src/types/global'
 */

// Covers the "Source Files (N)" disclosure panel: per-row locked/
// remove state and the "Add" control, for source shapes reachable
// through real wasm detection (split pairs, GoD folders, a malformed
// pair's error-recovery state). General multi-disc promote/add/move/
// remove coverage lives in multi-disc.spec.js.
//
// Not covered: "wrong order -> unresolved -> manual reorder -> Verify
// succeeds" - with only 2 fragments, the automatic classifier already
// tries both orderings before 'unresolved' ever surfaces, so a genuine
// 2-part split can't reach that state from a bad drop order.
test.describe('Source Files panel - resolved split pair', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('shows both parts as locked rows with no remove controls', async ({
		queuePage,
	}) => {
		const [part1, part2] = splitIsoPair(isoBytes);
		const item = await queuePage.addSource([
			{
				name: 'parts.1.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part1),
			},
			{
				name: 'parts.2.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part2),
			},
		]);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');
		await expect(queuePage.partRows(item)).toHaveCount(2);
		for (const row of await queuePage.partRows(item).all()) {
			await expect(row).toHaveAttribute('data-locked', 'true');
			await expect(queuePage.partRowRemoveBtn(row)).toBeHidden();
		}
		const names = await queuePage.partRowNames(item);
		expect(names.sort()).toEqual(['parts.1.iso', 'parts.2.iso']);
		// A verified split's order is the only valid one, so no drag/reorder
		// controls, unlike a multi-disc entry's rows.
		for (const row of await queuePage.partRows(item).all()) {
			await expect(queuePage.partRowDrag(row)).toBeHidden();
		}
	});

	// Once this pair re-inspects successfully, item.sourceFormat becomes
	// 'xiso', and the reattach picker (still live since a locked 2-file
	// split is also promotable) must narrow to '.iso' - the same real
	// extension a known-xiso disc addition narrows to, not the broad
	// known-extensions fallback.
	test("a resolved raw-XISO split's reattach control narrows to '.iso' once sourceFormat is known, not the broad fallback", async ({
		queuePage,
	}) => {
		const [part1, part2] = splitIsoPair(isoBytes);
		const item = await queuePage.addSource([
			{
				name: 'parts.1.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part1),
			},
			{
				name: 'parts.2.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(part2),
			},
		]);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.openParts(item);
		const addInput = queuePage.partsAddInput(item);
		await expect(addInput).toBeEnabled();
		await expect(addInput).toHaveAttribute('accept', '.iso');
	});
});

// Regression coverage: does the displayed total size recompute once a
// disc is merged into an existing multi-disc entry, or does it keep
// showing the size from the original inspection? Runs the real "Add"
// control end-to-end (partitionDir -> wasm merge-verify -> re-render),
// no mocked WorkerController.
//
// discCount is fixed metadata for the whole release - baked identically
// into every disc up front, not something that grows as discs are
// added - so all three discs below share one discCount.
test.describe('Source Files panel - source-meta__size after adding a disc to an existing multi-disc entry', () => {
	const MULTI_DISC_TITLE_ID = 0x6b6b0011;

	/** @param {{ discNumber: number, mediaId: number }} opts */
	function discBytes(opts) {
		return makeFixture({
			titleId: MULTI_DISC_TITLE_ID,
			platform: 'x360',
			discCount: 3,
			...opts,
		});
	}

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	// Assumes dropping only 2 of 3 discs that all declare discCount: 3
	// still merges into one multi-disc item (a "partial" set), rather
	// than the scanner requiring all 3 up front. Unconfirmed against the
	// real scanner - if the two-disc drop below doesn't merge into a
	// single item, that's this test failing informatively, not a bug in
	// the test.
	test('the combined size includes the third disc once addDisc() merges it in, not just the original two', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discBytes({ discNumber: 1, mediaId: 0x1 });
		const disc2 = discBytes({ discNumber: 2, mediaId: 0x2 });

		const item = await queuePage.addSource([
			{
				name: 'disc1.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(disc1),
			},
			{
				name: 'disc2.iso',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from(disc2),
			},
		]);

		// Same-titleId, same-discCount, compatible-container discs merge
		// into one multi-disc queue item - see mixed-batch-stress.spec.js's
		// analogous grouping test.
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectInspected(item, { timeout: 15_000 });

		const combinedTwoDiscSize = disc1.length + disc2.length;
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(combinedTwoDiscSize),
		);

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');

		const disc3 = discBytes({ discNumber: 3, mediaId: 0x3 });
		await queuePage.partsAddInput(item).setInputFiles({
			name: 'disc3.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc3),
		});

		// The merge round-trip re-verifies through the real worker before
		// the panel updates - give it the same generous window the
		// existing multi-disc/GoD conversion tests use for a real wasm
		// round trip.
		await expect(queuePage.partsCount(item)).toHaveText('3', {
			timeout: 15_000,
		});

		// The regression itself: total displayed size must include disc3,
		// not stay pinned at the original two-disc total.
		const combinedThreeDiscSize = combinedTwoDiscSize + disc3.length;
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(combinedThreeDiscSize),
			{ timeout: 15_000 },
		);
	});
});

// Confirms the accept hint tracks the worker-detected sourceFormat and
// not the filename, using a case where the two genuinely disagree - a
// same-extension fixture (e.g. a .cci pair, as in the malformed-pair
// tests below) can't prove this, since the filename and the resolved
// format point the same direction either way and the test would pass
// for the wrong reason.
test.describe('Source Files panel - Add-file accept hint follows real content, not filename', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	// The bytes are a genuine raw XISO image; the filename claims .cci.
	// If the accept hint were driven by the filename instead of the
	// sourceFormat the worker actually detected during inspection, this
	// would wrongly narrow to '.cci' instead of '.iso'.
	test('a genuinely-xiso file misnamed with a .cci extension narrows the picker to .iso, not .cci', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'game.cci',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes.buffer),
		});
		await queuePage.expectInspected(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		await expect(queuePage.partsAddInput(item)).toHaveAttribute('accept', '.iso');
	});

	// Distinct from the case above (and from the resolved-split-pair test):
	// this source was never part of a split at all, just a single file
	// that inspected as sourceFormat 'xiso'. Its promote/add-disc control
	// should narrow the same way a resolved split's reattach control does.
	test('a single, never-split source that inspected as xiso narrows its own Add control to .iso', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'solo.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes.buffer),
		});
		await queuePage.expectInspected(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('1');
		const addInput = queuePage.partsAddInput(item);
		await expect(addInput).toBeEnabled();
		await expect(addInput).toHaveAttribute('accept', '.iso');
	});
});

test.describe('Source Files panel - standalone GoD folder', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('renders the single "<dirName>/" summary row and a live, folder-mode Add control', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const dir = await makeGodDirFixture(isoBytes);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('1');
		await expect(queuePage.partRows(item)).toHaveCount(1);
		// The row reads the folder's dirName plus a trailing slash - no
		// leading disc-position number, since a standalone GoD folder
		// isn't part of any disc set yet.
		await expect(queuePage.partRowName(queuePage.partRows(item))).toHaveText(
			/\/$/,
		);
		await expect(queuePage.partRowName(queuePage.partRows(item))).not.toHaveText(
			/^\d+\//,
		);
		// A single GoD dir isn't a multi-disc entry yet, so its one row is
		// locked the same way a verified split's rows are - nothing to
		// remove.
		await expect(
			queuePage.partRowRemoveBtn(queuePage.partRows(item)),
		).toBeHidden();
		// A single idle dir source is still promotable, so the Add control
		// stays visible/enabled, switched to folder-picker mode.
		await expect(queuePage.partsAddWrap(item)).toBeVisible();
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
		await expect(queuePage.partsAddInput(item)).toHaveAttribute(
			'webkitdirectory',
			'',
		);
	});
});

test.describe('Source Files panel - standalone extracted folder', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('never shows the Source Files disclosure at all, since there is nothing to add', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const dir = await makeExtractedDirFixture(isoBytes);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.partsPanel(item)).toBeHidden();
	});
});

test.describe('Source Files panel - recovering from a malformed split pair', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	// Same malformed pair as folder-input-batch.spec.js's error test,
	// checking the parts panel itself here.
	test('a malformed pair still shows both files as locked rows, with a live reattach control', async ({
		queuePage,
	}) => {
		const garbage = new Uint8Array(2048);
		const dir = makeBatchDirFixture([
			{ name: 'bad.1.cci', bytes: garbage },
			{ name: 'bad.2.cci', bytes: garbage },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.error(item)).toBeVisible();
		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');
		await expect(queuePage.partRows(item)).toHaveCount(2);
		for (const row of await queuePage.partRows(item).all()) {
			await expect(row).toHaveAttribute('data-locked', 'true');
			await expect(queuePage.partRowRemoveBtn(row)).toBeHidden();
		}
		// A failed inspection re-enables the entry rather than dead-ending
		// it, so the Add control stays usable.
		await expect(queuePage.partsAddWrap(item)).toBeVisible();
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
	});

	// A malformed named pair never reaches real inspection, so
	// item.sourceFormat stays unset. The reattach picker falls back to a
	// filename hint instead - "bad.1.cci"/"bad.2.cci" still carry the
	// .cci extension, so it narrows to '.cci' rather than staying fully
	// unrestricted (the broad known-extensions fallback only kicks in
	// when neither sourceFormat nor filename gives a usable hint - see
	// the raw-XISO fragment case below).
	test("a malformed pair's reattach control narrows to '.cci' from the filename, even though it was never actually inspected", async ({
		queuePage,
	}) => {
		const garbage = new Uint8Array(2048);
		const dir = makeBatchDirFixture([
			{ name: 'bad.1.cci', bytes: garbage },
			{ name: 'bad.2.cci', bytes: garbage },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.error(item)).toBeVisible();
		await queuePage.openParts(item);
		const addInput = queuePage.partsAddInput(item);
		await expect(addInput).toBeEnabled();
		await expect(addInput).toHaveAttribute('accept', '.cci');
	});

	test.describe('Source Files panel - unresolved raw-XISO fragment set', () => {
		test.beforeEach(async ({ queuePage }) => {
			await queuePage.goto();
		});

		test('a header fragment plus a bogus continuation lands as unresolved, with reorder/remove rows', async ({
			queuePage,
		}) => {
			const [header, bogus] = makeUnresolvedSplitFragments(isoBytes);
			const item = await queuePage.addSource([
				{
					name: 'mystery.1.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(header),
				},
				{
					name: 'mystery.2.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(bogus),
				},
			]);
			await expect(queuePage.items).toHaveCount(1);
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
			await queuePage.openParts(item);
			await expect(queuePage.partsCount(item)).toHaveText('2');
			for (const row of await queuePage.partRows(item).all()) {
				await expect(row).toHaveAttribute('data-locked', 'false');
				await expect(queuePage.partRowRemoveBtn(row)).toBeVisible();
				await expect(queuePage.partRowDrag(row)).toBeVisible();
			}
			await expect(queuePage.verifyOrderBtn(item)).toBeEnabled();
		});

		test('removing the bad fragment and verifying leaves a recoverable single-file entry', async ({
			queuePage,
		}) => {
			const [header, bogus] = makeUnresolvedSplitFragments(isoBytes);
			const item = await queuePage.addSource([
				{
					name: 'mystery.1.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(header),
				},
				{
					name: 'mystery.2.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(bogus),
				},
			]);
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
			await queuePage.openParts(item);
			const badRow = queuePage.partRows(item).filter({ hasText: 'mystery.2.iso' });
			await queuePage.partRowRemoveBtn(badRow).click();
			await expect(queuePage.partsCount(item)).toHaveText('1');
		});

		// Drives Verify order through a real worker against real
		// (deliberately non-matching) bytes, catching a break anywhere in
		// the MSG.VERIFY_ORDER -> wasm -> MSG.VERIFY_RESULT chain.
		//
		// Asserts on the worker lifecycle (spun up for the check, torn
		// down once VERIFY_RESULT arrives) rather than on checkedEntries:
		// this fixture fails the wasm check as a whole, not at one
		// specific part, so no per-row 'no-match' status is guaranteed.
		//
		// Only the failure branch is reachable here - the automatic
		// search that produced 'unresolved' already tried every ordering
		// of this fixed file set, so nothing drives result.ok === true
		// without a fixture built to make that search miss a valid order.
		test('clicking Verify order on a genuinely unresolved fragment set round-trips through a real worker, leaving the entry unresolved', async ({
			page,
			queuePage,
		}) => {
			// Re-navigate so addInitScript() takes effect, rather than
			// relying on the describe block's own beforeEach navigation.
			await page.addInitScript(installWorkerHarness, { trackLive: true });
			await queuePage.goto();
			const [header, bogus] = makeUnresolvedSplitFragments(isoBytes);
			const item = await queuePage.addSource([
				{
					name: 'mystery.1.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(header),
				},
				{
					name: 'mystery.2.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(bogus),
				},
			]);
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
			await queuePage.openParts(item);
			await expect(queuePage.verifyOrderBtn(item)).toBeEnabled();
			const liveBefore = await page.evaluate(() => window.__liveWorkers.size);
			const postsBefore = await page.evaluate(() => window.__workerPostCount ?? 0);
			await queuePage.verifyOrderBtn(item).click();
			// A worker actually receives the VERIFY_ORDER message - not
			// asserted via __liveWorkers.size, since inspectWorkerPool may
			// serve this from an already-live idle worker instead of
			// spawning a new one.
			await expect
				.poll(() => page.evaluate(() => window.__workerPostCount ?? 0))
				.toBeGreaterThan(postsBefore);
			// ...and no worker leaks out of the pool once VERIFY_RESULT
			// comes back - proof the click drove a real worker/wasm round
			// trip, independent of whatever verdict this specific
			// fixture's bytes happen to produce.
			await expect
				.poll(() => page.evaluate(() => window.__liveWorkers.size), {
					timeout: 15_000,
				})
				.toBe(liveBefore);
			// A failed verify is diagnostic only - it must never silently
			// resolve or drop the entry. It stays unresolved, both parts
			// still present, and the error/reason stays visible.
			await queuePage.expectUnresolved(item);
			await expect(queuePage.partsCount(item)).toHaveText('2');
			await expect(queuePage.error(item)).toBeVisible();
			await expect(queuePage.error(item)).not.toBeEmpty();
		});

		// The filename gives no cci/cso/ciso hint either ("mystery.1.iso"
		// isn't one of the recognized split-naming extensions), and a
		// raw-XISO fragment set is never inspected, so item.sourceFormat
		// is unset too. With neither signal available, the picker falls
		// back to the known-extensions list - not fully unrestricted, but
		// not narrowed to one specific extension either.
		test("the unresolved set's reattach control falls back to the known-extensions list, not full unrestriction", async ({
			queuePage,
		}) => {
			const [header, bogus] = makeUnresolvedSplitFragments(isoBytes);
			const item = await queuePage.addSource([
				{
					name: 'mystery.1.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(header),
				},
				{
					name: 'mystery.2.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(bogus),
				},
			]);
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
			await queuePage.openParts(item);
			await expect(queuePage.partsAddInput(item)).toHaveAttribute(
				'accept',
				'.iso,.cso,.cci,.zar',
			);
		});
	});

	// Two or more files that each independently look like a truncated
	// part-1 header, with nothing to say which is real. Routed to the
	// same 'unresolved' kind as a plain fragment set, but tagged
	// unresolvedKind: 'ambiguousHeaders'.
	test.describe('Source Files panel - ambiguous raw-XISO header candidates', () => {
		test.beforeEach(async ({ queuePage }) => {
			await queuePage.goto();
		});

		// Two distinct images (different titleId), each independently
		// truncated to a structurally-valid-but-incomplete header, using
		// the same truncation point makeUnresolvedSplitFragments() uses
		// elsewhere (past the volume descriptor/directory table but short
		// of the full referenced length). Neither header's "bogus"
		// continuation half is used - the point is two competing headers
		// with no naming or content to disambiguate them.
		test('two distinct truncated headers with no naming/content to disambiguate them land as unresolved, with reorder/remove rows and Verify order enabled', async ({
			queuePage,
		}) => {
			const [headerA] = makeUnresolvedSplitFragments(
				makeFixture({ titleId: 0x7a7a0001 }),
			);
			const [headerB] = makeUnresolvedSplitFragments(
				makeFixture({ titleId: 0x7a7a0002 }),
			);
			const item = await queuePage.addSource([
				{
					name: 'candidate-a.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(headerA),
				},
				{
					name: 'candidate-b.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(headerB),
				},
			]);
			await expect(queuePage.items).toHaveCount(1);
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
			await queuePage.openParts(item);
			await expect(queuePage.partsCount(item)).toHaveText('2');
			for (const row of await queuePage.partRows(item).all()) {
				await expect(row).toHaveAttribute('data-locked', 'false');
				await expect(queuePage.partRowRemoveBtn(row)).toBeVisible();
				await expect(queuePage.partRowDrag(row)).toBeVisible();
			}
			// Unlike a duplicate-disc-claim entry (multi-disc.spec.js), this
			// IS a fragment set with a real header/order to verify, so the
			// control stays offered - not hidden the way it is there.
			await expect(queuePage.partsVerifyWrap(item)).toBeVisible();
			await expect(queuePage.verifyOrderBtn(item)).toBeEnabled();
			await expect(queuePage.error(item)).toBeVisible();
			await expect(queuePage.error(item)).not.toBeEmpty();
		});

		// Unlike a plain fragment set (where the automatic search already
		// tried every ordering), the automatic search never runs at all
		// once more than one header candidate exists - so dropping the
		// wrong candidate and letting the automatic re-search run over
		// the real header + continuation is a genuine way to resolve this
		// kind of entry, not just a diagnostic re-check.
		test('removing the decoy header leaves the real header + continuation, which resolves automatically without needing a manual Verify click', async ({
			queuePage,
		}) => {
			const [headerReal, continuationReal] = splitIsoPair(isoBytes);
			const [headerDecoy] = makeUnresolvedSplitFragments(
				makeFixture({ titleId: 0x7a7a0003 }),
			);
			const item = await queuePage.addSource([
				{
					name: 'real-header.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(headerReal),
				},
				{
					name: 'real-continuation.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(continuationReal),
				},
				{
					name: 'decoy-header.iso',
					mimeType: 'application/octet-stream',
					buffer: Buffer.from(headerDecoy),
				},
			]);
			await expect(queuePage.items).toHaveCount(1);
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
			await queuePage.openParts(item);
			await expect(queuePage.partsCount(item)).toHaveText('3');
			const decoyRow = queuePage
				.partRows(item)
				.filter({ hasText: 'decoy-header.iso' });
			await queuePage.partRowRemoveBtn(decoyRow).click();
			// The remaining [real-header, real-continuation] pair is a
			// genuine split pair, so the automatic re-search resolves it on
			// its own - the entry leaves 'unresolved' with real title/size
			// metadata, no manual Verify click needed.
			await expect(queuePage.partsCount(item)).toHaveText('2');
			await queuePage.expectInspected(item, { timeout: 15_000 });
			await expect(queuePage.sourceMetaTitleId(item)).not.toBeEmpty();
		});
	});
});

// A single .zar source's "Source Files" panel must never offer a way to
// attach a second source file, since the wasm batch scanner can only
// group raw XISO and GoD-shaped folders into a multi-disc set - never
// zar. The panel simply doesn't render for a healthy single zar entry.
test.describe('Source Files panel - single zar source offers no way to add sources', () => {
	/** @type {CompressedFixtures} */
	let compressed;

	test.beforeAll(async () => {
		compressed = await makeCompressedFixtures(isoBytes, 'test');
	});

	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a healthy single .zar entry never shows the Source Files disclosure at all', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'test.zar',
			mimeType: 'application/octet-stream',
			buffer: compressed.zar,
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		// Unlike a promotable .iso/.god single source, there's nothing this
		// panel could ever offer for a single zar - no split-sibling
		// reattach, no disc-addition/promote - so it stays hidden entirely
		// rather than exposing a control that can only fail.
		await expect(queuePage.partsPanel(item)).toBeHidden();
	});

	// A .cci/.cso single source hits the same wasm-scanner limitation as
	// .zar, pinned down here too so a future change narrowing this back
	// down to "just zar" gets caught.
	for (const ext of /** @type {const} */ (['cci', 'cso'])) {
		test(`a healthy single .${ext} entry never shows the Source Files disclosure at all`, async ({
			queuePage,
		}) => {
			const item = await queuePage.addSource({
				name: `test.${ext}`,
				mimeType: 'application/octet-stream',
				buffer: compressed[ext],
			});
			await queuePage.expectQueued(item, { timeout: 15_000 });
			await expect(queuePage.partsPanel(item)).toBeHidden();
		});
	}

	// STFS is in NO_SIBLING_FORMATS (see isSplitCapableSource() in
	// sourcePartsAccept.js) for the same reason as zar - a single package
	// has no "other half" to reattach - and it isn't in
	// MULTI_DISC_CAPABLE_FORMATS either, so there's no promote-to-multi-disc
	// affordance for it. The e2e counterpart to the isSplitCapableSource
	// unit test: confirms the panel stays hidden end-to-end, not just that
	// the underlying predicate returns false.
	test('a healthy single stfs entry never shows the Source Files disclosure at all', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: '4D530001',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(stfsBytes),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.partsPanel(item)).toBeHidden();
	});
});
