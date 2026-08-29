import { getFilenameWithoutExtension } from '../../lib/helpers.js';

/**
 * @import { DroppedSource, OutputFormat, ConversionOptions } from '../../../types/global'
 */

/**
 * Display/title base name for a dropped source.
 * @param {DroppedSource} source
 */
export function baseNameForFiles(source) {
	if (source.kind === 'multi-disc') {
		return source.titleId;
	}
	if (source.kind === 'dir') {
		return source.dirName || getFilenameWithoutExtension(source.files[0].name);
	}
	if (source.kind === 'unresolved') {
		// dirName is only set for a duplicateDiscClaim, whose files are a
		// GOD-container's Data#### chunks - prefer the folder's own name over a chunk filename.
		return source.dirName || getFilenameWithoutExtension(source.files[0].name);
	}
	const name = source.files[0].name.replace(/\.1\.(iso|cci)$/i, '');
	return getFilenameWithoutExtension(name);
}

/**
 * Raw file-level display name for a dropped source - the counterpart
 * to baseNameForFiles() above, which strips extensions/suffixes for
 * the editable game-title input. This one keeps them: real
 * filename(s) with extension for a file-backed source, dirName with a
 * trailing "/" for a folder.
 * @param {DroppedSource} source
 * @returns {string}
 */
export function displayFileName(source) {
	if (source.kind === 'multi-disc') {
		// titleId is an Xbox Title ID (e.g. "4B4E0809"), not a filename -
		// build the real name from each disc's own input file(s) instead,
		// same as the recursive call below would for a standalone source.
		return source.discs.map((disc) => displayFileName(disc)).join(', ');
	}
	if (source.kind === 'dir') {
		return source.dirName ? `${source.dirName}/` : `${source.files.length} files`;
	}
	if (source.kind === 'unresolved') {
		// Same dirName carve-out as baseNameForFiles() above: a
		// duplicateDiscClaim'd GOD folder is one thing, not N loose parts.
		return source.dirName
			? `${source.dirName}/`
			: `${source.files.length} unresolved parts`;
	}
	return source.files.map((f) => f.name).join(' + ');
}

/**
 * Resolves the effective game title from the (possibly untrimmed,
 * possibly empty) titleEl.value, falling back to `fallback` when the
 * input is empty or whitespace-only. Deliberately not just
 * `rawValue || fallback` - a value of "   " is truthy and would win
 * over the fallback despite having no real content once trimmed.
 * @param {string} rawValue - entry.titleEl.value
 * @param {string} fallback - e.g. baseNameForFiles(entry.source) or titleId
 * @returns {string}
 */
export function resolveGameTitle(rawValue, fallback) {
	return rawValue.trim() || fallback;
}

/**
 * Extension/title-suffix for each format that produces one named
 * download. 'ciso' and 'cci' are absent on purpose - they always
 * write multiple files directly rather than one named download, same
 * as a split 'xiso' (see outputFilenameFor()'s isMultiFileDirect
 * check below).
 * @type {Partial<Record<OutputFormat, { extension: string, suffix?: string }>>}
 */
const SINGLE_FILE_OUTPUT = {
	xiso: { extension: 'xiso.iso' },
	zar: { extension: 'zar' },
	god: { extension: 'zip', suffix: ' (GoD)' },
	extracted: { extension: 'zip', suffix: ' (XEX)' },
};

/**
 * Derives the fallback output filename (with the right extension and
 * format suffix, e.g. " (XEX).zip") for `gameTitle` given `format` and
 * that format's own ConversionOptions.
 * @param {string} gameTitle
 * @param {OutputFormat} format
 * @param {ConversionOptions[OutputFormat]} formatOptions
 * @returns {string}
 */
export function outputFilenameFor(gameTitle, format, formatOptions) {
	const isMultiFileDirect =
		format === 'ciso' ||
		format === 'cci' ||
		(format === 'xiso' &&
			/** @type {{ split?: boolean }} */ (formatOptions).split);
	if (isMultiFileDirect) return gameTitle;

	const output = SINGLE_FILE_OUTPUT[format];
	return output
		? `${gameTitle}${output.suffix ?? ''}.${output.extension}`
		: gameTitle;
}
