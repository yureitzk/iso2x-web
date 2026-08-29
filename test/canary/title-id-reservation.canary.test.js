import { describe, it, expect } from 'vitest';
import { resolveUnmappedTitleId } from '../utils/reserveTitleId.js';

/**
 * The e2e suite self-heals around an upstream iso2x game-list
 * change by drawing a fresh unmapped ID each run, which means a normal
 * green e2e run never tells anyone the game list moved. This test
 * exists to surface that directly. Run whenever iso2x is bumped.
 */
describe('unmapped-title-id reservation', () => {
	it('can still find a title ID with no entry in the current iso2x game list', async () => {
		const titleId = await resolveUnmappedTitleId();
		expect(Number.isInteger(titleId)).toBe(true);
		expect(titleId).toBeGreaterThan(0);
		expect(titleId).toBeLessThanOrEqual(0xffffffff);
	});
});
