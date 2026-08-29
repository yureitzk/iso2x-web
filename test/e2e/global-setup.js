import { resolveUnmappedTitleId } from '../utils/reserveTitleId.js';

/**
 * Playwright globalSetup: resolves this run's "verified unmapped" title
 * ID once, up front, and publishes it via `process.env.UNMAPPED_TITLE_ID`
 * so test/utils/unknownTitleId.js can read it synchronously at
 * module-import time in every worker.
 *
 * Worker processes inherit process.env from the root Playwright process
 * at spawn time - this is the pattern Playwright's docs recommend for
 * passing data from globalSetup to tests:
 * https://playwright.dev/docs/test-global-setup-teardown
 */
export default async function globalSetup() {
	const titleId = await resolveUnmappedTitleId();
	process.env.UNMAPPED_TITLE_ID = String(titleId);
	console.log(
		`[global-setup] reserved title ID 0x${titleId
			.toString(16)
			.padStart(8, '0')} verified unmapped for this run`,
	);
}
