import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * @import { SiteSettings } from '../../types/global'
 */

// settings.js reads `__SETTINGS_KEY__` as a bare identifier - normally
// replaced at build time by vite's `define`, which vitest doesn't apply.
// Stubbing it as a real global before the module loads is the same
// trick a build-time define achieves, without needing a vitest config
// change that every other suite would inherit.
const TEST_STORAGE_KEY = 'iso2x:settings:test';

/**
 * settings.js caches its state in a module-level variable seeded once at
 * import time, so each test needs a fresh module instance to see a clean
 * `localStorage` - `vi.resetModules()` plus a dynamic import gives that
 * without disturbing any other suite's already-loaded copy.
 * @returns {Promise<{ settings: typeof import('./settings.js').settings }>}
 */
async function freshSettings() {
	const mod = /** @type {any} */ (await import('./settings.js'));
	return mod;
}

describe('settings', () => {
	beforeEach(() => {
		/** @type {any} */ (globalThis).__SETTINGS_KEY__ = TEST_STORAGE_KEY;
		localStorage.removeItem(TEST_STORAGE_KEY);
		vi.resetModules();
	});

	afterEach(() => {
		localStorage.removeItem(TEST_STORAGE_KEY);
	});

	it('loads built-in defaults when nothing is persisted', async () => {
		const { settings } = await freshSettings();
		expect(settings.get('maxConcurrentConversions')).toBe(null);
		expect(settings.get('maxConcurrentDownloadStreams')).toBe(1);
		expect(settings.get('theme')).toBe('system');
	});

	it('round-trips maxConcurrentConversions and maxConcurrentDownloadStreams through set/get', async () => {
		const { settings } = await freshSettings();

		settings.set('maxConcurrentConversions', 4);
		settings.set('maxConcurrentDownloadStreams', 2);

		expect(settings.get('maxConcurrentConversions')).toBe(4);
		expect(settings.get('maxConcurrentDownloadStreams')).toBe(2);
	});

	it('persists concurrency fields across a reload of the module', async () => {
		const first = await freshSettings();
		first.settings.set('maxConcurrentConversions', 6);
		first.settings.set('maxConcurrentDownloadStreams', 3);

		vi.resetModules();
		const second = await freshSettings();

		expect(second.settings.get('maxConcurrentConversions')).toBe(6);
		expect(second.settings.get('maxConcurrentDownloadStreams')).toBe(3);
	});

	it('falls back to defaults for fields missing from persisted data', async () => {
		// load() merges saved data onto DEFAULTS, so a payload missing a
		// key should get its default rather than undefined.
		localStorage.setItem(TEST_STORAGE_KEY, JSON.stringify({ theme: 'dark' }));
		const { settings } = await freshSettings();

		expect(settings.get('theme')).toBe('dark');
		expect(settings.get('maxConcurrentConversions')).toBe(null);
		expect(settings.get('maxConcurrentDownloadStreams')).toBe(1);
	});

	it('reset() restores concurrency fields to their defaults', async () => {
		const { settings } = await freshSettings();
		settings.set('maxConcurrentConversions', 8);
		settings.set('maxConcurrentDownloadStreams', 5);

		settings.reset();

		expect(settings.get('maxConcurrentConversions')).toBe(null);
		expect(settings.get('maxConcurrentDownloadStreams')).toBe(1);
	});

	it('getAll() includes both new fields', async () => {
		const { settings } = await freshSettings();
		/** @type {SiteSettings} */
		const all = settings.getAll();
		expect(all).toHaveProperty('maxConcurrentConversions', null);
		expect(all).toHaveProperty('maxConcurrentDownloadStreams', 1);
	});

	describe('concurrency field sanitization', () => {
		it.each([
			['a negative number', -5],
			['zero', 0],
			['NaN', NaN],
			['Infinity', Infinity],
			['a string', 'lots'],
			['an array', [4]],
			['an object', { n: 4 }],
		])(
			'set() falls back to the default for maxConcurrentDownloadStreams given %s',
			async (_label, bad) => {
				const { settings } = await freshSettings();
				settings.set('maxConcurrentDownloadStreams', /** @type {any} */ (bad));
				expect(settings.get('maxConcurrentDownloadStreams')).toBe(1);
			},
		);

		it.each([
			['a negative number', -5],
			['zero', 0],
			['NaN', NaN],
			['Infinity', Infinity],
			['a string', 'lots'],
		])(
			'set() falls back to null (auto) for maxConcurrentConversions given %s',
			async (_label, bad) => {
				const { settings } = await freshSettings();
				// Seed a valid override first, so a fallback to the default
				// (null) is distinguishable from "value never changed".
				settings.set('maxConcurrentConversions', 4);
				settings.set('maxConcurrentConversions', /** @type {any} */ (bad));
				expect(settings.get('maxConcurrentConversions')).toBe(null);
			},
		);

		it('set() floors a fractional maxConcurrentConversions', async () => {
			const { settings } = await freshSettings();
			settings.set('maxConcurrentConversions', 3.9);
			expect(settings.get('maxConcurrentConversions')).toBe(3);
		});

		it('set() floors a fractional maxConcurrentDownloadStreams', async () => {
			const { settings } = await freshSettings();
			settings.set('maxConcurrentDownloadStreams', 2.1);
			expect(settings.get('maxConcurrentDownloadStreams')).toBe(2);
		});

		it('null is preserved (not sanitized away) for the nullable field', async () => {
			const { settings } = await freshSettings();
			settings.set('maxConcurrentConversions', 4);
			settings.set('maxConcurrentConversions', null);
			expect(settings.get('maxConcurrentConversions')).toBe(null);
		});

		it('load() sanitizes a corrupted value already sitting in localStorage (e.g. edited via devtools)', async () => {
			localStorage.setItem(
				TEST_STORAGE_KEY,
				JSON.stringify({
					maxConcurrentConversions: -7,
					maxConcurrentDownloadStreams: 'unlimited',
				}),
			);
			const { settings } = await freshSettings();

			expect(settings.get('maxConcurrentConversions')).toBe(null);
			expect(settings.get('maxConcurrentDownloadStreams')).toBe(1);
		});

		it('load() sanitizes a fractional value already sitting in localStorage', async () => {
			localStorage.setItem(
				TEST_STORAGE_KEY,
				JSON.stringify({
					maxConcurrentConversions: 5.7,
					maxConcurrentDownloadStreams: 2.2,
				}),
			);
			const { settings } = await freshSettings();

			expect(settings.get('maxConcurrentConversions')).toBe(5);
			expect(settings.get('maxConcurrentDownloadStreams')).toBe(2);
		});

		it('does not impose any upper bound on a valid override', async () => {
			const { settings } = await freshSettings();
			settings.set('maxConcurrentConversions', 999);
			settings.set('maxConcurrentDownloadStreams', 999);
			expect(settings.get('maxConcurrentConversions')).toBe(999);
			expect(settings.get('maxConcurrentDownloadStreams')).toBe(999);
		});
	});
});
