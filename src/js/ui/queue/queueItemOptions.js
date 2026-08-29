import { parseDeviceId } from '../../lib/helpers.js';
import { settings } from '../../lib/settings.js';

/**
 * @import { QueueEntry, OutputFormat } from '../../../types/global'
 */

/**
 * @param {HTMLElement} optionsEl
 * @param {OutputFormat} format
 */
export function updateOptionsVisibility(optionsEl, format) {
	let anyVisible = false;
	for (const el of Array.from(optionsEl.querySelectorAll('[data-formats]'))) {
		if (!(el instanceof HTMLElement)) continue;
		const formats = el.dataset.formats?.split(' ') ?? [];
		const visible = formats.includes(format);
		el.hidden = !visible;
		if (visible) anyVisible = true;
	}
	optionsEl.hidden = !anyVisible;
}

/**
 * Disables and clears "Allowed Media Patch" / "Rename XBE Title" for
 * any source that isn't Xbox Original - those options only affect the
 * `extracted` target's default.xbe.
 * @param {QueueEntry} item
 */
export function applyXbePatchConstraints(item) {
	const relevant = item.sourceIsOgx === true;
	item.allowedMediaPatchCheckBoxEl.disabled = !relevant;
	item.renameTitleCheckBoxEl.disabled = !relevant;
	// sourceIsOgx is undefined until inspection resolves; only clear
	// checkboxes once non-OGX is confirmed, not while still unknown.
	if (item.sourceIsOgx === false) {
		item.allowedMediaPatchCheckBoxEl.checked = false;
		item.renameTitleCheckBoxEl.checked = false;
		item.options.extracted.allowedMediaPatch = false;
		item.options.extracted.renameTitle = false;
	}
}

/**
 * Disables and clears "Generate Attach XBE" unless the source is a
 * confirmed Xbox Original and the target format can't boot an OGX
 * container directly from a softmod dashboard (xiso/ciso/cci).
 * @param {QueueEntry} item
 */
export function applyAttachXbeConstraint(item) {
	const canAttach =
		item.sourceIsOgx === true &&
		(item.options.format === 'xiso' ||
			item.options.format === 'ciso' ||
			item.options.format === 'cci');
	const wasDisabled = item.attachXbeCheckBoxEl.disabled;
	item.attachXbeCheckBoxEl.disabled = !canAttach;

	if (canAttach) {
		if (wasDisabled) {
			item.attachXbeCheckBoxEl.checked = item.options.generateAttachXbe;
			item.generateAttachXbe = item.options.generateAttachXbe;
		}
		return;
	}

	if (item.sourceIsOgx === undefined) return;

	item.attachXbeCheckBoxEl.checked = false;
	item.generateAttachXbe = false;
}

/**
 * Enables "Console-sign (CON)" only when this item actually has a
 * keyvault (item.godSigningKey - seeded from the ephemeral default,
 * replaceable via godKeyvaultInputEl) and the source is eligible
 * (console-signing is rejected server-side for OGX/XboxOriginal
 * sources - only GamesOnDemand/XEX sources can be signed).
 * @param {QueueEntry} item
 */
export function applyGodSigningConstraints(item) {
	const ogxSource = item.sourceIsOgx === true;
	item.godKeyvaultInputEl.disabled = ogxSource;

	const canSign = !!item.godSigningKey && !ogxSource;
	const wasDisabled = item.godSignCheckBoxEl.disabled;
	item.godSignCheckBoxEl.disabled = !canSign;

	if (canSign) {
		if (wasDisabled) {
			const defaultSign = settings.get('defaultConversionOptions').god.sign;
			item.godSignCheckBoxEl.checked = defaultSign;
			item.options.god.sign = defaultSign;
		}
		return;
	}

	item.godSignCheckBoxEl.checked = false;
	item.options.god.sign = false;
}

/**
 * Whether item's current Device ID input is either empty or a valid
 * 40-char hex string.
 * @param {QueueEntry} item
 * @returns {boolean}
 */
export function isGodDeviceIdValid(item) {
	try {
		parseDeviceId(item.godDeviceIdInputEl.value);
		return true;
	} catch {
		return false;
	}
}
