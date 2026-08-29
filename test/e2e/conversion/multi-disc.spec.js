import { test, expect } from '../support/test.js';
import fs from 'node:fs';
import path from 'node:path';
import {
	makeFixture,
	makeBatchDirFixture,
	makeGodDirFixture,
} from '../../fixtures/index.js';
import { readZipEntries } from '../support/zip.js';
import { TEXT } from '../../../src/js/constants/messages.js';

/**
 * Recursively sums the byte size of every file under `dir`. A GoD dir
 * fixture's on-disk footprint (sector-padded Data0000/Data0001/... parts)
 * isn't the same as the raw ISO byte count, unlike a raw-image ('files')
 * disc, whose file size is the source byte count directly.
 * @param {string} dir
 * @returns {number}
 */
function sumDirBytes(dir) {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		total += entry.isDirectory() ? sumDirBytes(abs) : fs.statSync(abs).size;
	}
	return total;
}

/**
 * Recursively reads every file under `dir` and returns it as a
 * `{ name, bytes }` entry, relative-path-prefixed with `prefix` - the
 * shape makeBatchDirFixture() expects. A GoD dir fixture nests its real
 * Data#### parts one level down inside its own ".data" subfolder, so a
 * flat, non-recursive read would list that subfolder as a file and throw
 * trying to read it.
 * @param {string} dir
 * @param {string} prefix
 * @returns {{ name: string, bytes: Buffer }[]}
 */
function collectDirFiles(dir, prefix) {
	/** @type {{ name: string, bytes: Buffer }[]} */
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		const rel = `${prefix}/${entry.name}`;
		if (entry.isDirectory()) {
			out.push(...collectDirFiles(abs, rel));
		} else {
			out.push({ name: rel, bytes: fs.readFileSync(abs) });
		}
	}
	return out;
}

/**
 * Escapes regex-special characters so a dynamic string (e.g. a fixture
 * dirName) can be dropped into a `RegExp` literally.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds the folder that directly holds a GoD fixture's Data#### parts -
 * the name the app itself renders as the disc's dirName. Real GoD dumps
 * name this folder by content hash (e.g. "0F3AE16EE192DBBC69A6.data"),
 * one or more path segments below whatever folder was actually selected -
 * never the top-level fixture directory's own name.
 * @param {string} dir
 * @returns {string}
 */
function findGodContentDirName(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name.endsWith('.data')) return entry.name;
		const nested = findGodContentDirName(path.join(dir, entry.name));
		if (nested) return nested;
	}
	throw new Error(`No ".data" content folder found under ${dir}`);
}

// Exercises multi-disc detection/reorder/promote/add/remove through real
// wasm grouping: 2+ complete images sharing (titleId, discCount) form a
// multi-disc set, split further by distinct mediaId/discNumber. Not
// mocked - uses makeFixture()'s mediaId/discNumber/discCount options
// (platform: 'x360' only, for now).
//
// A fixture with discCount: N alone isn't "multi-disc" by itself -
// grouping needs 2+ same-(titleId, discCount) images in one batch. A
// lone disc dropped by itself resolves as an ordinary standalone
// source, which the "promote" tests below rely on.

const TITLE_ID = 0x5a5a0010;

// addDisc()/promoteToMultiDisc() re-partition existingEntries + newEntries
// from scratch through real (unmocked) wasm detection - see
// resolveDiscAddition() in sourcePartsDiscActions.js. For a GoD-folder
// disc that's strictly more work than the raw single-file case (a whole
// nested directory's worth of entries/files, not one File), so the same
// 15s budget that's comfortably enough for a raw-image addDisc()/
// promoteToMultiDisc() round trip isn't proportionate here - it was tight
// enough to time out under ordinary local machine load, not just a truly
// broken build. Give every wait on a GoD-folder disc-add/promote/dissolve
// result this larger, cost-matched budget instead of the raw-file one.
const WASM_DETECT_TIMEOUT_MS = 30_000;

/**
 * @param {{ discNumber: number, discCount: number, mediaId: number }} opts
 */
function discFixture({ discNumber, discCount, mediaId }) {
	return makeFixture({
		titleId: TITLE_ID,
		platform: 'x360',
		discNumber,
		discCount,
		mediaId,
	});
}

/**
 * Same underlying disc content as discFixture(), repackaged as a GoD-shaped
 * folder instead of a raw .iso file, so the same (titleId, discCount,
 * mediaId/discNumber) grouping gets exercised through the GoD folder
 * container too, not just the raw-image container every other test in
 * this file uses.
 * @param {{ discNumber: number, discCount: number, mediaId: number }} opts
 */
async function godDiscFixture({ discNumber, discCount, mediaId }) {
	return makeGodDirFixture(discFixture({ discNumber, discCount, mediaId }));
}

test.describe('multi-disc detection from a real folder drop', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('two same-title, same-discCount images resolve into one multi-disc entry, sorted by disc number and locked', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });
		// Named/ordered so disc 2's file sorts first alphabetically, proving
		// row order comes from disc_number, not folder listing order.
		const dir = makeBatchDirFixture([
			{ name: 'aaa-second.iso', bytes: disc2 },
			{ name: 'zzz-first.iso', bytes: disc1 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');
		await expect(queuePage.partRows(item)).toHaveCount(2);
		expect(await queuePage.partRowNames(item)).toEqual([
			'zzz-first.iso',
			'aaa-second.iso',
		]);

		// data-locked reflects the row-set shape (fixed-order verified split
		// vs. reorderable multi-disc/unresolved list), not each disc's own
		// locked flag - a multi-disc entry's rows are always
		// data-locked="false" here, even though neither disc gets a remove
		// button (that's the disc's own `locked` state).
		for (const row of await queuePage.partRows(item).all()) {
			await expect(row).toHaveAttribute('data-locked', 'false');
			await expect(queuePage.partRowRemoveBtn(row)).toBeHidden();
		}
		const rows = queuePage.partRows(item);
		await expect(queuePage.partRowUpBtn(rows.nth(0))).toBeDisabled();
		await expect(queuePage.partRowDownBtn(rows.nth(0))).toBeEnabled();
		await expect(queuePage.partRowUpBtn(rows.nth(1))).toBeEnabled();
		await expect(queuePage.partRowDownBtn(rows.nth(1))).toBeDisabled();
	});

	test('two same-title, same-discCount images that both claim disc 1 resolve to unresolved entries, not a bogus multi-disc set', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1a = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc1b = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x2 });
		const dir = makeBatchDirFixture([
			{ name: 'maybe-disc1.iso', bytes: disc1a },
			{ name: 'also-maybe-disc1.iso', bytes: disc1b },
		]);
		await queuePage.addFolder(dir);

		// Two separate unresolved entries, never one 2-disc set.
		await expect(queuePage.items).toHaveCount(2);
		for (const item of await queuePage.items.all()) {
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
		}
	});

	test("a duplicate-disc-claim entry's parts panel hides the verify-order control, since there's no ordering to verify, but keeps its remove control live", async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1a = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc1b = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x2 });
		const dir = makeBatchDirFixture([
			{ name: 'maybe-disc1.iso', bytes: disc1a },
			{ name: 'also-maybe-disc1.iso', bytes: disc1b },
		]);
		await queuePage.addFolder(dir);

		await expect(queuePage.items).toHaveCount(2);
		for (const item of await queuePage.items.all()) {
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
			await queuePage.openParts(item);

			// The whole "Verify order" wrap is hidden - not merely disabled -
			// since a duplicate-disc-claim entry isn't a fragment set at all
			// and reordering it can never produce a valid split. Contrast with
			// a genuine unresolvedOrdering entry (see
			// source-parts-management.spec.js), where this same control is
			// visible and enabled.
			await expect(queuePage.partsVerifyWrap(item)).toBeHidden();
			await expect(queuePage.verifyOrderBtn(item)).toBeDisabled();

			// Row-level remove stays available - dropping one of the two
			// colliding images is still a genuine recovery path, since it
			// re-resolves the remainder.
			const rows = queuePage.partRows(item);
			await expect(rows).toHaveCount(1);
			await expect(queuePage.partRowRemoveBtn(rows)).toBeVisible();
		}
	});

	test('moveDisc(): the up/down row controls reorder the visible disc list', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });
		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-1.iso',
			'disc-2.iso',
		]);

		await queuePage.partRowUpBtn(queuePage.partRows(item).nth(1)).click();
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-2.iso',
			'disc-1.iso',
		]);

		// The now-first row's "up" control is disabled - that is the boundary
		// enforcement. Don't click it: Playwright's actionability checks
		// never resolve on a disabled element, so the test would just hang
		// (https://playwright.dev/docs/actionability).
		await expect(
			queuePage.partRowUpBtn(queuePage.partRows(item).nth(0)),
		).toBeDisabled();
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-2.iso',
			'disc-1.iso',
		]);
	});
});

test.describe('promoteToMultiDisc(): turning a standalone source into a disc set', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('attaching a second disc via the Source Files Add control promotes the entry to multi-disc', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });

		// disc1 dropped alone: with no sibling in the batch it's an ordinary
		// standalone source, not multi-disc, even though its own discCount
		// field says 2 - grouping needs 2+ images in the same batch.
		const item = await queuePage.addSource({
			name: 'solo-disc.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc1),
		});
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('1');
		expect(await queuePage.partRowNames(item)).toEqual(['solo-disc.iso']);

		const addBtn = queuePage.partsAddBtn(item);
		const addInput = queuePage.partsAddInput(item);
		await expect(addBtn).toBeEnabled();
		// Single raw-image source, not a GoD folder - the Add input stays a
		// plain (non-folder) file picker.
		await expect(addInput).not.toHaveAttribute('webkitdirectory', '');

		await addInput.setInputFiles({
			name: 'second-disc.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc2),
		});

		await expect(queuePage.items).toHaveCount(1); // still one entry, now multi-disc
		await expect(queuePage.partsCount(item)).toHaveText('2', { timeout: 15_000 });
		expect(await queuePage.partRowNames(item)).toEqual([
			'solo-disc.iso',
			'second-disc.iso',
		]);

		const rows = await queuePage.partRows(item).all();
		// Disc 1 is the original, locked source - no remove control.
		await expect(queuePage.partRowRemoveBtn(rows[0])).toBeHidden();
		// Disc 2 was just attached - unlocked, removable (data-locked itself
		// is "false" on both rows now, since that attribute reflects
		// row-set shape, not per-disc lock state).
		const disc2Remove = queuePage.partRowRemoveBtn(rows[1]);
		await expect(disc2Remove).toBeVisible();
		await expect(disc2Remove).toBeEnabled();
	});

	// The existing addDisc() mismatch test below (in the "genuine title
	// mismatch" block) starts from an already-2-disc set. This is the
	// same rejection, but starting from a single, not-yet-multi-disc
	// source - a different code path (promoteToMultiDisc(), not addDisc()).
	test('attaching a disc from a different title is rejected with a visible mismatch error, leaving the source single and still usable', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const wrongGame = makeFixture({ titleId: 0x11113333, platform: 'x360' });

		const item = await queuePage.addSource({
			name: 'solo-disc.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc1),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('1');

		const addInput = queuePage.partsAddInput(item);
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
		await addInput.setInputFiles({
			name: 'wrong-game.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(wrongGame),
		});

		// Rejected before ever becoming multi-disc: still a single-part
		// entry, not a 2-disc set with one disc stuck in error.
		await queuePage.expectError(item, { timeout: 15_000 });
		await expect(queuePage.error(item)).toContainText('wrong-game.iso');
		await expect(queuePage.partsCount(item)).toHaveText('1');
		expect(await queuePage.partRowNames(item)).toEqual(['solo-disc.iso']);

		// 'error' stays editable/removable - the Add control is live for a
		// real retry, same as the existing-multi-disc-set mismatch case.
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
	});
});

// Every other promoteToMultiDisc()/addDisc() test in this file exercises
// the raw-image ('files') container only - this is the GoD ('dir')
// equivalent, confirming the same title-match check works for a GoD
// folder disc addition too.
test.describe('promoteToMultiDisc(): GoD-folder discs', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('attaching a second GoD-folder disc of the same release via the Source Files Add control promotes the entry to multi-disc, without a false title-mismatch error', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1Dir = await godDiscFixture({
			discNumber: 1,
			discCount: 2,
			mediaId: 0x1,
		});
		const disc2Dir = await godDiscFixture({
			discNumber: 2,
			discCount: 2,
			mediaId: 0x2,
		});

		// Disc 1 dropped alone is an ordinary promotable single source,
		// not multi-disc yet - it has no sibling in this batch.
		const [item] = await queuePage.addFolder(disc1Dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.error(item)).toBeHidden();

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('1');

		const addBtn = queuePage.partsAddBtn(item);
		const addInput = queuePage.partsAddInput(item);
		await expect(addBtn).toBeEnabled();
		// A promotable GoD folder switches the Add control to folder-picker
		// mode.
		await expect(addInput).toHaveAttribute('webkitdirectory', '');

		await addInput.setInputFiles(disc2Dir);

		await expect(queuePage.items).toHaveCount(1); // still one entry, now multi-disc
		await expect(queuePage.error(item)).toBeHidden();
		await expect(queuePage.partsCount(item)).toHaveText('2', {
			timeout: WASM_DETECT_TIMEOUT_MS,
		});

		const rows = await queuePage.partRows(item).all();
		expect(rows).toHaveLength(2);
		// Disc 1 is the original, locked source - no remove control.
		await expect(queuePage.partRowRemoveBtn(rows[0])).toBeHidden();
		// Disc 2 was just attached - unlocked, removable.
		const disc2Remove = queuePage.partRowRemoveBtn(rows[1]);
		await expect(disc2Remove).toBeVisible();
		await expect(disc2Remove).toBeEnabled();
	});
});

// Every other addDisc()/removeDisc() test in this file grows a raw-image
// ('files') multi-disc set, never a GoD ('dir') one - this exercises
// adding/removing a disc from an existing GoD multi-disc set, where each
// disc's on-disk path nests as `<dirName>/DataNNNN`.
test.describe('addDisc(): GoD-folder discs', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a third GoD-folder disc can be added to an existing GoD multi-disc set via the Source Files Add control, then removed again', async ({
		queuePage,
	}) => {
		// Same shape as the dissolve test above: two sequential
		// WASM_DETECT_TIMEOUT_MS-budgeted GoD detections (disc2Dir then
		// disc3Dir) inside one test-level timeout, so 60s leaves no slack
		// under worker contention. See that test for the full rationale.
		test.setTimeout(90_000);
		const disc1Dir = await godDiscFixture({
			discNumber: 1,
			discCount: 3,
			mediaId: 0x1,
		});
		const disc2Dir = await godDiscFixture({
			discNumber: 2,
			discCount: 3,
			mediaId: 0x2,
		});
		const disc3Dir = await godDiscFixture({
			discNumber: 3,
			discCount: 3,
			mediaId: 0x3,
		});

		// Get to a 2-disc GoD multi-disc entry first via promoteToMultiDisc() -
		// this is setup, not what's under test here.
		const [item] = await queuePage.addFolder(disc1Dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		const addBtn = queuePage.partsAddBtn(item);
		const addInput = queuePage.partsAddInput(item);
		await expect(addBtn).toBeEnabled();
		await addInput.setInputFiles(disc2Dir);
		await expect(queuePage.error(item)).toBeHidden();
		await expect(queuePage.partsCount(item)).toHaveText('2', {
			timeout: WASM_DETECT_TIMEOUT_MS,
		});

		// The entry is now genuinely multi-disc, so this next Add control use
		// routes through addDisc() instead of promoteToMultiDisc().
		await expect(addBtn).toBeEnabled();
		await expect(addInput).toHaveAttribute('webkitdirectory', '');
		await addInput.setInputFiles(disc3Dir);

		await expect(queuePage.items).toHaveCount(1);
		await expect(queuePage.error(item)).toBeHidden();
		await expect(queuePage.partsCount(item)).toHaveText('3', {
			timeout: WASM_DETECT_TIMEOUT_MS,
		});

		const rows = await queuePage.partRows(item).all();
		expect(rows).toHaveLength(3);
		// Discs 1/2 came in before addDisc() was involved - locked, no
		// remove control.
		await expect(queuePage.partRowRemoveBtn(rows[0])).toBeHidden();
		await expect(queuePage.partRowRemoveBtn(rows[1])).toBeHidden();
		// Disc 3 was added via addDisc() - unlocked, removable.
		const disc3Remove = queuePage.partRowRemoveBtn(rows[2]);
		await expect(disc3Remove).toBeVisible();
		await expect(disc3Remove).toBeEnabled();

		// Removing it again should cleanly restore the 2-disc set without
		// disturbing discs 1/2.
		await disc3Remove.click();
		await expect(queuePage.partsCount(item)).toHaveText('2');
		expect(await queuePage.partRowNames(item)).toHaveLength(2);
	});
});

// Every row-name assertion elsewhere in this file checks a raw-image
// disc's filename. A GoD-folder disc's row instead prefixes its dirName
// with the disc's position ("<position>/ <dirName>"), so this checks
// that format directly, plus that reordering swaps the attached dirName
// while the position prefixes stay put - proof the move actually
// changed something, rather than just reprinting the same two labels.
test.describe('GoD-folder disc row labels: position prefix + attached dirName', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('rows read "<position>/ <dirName>", and moving a disc swaps the dirName between rows while the position prefixes stay fixed', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const disc1Dir = await godDiscFixture({
			discNumber: 1,
			discCount: 2,
			mediaId: 0x1,
		});
		const disc2Dir = await godDiscFixture({
			discNumber: 2,
			discCount: 2,
			mediaId: 0x2,
		});
		const disc1Name = path.basename(disc1Dir);
		const disc2Name = path.basename(disc2Dir);
		// The rendered row name is the real GoD content folder, not the
		// throwaway temp-root fixture dir - see findGodContentDirName().
		const disc1ContentName = findGodContentDirName(disc1Dir);
		const disc2ContentName = findGodContentDirName(disc2Dir);

		const combined = [
			...collectDirFiles(disc1Dir, disc1Name),
			...collectDirFiles(disc2Dir, disc2Name),
		];
		const dir = makeBatchDirFixture(combined, 'god-disc-row-labels');
		const [item] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(1);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');

		// Exact spacing around the "/" separator is unconfirmed, so this
		// matches on the shape (position digit, slash, the dirName) rather
		// than a fixed string.
		let names = await queuePage.partRowNames(item);
		expect(names[0]).toMatch(
			new RegExp(`^1/\\s*${escapeRegExp(disc1ContentName)}`),
		);
		expect(names[1]).toMatch(
			new RegExp(`^2/\\s*${escapeRegExp(disc2ContentName)}`),
		);

		await queuePage.partRowUpBtn(queuePage.partRows(item).nth(1)).click();

		names = await queuePage.partRowNames(item);
		// Still "1/" then "2/" - but disc2's dirName is now in row 0 and
		// disc1's is in row 1, confirming the swap moved the content, not
		// just the position labels.
		expect(names[0]).toMatch(
			new RegExp(`^1/\\s*${escapeRegExp(disc2ContentName)}`),
		);
		expect(names[1]).toMatch(
			new RegExp(`^2/\\s*${escapeRegExp(disc1ContentName)}`),
		);
	});
});

test.describe('addDisc() / removeDisc(): growing and shrinking an existing multi-disc set', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	// renderSourceParts()'s hidden state on a locked disc's remove button
	// is only a UI-layer reflection of lock state, not the enforcement
	// itself - that's removeDisc()'s own guard. Bypass the UI gate
	// entirely by forcing the button visible/clickable directly, and
	// confirm the guard in removeDisc() itself still holds with no UI
	// in the way.
	test("a locked disc's remove control is a no-op even if force-enabled, bypassing the UI's own hidden state", async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });

		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');

		// Disc 1 arrived via the original drop - locked, normally no remove
		// control at all (see the assertions in the tests above).
		const lockedRemoveBtn = queuePage.partRowRemoveBtn(
			queuePage.partRows(item).nth(0),
		);
		await expect(lockedRemoveBtn).toBeHidden();
		await lockedRemoveBtn.evaluate((el) => {
			/** @type {HTMLButtonElement} */ (el).hidden = false;
		});
		await expect(lockedRemoveBtn).toBeVisible();
		await lockedRemoveBtn.click();

		// removeDisc()'s own guard still blocks it - both discs remain,
		// still in their original order, and nothing else about the entry
		// was disturbed by the no-op click.
		await expect(queuePage.partsCount(item)).toHaveText('2');
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-1.iso',
			'disc-2.iso',
		]);
		await expect(queuePage.error(item)).toBeHidden();
	});

	test('a second, chained addDisc() call correctly locks the disc the first addDisc() call had just added', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 4, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 4, mediaId: 0x2 });
		const disc3 = discFixture({ discNumber: 3, discCount: 4, mediaId: 0x3 });
		const disc4 = discFixture({ discNumber: 4, discCount: 4, mediaId: 0x4 });

		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');

		const addInput = queuePage.partsAddInput(item);

		// First addDisc() call: 2 -> 3. Disc 3 lands unlocked, same shape
		// as the existing "third disc can be added" test above.
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
		await addInput.setInputFiles({
			name: 'disc-3.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc3),
		});
		await expect(queuePage.partsCount(item)).toHaveText('3', { timeout: 15_000 });

		let rows = queuePage.partRows(item);
		await expect(queuePage.partRowRemoveBtn(rows.nth(0))).toBeHidden();
		await expect(queuePage.partRowRemoveBtn(rows.nth(1))).toBeHidden();
		const disc3Remove = queuePage.partRowRemoveBtn(rows.nth(2));
		await expect(disc3Remove).toBeVisible();
		await expect(disc3Remove).toBeEnabled();

		// Second, chained addDisc() call: 3 -> 4. Does the lock cascade
		// correctly a second time?
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
		await addInput.setInputFiles({
			name: 'disc-4.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc4),
		});
		await expect(queuePage.partsCount(item)).toHaveText('4', { timeout: 15_000 });
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-1.iso',
			'disc-2.iso',
			'disc-3.iso',
			'disc-4.iso',
		]);

		rows = queuePage.partRows(item);
		// Discs 1/2 were always locked. Disc 3 - unlocked and removable a
		// moment ago - must now be locked too, since it's no longer the
		// most-recently-added disc.
		for (const idx of [0, 1, 2]) {
			await expect(queuePage.partRowRemoveBtn(rows.nth(idx))).toBeHidden();
		}
		// Disc 4 is the only one left unlocked/removable.
		const disc4Remove = queuePage.partRowRemoveBtn(rows.nth(3));
		await expect(disc4Remove).toBeVisible();
		await expect(disc4Remove).toBeEnabled();

		// Sanity check that disc 4 - genuinely unlocked - really is
		// removable via the normal flow.
		await disc4Remove.click();
		await expect(queuePage.partsCount(item)).toHaveText('3');
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-1.iso',
			'disc-2.iso',
			'disc-3.iso',
		]);
	});

	test('a third disc can be added, then removed, without disturbing the original two', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 3, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 3, mediaId: 0x2 });
		const disc3 = discFixture({ discNumber: 3, discCount: 3, mediaId: 0x3 });

		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');

		const addInput = queuePage.partsAddInput(item);
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
		await addInput.setInputFiles({
			name: 'disc-3.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc3),
		});

		await expect(queuePage.partsCount(item)).toHaveText('3', { timeout: 15_000 });
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-1.iso',
			'disc-2.iso',
			'disc-3.iso',
		]);

		const rows = queuePage.partRows(item);
		// Discs 1/2 came in on the original drop - locked, no remove control.
		await expect(queuePage.partRowRemoveBtn(rows.nth(0))).toBeHidden();
		await expect(queuePage.partRowRemoveBtn(rows.nth(1))).toBeHidden();
		// Disc 3 was added afterward via addDisc() - unlocked, removable.
		const disc3Remove = queuePage.partRowRemoveBtn(rows.nth(2));
		await expect(disc3Remove).toBeVisible();
		await expect(disc3Remove).toBeEnabled();

		await disc3Remove.click();
		await expect(queuePage.partsCount(item)).toHaveText('2');
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-1.iso',
			'disc-2.iso',
		]);
	});
});

// Every removeDisc() test above goes 3 discs -> 2; this covers the
// discs.length === 1 case, dissolving back to a single source. Both
// container shapes are covered: a 'files' single disc and a 'dir' (GoD)
// single disc take different code paths, so a pass on one shape doesn't
// guarantee the other behaves.
test.describe('removeDisc(): dissolving a 2-disc set back down to a single source', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a raw-image 2-disc set collapses to a plain single-file source once the unlocked disc is removed', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });

		// disc 1 arrives locked (it's what inspect() already ran against),
		// disc 2 attaches unlocked - the only disc position removeDisc()
		// can collapse away from a 2-disc set.
		const item = await queuePage.addSource({
			name: 'solo-disc.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc1),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.openParts(item);
		const addInput = queuePage.partsAddInput(item);
		await addInput.setInputFiles({
			name: 'second-disc.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc2),
		});
		await expect(queuePage.partsCount(item)).toHaveText('2', { timeout: 15_000 });

		const disc2Remove = queuePage.partRowRemoveBtn(
			queuePage.partRows(item).nth(1),
		);
		await expect(disc2Remove).toBeEnabled();
		await disc2Remove.click();

		// Collapsed back to a single 'files' source - one row, not a
		// multi-disc shell with one disc in it.
		await expect(queuePage.partsCount(item)).toHaveText('1');
		expect(await queuePage.partRowNames(item)).toEqual(['solo-disc.iso']);
		await expect(queuePage.sourceMetaSize(item)).toHaveText(String(disc1.length));
		// item.status was never touched by removeDisc(), so the entry is
		// still idle/queued and error-free - not stuck or misreported.
		await expect(queuePage.error(item)).toBeHidden();
		await queuePage.expectQueued(item);

		// The Add control should work exactly like it does for a normal,
		// never-promoted single-file entry - proving the dissolved source
		// isn't left in some half-multi-disc state.
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
		await expect(queuePage.partsAddInput(item)).not.toHaveAttribute(
			'webkitdirectory',
			'',
		);

		// Follow-up: attach a genuinely new disc and confirm it actually
		// merges into a fresh multi-disc set, rather than the Add control
		// staying wired to the now-stale addDisc() handler (a no-op once
		// the source is no longer multi-disc). A real timeout, not an
		// indefinite wait - if this regresses, the merge round trip never
		// happens and the assertion below should time out visibly.
		const disc3 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x9 });
		await queuePage.partsAddInput(item).setInputFiles({
			name: 'fresh-second-disc.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc3),
		});
		await expect(queuePage.partsCount(item)).toHaveText('2', { timeout: 15_000 });
		expect(await queuePage.partRowNames(item)).toEqual([
			'solo-disc.iso',
			'fresh-second-disc.iso',
		]);
	});

	test('a GoD-folder 2-disc set collapses to a plain single-dir source once the unlocked disc is removed', async ({
		queuePage,
	}) => {
		// Two full WASM_DETECT_TIMEOUT_MS-budgeted GoD detections happen
		// back-to-back here (attaching disc2Dir, then attaching disc3Dir
		// after the dissolve), on top of the initial disc1Dir add/detect
		// and the intervening DOM assertions. 60s only covers 2x
		// WASM_DETECT_TIMEOUT_MS with zero slack, so under real worker
		// contention (parallel WASM-heavy GoD detection across the other
		// 5 workers) either wait can legitimately run close to its own
		// 30s budget and blow the shared test-level clock - killing the
		// test mid-step with a misleading "expect failed"/"page closed"
		// error instead of a clean, attributable timeout. Match the 90s
		// budget already used elsewhere in this file for tests that chain
		// two GoD-folder detections (see the moveDisc()/labels test and
		// the two GoD-vs-GoD grouping tests below).
		test.setTimeout(90_000);
		const disc2Dir = await godDiscFixture({
			discNumber: 2,
			discCount: 2,
			mediaId: 0x2,
		});

		const disc1Dir = await godDiscFixture({
			discNumber: 1,
			discCount: 2,
			mediaId: 0x1,
		});
		// disc1's expected size is the GoD dir's real on-disk bytes, not
		// the raw ISO's.
		const disc1DirBytes = sumDirBytes(disc1Dir);
		const [item] = await queuePage.addFolder(disc1Dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.openParts(item);
		const addInput = queuePage.partsAddInput(item);
		await expect(addInput).toHaveAttribute('webkitdirectory', '');
		await addInput.setInputFiles(disc2Dir);
		await expect(queuePage.partsCount(item)).toHaveText('2', {
			timeout: WASM_DETECT_TIMEOUT_MS,
		});

		const disc2Remove = queuePage.partRowRemoveBtn(
			queuePage.partRows(item).nth(1),
		);
		await expect(disc2Remove).toBeEnabled();
		await disc2Remove.click();

		// The panel stays visible at rowCount 1, showing the "<dirName>/"
		// row a lone GoD folder always shows, with no leading disc-position
		// number since a dissolved single folder isn't part of any disc set.
		await expect(queuePage.partsCount(item)).toHaveText('1');
		await expect(queuePage.partRowName(queuePage.partRows(item))).toHaveText(
			/\/$/,
		);
		await expect(queuePage.partRowName(queuePage.partRows(item))).not.toHaveText(
			/^\d+\//,
		);
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(disc1DirBytes),
		);
		await expect(queuePage.error(item)).toBeHidden();

		// Still folder-mode and still live - a dissolved GoD source is
		// promotable back into a fresh multi-disc set the same way a
		// never-promoted standalone GoD folder is.
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
		await expect(addInput).toHaveAttribute('webkitdirectory', '');

		// Follow-up: attach a new GoD disc and confirm the merge actually
		// happens, same regression guard as the raw-image case above. A
		// real timeout - if the Add control is still wired to the stale
		// addDisc() handler, this hangs waiting for a partitionDir round
		// trip that never fires.
		const disc3Dir = await godDiscFixture({
			discNumber: 2,
			discCount: 2,
			mediaId: 0x9,
		});
		await addInput.setInputFiles(disc3Dir);
		await expect(queuePage.partsCount(item)).toHaveText('2', {
			timeout: WASM_DETECT_TIMEOUT_MS,
		});
	});
});

// A genuine, content-verified title mismatch - as opposed to the
// named-but-broken-pair path other "malformed"/"mismatch" tests in this
// suite exercise. This drops a completely unrelated title in as the
// would-be third disc, so it can never group into a matching
// (titleId, discCount) set with the existing two.
test.describe('addDisc(): a genuine title mismatch through real wasm detection', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('adding a disc from a different title is rejected with DISC_MISMATCH, leaving the existing set untouched', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });
		// A genuinely different release - different titleId entirely, not
		// just a differently-named file with the same content shape. Never
		// groups with TITLE_ID no matter what discCount/mediaId it's given.
		const wrongGame = makeFixture({ titleId: 0x11112222, platform: 'x360' });

		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.openParts(item);
		await expect(queuePage.partsCount(item)).toHaveText('2');

		const addInput = queuePage.partsAddInput(item);
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
		await addInput.setInputFiles({
			name: 'wrong-game.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(wrongGame),
		});

		// A rejected addDisc() surfaces a visible error, status flips to
		// 'error', and item.source is never touched by the failed attempt.
		await queuePage.expectError(item, { timeout: 15_000 });
		await expect(queuePage.error(item)).toContainText('wrong-game.iso');

		// Still exactly the original 2 discs - the rejected third never got
		// spliced in.
		await expect(queuePage.partsCount(item)).toHaveText('2');
		expect(await queuePage.partRowNames(item)).toEqual([
			'disc-1.iso',
			'disc-2.iso',
		]);
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(disc1.length + disc2.length),
		);

		// 'error' status is still editable/removable, so the Add control
		// stays live for a real retry.
		await expect(queuePage.partsAddBtn(item)).toBeEnabled();
	});
});

test.describe('multi-disc parts panel while mid-conversion', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	// renderSourceParts() gates every disc row's move-up/move-down/remove
	// button, and the "add another disc" control, on isEditable(item) -
	// false for 'running'/'paused'/'awaitingSlot'. This confirms a
	// multi-disc entry's parts panel actually goes non-interactive
	// mid-run instead of staying reorderable while its discs convert.
	test('disc row move/remove controls and the "add disc" control are disabled while a multi-disc entry is mid-conversion', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });
		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		// 'extracted' does real XEX conversion work (unlike a tiny god/xiso
		// rebuild of this fixture, which can finish in well under a second),
		// giving a real window to assert mid-run state in.
		await queuePage.selectFormat(item, 'extracted');
		await queuePage.openParts(item);

		await queuePage.convert(item);
		await expect(queuePage.cancelBtn(item)).toBeVisible();

		for (const row of await queuePage.partRows(item).all()) {
			await expect(queuePage.partRowUpBtn(row)).toBeDisabled();
			await expect(queuePage.partRowDownBtn(row)).toBeDisabled();
		}
		await expect(queuePage.partsAddBtn(item)).toBeDisabled();

		await queuePage.cancelBtn(item).click();
	});
});

test.describe('source-meta__size across a multi-disc source', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	// A multi-disc entry's displayed size must reflect every disc's
	// bytes, not just disc 1's - it's derived from the entry's full file
	// list, kept in sync across every disc mutation.
	test('a resolved 2-disc set shows the combined byte size of both discs, not just disc 1', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });
		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		const expectedTotal = disc1.length + disc2.length;
		// Sanity check the two discs really are different sizes, so this
		// assertion can't pass by coincidence if a future fixture change
		// makes disc1.length === disc2.length.
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(expectedTotal),
		);
	});

	test('a 3-disc set built up via addDisc() reflects all three discs once the third is attached', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 3, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 3, mediaId: 0x2 });
		const disc3 = discFixture({ discNumber: 3, discCount: 3, mediaId: 0x3 });

		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(disc1.length + disc2.length),
		);

		await queuePage.openParts(item);
		const addInput = queuePage.partsAddInput(item);
		await addInput.setInputFiles({
			name: 'disc-3.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc3),
		});
		await expect(queuePage.partsCount(item)).toHaveText('3', { timeout: 15_000 });
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(disc1.length + disc2.length + disc3.length),
		);
	});

	test('removing a disc drops its bytes back out of the displayed total', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 3, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 3, mediaId: 0x2 });
		const disc3 = discFixture({ discNumber: 3, discCount: 3, mediaId: 0x3 });

		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });

		await queuePage.openParts(item);
		const addInput = queuePage.partsAddInput(item);
		await addInput.setInputFiles({
			name: 'disc-3.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc3),
		});
		await expect(queuePage.partsCount(item)).toHaveText('3', { timeout: 15_000 });
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(disc1.length + disc2.length + disc3.length),
		);

		// Disc 3 was attached via addDisc(), so it's unlocked/removable.
		const disc3Remove = queuePage.partRowRemoveBtn(
			queuePage.partRows(item).nth(2),
		);
		await disc3Remove.click();
		await expect(queuePage.partsCount(item)).toHaveText('2');
		// removeDisc() doesn't re-inspect (nothing worth re-parsing changed),
		// so this has to update synchronously, not "eventually" - no
		// timeout override, unlike the inspect-driven assertions above.
		await expect(queuePage.sourceMetaSize(item)).toHaveText(
			String(disc1.length + disc2.length),
		);
	});
});

test.describe('multi-disc conversion end-to-end', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a resolved 2-disc set converts disc-by-disc, producing one download per disc with genuine XEX content, ending [done]', async ({
		queuePage,
	}) => {
		test.setTimeout(120_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });
		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.selectFormat(item, 'extracted');

		// convertOneDisc() opens a fresh WorkerController per disc, so this
		// fires two independent download streams, not one combined archive.
		// Only one 'download' waiter can be armed at a time: Playwright
		// resolves every currently-armed waitForEvent('download') call
		// against the very next 'download' event, so arming both up front
		// would make them both resolve to disc 1's download. Disc 1's is
		// resolved via the standard Promise.all-with-the-click idiom, and
		// disc 2's listener is only attached once disc 1's has resolved -
		// safe here since discs convert strictly sequentially and a disc's
		// 'download' event fires as soon as its stream's iframe attaches,
		// well before that disc's conversion finishes.
		const [download1] = await Promise.all([
			queuePage.page.waitForEvent('download', { timeout: 60_000 }),
			queuePage.convert(item),
		]);
		expect(download1.suggestedFilename()).toContain('(Disc 1)');
		expect(download1.suggestedFilename()).toMatch(/\(XEX\)\.zip$/);

		const download2 = await queuePage.page.waitForEvent('download', {
			timeout: 90_000,
		});
		expect(download2.suggestedFilename()).toContain('(Disc 2)');
		expect(download2.suggestedFilename()).toMatch(/\(XEX\)\.zip$/);
		// Distinct filenames confirm each disc got its own real output
		// rather than one overwriting/duplicating the other.
		expect(download2.suggestedFilename()).not.toBe(download1.suggestedFilename());

		await queuePage.expectDone(item, { timeout: 60_000 });

		// Content check on disc 1's output only, confirming a real converted
		// XEX payload rather than a correctly-named placeholder.
		const filePath = await download1.path();
		if (!filePath) throw new Error('Download path missing');
		const entries = await readZipEntries(filePath, () => true);
		const foundFiles = entries.map((e) => e.filename);
		const hasXex = foundFiles.some((name) => name.endsWith('.xex'));
		expect(
			hasXex,
			`Expected a .xex file in disc 1's output, found: ${foundFiles.join(', ')}`,
		).toBeTruthy();
	});

	// Confirms convertOneDisc() derives the real output filename (format
	// suffix + extension), the same way startConversion() does for a
	// single-source entry, for every target format a multi-disc entry can
	// pick.
	const DISC_TARGET_FILENAME_PATTERNS = /** @type {const} */ ({
		xiso: /\(Disc 1\)\.xiso\.iso$/,
		god: /\(Disc 1\) \(GoD\)\.zip$/,
		extracted: /\(Disc 1\) \(XEX\)\.zip$/,
		zar: /\(Disc 1\)\.zar$/,
	});

	for (const target of /** @type {const} */ (['xiso', 'god', 'zar'])) {
		test(`disc 1's download filename is correctly suffixed/extensioned for ${target} target`, async ({
			queuePage,
		}) => {
			test.setTimeout(90_000);
			const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
			const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });
			const dir = makeBatchDirFixture([
				{ name: 'disc-1.iso', bytes: disc1 },
				{ name: 'disc-2.iso', bytes: disc2 },
			]);
			const [item] = await queuePage.addFolder(dir);
			await queuePage.expectQueued(item, { timeout: 15_000 });
			const download1 = await queuePage.convertAndDownload(item, target, {
				timeout: 60_000,
			});
			expect(download1.suggestedFilename()).toMatch(
				DISC_TARGET_FILENAME_PATTERNS[target],
			);
		});
	}

	test('cancelling mid-chain stops before the next disc starts', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const disc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x2 });
		const dir = makeBatchDirFixture([
			{ name: 'disc-1.iso', bytes: disc1 },
			{ name: 'disc-2.iso', bytes: disc2 },
		]);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.selectFormat(item, 'extracted');
		await queuePage.convert(item);
		await expect(queuePage.cancelBtn(item)).toBeVisible();
		await queuePage.cancelBtn(item).click();
		// A cancel mid-chain should land on 'cancelled', not continue on to
		// disc 2 or dead-end on 'error'. The label is disc-specific,
		// naming which disc was in flight.
		await expect(queuePage.status(item)).toContainText(
			/\[cancelled \(disc \d+\)\]/,
			{
				timeout: 15_000,
			},
		);
		await expect(queuePage.status(item)).toHaveClass(
			/queue-item__status--cancelled/,
		);
	});
});

// Every other test in this file drives the Add control via
// addInput.setInputFiles() directly, bypassing the visible button.
// These two tests click the real button instead, asserting the native
// picker actually opens.
test.describe('Source Files panel - the visible Add button actually opens its picker', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('clicking "Add disc (file)" on a promotable single source opens a file chooser', async ({
		queuePage,
	}) => {
		const disc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x1 });
		const item = await queuePage.addSource({
			name: 'solo-disc.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(disc1),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.openParts(item);
		const addBtn = queuePage.partsAddBtn(item);
		await expect(addBtn).toBeEnabled();
		await expect(addBtn).toHaveText(TEXT.ADD_DISC_FILE);

		const chooserPromise = queuePage.page.waitForEvent('filechooser');
		await addBtn.click();
		const chooser = await chooserPromise;
		expect(chooser.isMultiple()).toBe(false);
	});

	test('clicking "Add disc (folder)" on a promotable GoD source opens a folder chooser', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const disc1Dir = await godDiscFixture({
			discNumber: 1,
			discCount: 2,
			mediaId: 0x1,
		});
		const [item] = await queuePage.addFolder(disc1Dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.openParts(item);
		const addBtn = queuePage.partsAddBtn(item);
		await expect(addBtn).toBeEnabled();
		await expect(addBtn).toHaveText(TEXT.ADD_DISC_FOLDER);

		const chooserPromise = queuePage.page.waitForEvent('filechooser');
		await addBtn.click();
		await chooserPromise;
	});
});

// A GoD-shaped copy of a disc sharing a title/discCount with a genuine,
// complementary same-shape disc pair must never poison the whole title
// into 'unresolved' - duplicateDiscClaim should only ever apply within
// one container shape. mixed-batch-stress.spec.js covers the
// complementary cross-shape case (disc 1 GoD + disc 2 iso, no numeric
// collision, resolving to two standalone entries); this covers the
// collision case, which needs the shape check to run before Rust's
// otherwise shape-blind grouping.
test.describe('cross-shape disc-number collision does not poison a genuine same-shape set', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a GoD-shaped disc 1 alongside a genuine iso disc-1/disc-2 pair resolves to one clean multi-disc set plus one standalone GoD folder - never an unresolved duplicate claim', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const godDisc1Dir = await godDiscFixture({
			discNumber: 1,
			discCount: 2,
			mediaId: 0x1,
		});
		const isoDisc1 = discFixture({ discNumber: 1, discCount: 2, mediaId: 0x2 });
		const isoDisc2 = discFixture({ discNumber: 2, discCount: 2, mediaId: 0x3 });

		const combined = [
			...collectDirFiles(godDisc1Dir, path.basename(godDisc1Dir)),
			{ name: 'Game (Disc 1).iso', bytes: isoDisc1 },
			{ name: 'Game (Disc 2).iso', bytes: isoDisc2 },
		];
		const dir = makeBatchDirFixture(combined, 'cross-shape-collision');

		await queuePage.addFolder(dir);

		// One multi-disc entry (the two same-shape isos) + one standalone
		// GoD-folder entry = 2 queue items, never an 'unresolved' one.
		// Filtered + toHaveCount(0), not a bare `.not.toContainText` on
		// the unscoped status locator: that locator matches both items at
		// once, and Playwright's strict mode rejects a single-string
		// toContainText/not.toContainText assertion against a
		// multi-element locator regardless of what the text says.
		await expect(queuePage.items).toHaveCount(2);
		await expect(
			queuePage.page
				.getByTestId('queue-item-status')
				.filter({ hasText: TEXT.UNRESOLVED }),
		).toHaveCount(0);

		const items = await queuePage.items.all();
		for (const item of items) {
			await queuePage.expectQueued(item, { timeout: 15_000 });
			await expect(queuePage.error(item)).toBeHidden();
		}

		// One of the two items is the 2-disc multi-disc set (its parts
		// panel has 2 rows); the other is the standalone GoD folder
		// (1 row). Neither should still be a flat pile of Data#### rows -
		// confirms the GoD folder rendered as one dirName row.
		/** @type {number[]} */
		const partCounts = [];
		for (const item of items) {
			await queuePage.openParts(item);
			partCounts.push(Number(await queuePage.partsCount(item).textContent()));
		}
		partCounts.sort((a, b) => a - b);
		expect(partCounts).toEqual([1, 2]);
	});
});

// The flip side of the cross-shape case above: a *same*-shape duplicate
// (two GoD folders both claiming disc 1) is a real duplicateDiscClaim -
// unlike the cross-shape case, this one really is unresolved - but it
// must still render each claimant as the one dirName row a GoD folder
// always gets, never as a flat pile of every individual Data#### chunk
// file.
test.describe('same-shape duplicate disc claim renders each GoD folder as one row, not a pile of Data#### parts', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('two GoD folders both claiming disc 1 resolve as two unresolved entries, each collapsed to a single folder row', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const claimADir = await godDiscFixture({
			discNumber: 1,
			discCount: 2,
			mediaId: 0x1,
		});
		const claimBDir = await godDiscFixture({
			discNumber: 1,
			discCount: 2,
			mediaId: 0x9,
		});

		const combined = [
			...collectDirFiles(claimADir, path.basename(claimADir)),
			...collectDirFiles(claimBDir, path.basename(claimBDir)),
		];
		const dir = makeBatchDirFixture(combined, 'same-shape-duplicate-claim');

		await queuePage.addFolder(dir);

		await expect(queuePage.items).toHaveCount(2);
		const items = await queuePage.items.all();
		for (const item of items) {
			await queuePage.expectUnresolved(item, { timeout: 15_000 });
			await expect(queuePage.error(item)).toContainText(
				/multiple sources claim disc 1/,
			);

			await queuePage.openParts(item);
			await expect(queuePage.partsCount(item)).toHaveText('1');
			await expect(queuePage.partRowName(queuePage.partRows(item))).toHaveText(
				/\.data\/$/,
			);
		}
	});
});
