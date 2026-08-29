import { describe, it, expect } from 'vitest';
import {
	assertStreamComplete,
	assertEntryComplete,
} from './streamSizeGuard.js';

describe('assertStreamComplete', () => {
	it('does not throw when sentBytes matches the expected size', () => {
		expect(() => assertStreamComplete(2855964672, 2855964672n)).not.toThrow();
	});

	it('throws when fewer bytes were streamed than expected', () => {
		expect(() => assertStreamComplete(2855901184, 2855964672n)).toThrow(
			/Conversion incomplete/,
		);
	});

	it('throws when more bytes were streamed than expected', () => {
		expect(() => assertStreamComplete(2855967744, 2855964672n)).toThrow(
			/Conversion incomplete/,
		);
	});

	it('is a no-op when expectedSize is undefined (zar, unknown until the footer phase)', () => {
		expect(() => assertStreamComplete(12345, undefined)).not.toThrow();
	});

	it('handles sentBytes values above Number.MAX_SAFE_INTEGER-adjacent sizes without precision loss', () => {
		const big = 5_000_000_000;
		expect(() => assertStreamComplete(big, BigInt(big))).not.toThrow();
		expect(() => assertStreamComplete(big - 1, BigInt(big))).toThrow(
			/Conversion incomplete/,
		);
	});
});

describe('assertEntryComplete', () => {
	it('does not throw when sent matches expected', () => {
		expect(() =>
			assertEntryComplete({ name: 'a.iso', expected: 1024, sent: 1024 }),
		).not.toThrow();
	});

	it('is a no-op when current is null (nothing streamed yet)', () => {
		expect(() => assertEntryComplete(null)).not.toThrow();
	});

	it('throws and names the entry when fewer bytes were sent than expected', () => {
		expect(() =>
			assertEntryComplete({ name: 'part.1.iso', expected: 2048, sent: 1000 }),
		).toThrow(/part\.1\.iso streamed 1000 of 2048/);
	});

	it('throws when more bytes were sent than expected', () => {
		expect(() =>
			assertEntryComplete({ name: 'part.2.iso', expected: 2048, sent: 3000 }),
		).toThrow(/Conversion incomplete/);
	});
});
