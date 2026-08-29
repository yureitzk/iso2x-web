import { createLogger } from '../lib/logger.js';
import { prefersReducedMotion } from './helpers.js';
import { DEFAULT_CONVERSION_OPTIONS } from '../constants/conversion.js';

/**
 * @import { SiteSettings, FeatureCheck } from '../../types/global'
 */

const log = createLogger('settings');

const STORAGE_KEY = __SETTINGS_KEY__;

export { DEFAULT_CONVERSION_OPTIONS };

/** @type {SiteSettings} */
const DEFAULTS = {
	showNotifications: false,
	notifyIgnoreFocus: false,
	theme: 'system',
	keepScreenAwake: true,
	headerAnimation: !prefersReducedMotion(),
	faviconEnabled: true,
	faviconPulseAnimation: !prefersReducedMotion(),
	badgeEnabled: true,
	multiFileDownloadsPrimed: false,
	defaultConversionOptions: DEFAULT_CONVERSION_OPTIONS,
	maxConcurrentConversions: null,
	maxConcurrentDownloadStreams: 1,
};

/**
 * @param {unknown} value
 * @param {boolean} nullable
 * @param {number | null} fallback
 * @returns {number | null}
 */
function sanitizeConcurrency(value, nullable, fallback) {
	if (nullable && value === null) return null;
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	const floored = Math.floor(value);
	return floored >= 1 ? floored : fallback;
}

/**
 * @param {SiteSettings} data
 * @returns {SiteSettings}
 */
function sanitizeConcurrencyFields(data) {
	return {
		...data,
		maxConcurrentConversions: sanitizeConcurrency(
			data.maxConcurrentConversions,
			true,
			DEFAULTS.maxConcurrentConversions,
		),
		maxConcurrentDownloadStreams: /** @type {number} */ (
			sanitizeConcurrency(
				data.maxConcurrentDownloadStreams,
				false,
				DEFAULTS.maxConcurrentDownloadStreams,
			)
		),
	};
}

/** @returns {SiteSettings} */
function load() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULTS };
		return sanitizeConcurrencyFields({ ...DEFAULTS, ...JSON.parse(raw) });
	} catch {
		return { ...DEFAULTS };
	}
}

/** @param {SiteSettings} data */
function save(data) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
	} catch (err) {
		log.warn('Failed to persist settings:', err);
	}
}

let _cache = load();

export const settings = {
	getAll() {
		return { ..._cache };
	},

	/**
	 * @template {keyof SiteSettings} K
	 * @param {K} key
	 * @returns {SiteSettings[K]}
	 */
	get(key) {
		return _cache[key];
	},

	/**
	 * @template {keyof SiteSettings} K
	 * @param {K} key
	 * @param {SiteSettings[K]} value
	 */
	set(key, value) {
		if (key === 'maxConcurrentConversions') {
			_cache.maxConcurrentConversions = sanitizeConcurrency(
				value,
				true,
				DEFAULTS.maxConcurrentConversions,
			);
		} else if (key === 'maxConcurrentDownloadStreams') {
			_cache.maxConcurrentDownloadStreams = /** @type {number} */ (
				sanitizeConcurrency(value, false, DEFAULTS.maxConcurrentDownloadStreams)
			);
		} else {
			_cache[key] = value;
		}
		save(_cache);
	},

	reset() {
		_cache = { ...DEFAULTS };
		save(_cache);
	},
};

/** @type {FeatureCheck} */
export const checkMultiFileDownloads = async () => {
	const primed = settings.get('multiFileDownloadsPrimed');
	return primed
		? { status: 'available', text: 'Checked' }
		: { status: 'warn', text: 'Not checked yet' };
};
