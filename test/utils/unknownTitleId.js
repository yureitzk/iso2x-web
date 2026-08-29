/**
 * Verified, at the start of this test run, to have no entry in
 * iso2x's game list. Do not replace with a hardcoded number - the
 * game list can grow and claim any fixed ID.
 *
 * Populated by resolveUnmappedTitleId() (./reserveTitleId.js) via
 * Playwright's globalSetup (../e2e/global-setup.js) before any spec
 * file is imported. If globalSetup isn't wired up, set it manually:
 *
 *   import { resolveUnmappedTitleId } from './reserveTitleId.js';
 *   process.env.UNMAPPED_TITLE_ID = String(await resolveUnmappedTitleId());
 */
export const UNKNOWN_TITLE_ID = loadReservedTitleId();

function loadReservedTitleId() {
	const raw = process.env.UNMAPPED_TITLE_ID;
	if (raw === undefined) {
		throw new Error(
			'UNKNOWN_TITLE_ID: process.env.UNMAPPED_TITLE_ID is not set.',
		);
	}
	const titleId = Number(raw);
	if (!Number.isInteger(titleId)) {
		throw new Error(
			`UNKNOWN_TITLE_ID: process.env.UNMAPPED_TITLE_ID is not a valid integer (got ${JSON.stringify(raw)}).`,
		);
	}
	return titleId;
}
