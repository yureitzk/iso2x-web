import { setupWasm } from './wasmSetup.js';
import { lookupTitleById } from 'iso2x';

/** Exhausting this means lookupTitleById() is broken. */
const DEFAULT_PROBE_ATTEMPTS = 25;

/** @returns {number} a random u32, excluding 0 */
function randomCandidateTitleId() {
	const buf = new Uint32Array(1);
	let candidate;
	do {
		crypto.getRandomValues(buf);
		candidate = buf[0];
	} while (candidate === 0);
	return candidate;
}

/**
 * Draws random candidates against the live iso2x game list until
 * one comes back unmapped, rather than trusting a fixed literal that
 * could get claimed by a future game-list update.
 * @param {{ attempts?: number }} [opts]
 * @returns {Promise<number>} a title ID verified to have no entry in
 *   iso2x's game list.
 */
export async function resolveUnmappedTitleId({
	attempts = DEFAULT_PROBE_ATTEMPTS,
} = {}) {
	await setupWasm();
	for (let i = 0; i < attempts; i++) {
		const candidate = randomCandidateTitleId();
		if (lookupTitleById(candidate) === undefined) return candidate;
	}
	throw new Error(
		`resolveUnmappedTitleId: all ${attempts} random title IDs resolved to known games. ` +
			'This is highly unexpected and likely indicates that lookupTitleById() ' +
			'is broken or its contract has changed.',
	);
}
