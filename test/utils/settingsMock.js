import { vi } from 'vitest';

/**
 * @import { SiteSettings } from '../../src/types/global'
 */

/**
 * Deliberately not imported from settings.js's own defaults, so a
 * change there can't silently reshape every mock-backed test's
 * starting state.
 * @satisfies {SiteSettings}
 */
const MOCK_DEFAULTS = {
	showNotifications: false,
	notifyIgnoreFocus: false,
	theme: 'system',
	keepScreenAwake: true,
	audioKeepAlive: false,
	multiFileDownloadsPrimed: false,
	headerAnimation: false,
	faviconEnabled: true,
	faviconPulseAnimation: false,
	badgeEnabled: true,
	maxConcurrentConversions: null,
	maxConcurrentDownloadStreams: 1,
	defaultConversionOptions: {
		format: 'god',
		generateAttachXbe: false,
		god: { mode: 'full', sign: false },
		xiso: { mode: 'full', split: false },
		extracted: {
			skipSystemUpdate: false,
			allowedMediaPatch: false,
			renameTitle: false,
		},
		ciso: { mode: 'full' },
		cci: { mode: 'full' },
		zar: {},
	},
};

/** @param {Partial<SiteSettings>} [initial] overrides applied on top of MOCK_DEFAULTS */
export function createMockSettings(initial = {}) {
	/** @type {SiteSettings} */
	let store = { ...MOCK_DEFAULTS, ...initial };

	// get/set are named generic functions, not inline arrows, so `key`/`value`
	// don't typecheck as implicit `any`. vi.fn() can't preserve that genericity
	// at runtime though - it collapses SiteSettings[K] to the flattened union -
	// so getMock/setMock below are asserted directly against the real types
	// instead of inferred.
	/**
	 * @template {keyof SiteSettings} K
	 * @param {K} key
	 * @returns {SiteSettings[K]}
	 */
	function get(key) {
		return store[key];
	}
	/**
	 * @template {keyof SiteSettings} K
	 * @param {K} key
	 * @param {SiteSettings[K]} value
	 */
	function set(key, value) {
		store[key] = value;
	}
	function getAll() {
		return { ...store };
	}
	function reset() {
		store = { ...MOCK_DEFAULTS };
	}

	/** @type {typeof import('../../src/js/lib/settings.js').settings.get} */
	const getMock = /** @type {any} */ (vi.fn(get));
	/** @type {typeof import('../../src/js/lib/settings.js').settings.set} */
	const setMock = /** @type {any} */ (vi.fn(set));

	/** @satisfies {typeof import('../../src/js/lib/settings.js').settings} */
	const settingsDouble = {
		getAll: vi.fn(getAll),
		get: getMock,
		set: setMock,
		reset: vi.fn(reset),
	};

	return { settings: settingsDouble };
}
