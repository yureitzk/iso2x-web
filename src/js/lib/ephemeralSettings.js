/**
 * @import { EphemeralSettings } from '../../types/global'
 */

/**
 * In-memory-only settings.
 * @type {EphemeralSettings}
 */
let _cache = {};

export const ephemeralSettings = {
	/** @returns {EphemeralSettings} */
	getAll() {
		return { ..._cache };
	},

	/**
	 * @template {keyof EphemeralSettings} K
	 * @param {K} key
	 * @returns {EphemeralSettings[K]}
	 */
	get(key) {
		return _cache[key];
	},

	/**
	 * @template {keyof EphemeralSettings} K
	 * @param {K} key
	 * @param {EphemeralSettings[K]} value
	 */
	set(key, value) {
		_cache[key] = value;
	},

	clear() {
		_cache = {};
	},
};
