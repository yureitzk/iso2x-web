/**
 * @import { ConversionOptions } from '../../types/global'
 */

/**
 * @satisfies {ConversionOptions}
 */
export const DEFAULT_CONVERSION_OPTIONS = {
	format: 'god',
	generateAttachXbe: false,
	god: { mode: 'full', sign: false },
	xiso: { mode: 'full', split: false },
	extracted: {
		skipSystemUpdate: false,
		allowedMediaPatch: false,
		renameTitle: false,
	},
	ciso: { mode: 'full' },
	cci: { mode: 'full' },
	zar: {},
};
