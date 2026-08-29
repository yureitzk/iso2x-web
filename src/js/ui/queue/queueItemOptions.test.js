import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	applyGodSigningConstraints,
	applyXbePatchConstraints,
	applyAttachXbeConstraint,
	isGodDeviceIdValid,
} from './queueItemOptions.js';
import { settings } from '../../lib/settings.js';
import { stubItem } from '../../../../test/utils/queueTestHelpers.js';

/**
 * @import { OutputFormat } from '../../../types/global'
 */

const { settings: mockSettings } = await vi.hoisted(async () => {
	const { createMockSettings } =
		await import('../../../../test/utils/settingsMock.js');
	return createMockSettings();
});
vi.mock('../../lib/settings.js', () => ({ settings: mockSettings }));

/**
 * @param {{
 *   sourceIsOgx?: boolean,
 *   godSigningKey?: Uint8Array,
 *   keyvaultDisabled?: boolean,
 *   checkboxDisabled?: boolean,
 *   checkboxChecked?: boolean,
 *   sign?: boolean,
 * }} [opts]
 */
function godItem({
	sourceIsOgx = undefined,
	godSigningKey = undefined,
	keyvaultDisabled = false,
	checkboxDisabled = true,
	checkboxChecked = false,
	sign = false,
} = {}) {
	return stubItem({
		sourceIsOgx,
		godSigningKey,
		godKeyvaultInputEl: { disabled: keyvaultDisabled },
		godSignCheckBoxEl: { disabled: checkboxDisabled, checked: checkboxChecked },
		options: { god: { sign } },
	});
}

/** @param {boolean} value */
function setDefaultGodSign(value) {
	const current = settings.get('defaultConversionOptions');
	settings.set('defaultConversionOptions', {
		...current,
		god: { ...current.god, sign: value },
	});
}

describe('applyGodSigningConstraints', () => {
	beforeEach(() => {
		settings.reset();
	});

	describe('keyvault input disabled state', () => {
		it('disables the keyvault input for a confirmed OGX source', () => {
			const item = godItem({ sourceIsOgx: true });
			applyGodSigningConstraints(item);
			expect(item.godKeyvaultInputEl.disabled).toBe(true);
		});

		it('enables the keyvault input for a confirmed non-OGX source', () => {
			const item = godItem({ sourceIsOgx: false });
			applyGodSigningConstraints(item);
			expect(item.godKeyvaultInputEl.disabled).toBe(false);
		});

		// undefined === true is false, so pre-inspection must take the
		// non-OGX branch, not the OGX one.
		it('enables the keyvault input while sourceIsOgx is still unresolved (pre-inspection)', () => {
			const item = godItem({ sourceIsOgx: undefined });
			applyGodSigningConstraints(item);
			expect(item.godKeyvaultInputEl.disabled).toBe(false);
		});
	});

	describe('checkbox: no keyvault present', () => {
		it('disables and clears the checkbox', () => {
			const item = godItem({ sourceIsOgx: false, godSigningKey: undefined });
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.disabled).toBe(true);
			expect(item.godSignCheckBoxEl.checked).toBe(false);
			expect(item.options.god.sign).toBe(false);
		});
	});

	describe('checkbox: OGX gate', () => {
		it('keeps the checkbox disabled and clears it even when a keyvault is present', () => {
			const item = godItem({
				sourceIsOgx: true,
				godSigningKey: new Uint8Array(8),
			});
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.disabled).toBe(true);
			expect(item.godSignCheckBoxEl.checked).toBe(false);
			expect(item.options.god.sign).toBe(false);
		});
	});

	describe('checkbox: disabled -> enabled reapplies the current default', () => {
		it('checks the box when the default is true', () => {
			setDefaultGodSign(true);
			const item = godItem({
				sourceIsOgx: false,
				godSigningKey: new Uint8Array(8),
				checkboxDisabled: true,
				checkboxChecked: false,
			});
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.disabled).toBe(false);
			expect(item.godSignCheckBoxEl.checked).toBe(true);
			expect(item.options.god.sign).toBe(true);
		});

		it('leaves the box unchecked when the default is false', () => {
			setDefaultGodSign(false);
			const item = godItem({
				sourceIsOgx: false,
				godSigningKey: new Uint8Array(8),
				checkboxDisabled: true,
				checkboxChecked: false,
			});
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.disabled).toBe(false);
			expect(item.godSignCheckBoxEl.checked).toBe(false);
			expect(item.options.god.sign).toBe(false);
		});
	});

	describe('checkbox: already enabled - manual choice is not overwritten', () => {
		it('leaves a manually-checked box checked, even though the default is false', () => {
			setDefaultGodSign(false);
			const item = godItem({
				sourceIsOgx: false,
				godSigningKey: new Uint8Array(8),
				checkboxDisabled: false,
				checkboxChecked: true,
				sign: true,
			});
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.checked).toBe(true);
			expect(item.options.god.sign).toBe(true);
		});

		it('leaves a manually-unchecked box unchecked, even though the default is true', () => {
			setDefaultGodSign(true);
			const item = godItem({
				sourceIsOgx: false,
				godSigningKey: new Uint8Array(8),
				checkboxDisabled: false,
				checkboxChecked: false,
				sign: false,
			});
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.checked).toBe(false);
			expect(item.options.god.sign).toBe(false);
		});
	});

	describe('checkbox: enabled -> disabled clears regardless of manual state', () => {
		it('clears an enabled+checked box once the keyvault is removed', () => {
			const item = godItem({
				sourceIsOgx: false,
				godSigningKey: undefined,
				checkboxDisabled: false,
				checkboxChecked: true,
				sign: true,
			});
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.disabled).toBe(true);
			expect(item.godSignCheckBoxEl.checked).toBe(false);
			expect(item.options.god.sign).toBe(false);
		});

		it('clears an enabled+checked box once sourceIsOgx resolves true', () => {
			const item = godItem({
				sourceIsOgx: true,
				godSigningKey: new Uint8Array(8),
				checkboxDisabled: false,
				checkboxChecked: true,
				sign: true,
			});
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.disabled).toBe(true);
			expect(item.godSignCheckBoxEl.checked).toBe(false);
			expect(item.options.god.sign).toBe(false);
		});
	});

	describe('idempotency', () => {
		it('a later default change does not retroactively re-check an already-eligible box', () => {
			setDefaultGodSign(true);
			const item = godItem({
				sourceIsOgx: false,
				godSigningKey: new Uint8Array(8),
				checkboxDisabled: true,
				checkboxChecked: false,
			});
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.checked).toBe(true);

			setDefaultGodSign(false);
			applyGodSigningConstraints(item);
			expect(item.godSignCheckBoxEl.checked).toBe(true);
			expect(item.options.god.sign).toBe(true);
		});
	});
});

/**
 * @param {{
 *   sourceIsOgx?: boolean,
 *   allowedMediaPatchDisabled?: boolean,
 *   allowedMediaPatchChecked?: boolean,
 *   renameTitleDisabled?: boolean,
 *   renameTitleChecked?: boolean,
 *   allowedMediaPatch?: boolean,
 *   renameTitle?: boolean,
 * }} [opts]
 */
function xbePatchItem({
	sourceIsOgx = undefined,
	allowedMediaPatchDisabled = false,
	allowedMediaPatchChecked = false,
	renameTitleDisabled = false,
	renameTitleChecked = false,
	allowedMediaPatch = false,
	renameTitle = false,
} = {}) {
	return stubItem({
		sourceIsOgx,
		allowedMediaPatchCheckBoxEl: {
			disabled: allowedMediaPatchDisabled,
			checked: allowedMediaPatchChecked,
		},
		renameTitleCheckBoxEl: {
			disabled: renameTitleDisabled,
			checked: renameTitleChecked,
		},
		options: { extracted: { allowedMediaPatch, renameTitle } },
	});
}

describe('applyXbePatchConstraints', () => {
	describe('disabled state', () => {
		it('enables both checkboxes for a confirmed OGX source', () => {
			const item = xbePatchItem({ sourceIsOgx: true });
			applyXbePatchConstraints(item);
			expect(item.allowedMediaPatchCheckBoxEl.disabled).toBe(false);
			expect(item.renameTitleCheckBoxEl.disabled).toBe(false);
		});

		it('disables both checkboxes for a confirmed non-OGX source', () => {
			const item = xbePatchItem({ sourceIsOgx: false });
			applyXbePatchConstraints(item);
			expect(item.allowedMediaPatchCheckBoxEl.disabled).toBe(true);
			expect(item.renameTitleCheckBoxEl.disabled).toBe(true);
		});

		it('disables both checkboxes while sourceIsOgx is still unresolved (pre-inspection)', () => {
			const item = xbePatchItem({ sourceIsOgx: undefined });
			applyXbePatchConstraints(item);
			expect(item.allowedMediaPatchCheckBoxEl.disabled).toBe(true);
			expect(item.renameTitleCheckBoxEl.disabled).toBe(true);
		});
	});

	describe('clearing only fires on a *confirmed* non-OGX source', () => {
		it('leaves a checked/set state untouched while sourceIsOgx is still unresolved', () => {
			const item = xbePatchItem({
				sourceIsOgx: undefined,
				allowedMediaPatchChecked: true,
				renameTitleChecked: true,
				allowedMediaPatch: true,
				renameTitle: true,
			});
			applyXbePatchConstraints(item);
			expect(item.allowedMediaPatchCheckBoxEl.checked).toBe(true);
			expect(item.renameTitleCheckBoxEl.checked).toBe(true);
			expect(item.options.extracted.allowedMediaPatch).toBe(true);
			expect(item.options.extracted.renameTitle).toBe(true);
		});

		it('clears a checked/set state once sourceIsOgx resolves false', () => {
			const item = xbePatchItem({
				sourceIsOgx: false,
				allowedMediaPatchChecked: true,
				renameTitleChecked: true,
				allowedMediaPatch: true,
				renameTitle: true,
			});
			applyXbePatchConstraints(item);
			expect(item.allowedMediaPatchCheckBoxEl.checked).toBe(false);
			expect(item.renameTitleCheckBoxEl.checked).toBe(false);
			expect(item.options.extracted.allowedMediaPatch).toBe(false);
			expect(item.options.extracted.renameTitle).toBe(false);
		});

		it('leaves a checked/set state untouched for a confirmed OGX source', () => {
			const item = xbePatchItem({
				sourceIsOgx: true,
				allowedMediaPatchChecked: true,
				renameTitleChecked: true,
				allowedMediaPatch: true,
				renameTitle: true,
			});
			applyXbePatchConstraints(item);
			expect(item.allowedMediaPatchCheckBoxEl.checked).toBe(true);
			expect(item.renameTitleCheckBoxEl.checked).toBe(true);
			expect(item.options.extracted.allowedMediaPatch).toBe(true);
			expect(item.options.extracted.renameTitle).toBe(true);
		});
	});

	describe('idempotency', () => {
		it('repeated calls on a confirmed OGX source keep re-enabling without clearing', () => {
			const item = xbePatchItem({
				sourceIsOgx: true,
				allowedMediaPatchChecked: true,
				renameTitleChecked: true,
				allowedMediaPatch: true,
				renameTitle: true,
			});
			applyXbePatchConstraints(item);
			applyXbePatchConstraints(item);
			expect(item.allowedMediaPatchCheckBoxEl.disabled).toBe(false);
			expect(item.allowedMediaPatchCheckBoxEl.checked).toBe(true);
			expect(item.options.extracted.allowedMediaPatch).toBe(true);
		});
	});
});

/**
 * @param {{
 *   sourceIsOgx?: boolean,
 *   format?: OutputFormat,
 *   checkboxDisabled?: boolean,
 *   checkboxChecked?: boolean,
 *   itemGenerateAttachXbe?: boolean,
 *   optionsGenerateAttachXbe?: boolean,
 * }} [opts]
 */
function attachXbeItem({
	sourceIsOgx = undefined,
	format = /** @type {OutputFormat} */ ('xiso'),
	checkboxDisabled = true,
	checkboxChecked = false,
	itemGenerateAttachXbe = false,
	optionsGenerateAttachXbe = false,
} = {}) {
	return stubItem({
		sourceIsOgx,
		generateAttachXbe: itemGenerateAttachXbe,
		attachXbeCheckBoxEl: { disabled: checkboxDisabled, checked: checkboxChecked },
		options: { format, generateAttachXbe: optionsGenerateAttachXbe },
	});
}

describe('applyAttachXbeConstraint', () => {
	describe('checkbox disabled state (canAttach gate)', () => {
		it('enables the checkbox for a confirmed OGX source targeting xiso', () => {
			const item = attachXbeItem({ sourceIsOgx: true, format: 'xiso' });
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(false);
		});

		it('enables the checkbox for a confirmed OGX source targeting ciso', () => {
			const item = attachXbeItem({ sourceIsOgx: true, format: 'ciso' });
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(false);
		});

		it('enables the checkbox for a confirmed OGX source targeting cci', () => {
			const item = attachXbeItem({ sourceIsOgx: true, format: 'cci' });
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(false);
		});

		it('disables the checkbox for a confirmed OGX source targeting a format that can boot OGX directly (god)', () => {
			const item = attachXbeItem({ sourceIsOgx: true, format: 'god' });
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(true);
		});

		it('disables the checkbox for a confirmed OGX source targeting extracted', () => {
			const item = attachXbeItem({ sourceIsOgx: true, format: 'extracted' });
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(true);
		});

		it('disables the checkbox for a confirmed non-OGX source, even on an eligible target format', () => {
			const item = attachXbeItem({ sourceIsOgx: false, format: 'xiso' });
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(true);
		});

		it('disables the checkbox while sourceIsOgx is still unresolved (pre-inspection)', () => {
			const item = attachXbeItem({ sourceIsOgx: undefined, format: 'xiso' });
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(true);
		});
	});

	describe("checkbox: disabled -> enabled reapplies the item's current options.generateAttachXbe", () => {
		it('checks the box when options.generateAttachXbe is true', () => {
			const item = attachXbeItem({
				sourceIsOgx: true,
				format: 'xiso',
				checkboxDisabled: true,
				checkboxChecked: false,
				optionsGenerateAttachXbe: true,
			});
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(false);
			expect(item.attachXbeCheckBoxEl.checked).toBe(true);
			expect(item.generateAttachXbe).toBe(true);
		});

		it('leaves the box unchecked when options.generateAttachXbe is false', () => {
			const item = attachXbeItem({
				sourceIsOgx: true,
				format: 'xiso',
				checkboxDisabled: true,
				checkboxChecked: false,
				optionsGenerateAttachXbe: false,
			});
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(false);
			expect(item.attachXbeCheckBoxEl.checked).toBe(false);
			expect(item.generateAttachXbe).toBe(false);
		});
	});

	describe('checkbox: already enabled - manual choice is not overwritten', () => {
		it('leaves a manually-checked box checked, even though options.generateAttachXbe is false', () => {
			const item = attachXbeItem({
				sourceIsOgx: true,
				format: 'xiso',
				checkboxDisabled: false,
				checkboxChecked: true,
				itemGenerateAttachXbe: true,
				optionsGenerateAttachXbe: false,
			});
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.checked).toBe(true);
			expect(item.generateAttachXbe).toBe(true);
		});

		it('leaves a manually-unchecked box unchecked, even though options.generateAttachXbe is true', () => {
			const item = attachXbeItem({
				sourceIsOgx: true,
				format: 'xiso',
				checkboxDisabled: false,
				checkboxChecked: false,
				itemGenerateAttachXbe: false,
				optionsGenerateAttachXbe: true,
			});
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.checked).toBe(false);
			expect(item.generateAttachXbe).toBe(false);
		});
	});

	describe('checkbox: enabled -> disabled clears regardless of manual state', () => {
		it('clears an enabled+checked box once sourceIsOgx resolves false', () => {
			const item = attachXbeItem({
				sourceIsOgx: false,
				format: 'xiso',
				checkboxDisabled: false,
				checkboxChecked: true,
				itemGenerateAttachXbe: true,
			});
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(true);
			expect(item.attachXbeCheckBoxEl.checked).toBe(false);
			expect(item.generateAttachXbe).toBe(false);
		});

		it('clears an enabled+checked box once the target format moves off xiso/ciso/cci, even with OGX still true', () => {
			const item = attachXbeItem({
				sourceIsOgx: true,
				format: 'god',
				checkboxDisabled: false,
				checkboxChecked: true,
				itemGenerateAttachXbe: true,
			});
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(true);
			expect(item.attachXbeCheckBoxEl.checked).toBe(false);
			expect(item.generateAttachXbe).toBe(false);
		});
	});

	describe('checkbox: enabled -> unresolved does NOT clear', () => {
		// A re-inspection cycle can transiently pass back through
		// sourceIsOgx === undefined before resolving again.
		it('leaves a manually-checked box checked while sourceIsOgx transiently reverts to unresolved', () => {
			const item = attachXbeItem({
				sourceIsOgx: undefined,
				format: 'xiso',
				checkboxDisabled: false,
				checkboxChecked: true,
				itemGenerateAttachXbe: true,
			});
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.disabled).toBe(true);
			expect(item.attachXbeCheckBoxEl.checked).toBe(true);
			expect(item.generateAttachXbe).toBe(true);
		});
	});

	describe('idempotency', () => {
		it('a later options.generateAttachXbe change does not retroactively re-check an already-eligible box', () => {
			const item = attachXbeItem({
				sourceIsOgx: true,
				format: 'xiso',
				checkboxDisabled: true,
				checkboxChecked: false,
				optionsGenerateAttachXbe: true,
			});
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.checked).toBe(true);

			item.options.generateAttachXbe = false;
			applyAttachXbeConstraint(item);
			expect(item.attachXbeCheckBoxEl.checked).toBe(true);
			expect(item.generateAttachXbe).toBe(true);
		});
	});
});

/** @param {string} value */
function deviceIdItem(value) {
	return stubItem({ godDeviceIdInputEl: { value } });
}

describe('isGodDeviceIdValid', () => {
	it('is valid when the field is empty (not-set is allowed)', () => {
		expect(isGodDeviceIdValid(deviceIdItem(''))).toBe(true);
	});

	it('is valid when the field is whitespace-only', () => {
		expect(isGodDeviceIdValid(deviceIdItem('   '))).toBe(true);
	});

	it('is valid for a well-formed 40-char hex string', () => {
		const value = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
		expect(isGodDeviceIdValid(deviceIdItem(value))).toBe(true);
	});

	it('is valid for a well-formed hex string with uppercase digits', () => {
		const value = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
		expect(isGodDeviceIdValid(deviceIdItem(value))).toBe(true);
	});

	it('is invalid when shorter than 40 hex characters', () => {
		const value = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
		expect(isGodDeviceIdValid(deviceIdItem(value))).toBe(false);
	});

	it('is invalid when longer than 40 hex characters', () => {
		const value = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678a';
		expect(isGodDeviceIdValid(deviceIdItem(value))).toBe(false);
	});

	// Right length (40 chars), but not hex - must fail on content, not be
	// mistaken for valid just because the length happens to match.
	it('is invalid for a right-length string containing non-hex characters', () => {
		const value = 'ssdasasdaasdsdaasasdasdasdasdasdsaasdasd';
		expect(value).toHaveLength(40);
		expect(isGodDeviceIdValid(deviceIdItem(value))).toBe(false);
	});
});
