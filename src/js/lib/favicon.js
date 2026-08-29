import { createLogger } from './logger.js';
import { settings } from './settings.js';
import { isTabUnseen } from './helpers.js';

const log = createLogger('favicon');

/**
 * @typedef {'default' | 'running' | 'done' | 'error'} FaviconState
 */

/**
 * Icon and shortcut variants for each favicon state.
 * @type {Record<FaviconState, { icon: string, shortcut: string }>}
 */
const VARIANTS = {
	default: {
		icon: './favicon-96x96.png',
		shortcut: './favicon.ico',
	},
	running: {
		icon: './favicon-running-96x96.png',
		shortcut: './favicon-running.ico',
	},
	done: {
		icon: './favicon-done-96x96.png',
		shortcut: './favicon-done.ico',
	},
	error: {
		icon: './favicon-error-96x96.png',
		shortcut: './favicon-error.ico',
	},
};

const RUNNING_PULSE = {
	icon: './favicon-running-dim-96x96.png',
	shortcut: './favicon-running-dim.ico',
};
const PULSE_INTERVAL_MS = 1600;

/**
 * @type {Record<'success' | 'error' | 'cancelled', string>}
 */
const OUTCOME_ICON_320 = {
	success: './favicon-done-320x320.png',
	error: './favicon-error-320x320.png',
	cancelled: './favicon-320x320.png',
};

/** @type {HTMLLinkElement | null} */
let _iconLink = null;
/** @type {HTMLLinkElement | null} */
let _shortcutLink = null;

/** @type {FaviconState} */
let _current = 'default';

/** Error takes precedence over done while the tab is unseen. */
let _pendingTerminal = /** @type {'done' | 'error' | null} */ (null);
let _hasActiveWork = false;

let _pulseTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);
let _pulseOn = false;

/**
 * @type {Map<string, HTMLImageElement>}
 */
const _preloaded = new Map();

/**
 * @param {string} src
 */
function preloadFrame(src) {
	if (_preloaded.has(src)) return;
	const img = new Image();
	img.src = src;
	_preloaded.set(src, img);
}

function preloadAllFrames() {
	for (const variant of Object.values(VARIANTS)) {
		preloadFrame(variant.icon);
	}
	preloadFrame(RUNNING_PULSE.icon);

	// Image() can't decode .ico, so warm those through the HTTP cache instead.
	for (const variant of Object.values(VARIANTS)) {
		fetch(variant.shortcut, { cache: 'force-cache' }).catch(() => {});
	}
	fetch(RUNNING_PULSE.shortcut, { cache: 'force-cache' }).catch(() => {});
}

/**
 * Swaps in a new favicon link by inserting the replacement before
 * removing the old one.
 * @param {HTMLLinkElement} oldLink
 * @param {string} href
 * @returns {HTMLLinkElement} the replacement link
 */
function swapLink(oldLink, href) {
	if (oldLink.getAttribute('href') === href) return oldLink;

	const next = /** @type {HTMLLinkElement} */ (oldLink.cloneNode(false));
	next.href = href;
	oldLink.insertAdjacentElement('afterend', next);
	oldLink.remove();

	return next;
}

/**
 * Applies a favicon variant, optionally overriding it with a pulse frame.
 * @param {FaviconState} state
 * @param {{ icon: string, shortcut: string }} [override]
 */
function applyVariant(state, override) {
	if (!_iconLink || !_shortcutLink) return;

	const variant = override ?? VARIANTS[state];
	_iconLink = swapLink(_iconLink, variant.icon);
	_shortcutLink = swapLink(_shortcutLink, variant.shortcut);
}

function stopPulse() {
	if (_pulseTimer !== null) clearInterval(_pulseTimer);
	_pulseTimer = null;
	_pulseOn = false;
}

function startPulse() {
	if (_pulseTimer !== null) return;

	_pulseOn = false;
	_pulseTimer = setInterval(() => {
		_pulseOn = !_pulseOn;
		applyVariant('running', _pulseOn ? RUNNING_PULSE : undefined);
	}, PULSE_INTERVAL_MS);
}

function render() {
	if (!settings.get('faviconEnabled')) {
		stopPulse();
		applyVariant('default');
		_current = 'default';
		return;
	}

	/** @type {FaviconState} */
	let next;

	if (_hasActiveWork) {
		next = 'running';
	} else if (_pendingTerminal) {
		next = _pendingTerminal;
	} else {
		next = 'default';
	}

	if (next === 'running' && settings.get('faviconPulseAnimation')) {
		startPulse();
	} else {
		stopPulse();
		applyVariant(next);
	}

	_current = next;
}

/** Re-applies the favicon after a faviconEnabled/faviconPulseAnimation change. */
export function applyFaviconSettings() {
	if (!_iconLink || !_shortcutLink) return;
	render();
}

export function initFavicon() {
	_iconLink = /** @type {HTMLLinkElement | null} */ (
		document.querySelector('link[rel="icon"][type="image/png"]')
	);
	_shortcutLink = /** @type {HTMLLinkElement | null} */ (
		document.querySelector('link[rel="shortcut icon"]')
	);

	if (!_iconLink || !_shortcutLink) {
		log.warn('Expected favicon <link> tags not found; indicator disabled.');
		return;
	}

	preloadAllFrames();

	document.addEventListener('visibilitychange', handleSeenCheck);
	window.addEventListener('focus', handleSeenCheck);
}

function handleSeenCheck() {
	if (isTabUnseen()) return;

	if (_pendingTerminal) {
		_pendingTerminal = null;
		render();
	}
}

/**
 * Updates the favicon's running state.
 * @param {boolean} hasActiveWork Whether any work is running or paused.
 */
export function setFaviconActivity(hasActiveWork) {
	if (_hasActiveWork === hasActiveWork) return;

	_hasActiveWork = hasActiveWork;
	render();
}

/**
 * Records a completed queue entry for the favicon. Terminal states show
 * only while the tab is unseen; errors take precedence over successes,
 * and cancellations are ignored.
 * @param {'success' | 'error' | 'cancelled'} outcome
 */
export function notifyFaviconOutcome(outcome) {
	if (outcome === 'cancelled') return;
	if (!isTabUnseen()) return;
	if (_pendingTerminal === 'error') return;

	_pendingTerminal = outcome === 'success' ? 'done' : 'error';
	render();
}

/**
 * 320px icon path for a conversion outcome.
 * @param {'success' | 'error' | 'cancelled'} outcome
 * @returns {string}
 */
export function iconForOutcome(outcome) {
	return OUTCOME_ICON_320[outcome];
}

/** Test/debug helper; not used by application code. */
export function _getFaviconStateForTests() {
	return _current;
}
