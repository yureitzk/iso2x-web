import { test, expect } from '../support/test.js';
import {
	makeExtractedDirFixture,
	makeCorruptExtractedDirFixtureXex,
} from '../../fixtures/index.js';
import { isoBytes, stfsBytes } from '../support/test-data.js';

/**
 * @import { ModeTargetFormat, ScrubMode, XisoMode } from '../../../src/types/global'
 */

// When a queue item's source is 'extracted', every target format's
// scrub-mode select (god, xiso, ciso, cci) narrows to 'full' only and
// locks, since exactly one mode remains valid. Any other source format
// keeps the normal, interactive option set. UI-layer coverage only - the
// full-vs-partial conversion behavior itself is exercised end-to-end in
// folder-input-structured.spec.js.

/** @type {{ format: ModeTargetFormat, allModes: (ScrubMode | XisoMode)[] }[]} */
const TARGETS = [
	{ format: 'god', allModes: ['none', 'partial', 'full'] },
	{ format: 'xiso', allModes: ['trim', 'zero', 'full'] },
	{ format: 'ciso', allModes: ['none', 'partial', 'full'] },
	{ format: 'cci', allModes: ['none', 'partial', 'full'] },
];

test.describe('mode select constraints by source format', () => {
	test.beforeEach(async ({ queuePage }) => {
		await queuePage.goto();
	});

	test('an extracted-shaped source forces every target format to full-only, disabled mode selects', async ({
		queuePage,
	}) => {
		const dir = await makeExtractedDirFixture(isoBytes);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.optionsSummary(item).click();

		for (const { format, allModes } of TARGETS) {
			const select = queuePage.modeSelect(item, format);
			await expect(select).toHaveValue('full');
			await expect(select).toBeDisabled();
			for (const mode of allModes) {
				const option = select.locator(`option[value="${mode}"]`);
				if (mode === 'full') {
					await expect(option).not.toHaveAttribute('disabled', '');
				} else {
					await expect(option).toHaveAttribute('disabled', '');
				}
			}
		}
	});

	// An 'stfs' source hits the same MODE_CONSTRAINTS narrowing as
	// 'extracted' (see queue.js) - it also only ever opens as an
	// ExtractedFs, with no raw disc image to scrub partially.
	test('an stfs source forces every target format to full-only, disabled mode selects', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: '4D530001',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(stfsBytes),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.optionsSummary(item).click();

		for (const { format, allModes } of TARGETS) {
			const select = queuePage.modeSelect(item, format);
			await expect(select).toHaveValue('full');
			await expect(select).toBeDisabled();
			for (const mode of allModes) {
				const option = select.locator(`option[value="${mode}"]`);
				if (mode === 'full') {
					await expect(option).not.toHaveAttribute('disabled', '');
				} else {
					await expect(option).toHaveAttribute('disabled', '');
				}
			}
		}
	});

	test('a non-extracted source leaves each target format with its normal, interactive mode range', async ({
		queuePage,
	}) => {
		const item = await queuePage.addSource({
			name: 'test.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes.buffer),
		});
		await queuePage.expectQueued(item, { timeout: 15_000 });
		await queuePage.optionsSummary(item).click();

		for (const { format, allModes } of TARGETS) {
			const select = queuePage.modeSelect(item, format);
			await expect(select).toBeEnabled();
			for (const mode of allModes) {
				await expect(select.locator(`option[value="${mode}"]`)).toBeEnabled();
			}
		}
	});

	// A failed inspection never sets sourceFormat, even though an errored
	// item is still convertible/editable like an idle one - it must not be
	// misread as 'extracted' and wrongly narrowed.
	test('a source that failed inspection (still convertible) keeps every target format at its normal, interactive mode range', async ({
		queuePage,
	}) => {
		test.setTimeout(60_000);
		const dir = await makeCorruptExtractedDirFixtureXex(isoBytes);
		const [item] = await queuePage.addFolder(dir);
		await queuePage.expectError(item, { timeout: 15_000 });
		await queuePage.optionsSummary(item).click();

		for (const { format, allModes } of TARGETS) {
			const select = queuePage.modeSelect(item, format);
			await expect(select).toBeEnabled();
			for (const mode of allModes) {
				await expect(select.locator(`option[value="${mode}"]`)).toBeEnabled();
			}
		}
	});

	// Constraints are keyed off each item's own sourceFormat: adding a
	// second, extracted-shaped item must not touch the first item's mode.
	test('mode constraints are scoped to each queue item independently', async ({
		queuePage,
	}) => {
		const isoItem = await queuePage.addSource({
			name: 'test.iso',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from(isoBytes.buffer),
		});
		await queuePage.expectQueued(isoItem, { timeout: 15_000 });
		await queuePage.optionsSummary(isoItem).click();
		await queuePage.modeSelect(isoItem, 'god').selectOption('partial');

		const dir = await makeExtractedDirFixture(isoBytes);
		const [extractedItem] = await queuePage.addFolder(dir);
		await expect(queuePage.items).toHaveCount(2);
		await queuePage.expectQueued(extractedItem, { timeout: 15_000 });

		// The plain-ISO item's explicit 'partial' choice survives...
		await expect(queuePage.modeSelect(isoItem, 'god')).toHaveValue('partial');
		await expect(queuePage.modeSelect(isoItem, 'god')).toBeEnabled();

		// ...while the newly-added extracted item is independently forced to
		// 'full' and locked.
		await queuePage.optionsSummary(extractedItem).click();
		await expect(queuePage.modeSelect(extractedItem, 'god')).toHaveValue('full');
		await expect(queuePage.modeSelect(extractedItem, 'god')).toBeDisabled();
	});
});
