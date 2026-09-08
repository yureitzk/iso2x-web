import { vi } from 'vitest';

/**
 * Shared `iso2x` (and `iso2x/detect-advanced`) test double - any suite
 * that needs to mock the wasm package rather than boot real wasm should
 * get its double from here, so there's a single place to update when
 * iso2x's exported surface changes.
 *
 * `iso2x`'s real module is a thin JS wrapper (`dist/*.js`) around
 * generated wasm-bindgen glue (`dist/wasm/iso2x.js`), so - unlike
 * WorkerController/SwBridge - there's no private/nominal class to
 * dodge here: this mock is just every named export replaced with a
 * `vi.fn()`, plus the default export (`initWasm`).
 *
 * @typedef {object} Iso2xModuleLike
 * @property {import('vitest').Mock} default - initWasm()
 * @property {import('vitest').Mock} chainMhtDigest
 * @property {import('vitest').Mock} lookupTitleById
 * @property {import('vitest').Mock} suggestDiscTitle
 * @property {import('vitest').Mock} formatTitleVersion
 * @property {import('vitest').Mock} contentTypeFamily
 * @property {import('vitest').Mock} splitSourceRef
 * @property {import('vitest').Mock} isoRootOffsetCandidates
 * @property {import('vitest').Mock} mhtSize
 * @property {import('vitest').Mock} cciFileSplitPoint
 * @property {import('vitest').Mock} cciSectorSize
 * @property {import('vitest').Mock} cciSizingBatchSectors
 * @property {import('vitest').Mock} cisoFilePaddingModulus
 * @property {import('vitest').Mock} cisoFileSplitPoint
 * @property {import('vitest').Mock} cisoSectorSize
 * @property {import('vitest').Mock} cisoSizingBatchSectors
 * @property {import('vitest').Mock} stfsFileEntryNameLenOffset
 * @property {import('vitest').Mock} stfsFileEntryPathIndicatorOffset
 * @property {import('vitest').Mock} stfsFileEntrySize
 * @property {import('vitest').Mock} xisoSplitMargin
 * @property {import('vitest').Mock} zarBlockSize
 * @property {import('vitest').Mock} detectDirFormat
 * @property {import('vitest').Mock} detectFormat
 * @property {import('vitest').Mock} scanBatch
 * @property {import('vitest').Mock} resolveBatchEntry
 * @property {Record<string, string>} contentTypeLabels
 * @property {import('vitest').Mock} generateAttachXbe
 * @property {{ wrap: import('vitest').Mock, open: import('vitest').Mock }} ConversionSession
 * @property {import('vitest').Mock} chunksFromSession
 * @property {import('vitest').Mock} openSource
 * @property {import('vitest').Mock} inspectSource
 */

/**
 * @returns {Iso2xModuleLike}
 */
export function createIso2xMock() {
	return {
		default: vi.fn().mockResolvedValue(undefined),
		chainMhtDigest: vi.fn(),
		lookupTitleById: vi.fn(),
		suggestDiscTitle: vi.fn(),
		formatTitleVersion: vi.fn(),
		contentTypeFamily: vi.fn(),
		splitSourceRef: vi.fn((ref) => ({
			source: ref?.source,
			parts: ref?.parts,
		})),
		// Sizing/format constants - real defaults so callers that don't
		// care about a specific value still get something numeric.
		isoRootOffsetCandidates: vi.fn(() => []),
		mhtSize: vi.fn(() => 0),
		cciFileSplitPoint: vi.fn(() => 0),
		cciSectorSize: vi.fn(() => 2048),
		cciSizingBatchSectors: vi.fn(() => 1),
		cisoFilePaddingModulus: vi.fn(() => 0),
		cisoFileSplitPoint: vi.fn(() => 0),
		cisoSectorSize: vi.fn(() => 2048),
		cisoSizingBatchSectors: vi.fn(() => 1),
		stfsFileEntryNameLenOffset: vi.fn(() => 0),
		stfsFileEntryPathIndicatorOffset: vi.fn(() => 0),
		stfsFileEntrySize: vi.fn(() => 0),
		xisoSplitMargin: vi.fn(() => 0),
		zarBlockSize: vi.fn(() => 0),
		detectDirFormat: vi.fn(),
		detectFormat: vi.fn(),
		scanBatch: vi.fn().mockResolvedValue([]),
		resolveBatchEntry: vi.fn(),
		contentTypeLabels: {},
		generateAttachXbe: vi.fn(),
		ConversionSession: {
			wrap: vi.fn((raw) => raw),
			open: vi.fn(),
		},
		chunksFromSession: vi.fn(),
		openSource: vi.fn(),
		inspectSource: vi.fn(),
	};
}

/**
 * @typedef {object} Iso2xDetectAdvancedModuleLike
 * @property {import('vitest').Mock} sourceParts
 * @property {import('vitest').Mock} resolveArbitraryXisoSplit
 * @property {import('vitest').Mock} checkIsoCompleteness
 * @property {import('vitest').Mock} verifySplitCandidate
 */

/**
 * @returns {Iso2xDetectAdvancedModuleLike}
 */
export function createIso2xDetectAdvancedMock() {
	return {
		sourceParts: vi.fn((names, files) =>
			names.map((/** @type {string} */ name) => ({
				name,
				size: files.size(name),
				readFn: files.readFn(name),
			})),
		),
		resolveArbitraryXisoSplit: vi.fn().mockResolvedValue(null),
		checkIsoCompleteness: vi.fn(() => undefined),
		verifySplitCandidate: vi.fn(),
	};
}
