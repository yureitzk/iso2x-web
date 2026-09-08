/**
 * Centralized home for every "what do we call this source?" decision in
 * the app - queue item titles, the editable title input's fallback, the
 * source-parts folder/disc rows, and the Worker's own debug log output.
 * Nothing outside this file should re-derive a display name from a
 * DroppedSource's raw fields; route through these functions instead.
 *
 * @import { DroppedSource, MultiDiscEntry, OutputFormat, ConversionOptions, SingleDroppedSource, SourceFile } from '../../types/global'
 */

/**
 * @param {string} filename
 */
export function getFilenameWithoutExtension(filename) {
	if (filename.toLowerCase().endsWith('.xiso.iso')) {
		return (
			filename.substring(0, filename.length - '.xiso.iso'.length) || filename
		);
	}
	return filename.substring(0, filename.lastIndexOf('.')) || filename;
}

/**
 * The shared zip `File` every one of `files` was extracted from, or
 * `undefined` if `files` is empty, contains a real (non-zip-entry)
 * `File`, or spans more than one archive.
 * @param {SourceFile[]} files
 * @returns {File | undefined}
 */
export function sourceZipFile(files) {
	const [first, ...rest] = files;
	if (!first || !('kind' in first) || first.kind !== 'zipEntry') {
		return undefined;
	}
	const { zipFile } = first;
	const sameArchive = rest.every(
		(f) => 'kind' in f && f.kind === 'zipEntry' && f.zipFile === zipFile,
	);
	return sameArchive ? zipFile : undefined;
}

/**
 * A zip-derived `dir` source (e.g. a GOD folder's Data#### chunks) often
 * has no real `dirName` - iso2x can detect it without recursing into a
 * wrapping folder first. This falls back to the zip's own filename (sans
 * extension) whenever every file in `files` came from the same archive.
 * Extension-stripped variant for the editable title fallback
 * (baseNameForFiles()); use zipArchiveFileName() for a real filename
 * display.
 * @param {SourceFile[]} files
 * @returns {string | undefined}
 */
export function zipArchiveDisplayName(files) {
	const zipFile = sourceZipFile(files);
	return zipFile ? getFilenameWithoutExtension(zipFile.name) : undefined;
}

/**
 * Same resolution as zipArchiveDisplayName() above, but keeps the zip's
 * own extension: a zip-derived 'dir' source with no real dirName isn't
 * actually a folder, so it displays like a file (extension included, no
 * trailing slash).
 * @param {SourceFile[]} files
 * @returns {string | undefined}
 */
export function zipArchiveFileName(files) {
	return sourceZipFile(files)?.name;
}

/**
 * The immediate parent folder of a zip entry's own path within its
 * archive, e.g. "HaloCE/HaloCE.iso" -> "HaloCE"; undefined when the
 * entry sits at the zip's root.
 * @param {string | undefined} entryPath
 * @returns {string | undefined}
 */
export function entryParentFolder(entryPath) {
	if (!entryPath) return undefined;
	const slash = entryPath.lastIndexOf('/');
	return slash === -1 ? undefined : entryPath.slice(0, slash);
}

/**
 * Assigns a `zipLabel` to every zip-derived, successfully-resolved
 * 'files' source in one drop batch: one game from a zip gets the zip's
 * own filename; several get their own parent folder inside the zip
 * (entryParentFolder()), falling back to their own filename if flat.
 * 'dir'/'unresolved' sources and sources with `invalidReason` are
 * untouched.
 * @param {DroppedSource[]} sources
 * @returns {DroppedSource[]} a new array; input is never mutated.
 */
export function assignZipLabels(sources) {
	/** @type {Map<File, SingleDroppedSource[]>} */
	const gamesByZip = new Map();
	for (const source of sources) {
		if (source.kind !== 'files' || source.invalidReason) continue;
		const zipFile = sourceZipFile(source.files);
		if (!zipFile) continue;
		const group = gamesByZip.get(zipFile);
		if (group) group.push(source);
		else gamesByZip.set(zipFile, [source]);
	}

	/** @type {Map<SingleDroppedSource, string>} */
	const labelFor = new Map();
	for (const [zipFile, group] of gamesByZip) {
		if (group.length === 1) {
			labelFor.set(group[0], getFilenameWithoutExtension(zipFile.name));
			continue;
		}
		for (const source of group) {
			const [first] = source.files;
			const entryPath =
				first && 'kind' in first && first.kind === 'zipEntry'
					? first.entryPath
					: undefined;
			const parent = entryParentFolder(entryPath);
			if (parent) labelFor.set(source, parent);
		}
	}

	if (labelFor.size === 0) return sources;
	return sources.map((source) => {
		const zipLabel = labelFor.get(/** @type {SingleDroppedSource} */ (source));
		return zipLabel ? { ...source, zipLabel } : source;
	});
}

/**
 * Folder-row label for a `dir`-kind source: the real dirName, else the
 * zip archive's own file name when every file came from the same zip.
 * @param {SingleDroppedSource & { kind: 'dir' }} dirSource
 * @returns {string | undefined}
 */
export function dirRowFolderName(dirSource) {
	return dirSource.dirName || zipArchiveFileName(dirSource.files);
}

/**
 * Leads with the disc's 1-based position since the picked folder is
 * often a GOD title-hash directory one level below what the person
 * selected.
 * @param {MultiDiscEntry} disc
 * @param {number} index - 0-based position within source.discs
 */
export function discRowName(disc, index) {
	if (disc.kind === 'dir') {
		const position = `${index + 1}/`;
		const folderName = dirRowFolderName(disc);
		return folderName ? `${position} ${folderName}` : position;
	}
	return disc.files.map((f) => f.name).join(' + ');
}

/**
 * Display/title base name for a dropped source.
 * @param {DroppedSource} source
 */
export function baseNameForFiles(source) {
	if (source.kind === 'multi-disc') {
		return source.titleId;
	}
	if (source.kind === 'dir') {
		return (
			source.dirName ||
			zipArchiveDisplayName(source.files) ||
			getFilenameWithoutExtension(source.files[0].name)
		);
	}
	if (source.kind === 'unresolved') {
		// dirName is only set for a duplicateDiscClaim (a GOD container's
		// Data#### chunks). Prefer the folder's own name in that case
		// over a bare chunk filename.
		return (
			source.dirName ||
			zipArchiveDisplayName(source.files) ||
			getFilenameWithoutExtension(source.files[0].name)
		);
	}
	if (source.zipLabel) return source.zipLabel;
	const name = source.files[0].name.replace(/\.1\.(iso|cci)$/i, '');
	return getFilenameWithoutExtension(name);
}

/**
 * Raw file-level display name for a dropped source - the counterpart to
 * baseNameForFiles() above, which strips extensions/suffixes. This one
 * keeps them: real filename(s) for a file-backed source, dirName with a
 * trailing "/" for a real folder, or the zip's own file name (no
 * trailing slash) when a zip-derived 'dir' source has no dirName.
 * @param {DroppedSource} source
 * @returns {string}
 */
export function displayFileName(source) {
	if (source.kind === 'multi-disc') {
		// titleId is an Xbox Title ID (e.g. "4B4E0809"), not a filename.
		// Build the real name from each disc's own input file(s) instead.
		return source.discs.map((disc) => displayFileName(disc)).join(', ');
	}
	if (source.kind === 'dir') {
		if (source.dirName) return `${source.dirName}/`;
		return zipArchiveFileName(source.files) ?? `${source.files.length} files`;
	}
	if (source.kind === 'unresolved') {
		if ('dirName' in source) {
			if (source.dirName) return `${source.dirName}/`;
			const zipName = zipArchiveFileName(source.files);
			if (zipName) return zipName;
		}
		return `${source.files.length} unresolved parts`;
	}
	if (source.zipLabel) return source.zipLabel;
	return source.files.map((f) => f.name).join(' + ');
}

/**
 * Resolves the effective game title from the (possibly untrimmed,
 * possibly empty) titleEl.value, falling back to `fallback`. Deliberately
 * not just `rawValue || fallback` - a whitespace-only value is truthy.
 * @param {string} rawValue - entry.titleEl.value
 * @param {string} fallback - e.g. baseNameForFiles(entry.source) or titleId
 * @returns {string}
 */
export function resolveGameTitle(rawValue, fallback) {
	return rawValue.trim() || fallback;
}

/**
 * Extension/title-suffix for each format that produces one named
 * download. 'ciso' and 'cci' are absent since they always write
 * multiple files directly, same as a split 'xiso'.
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

/**
 * Human-readable source label for converterWorker.js's log output.
 * Mirrors displayFileName() above, minus the multi-disc/unresolved
 * cases converterWorker.js never logs directly.
 * @param {SingleDroppedSource} source
 * @returns {string}
 */
export function sourceLogLabel(source) {
	if (source.kind !== 'dir') {
		if (source.zipLabel) return source.zipLabel;
		return source.files.map((f) => f.name).join(' + ');
	}
	if (source.dirName) return `${source.dirName}/`;
	return zipArchiveFileName(source.files) ?? `${source.files.length} files`;
}
