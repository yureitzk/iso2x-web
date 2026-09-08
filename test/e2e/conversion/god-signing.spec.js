import { test, expect } from '../support/test.js';
import {
	isoBytes,
	x360IsoBytes,
	syntheticKeyvault,
	makeSyntheticKeyvault,
	makeTruncatedKeyvault,
	makeCorruptKeyvault,
} from '../support/test-data.js';
import { extractZipToDir, readZipEntryPrefix } from '../support/zip.js';
import { contentTypeLabels } from 'iso2x';
import fs from 'node:fs';

/**
 * @import { QueuePage } from '../pages/queue-page.js'
 * @import { Locator } from '@playwright/test'
 */

const godKeyvaultFixture = {
	name: 'console.bin',
	mimeType: 'application/octet-stream',
};

/**
 * Adds an x360/XEX (GamesOnDemand-shaped) queue item and selects the
 * 'god' format - the .queue-item__option[data-formats="god"] block is
 * hidden by updateOptionsVisibility() until this item's format is
 * actually 'god' (see queueItemOptions.js), so every test that needs to
 * reach the keyvault input / sign checkbox has to go through this
 * rather than just addSource().
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

test.describe('console-sign - per-item constraints', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('sign checkbox is disabled until this item has a usable keyvault', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await expect(queuePage.godSignCheckbox(item)).toBeDisabled();
		await expect(queuePage.godSignCheckbox(item)).not.toBeChecked();
	});

	test('uploading a per-item keyvault enables the sign checkbox, and checking it sticks', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godKeyvaultInput(item).setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await expect(queuePage.godSignCheckbox(item)).toBeEnabled();
		await queuePage.godSignCheckbox(item).check();
		await expect(queuePage.godSignCheckbox(item)).toBeChecked();
		// A no-op re-render (toggling Options closed/open) must not lose
		// the manual choice.
		await queuePage.optionsSummary(item).click();
		await queuePage.optionsSummary(item).click();
		await expect(queuePage.godSignCheckbox(item)).toBeChecked();
	});

	test('an OGX source never offers console-signing, even with a valid per-item key', async ({
		queuePage,
	}) => {
		// isoBytes (test-data.js) is the OGX/XBE fixture - see xfs.js's
		// default platform: 'ogx'. Inlined rather than a shared helper
		// since this is the only OGX-sourced test in this file.
		const item = await queuePage.addSource({
			name: 'ogx.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes.buffer),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.selectFormat(item, 'god');
		await queuePage.optionsSummary(item).click();
		// Keyvault input itself is disabled for OGX sources - signing is
		// rejected server-side for them regardless of key. setInputFiles()
		// can still target a disabled input (Playwright doesn't require
		// actionability for it), so this genuinely proves a valid key
		// doesn't unlock signing here, rather than just asserting the
		// initial disabled state.
		await expect(queuePage.godKeyvaultInput(item)).toBeDisabled();
		await queuePage.godKeyvaultInput(item).setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await expect(queuePage.godSignCheckbox(item)).toBeDisabled();
		await expect(queuePage.godSignCheckbox(item)).not.toBeChecked();
	});

	test('an eligible, checked sign checkbox is cleared if the key is removed', async ({
		queuePage,
	}) => {
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godKeyvaultInput(item).setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await queuePage.godSignCheckbox(item).check();
		await expect(queuePage.godSignCheckbox(item)).toBeChecked();
		await queuePage.godKeyvaultInput(item).setInputFiles([]);
		await expect(queuePage.godSignCheckbox(item)).toBeDisabled();
		await expect(queuePage.godSignCheckbox(item)).not.toBeChecked();
	});

	// Constraints are per-item (mirrors mode-constraints.spec.js's scoping
	// test) - each item gets its own distinct key, so this also proves
	// item B's key can't accidentally end up applied to item A, not just
	// that an *absent* key stays absent.
	test('per-item keyvault/sign state is scoped independently across items', async ({
		queuePage,
	}) => {
		const itemA = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(itemA).click();
		await queuePage.godKeyvaultInput(itemA).setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await queuePage.godSignCheckbox(itemA).check();
		const { kv: kvB } = makeSyntheticKeyvault();
		const itemB = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(itemB).click();
		// itemB starts with no key of its own - unaffected by itemA's.
		await expect(queuePage.godSignCheckbox(itemB)).toBeDisabled();
		await expect(queuePage.godSignCheckbox(itemB)).not.toBeChecked();
		// Giving itemB its own distinct key enables it independently,
		// without disturbing itemA's already-checked state.
		await queuePage.godKeyvaultInput(itemB).setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(kvB),
		});
		await expect(queuePage.godSignCheckbox(itemB)).toBeEnabled();
		await expect(queuePage.godSignCheckbox(itemB)).not.toBeChecked();
		await expect(queuePage.godSignCheckbox(itemA)).toBeChecked();
	});
});

test.describe('console-sign - settings panel defaults', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
		await queuePage.openSettings();
	});

	test('"Console-sign by default" is disabled until a default keyvault is uploaded', async ({
		queuePage,
	}) => {
		await expect(queuePage.defaultGodSignCheckbox).toBeDisabled();
	});

	test('uploading a default keyvault enables "Console-sign by default"', async ({
		queuePage,
	}) => {
		await queuePage.defaultGodKeyvaultInput.setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await expect(queuePage.defaultGodSignCheckbox).toBeEnabled();
	});

	test('a newly added eligible item shows the default keyvault file itself, not just its bytes', async ({
		queuePage,
	}) => {
		await queuePage.defaultGodKeyvaultInput.setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await queuePage.defaultGodSignCheckbox.check();
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		expect(await queuePage.godKeyvaultFileName(item)).toBe(
			godKeyvaultFixture.name,
		);
	});

	test('a newly added eligible item picks up the default keyvault + default sign', async ({
		queuePage,
	}) => {
		await queuePage.defaultGodKeyvaultInput.setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await queuePage.defaultGodSignCheckbox.check();
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await expect(queuePage.godSignCheckbox(item)).toBeEnabled();
		await expect(queuePage.godSignCheckbox(item)).toBeChecked();
	});

	test('a stale "sign by default" preference does not survive the key being cleared by reload', async ({
		queuePage,
	}) => {
		await queuePage.defaultGodKeyvaultInput.setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await queuePage.defaultGodSignCheckbox.check();
		await queuePage.reload();
		await queuePage.openSettings();
		await expect(queuePage.defaultGodSignCheckbox).toBeDisabled();
		await expect(queuePage.defaultGodSignCheckbox).not.toBeChecked();
		// Re-uploading a key this session must not resurrect the stale
		// intent from before the reload - the user never re-checked it.
		await queuePage.defaultGodKeyvaultInput.setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await expect(queuePage.defaultGodSignCheckbox).toBeEnabled();
		await expect(queuePage.defaultGodSignCheckbox).not.toBeChecked();
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await expect(queuePage.godSignCheckbox(item)).toBeEnabled();
		await expect(queuePage.godSignCheckbox(item)).not.toBeChecked();
	});

	test('flipping the default after an item is already eligible does not retroactively change it', async ({
		queuePage,
	}) => {
		// Idempotency: applyGodSigningConstraints() only reapplies the
		// current default on the disabled -> enabled transition, not on
		// every re-eval - covers the gap flagged against
		// queueItemOptions.test.js's coverage.
		await queuePage.defaultGodKeyvaultInput.setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await queuePage.defaultGodSignCheckbox.check();
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await expect(queuePage.godSignCheckbox(item)).toBeChecked();
		// Manually uncheck for this item, then flip the *global* default
		// off - the per-item choice must survive since nothing about this
		// item's own eligibility changed.
		await queuePage.godSignCheckbox(item).uncheck();
		await queuePage.defaultGodSignCheckbox.uncheck();
		await expect(queuePage.godSignCheckbox(item)).not.toBeChecked();
	});
});

test.describe('console-sign - signed output', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('a console-signed GoD conversion writes a CON header, not LIVE', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godKeyvaultInput(item).setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await queuePage.godSignCheckbox(item).check();
		// Same convertAndDownload() + suggestedFilename() + expectDone()
		// shape as queue-and-flow.spec.js's 'god conversion completes...'
		// test - no timeout opts here either, relying on the
		// test.setTimeout(90_000) above like that test does.
		const download = await queuePage.convertAndDownload(item, 'god');
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });
		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		expect(fs.statSync(filePath).size).toBeGreaterThan(0);
		// The header entry is NOT `<prefix>.data/Data0000` (that's an
		// MHT/subpart hash chunk; see PartState/current_part_entry_name
		// in god/mod.rs). The header is written under its own entry,
		// keyed by output_path_prefix() alone (`titleId/contentType/
		// mediaId`, no `.data` segment) - see GodSession::next_chunk's
		// `self.current_part_index >= self.part_count` branch and
		// ChunkSource::output_manifest's trailing
		// `entries.push((prefix, ...))`.
		const headerMagic = await readZipEntryPrefix(
			filePath,
			(name) => !name.includes('.data/'),
		);
		expect(headerMagic.toString('ascii')).toBe('CON ');
		// syntheticKeyvault.publicKey is available for a follow-up test
		// that verifies the embedded certificate's signature against it
		// directly (see signing.test.ts's "embeds the keyvault
		// certificate verbatim" / "signature verifies" cases for the
		// byte offsets) - not asserted here since the header-magic check
		// already proves signing engaged.
		expect(syntheticKeyvault.publicKey).toBeDefined();
	});

	test('an unsigned GoD conversion still writes a LIVE header (regression guard)', async ({
		queuePage,
	}) => {
		test.setTimeout(90_000);
		const item = await addX360GodItem(queuePage);
		const download = await queuePage.convertAndDownload(item, 'god');
		expect(download.suggestedFilename()).toContain('.zip');
		await queuePage.expectDone(item, { timeout: 60_000 });
		const filePath = await download.path();
		if (!filePath) throw new Error('Download path missing');
		const headerMagic = await readZipEntryPrefix(
			filePath,
			(name) => !name.includes('.data/'),
		);
		expect(headerMagic.toString('ascii')).toBe('LIVE');
	});

	// Structural validation (buffer too short for the certificate/private
	// key region) happens inside ConsoleSigningKey::parse() at
	// ConversionSession.open() time, not at upload time - the UI has no
	// way to check this without a wasm round trip, so the checkbox is
	// enabled off presence alone (`!!item.godSigningKey`) and the
	// rejection only surfaces once conversion actually starts.
	test('a structurally-too-short keyvault is accepted by the checkbox but fails at conversion time', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const kv = makeTruncatedKeyvault();
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage
			.godKeyvaultInput(item)
			.setInputFiles({ ...godKeyvaultFixture, buffer: Buffer.from(kv) });
		await expect(queuePage.godSignCheckbox(item)).toBeEnabled();
		await queuePage.godSignCheckbox(item).check();
		await queuePage.convert(item);
		// Conversion-time signing failures set status without populating
		// the `.queue-item__error` panel (that panel is
		// SOURCE_ERROR/inspection-time only - see mode-constraints.spec.js's
		// corrupt-extracted-dir case for that path) - so assert the
		// status key directly rather than via expectError(), which also
		// waits on that panel.
		await queuePage.expectStatusKey(item, 'error', { timeout: 30_000 });
	});

	// Right-sized but content-garbage - parse() accepts the byte layout,
	// but deriving a usable RSA key (or the sign operation itself) fails
	// on the bogus p/q/exponent, so this fails the same way as the
	// too-short case above, just later (after hashing/data has run).
	test('a corrupt (garbage) keyvault of the right size still fails at conversion time', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const kv = makeCorruptKeyvault();
		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage
			.godKeyvaultInput(item)
			.setInputFiles({ ...godKeyvaultFixture, buffer: Buffer.from(kv) });
		await expect(queuePage.godSignCheckbox(item)).toBeEnabled();
		await queuePage.godSignCheckbox(item).check();
		await queuePage.convert(item);
		await queuePage.expectStatusKey(item, 'error', { timeout: 30_000 });
	});

	// Re-dropping a signed GoD folder must keep the package header in
	// sourceParts, or re-inspection reports gamesOnDemand instead of the
	// correct installedGame type. Must be caught via an actual folder
	// re-drop, not a direct inspectSource() call with hand-assembled
	// sourceParts - see god.test.ts, which doesn't exercise that path.
	test('re-dropping a signed GoD folder reports its real (installedGame) content type, not gamesOnDemand', async ({
		queuePage,
	}, testInfo) => {
		test.setTimeout(120_000);

		const item = await addX360GodItem(queuePage);
		await queuePage.optionsSummary(item).click();
		await queuePage.godKeyvaultInput(item).setInputFiles({
			...godKeyvaultFixture,
			buffer: Buffer.from(syntheticKeyvault.kv),
		});
		await queuePage.godSignCheckbox(item).check();
		const download = await queuePage.convertAndDownload(item, 'god');
		await queuePage.expectDone(item, { timeout: 60_000 });
		const zipPath = await download.path();
		if (!zipPath) throw new Error('Download path missing');

		// Extract to a real directory on disk - exactly what a person
		// gets after unzipping a real download, and exactly what "Add
		// folder" reads off disk.
		const extractDir = testInfo.outputPath('god-signed-refolder');
		await extractZipToDir(zipPath, extractDir);

		const [reAdded] = await queuePage.addFolder(extractDir);
		await queuePage.expectInspected(reAdded, { timeout: 15_000 });

		await expect(queuePage.sourceMetaContentType(reAdded)).toHaveText(
			contentTypeLabels.installedGame,
		);
	});
});
