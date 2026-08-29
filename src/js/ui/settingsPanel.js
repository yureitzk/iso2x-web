import { settings } from '../lib/settings.js';
import { ephemeralSettings } from '../lib/ephemeralSettings.js';
import {
	initClearableInput,
	parseDeviceId,
	requestNotificationPermission,
	stripWhitespace,
} from '../lib/helpers.js';
import { setWakeLockEnabled } from '../lib/wakeLock.js';
import { applyFaviconSettings } from '../lib/favicon.js';
import { applyBadgeSettings } from '../lib/badge.js';
import { applyConcurrencySettings } from './queue/queueUi.js';
import { EVENTS } from '../core/protocol.js';
import { TEXT } from '../constants/messages.js';

/**
 * @import { OutputFormat, ScrubMode, XisoMode } from '../../types/global.js'
 */

export function applyHeaderAnimation() {
	const header = document.querySelector('#site-header');
	if (header) {
		header.classList.toggle('header--animated', settings.get('headerAnimation'));
	}
}

export function initSettingsPanel() {
	const notificationsCheckbox = document.getElementById('show-notifications');
	const notifyIgnoreFocusCheckbox = document.getElementById(
		'notify-ignore-focus',
	);
	if (notificationsCheckbox instanceof HTMLInputElement) {
		notificationsCheckbox.checked = settings.get('showNotifications');
		if (notifyIgnoreFocusCheckbox instanceof HTMLInputElement) {
			notifyIgnoreFocusCheckbox.disabled = !notificationsCheckbox.checked;
		}
		notificationsCheckbox.addEventListener('change', async () => {
			const wantsNotifications = notificationsCheckbox.checked;
			if (wantsNotifications) {
				const permission = await requestNotificationPermission();
				if (permission !== 'granted') {
					notificationsCheckbox.checked = false;
					settings.set('showNotifications', false);
					if (notifyIgnoreFocusCheckbox instanceof HTMLInputElement) {
						notifyIgnoreFocusCheckbox.disabled = true;
					}
					window.dispatchEvent(new Event(EVENTS.FEATURE_CHANGED));
					if (permission === 'denied') {
						alert(TEXT.NOTIFICATION_DENIED);
					}
					return;
				}
				window.dispatchEvent(new Event(EVENTS.FEATURE_CHANGED));
			}
			settings.set('showNotifications', wantsNotifications);
			if (notifyIgnoreFocusCheckbox instanceof HTMLInputElement) {
				notifyIgnoreFocusCheckbox.disabled = !wantsNotifications;
			}
		});
	}

	if (notifyIgnoreFocusCheckbox instanceof HTMLInputElement) {
		notifyIgnoreFocusCheckbox.checked = settings.get('notifyIgnoreFocus');
		notifyIgnoreFocusCheckbox.addEventListener('change', () => {
			settings.set('notifyIgnoreFocus', notifyIgnoreFocusCheckbox.checked);
		});
	}

	const keepAwakeCheckbox = document.getElementById('keep-screen-awake');
	if (keepAwakeCheckbox instanceof HTMLInputElement) {
		keepAwakeCheckbox.checked = settings.get('keepScreenAwake');
		setWakeLockEnabled(keepAwakeCheckbox.checked);
		keepAwakeCheckbox.addEventListener('change', () => {
			const val = keepAwakeCheckbox.checked;
			settings.set('keepScreenAwake', val);
			setWakeLockEnabled(val);
		});
	}

	const defaultFormatEl = document.getElementById('default-format');
	if (defaultFormatEl instanceof HTMLSelectElement) {
		defaultFormatEl.value = settings.get('defaultConversionOptions').format;
		defaultFormatEl.addEventListener('change', () => {
			const format = /** @type {OutputFormat} */ (defaultFormatEl.value);
			settings.set('defaultConversionOptions', {
				...settings.get('defaultConversionOptions'),
				format,
			});
		});
	}

	const godModeEl = document.getElementById('default-god-mode');
	if (godModeEl instanceof HTMLSelectElement) {
		godModeEl.value = settings.get('defaultConversionOptions').god.mode;
		godModeEl.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				god: {
					...opts.god,
					mode: /** @type ScrubMode */ (godModeEl.value),
				},
			});
		});
	}

	const ephemeralGodKeyvaultInput = document.getElementById(
		'ephemeral-god-keyvault',
	);
	const defaultGodSignCheckbox = document.getElementById('default-god-sign');
	if (
		ephemeralGodKeyvaultInput instanceof HTMLInputElement &&
		defaultGodSignCheckbox instanceof HTMLInputElement
	) {
		const hasDefaultKey = () => !!ephemeralSettings.get('godSigningKey');

		// The key is ephemeral (cleared on reload), but god.sign is
		// persisted - reset a stale `true` left over without a key,
		// so it can't silently reapply once a key is re-uploaded.
		if (!hasDefaultKey() && settings.get('defaultConversionOptions').god.sign) {
			const staleOpts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...staleOpts,
				god: { ...staleOpts.god, sign: false },
			});
		}

		defaultGodSignCheckbox.checked =
			hasDefaultKey() && settings.get('defaultConversionOptions').god.sign;
		defaultGodSignCheckbox.disabled = !hasDefaultKey();

		defaultGodSignCheckbox.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				god: { ...opts.god, sign: defaultGodSignCheckbox.checked },
			});
		});

		ephemeralGodKeyvaultInput.addEventListener('change', async () => {
			const file = ephemeralGodKeyvaultInput.files?.[0];
			const opts = settings.get('defaultConversionOptions');
			if (!file) {
				ephemeralSettings.set('godSigningKey', undefined);
				ephemeralSettings.set('godSigningKeyName', undefined);
				defaultGodSignCheckbox.checked = false;
				defaultGodSignCheckbox.disabled = true;
				settings.set('defaultConversionOptions', {
					...opts,
					god: { ...opts.god, sign: false },
				});
				return;
			}
			ephemeralSettings.set(
				'godSigningKey',
				new Uint8Array(await file.arrayBuffer()),
			);
			ephemeralSettings.set('godSigningKeyName', file.name);
			defaultGodSignCheckbox.disabled = false;
		});
	}

	const godDeviceIdInput = document.getElementById('default-god-device-id');
	const godDeviceIdError = document.querySelector(
		'.default-god-device-id-error',
	);
	if (
		godDeviceIdInput instanceof HTMLInputElement &&
		godDeviceIdError instanceof HTMLElement
	) {
		godDeviceIdInput.value =
			settings.get('defaultConversionOptions').god.deviceId ?? '';

		// Commits on every keystroke, not just blur - a drag-and-drop file
		// add never focuses the page, so blur alone would leave a newly
		// typed default stale for it.
		const persistDeviceId = () => {
			try {
				parseDeviceId(godDeviceIdInput.value);
			} catch (err) {
				godDeviceIdInput.classList.add('is-invalid');
				godDeviceIdError.textContent =
					err instanceof Error ? err.message : String(err);
				godDeviceIdError.hidden = false;
				return false;
			}
			godDeviceIdInput.classList.remove('is-invalid');
			godDeviceIdError.hidden = true;
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				god: {
					...opts.god,
					deviceId: stripWhitespace(godDeviceIdInput.value),
				},
			});
			return true;
		};
		godDeviceIdInput.addEventListener('input', persistDeviceId);

		// Blur just tidies up the displayed text; persistDeviceId() already committed.
		const formatDeviceIdOnBlur = () => {
			if (!persistDeviceId()) return;
			godDeviceIdInput.value = stripWhitespace(godDeviceIdInput.value);
		};
		godDeviceIdInput.addEventListener('blur', formatDeviceIdOnBlur);

		const godDeviceIdClearBtn = godDeviceIdInput
			.closest('.clearable-input')
			?.querySelector('.clearable-input__clear-btn');
		if (godDeviceIdClearBtn instanceof HTMLButtonElement) {
			initClearableInput(
				godDeviceIdInput,
				godDeviceIdClearBtn,
				formatDeviceIdOnBlur,
			);
		}
	}

	const xisoModeEl = document.getElementById('default-xiso-mode');
	if (xisoModeEl instanceof HTMLSelectElement) {
		xisoModeEl.value = settings.get('defaultConversionOptions').xiso.mode;
		xisoModeEl.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				xiso: {
					...opts.xiso,
					mode: /** @type XisoMode */ (xisoModeEl.value),
				},
			});
		});
	}

	const splitXisoCheckbox = document.getElementById('default-split-xiso');
	if (splitXisoCheckbox instanceof HTMLInputElement) {
		splitXisoCheckbox.checked = settings.get(
			'defaultConversionOptions',
		).xiso.split;
		splitXisoCheckbox.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				xiso: { ...opts.xiso, split: splitXisoCheckbox.checked },
			});
		});
	}

	const skipSystemUpdateCheckbox = document.getElementById(
		'default-extracted-skip-system-update',
	);
	if (skipSystemUpdateCheckbox instanceof HTMLInputElement) {
		skipSystemUpdateCheckbox.checked = settings.get(
			'defaultConversionOptions',
		).extracted.skipSystemUpdate;
		skipSystemUpdateCheckbox.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				extracted: {
					...opts.extracted,
					skipSystemUpdate: skipSystemUpdateCheckbox.checked,
				},
			});
		});
	}

	const allowedMediaPatchCheckbox = document.getElementById(
		'default-extracted-allowed-media-patch',
	);
	if (allowedMediaPatchCheckbox instanceof HTMLInputElement) {
		allowedMediaPatchCheckbox.checked = settings.get(
			'defaultConversionOptions',
		).extracted.allowedMediaPatch;
		allowedMediaPatchCheckbox.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				extracted: {
					...opts.extracted,
					allowedMediaPatch: allowedMediaPatchCheckbox.checked,
				},
			});
		});
	}

	const renameTitleCheckbox = document.getElementById(
		'default-extracted-rename-title',
	);
	if (renameTitleCheckbox instanceof HTMLInputElement) {
		renameTitleCheckbox.checked = settings.get(
			'defaultConversionOptions',
		).extracted.renameTitle;
		renameTitleCheckbox.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				extracted: {
					...opts.extracted,
					renameTitle: renameTitleCheckbox.checked,
				},
			});
		});
	}

	const cisoModeEl = document.getElementById('default-ciso-mode');
	if (cisoModeEl instanceof HTMLSelectElement) {
		cisoModeEl.value = settings.get('defaultConversionOptions').ciso.mode;
		cisoModeEl.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				ciso: {
					...opts.ciso,
					mode: /** @type {ScrubMode} */ (cisoModeEl.value),
				},
			});
		});
	}
	const cciModeEl = document.getElementById('default-cci-mode');
	if (cciModeEl instanceof HTMLSelectElement) {
		cciModeEl.value = settings.get('defaultConversionOptions').cci.mode;
		cciModeEl.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				cci: {
					...opts.cci,
					mode: /** @type {ScrubMode} */ (cciModeEl.value),
				},
			});
		});
	}

	const attachXbeCheckbox = document.getElementById('default-attach-xbe');
	if (attachXbeCheckbox instanceof HTMLInputElement) {
		attachXbeCheckbox.checked = settings.get(
			'defaultConversionOptions',
		).generateAttachXbe;
		attachXbeCheckbox.addEventListener('change', () => {
			const opts = settings.get('defaultConversionOptions');
			settings.set('defaultConversionOptions', {
				...opts,
				generateAttachXbe: attachXbeCheckbox.checked,
			});
		});
	}

	const maxConversionsInput = document.getElementById(
		'max-concurrent-conversions',
	);
	if (maxConversionsInput instanceof HTMLInputElement) {
		const stored = settings.get('maxConcurrentConversions');
		maxConversionsInput.value = stored != null ? String(stored) : '';

		// Same reasoning as the device ID field above: commit on input,
		// not just blur, so a drag-and-drop add can't read a stale value.
		const persistMaxConversions = () => {
			const raw = maxConversionsInput.value.trim();
			if (raw === '') {
				settings.set('maxConcurrentConversions', null);
			} else {
				settings.set(
					'maxConcurrentConversions',
					Math.max(1, Math.floor(Number(raw)) || 1),
				);
			}
			applyConcurrencySettings();
		};
		maxConversionsInput.addEventListener('input', persistMaxConversions);

		// Blur just normalizes what's displayed.
		maxConversionsInput.addEventListener('blur', () => {
			persistMaxConversions();
			const value = settings.get('maxConcurrentConversions');
			maxConversionsInput.value = value != null ? String(value) : '';
		});
	}

	const maxDownloadStreamsInput = document.getElementById(
		'max-concurrent-download-streams',
	);
	if (maxDownloadStreamsInput instanceof HTMLInputElement) {
		maxDownloadStreamsInput.value = String(
			settings.get('maxConcurrentDownloadStreams'),
		);

		const persistMaxDownloadStreams = () => {
			settings.set(
				'maxConcurrentDownloadStreams',
				Math.max(1, Math.floor(Number(maxDownloadStreamsInput.value)) || 1),
			);
			applyConcurrencySettings();
		};
		maxDownloadStreamsInput.addEventListener('input', persistMaxDownloadStreams);

		// Blur just normalizes what's displayed.
		maxDownloadStreamsInput.addEventListener('blur', () => {
			persistMaxDownloadStreams();
			maxDownloadStreamsInput.value = String(
				settings.get('maxConcurrentDownloadStreams'),
			);
		});
	}

	const headerAnimationCheckbox = document.getElementById('header-animation');
	if (headerAnimationCheckbox instanceof HTMLInputElement) {
		headerAnimationCheckbox.checked = settings.get('headerAnimation');
		headerAnimationCheckbox.addEventListener('change', () => {
			settings.set('headerAnimation', headerAnimationCheckbox.checked);
			applyHeaderAnimation();
		});
	}

	const faviconEnabledCheckbox = document.getElementById('favicon-enabled');
	const faviconPulseCheckbox = document.getElementById(
		'favicon-pulse-animation',
	);
	if (faviconEnabledCheckbox instanceof HTMLInputElement) {
		faviconEnabledCheckbox.checked = settings.get('faviconEnabled');
		if (faviconPulseCheckbox instanceof HTMLInputElement) {
			faviconPulseCheckbox.disabled = !faviconEnabledCheckbox.checked;
		}
		faviconEnabledCheckbox.addEventListener('change', () => {
			settings.set('faviconEnabled', faviconEnabledCheckbox.checked);
			if (faviconPulseCheckbox instanceof HTMLInputElement) {
				faviconPulseCheckbox.disabled = !faviconEnabledCheckbox.checked;
			}
			applyFaviconSettings();
		});
	}

	if (faviconPulseCheckbox instanceof HTMLInputElement) {
		faviconPulseCheckbox.checked = settings.get('faviconPulseAnimation');
		faviconPulseCheckbox.addEventListener('change', () => {
			settings.set('faviconPulseAnimation', faviconPulseCheckbox.checked);
			applyFaviconSettings();
		});
	}

	const badgeEnabledCheckbox = document.getElementById('badge-enabled');
	if (badgeEnabledCheckbox instanceof HTMLInputElement) {
		badgeEnabledCheckbox.checked = settings.get('badgeEnabled');
		badgeEnabledCheckbox.addEventListener('change', () => {
			settings.set('badgeEnabled', badgeEnabledCheckbox.checked);
			applyBadgeSettings();
		});
	}
}
