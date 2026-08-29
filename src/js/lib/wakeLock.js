import { createLogger } from './logger.js';

const log = createLogger('wake-lock');

/** @type {WakeLockSentinel | null} */
let sentinel = null;
let _enabled = false;
let _active = false;

const isSupported = () => 'wakeLock' in navigator && !navigator.webdriver;

async function acquire() {
	if (!isSupported() || sentinel) return;
	try {
		sentinel = await navigator.wakeLock.request('screen');
		sentinel.addEventListener('release', () => {
			log.info('Wake lock released');
			sentinel = null;
		});
		log.info('Wake lock acquired');
	} catch (err) {
		log.warn('Wake lock request failed:', err);
	}
}

function release() {
	sentinel?.release();
	sentinel = null;
}

if (isSupported()) {
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && _enabled && _active) {
			acquire();
		}
	});
}

/**
 * Called when the user toggles the setting.
 * @param {boolean} enabled
 */
export function setWakeLockEnabled(enabled) {
	if (!isSupported()) return;

	_enabled = enabled;
	if (_enabled && _active) {
		acquire();
	} else {
		release();
	}
}

export function notifyConversionStarted() {
	if (!isSupported()) return;

	_active = true;
	if (_enabled) acquire();
}

export function notifyConversionFinished() {
	if (!isSupported()) return;

	_active = false;
	release();
}
