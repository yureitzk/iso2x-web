import { EVENTS } from '../core/protocol.js';
import {
	checkServiceWorker,
	checkWebAssembly,
	checkWebWorkers,
	checkNotifications,
	checkWakeLock,
	checkFolderInput,
	checkBadging,
} from '../lib/helpers.js';
import { createLogger } from '../lib/logger.js';
import { settings, checkMultiFileDownloads } from '../lib/settings.js';
import { notify } from '../lib/notify.js';
import { TEXT } from '../constants/messages.js';

/**
 * @import { Feature } from '../../types/global'
 * @import { SwBridge } from '../serviceWorker/controller/SwBridge.js'
 */

const log = createLogger('features');

/** @type {SwBridge | null} */
let _swBridge = null;

/** @param {SwBridge} swBridge */
export function setFeaturesSwBridge(swBridge) {
	_swBridge = swBridge;
}

async function enableMultiFileDownloads() {
	if (!_swBridge) {
		log.error('enableMultiFileDownloads called before setFeaturesSwBridge()');
		notify('error', TEXT.MULTI_FILE_DOWNLOADS_NOTIFY_TITLE);
		return;
	}
	try {
		await _swBridge.primeMultiDownloadPermission();
		settings.set('multiFileDownloadsPrimed', true);
	} catch (e) {
		log.warn('Failed to prime multi-file downloads', e);
		notify('error', TEXT.MULTI_FILE_DOWNLOADS_NOTIFY_TITLE);
	}
	window.dispatchEvent(new Event(EVENTS.FEATURE_CHANGED));
}

/** @type {Array<Feature>} */
const FEATURES = [
	{ label: TEXT.FEATURE_LABEL_WEB_WORKERS, check: checkWebWorkers },
	{ label: TEXT.FEATURE_LABEL_SERVICE_WORKER, check: checkServiceWorker },
	{ label: TEXT.FEATURE_LABEL_WEBASSEMBLY, check: checkWebAssembly },
	{ label: TEXT.FEATURE_LABEL_WEBKITDIRECTORY, check: checkFolderInput },
	{
		label: TEXT.FEATURE_LABEL_MULTI_FILE_DOWNLOADS,
		check: checkMultiFileDownloads,
		action: {
			label: (status) =>
				status === 'available' ? TEXT.FEATURE_RECHECK : TEXT.FEATURE_CHECK,
			onClick: enableMultiFileDownloads,
		},
	},
	{ label: TEXT.FEATURE_LABEL_NOTIFICATIONS, check: checkNotifications },
	{ label: TEXT.FEATURE_LABEL_SCREEN_WAKE_LOCK, check: checkWakeLock },
	{ label: TEXT.FEATURE_LABEL_BADGING_API, check: checkBadging },
];

export async function initFeatures() {
	const featureList = document.getElementById('feature-list');
	const template = document.getElementById('feature-item-template');
	if (
		!(featureList instanceof HTMLElement) ||
		!(template instanceof HTMLTemplateElement)
	)
		return;

	const results = await Promise.all(
		FEATURES.map(async (row) => {
			try {
				return { label: row.label, action: row.action, ...(await row.check()) };
			} catch (e) {
				log.warn(`Feature check failed: ${row.label}`, e);
				return {
					label: row.label,
					action: row.action,
					status: 'not-available',
					text: TEXT.FEATURE_CHECK_ERROR,
				};
			}
		}),
	);

	/** @param {HTMLElement} li @param {Feature['action']} [action] @param {string} [status] */
	function bindAction(li, action, status) {
		const btn = li.querySelector('.feature-action');
		if (!(btn instanceof HTMLButtonElement)) return;
		if (!action) {
			btn.hidden = true;
			return;
		}
		btn.hidden = false;
		btn.textContent =
			typeof action.label === 'function'
				? action.label(status ?? '')
				: action.label;
		btn.onclick = async () => {
			btn.disabled = true;
			try {
				await action.onClick();
			} finally {
				btn.disabled = false;
			}
		};
	}

	const existingItems = featureList.querySelectorAll('li');

	if (existingItems.length !== results.length) {
		const fragment = document.createDocumentFragment();
		for (const { label, status, text, action } of results) {
			const item = /** @type {DocumentFragment} */ (
				template.content.cloneNode(true)
			);
			const labelSpan = item.querySelector('.feature-label');
			if (labelSpan) labelSpan.textContent = `${label}: `;
			const statusSpan = item.querySelector('.feature-status');
			if (statusSpan) {
				statusSpan.textContent = text;
				statusSpan.classList.add(`feature-${status}`);
			}
			const li = item.querySelector('li');
			if (li instanceof HTMLElement) bindAction(li, action, status);
			fragment.appendChild(item);
		}
		featureList.replaceChildren(fragment);
	} else {
		results.forEach(({ status, text, action }, i) => {
			const li = existingItems[i];
			const statusSpan = li.querySelector('.feature-status');
			if (statusSpan) {
				statusSpan.textContent = text;
				statusSpan.className = `feature-status feature-${status}`;
			}
			bindAction(li, action, status);
		});
	}
}

window.addEventListener(EVENTS.FEATURE_CHANGED, initFeatures);
