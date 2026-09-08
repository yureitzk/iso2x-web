import { SECTOR_SIZE } from './xfs.js';
import { writePartsToTempDir } from './tempDir.js';

/**
 * A real XISO header fragment paired with an unrelated random-byte
 * "continuation". The random bytes look like a plausible continuation
 * candidate but don't verify against the real header, producing a genuine
 * unresolved/unordered split result - useful for exercising that error
 * path without needing a real multi-gigabyte split.
 *
 * @param {Uint8Array} isoBuffer
 */
export function makeUnresolvedSplitFragments(isoBuffer) {
	const mid = isoBuffer.length - SECTOR_SIZE;
	const header = isoBuffer.subarray(0, mid);
	const bogusContinuation = crypto.getRandomValues(
		new Uint8Array(isoBuffer.length - header.length),
	);
	return [header, bogusContinuation];
}

/**
 * Writes an arbitrary flat set of named files into a fresh temp directory -
 * for "batch dir" fixtures.
 *
 * @param {{ name: string, bytes: Uint8Array }[]} files
 * @param {string} [prefix]
 * @returns {string} absolute path to the populated temp directory
 */
export function makeBatchDirFixture(files, prefix = 'batch-fixture') {
	return writePartsToTempDir(files, prefix);
}
