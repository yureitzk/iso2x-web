import { settings } from './settings.js';
/** @import { Theme } from '../../types/global' */

const DATA_ATTRIBUTE = 'data-theme';

/** @param {Theme} theme */
function applyTheme(theme) {
	const root = document.documentElement;
	if (theme === 'system') {
		const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		root.setAttribute(DATA_ATTRIBUTE, prefersDark ? 'dark' : 'light');
	} else {
		root.setAttribute(DATA_ATTRIBUTE, theme);
	}
}

/**
 * Apply the persisted theme preference and set up the theme selector element
 * and the `prefers-color-scheme` media query listener.
 */
export function initTheme() {
	const saved = settings.get('theme');
	applyTheme(saved);

	const themeSelect = document.getElementById('theme-select');
	if (themeSelect instanceof HTMLSelectElement) {
		themeSelect.value = saved;
		themeSelect.addEventListener('change', (e) => {
			const next = /** @type {Theme} */ (
				/** @type {HTMLSelectElement} */ (e.target).value
			);
			settings.set('theme', next);
			applyTheme(next);
		});
	}

	window
		.matchMedia('(prefers-color-scheme: dark)')
		.addEventListener('change', () => {
			if (settings.get('theme') === 'system') {
				applyTheme('system');
			}
		});
}
