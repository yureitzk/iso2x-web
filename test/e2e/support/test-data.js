import {
	makeFixture,
	SECTOR_SIZE,
	XGD3_ROOT_OFFSET,
} from '../../fixtures/xfs.js';
import {
	makeSyntheticKeyvault,
	makeTruncatedKeyvault,
	makeCorruptKeyvault,
	CERTIFICATE_OFFSET,
	CERTIFICATE_LEN,
} from '../../fixtures/keyvault.js';
import { makeStfsFixture } from '../../fixtures/stfs.js';
import { UNKNOWN_TITLE_ID } from '../../utils/unknownTitleId.js';

// tempDir.js writes under each test's own Playwright output directory
// (testInfo.outputPath()), which Playwright wipes at the start of every
// run - no fixture-cleanup hook needed here. See writePartsToTempDir()'s
// doc comment in fixtures/tempDir.js.

export const isoBytes = makeFixture();
export const untitledIsoBytes = makeFixture({ titleId: UNKNOWN_TITLE_ID });

export const x360IsoBytes = makeFixture({
	titleId: 0x5a5a0001,
	platform: 'x360',
});

// Built once and shared, same reasoning as isoBytes above - STFS isn't
// produced by a conversion session in this codebase (it's read-only),
// so this is built directly rather than round-tripped through an xiso.
export const stfsBytes = makeStfsFixture({ titleId: 0x5a5a0003 });

// Built once and shared, same reasoning as isoBytes above, plus RSA
// keygen is comparatively expensive - most specs only need *a* valid
// keyvault, not a specific one. A test asserting per-item isolation
// across two distinct keys should call makeSyntheticKeyvault() itself
// for the second one rather than reuse this.
export const syntheticKeyvault = makeSyntheticKeyvault();

export {
	makeFixture,
	SECTOR_SIZE,
	XGD3_ROOT_OFFSET,
	UNKNOWN_TITLE_ID,
	makeSyntheticKeyvault,
	makeTruncatedKeyvault,
	makeCorruptKeyvault,
	CERTIFICATE_OFFSET,
	CERTIFICATE_LEN,
	makeStfsFixture,
};

/**
 * Splits a fixture buffer into a `.1.iso`/`.2.iso`-style pair, one sector
 * before the end. Returns copies, not views: `isoBytes`/`untitledIsoBytes`
 * are shared module-level fixtures imported by many spec files running
 * under fullyParallel: true, so a view (`subarray`) over the same
 * ArrayBuffer would let any future mutation of one "half" corrupt the
 * shared original for every other test.
 * @param {Uint8Array} buf
 * @returns {[Uint8Array, Uint8Array]}
 */
export function splitIsoPair(buf) {
	const mid = buf.length - SECTOR_SIZE;
	return [buf.slice(0, mid), buf.slice(mid)];
}
