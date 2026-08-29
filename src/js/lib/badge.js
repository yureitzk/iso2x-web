import { createLogger } from './logger.js';
import { settings } from './settings.js';
import { supportsBadging, isTabUnseen } from './helpers.js';

const log = createLogger('badge');

const _supported = supportsBadging();

let _activeCount = 0;

/** Errors that occurred while the tab was unseen; cleared once the tab regains focus. */
let _pendingErrorCount = 0;

/** @returns {number} */
function total() {
	return _activeCount + _pendingErrorCount;
}

async function apply() {
	if (!_supported) return;

	if (!settings.get('badgeEnabled')) {
		try {
			await navigator.clearAppBadge();
		} catch (e) {
			log.warn('Failed to clear app badge', e);
		}
		return;
	}

	try {
		const count = total();
		if (count > 0) {
			await navigator.setAppBadge(count);
		} else {
			await navigator.clearAppBadge();
		}
	} catch (e) {
		log.warn('Failed to update app badge', e);
	}
}

function handleSeenCheck() {
	if (isTabUnseen()) return;
	if (_pendingErrorCount === 0) return;

	_pendingErrorCount = 0;
	apply();
}

export function initBadge() {
	if (!_supported) {
		log.warn('Badging API not supported; indicator disabled.');
		return;
	}

	document.addEventListener('visibilitychange', handleSeenCheck);
	window.addEventListener('focus', handleSeenCheck);
}

/**
 * Re-applies the badge to reflect a change to the badgeEnabled setting,
 * without waiting for the next activity or outcome event.
 */
export function applyBadgeSettings() {
	apply();
}

/**
 * Updates the badge with the number of queue entries running/paused.
 * @param {number} count
 */
export function setBadgeActiveCount(count) {
	if (_activeCount === count) return;

	_activeCount = count;
	apply();
}

/**
 * Records a conversion outcome for the badge. Only errors accumulate,
 * and only while the tab is unseen.
 * @param {'success' | 'error' | 'cancelled'} outcome
 */
export function notifyBadgeOutcome(outcome) {
	if (outcome !== 'error') return;
	if (!isTabUnseen()) return;

	_pendingErrorCount += 1;
	apply();
}

export function isBadgingSupported() {
	return _supported;
}

/** Test/debug helper; not used by application code. */
export function _getBadgeCountForTests() {
	return total();
}
