import { settings } from './settings.js';
import * as pkg from '../../../package.json';
import { TEXT } from '../constants/messages.js';
import { isTabUnseen } from './helpers.js';
import { iconForOutcome } from './favicon.js';

/**
 * Fires a system notification for a finished conversion. Skipped
 * while the tab is focused, unless notifyIgnoreFocus is set.
 * @param {'success' | 'error' | 'cancelled'} type
 * @param {string} title
 */
export function notify(type, title) {
	if (!settings.get('showNotifications')) return;
	if (Notification.permission !== 'granted') return;
	if (!settings.get('notifyIgnoreFocus') && !isTabUnseen()) return;
	const configs = {
		success: {
			body: TEXT.NOTIFY_SUCCESS(title),
			tag: 'convert-success',
		},
		error: {
			body: TEXT.NOTIFY_ERROR(title),
			tag: 'convert-error',
		},
		cancelled: {
			body: TEXT.NOTIFY_CANCELLED(title),
			tag: 'convert-cancelled',
		},
	};
	new Notification(`${pkg.displayName}`, {
		...configs[type],
		icon: iconForOutcome(type),
	});
}
