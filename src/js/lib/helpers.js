/**
 * @import { FeatureCheck } from '../../types/global'
 */

import { TEXT } from '../constants/messages';
import { PUBLIC_PATH } from './publicPath';

/** @type {FeatureCheck} */
export const checkWebWorkers = async () => {
	const ok = typeof Worker !== 'undefined';
	return {
		status: ok ? 'available' : 'not-available',
		text: ok ? TEXT.FEATURE_STATUS_AVAILABLE : TEXT.FEATURE_STATUS_NOT_SUPPORTED,
	};
};

/**
 * Collapses `.`/`..` segments and duplicate slashes in a POSIX-style
 * relative path. Defensive only - a native webkitRelativePath never
 * contains these.
 * @param {string} path
 * @returns {string}
 */
function normalizePathSegments(path) {
	const out = [];
	for (const seg of path.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.join('/');
}

/**
 * Repairs Android's corrupted `webkitRelativePath` for folders picked
 * through `<input webkitdirectory>`. Chromium-on-Android leaks its
 * internal `content://.../tree/<id>/document/<id>` URI shape into the
 * path, e.g. "primary:Download/json/document/primary:Download/json/track.png"
 * instead of "json/track.png". Splitting on "/document/" and stripping
 * the duplicated prefix recovers the real path. Anything that doesn't
 * match this shape (desktop paths, Firefox-Android/iOS's always-empty
 * paths) is returned unchanged.
 * @param {string} rawPath
 * @returns {string}
 */
export function decodeAndroidSafPath(rawPath) {
	if (typeof rawPath !== 'string' || rawPath === '') return rawPath;

	// Cheap pre-check so real desktop paths skip the rest of this function.
	const looksLikeSaf = /\/document\//.test(rawPath) || /%2F|%3A/i.test(rawPath);
	if (!looksLikeSaf) return rawPath;

	let path = rawPath;
	if (/%[0-9a-fA-F]{2}/.test(path)) {
		try {
			path = decodeURIComponent(path);
		} catch {
			return rawPath; // Malformed percent-escape.
		}
	}

	path = path.replace(/^tree\//, '');

	const marker = '/document/';
	const markerIndex = path.indexOf(marker);
	if (markerIndex === -1) return rawPath;

	const rawTree = path.slice(0, markerIndex);
	const rawDoc = path.slice(markerIndex + marker.length);

	// Both sides need a SAF `<volume>:` prefix (e.g. "primary:") before
	// any slash. That's what tells the corrupted shape apart from an
	// ordinary path that just happens to have a folder named "document".
	const volumePrefix = /^[^/]+:/;
	if (!volumePrefix.test(rawTree) || !volumePrefix.test(rawDoc)) return rawPath;

	const stripVolumePrefix = (/** @type {string} */ segment) =>
		segment.replace(volumePrefix, '');

	const treePath = stripVolumePrefix(rawTree);
	const docPath = stripVolumePrefix(rawDoc);
	if (treePath === '' || docPath === '') return rawPath;

	// docPath must start with treePath, or we can't safely recover it.
	if (!docPath.startsWith(`${treePath}/`)) return rawPath;

	const relative = docPath.slice(treePath.length + 1);
	if (relative === '') return rawPath;

	const rootName = treePath.split('/').filter(Boolean).pop();
	if (!rootName) return rawPath;

	return `${rootName}/${relative}`;
}

/**
 * Strips the shared top-level folder name from each file's
 * webkitRelativePath, e.g. "MyGame/default.xex" -> "default.xex",
 * since detectDirFormat/resolveBatchEntry expect paths relative to
 * the dropped folder itself. Repairs Android's SAF path corruption
 * first (see decodeAndroidSafPath). Browsers that report an
 * always-empty webkitRelativePath (Firefox for Android pre-142,
 * iOS/iPadOS) fall back to `f.name`, degrading to loose files.
 * @param {FileList | File[]} fileList
 * @returns {{ dirName: string, entries: string[], files: File[] }}
 */
export function relativeDirEntries(fileList) {
	const files = Array.from(fileList);
	const paths = files.map((f) =>
		normalizePathSegments(
			decodeAndroidSafPath((f.webkitRelativePath || f.name).replace(/\\/g, '/')),
		),
	);
	const root = paths[0]?.split('/')[0] ?? '';
	const shared = root !== '' && paths.every((p) => p.startsWith(`${root}/`));
	const entries = shared ? paths.map((p) => p.slice(root.length + 1)) : paths;
	return { dirName: shared ? root : '', entries, files };
}

/** @type {FeatureCheck} */
export const checkServiceWorker = async () => {
	if (!('serviceWorker' in navigator)) {
		return { status: 'not-available', text: TEXT.FEATURE_STATUS_NOT_SUPPORTED };
	}

	const reg = await navigator.serviceWorker.getRegistration(
		`${PUBLIC_PATH}/sw.js`,
	);

	if (!reg) {
		return { status: 'warn', text: TEXT.SW_NOT_REGISTERED };
	}

	if (reg.active) {
		if (!navigator.serviceWorker.controller) {
			return { status: 'warn', text: TEXT.SW_ACTIVE_UNCONTROLLED };
		}
		return { status: 'available', text: TEXT.SW_RUNNING };
	}

	if (reg.installing) {
		return { status: 'warn', text: TEXT.SW_INSTALLING };
	}

	if (reg.waiting) {
		return { status: 'warn', text: TEXT.SW_WAITING_TO_ACTIVATE };
	}

	return { status: 'warn', text: TEXT.SW_REGISTERED_NOT_ACTIVE };
};

/**
 * Wires a clearable input button.
 *
 * @param {HTMLInputElement} input
 * @param {HTMLButtonElement} clearBtn
 * @param {() => void} [onClear] Called after the value is cleared.
 */
export function initClearableInput(input, clearBtn, onClear) {
	const sync = () => {
		clearBtn.hidden = input.value.length === 0;
	};

	sync();
	input.addEventListener('input', sync);

	clearBtn.addEventListener('mousedown', (e) => e.preventDefault()); // Keep focus on input.

	clearBtn.addEventListener('click', () => {
		input.value = '';

		input.dispatchEvent(new Event('input', { bubbles: true }));
		onClear?.();
	});
}

/** @type {FeatureCheck} */
export const checkWebAssembly = async () => {
	const ok = typeof WebAssembly === 'object';
	return {
		status: ok ? 'available' : 'not-available',
		text: ok ? TEXT.FEATURE_STATUS_AVAILABLE : TEXT.FEATURE_STATUS_NOT_SUPPORTED,
	};
};

/** @returns {boolean} */
export function supportsBadging() {
	return typeof navigator !== 'undefined' && 'setAppBadge' in navigator;
}

/** @type {FeatureCheck} */
export const checkBadging = async () => {
	const ok = supportsBadging();
	return {
		status: ok ? 'available' : 'not-available',
		text: ok ? TEXT.FEATURE_STATUS_AVAILABLE : TEXT.FEATURE_STATUS_NOT_SUPPORTED,
	};
};

/** @type {FeatureCheck} */
export const checkWakeLock = async () => {
	const ok = 'wakeLock' in navigator;
	return {
		status: ok ? 'available' : 'not-available',
		text: ok ? TEXT.FEATURE_STATUS_AVAILABLE : TEXT.FEATURE_STATUS_NOT_SUPPORTED,
	};
};

/** @returns {boolean} */
export function supportsNotifications() {
	return typeof window !== 'undefined' && 'Notification' in window;
}

/** @type {FeatureCheck} */
export const checkNotifications = async () => {
	const supported = supportsNotifications();

	if (!supported) {
		return {
			status: 'not-available',
			text: TEXT.FEATURE_STATUS_NOT_SUPPORTED,
		};
	}

	const permission = Notification.permission;

	switch (permission) {
		case 'granted':
			return {
				status: 'available',
				text: TEXT.NOTIFICATIONS_PERMISSION_GRANTED,
			};

		case 'denied':
			return {
				status: 'not-available',
				text: TEXT.NOTIFICATIONS_PERMISSION_DENIED,
			};

		default:
			return {
				status: 'warn',
				text: TEXT.NOTIFICATIONS_PERMISSION_NOT_GRANTED,
			};
	}
};

/**
 * Whether the document is currently hidden or unfocused - the "tab
 * isn't being looked at" state used to gate terminal-state indicators
 * (favicon, badge) until the user actually sees them.
 * @returns {boolean}
 */
export function isTabUnseen() {
	return document.hidden || !document.hasFocus();
}

/**
 * @returns {boolean} Whether `<input webkitdirectory>` is supported
 * - i.e. whether it will actually open a directory picker.
 */
export function supportsFolderInput() {
	return 'webkitdirectory' in document.createElement('input');
}

/**
 * Populates a file input with a synthetic File built from raw bytes.
 * DataTransfer is the only script-accessible way to populate
 * `input.files`; it can't be assigned directly.
 *
 * @param {HTMLInputElement} input
 * @param {Uint8Array<ArrayBufferLike>} bytes - Raw file contents.
 * @param {string} name
 * @param {string} [mimeType=''] - Pass the original file's type when
 *   known so downstream `.type` checks behave like a real file pick.
 * @returns {void}
 */
export function setFileInputFromBytes(input, bytes, name, mimeType = '') {
	const safeBytes = new Uint8Array(bytes);
	const file = new File([safeBytes], name, { type: mimeType });
	const dt = new DataTransfer();
	dt.items.add(file);
	input.files = dt.files;
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** @type {FeatureCheck} */
export const checkFolderInput = async () => {
	const ok = supportsFolderInput();
	return {
		status: ok ? 'available' : 'not-available',
		text: ok ? TEXT.FEATURE_STATUS_AVAILABLE : TEXT.FEATURE_STATUS_NOT_SUPPORTED,
	};
};

export const requestNotificationPermission = async () => {
	if (!supportsNotifications()) return 'denied';
	if (Notification.permission === 'granted') return 'granted';
	if (Notification.permission === 'denied') return 'denied';

	return Notification.requestPermission();
};

/**
 * @param {string} value
 * @returns {string}
 */
export function stripWhitespace(value) {
	return value.replace(/\s+/g, '');
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
		throw new Error(`invalid hex string: ${hex}`);
	}
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * Parses a hex Device ID string into bytes. STFS header field at
 * offset 0x3FD, 20 bytes, ties the package to one storage device.
 * @param {string | undefined} hex
 * @returns {Uint8Array | undefined}
 */
export function parseDeviceId(hex) {
	const stripped = stripWhitespace(hex ?? '').trim();
	if (stripped === '') return undefined;

	if (stripped.length !== 40) {
		throw new Error(TEXT.DEVICE_ID_INVALID_LENGTH(stripped.length));
	}
	if (!/^[0-9a-fA-F]{40}$/.test(stripped)) {
		throw new Error(TEXT.DEVICE_ID_INVALID_CHARS);
	}

	return hexToBytes(stripped);
}

/**
 * @template {Element} T
 * @param {ParentNode}      parent
 * @param {string}          selector
 * @param {new() => T}      Type
 * @returns {T}
 */
export function queryElement(parent, selector, Type) {
	const el = parent.querySelector(selector);
	if (!(el instanceof Type)) throw new Error(`Missing element: ${selector}`);
	return el;
}

/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID
 * @returns {string}
 */
export const generateUUID = () => {
	return crypto.randomUUID();
};

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export const copyToClipboard = async (text) => {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to execCommand fallback.
		}
	}

	try {
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(textarea);
		return ok;
	} catch {
		return false;
	}
};

/**
 * @param {string} base
 * @param {number} [percent]
 */
export function formatTitle(base, percent) {
	return percent !== undefined ? `[${percent}%] ${base}` : base;
}

/**
 * @returns {boolean} Whether the user prefers reduced motion.
 */
export const prefersReducedMotion = () =>
	typeof window !== 'undefined' &&
	window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Swaps `array[idx]` with its `idx + direction` neighbor, in place.
 * @param {unknown[]} array
 * @param {number} idx
 * @param {1 | -1} direction
 * @returns {boolean} whether the swap happened (false if out of bounds)
 */
export function swapAdjacent(array, idx, direction) {
	const newIdx = idx + direction;
	if (newIdx < 0 || newIdx >= array.length) return false;
	[array[idx], array[newIdx]] = [array[newIdx], array[idx]];
	return true;
}

/**
 * Yields to the browser's main-thread scheduler so queued input/paint
 * work can run before the caller's next synchronous chunk starts.
 * Prefers `scheduler.yield()` (schedules the continuation as a
 * prioritized task ahead of unrelated new work); falls back to
 * `setTimeout(0)` where it's unavailable, since a bare microtask
 * (`Promise.resolve()`) never actually hands control back to the
 * browser between two synchronous chunks. Works in both windows and
 * workers - `scheduler` is available in both contexts.
 * @returns {Promise<void>}
 */
export function yieldToMain() {
	if (
		typeof scheduler !== 'undefined' &&
		typeof scheduler.yield === 'function'
	) {
		return scheduler.yield();
	}
	return new Promise((resolve) => setTimeout(resolve, 0));
}
