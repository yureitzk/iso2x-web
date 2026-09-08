import {
	detectDirFormat,
	detectFormat,
	resolveBatchEntry,
	scanBatch,
} from 'iso2x';
import { checkIsoCompleteness } from 'iso2x/detect-advanced';
import { trackRead } from '../../lib/readTracker.js';
import { assignZipLabels, sourceZipFile } from '../../lib/sourceLabels.js';
import { expandZipFile, sliceSourceFile } from './zipSource.js';
/**
 * @import { DroppedSource, MultiDiscEntry, SourceFile } from '../../../types/global'
 * @import { BatchResolution } from 'iso2x'
 */

/** Matches a dropped/selected zip file, anywhere in the entry tree. */
const ZIP_EXTENSION = /\.zip$/i;

/** Loose disc-image extensions (not part of a god/extracted folder format). */
const LOOSE_IMAGE_EXTENSIONS = /\.(iso|cso|cci|zar)$/i;

/**
 * True if `name`'s final path segment has no extension - the shape STFS
 * packages and GOD "Data####" chunks take. A leading dot alone
 * ("`.gitignore`") doesn't count as an extension.
 * @param {string} name
 * @returns {boolean}
 */
function isExtensionless(name) {
	const base = name.slice(name.lastIndexOf('/') + 1);
	return base.lastIndexOf('.') <= 0;
}

/**
 * Whether `name` looks enough like a disc image to be worth a
 * content-based magic-byte probe. Skips the probe for ordinary files
 * (movies, saves, executables) - useful on Android, where these reads
 * can be blocking SAF IPC round trips rather than local disk reads.
 * @param {string} name
 * @returns {boolean}
 */
function isProbeCandidate(name) {
	return LOOSE_IMAGE_EXTENSIONS.test(name) || isExtensionless(name);
}

/**
 * InvalidKind values a person could fix by hand (reorder files, pick the
 * real header) - unlike `'mismatch'`, which can't be recovered. Used by
 * groupInputFiles() to decide between an 'unresolved' (recoverable) and
 * a dead-end 'files' + invalidReason result.
 * @type {ReadonlySet<string>}
 */
const RECOVERABLE_INVALID_KINDS = new Set([
	'unresolvedOrdering',
	'ambiguousHeaders',
]);

/**
 * Builds a `FileAccessor` (`{ readFn, size }`) over `byName`, whose
 * values may be real Files or zip-entry references (see
 * sliceSourceFile() in zipSource.js). Uses FileReaderSync, so only
 * callable inside a Worker.
 * @param {Map<string, SourceFile>} byName
 */
export function fileReaders(byName) {
	return {
		/** @param {string} name */
		readFn: (name) => {
			const file = /** @type {SourceFile} */ (byName.get(name));
			return (/** @type {number} */ offset, /** @type {number} */ length) => {
				const reader = new FileReaderSync();
				const bytes = new Uint8Array(
					reader.readAsArrayBuffer(sliceSourceFile(file, offset, length)),
				);
				trackRead(bytes.length);
				return bytes;
			};
		},
		/** @param {string} name */
		size: (name) => /** @type {SourceFile} */ (byName.get(name)).size,
	};
}

/**
 * Same as fileReaders(), but keyed by full relative path rather than
 * bare name, so same-named leaves in different directories (e.g. GOD
 * candidates several levels deep) don't collide.
 * @param {string[]} entries
 * @param {SourceFile[]} files
 */
function entryReaders(entries, files) {
	const byEntry = new Map(entries.map((e, i) => [e, files[i]]));
	return {
		/** @param {string} name */
		readFn: (name) => {
			const file = /** @type {SourceFile} */ (byEntry.get(name));
			return (/** @type {number} */ offset, /** @type {number} */ length) => {
				const reader = new FileReaderSync();
				const bytes = new Uint8Array(
					reader.readAsArrayBuffer(sliceSourceFile(file, offset, length)),
				);
				trackRead(bytes.length);
				return bytes;
			};
		},
		/** @param {string} name */
		size: (name) => /** @type {SourceFile} */ (byEntry.get(name)).size,
		byEntry,
	};
}

/**
 * Lowercased extension (with leading dot), or `''` if `name` has none.
 * Used only to bound resolveBatchEntry()'s candidate pool below, not for
 * format detection (see detectFormat for that).
 * @param {string} name
 * @returns {string}
 */
function fileExtension(name) {
	const base = name.slice(name.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Extensions resolveBatchEntry() pairs by name (e.g. "game.1.cci" +
 * "game.2.cci"). Raw XISO (.iso) has no naming convention - splits are
 * found by header-fragment matching instead (see candidateSiblings) -
 * so it's deliberately excluded here to avoid bucketing every corrupted
 * .iso in a drop together.
 * @type {ReadonlySet<string>}
 */
const NAMED_SPLIT_EXTENSIONS = new Set(['.cci', '.cso']);

/**
 * Groups `files` into DroppedSource entries via content-verified split
 * detection (resolveBatchEntry), not filename guessing. Must run inside
 * a Worker. candidateSiblings() below narrows the pool to avoid
 * unnecessary re-probing on messy drops.
 * @param {SourceFile[]} files
 * @param {(source: DroppedSource) => void} [onSource] called as each
 *   group resolves, so a caller can stream results.
 * @returns {Promise<DroppedSource[]>}
 */
export async function groupInputFiles(files, onSource) {
	const byName = new Map(files.map((f) => [f.name, f]));
	const accessor = fileReaders(byName);
	const remaining = new Set(byName.keys());
	/** @type {DroppedSource[]} */
	const groups = [];

	/** @param {DroppedSource} source */
	const emit = (source) => {
		groups.push(source);
		onSource?.(source);
	};

	// One completeness probe per file (not per file/sibling pair), and
	// classifies survivors as header fragments for candidateSiblings().
	/** @type {Set<string>} */
	const headerFragments = new Set();
	for (const name of [...remaining]) {
		let info;
		try {
			info = checkIsoCompleteness(accessor.readFn(name), accessor.size(name));
		} catch {
			continue; // Not raw XDVDFS-parseable (e.g. cci/cso, or opaque junk).
		}
		if (info?.isComplete) {
			remaining.delete(name);
			emit({
				kind: 'files',
				files: [/** @type {SourceFile} */ (byName.get(name))],
			});
		} else if (info) {
			headerFragments.add(name);
		}
	}

	/**
	 * @param {string} name
	 * @param {string[]} pool
	 * @returns {string[]}
	 */
	const candidateSiblings = (name, pool) => {
		if (headerFragments.has(name)) return pool;
		const ext = fileExtension(name);
		const sameExtensionMatters = NAMED_SPLIT_EXTENSIONS.has(ext);
		return pool.filter(
			(n) =>
				headerFragments.has(n) ||
				(sameExtensionMatters && fileExtension(n) === ext),
		);
	};

	for (const file of files) {
		if (!remaining.has(file.name)) continue; // Already claimed above.
		const pool = [...remaining].filter((n) => n !== file.name);
		const siblings = candidateSiblings(file.name, pool);
		const resolved = await resolveBatchEntry([file.name, ...siblings], accessor);

		if (resolved.kind === 'file') {
			remaining.delete(file.name);
			emit({ kind: 'files', files: [file] });
			continue;
		}

		const names =
			resolved.kind === 'dir' ? resolved.parts.map((p) => p.name) : resolved.names;

		// Defense in depth: resolveBatchEntry's contract is that `file.name`
		// is always part of whatever it resolves to. If that regressed,
		// trusting `names` blindly could drop `file` from the queue.
		if (!names.includes(file.name)) {
			remaining.delete(file.name);
			emit({ kind: 'files', files: [file] });
			continue;
		}
		names.forEach((n) => remaining.delete(n));

		// unresolvedKind is only stamped for 'ambiguousHeaders' (not
		// 'unresolvedOrdering'); sourcePartsUi.js's duplicateDiscClaim
		// checks treat both as verifiable regardless.
		if (
			resolved.kind === 'invalid' &&
			RECOVERABLE_INVALID_KINDS.has(resolved.invalidKind)
		) {
			emit({
				kind: 'unresolved',
				files: names.map((n) => /** @type {SourceFile} */ (byName.get(n))),
				reason: resolved.reason,
				...(resolved.invalidKind === 'ambiguousHeaders'
					? { unresolvedKind: 'ambiguousHeaders' }
					: {}),
			});
		} else {
			emit({
				kind: 'files',
				files: names.map((n) => /** @type {SourceFile} */ (byName.get(n))),
				...(resolved.kind === 'invalid'
					? { invalidReason: resolved.reason, invalidKind: resolved.invalidKind }
					: {}),
			});
		}
	}
	return groups;
}

/**
 * STFS packages ("CON "/"LIVE"/"PIRS" containers) are identified by
 * magic bytes, not extension, so a filename-only gate would miss real
 * ones (extensionless, or named after a hex title/save ID). Reuses the
 * wasm layer's detectFormat() instead of duplicating its magic constants.
 * @param {SourceFile} file
 * @param {{ readFn: (name: string) => (offset: number, length: number) => Uint8Array }} accessor
 * @returns {boolean}
 */
function isStfsMagic(file, accessor) {
	if (file.size < 4) return false; // detectFormat() throws below this size.
	try {
		return detectFormat(accessor.readFn(file.name), file.size) === 'stfs';
	} catch {
		return false;
	}
}

/**
 * @param {SourceFile[]} files
 * @param {(source: DroppedSource) => void} [onSource]
 * @returns {Promise<DroppedSource[]>}
 */
async function looseImageSourcesAt(files, onSource) {
	const accessor = fileReaders(new Map(files.map((f) => [f.name, f])));
	const images = files.filter((f) => {
		if (LOOSE_IMAGE_EXTENSIONS.test(f.name)) return true;
		// isStfsMagic() reads file content, so only probe names shaped
		// like a real STFS package (see isProbeCandidate).
		return isExtensionless(f.name) && isStfsMagic(f, accessor);
	});
	return groupInputFiles(images, onSource);
}

/**
 * Recursively splits a dropped folder into DroppedSource entries.
 * @param {string} dirName
 * @param {string[]} entries
 * @param {SourceFile[]} files
 * @param {(source: DroppedSource) => void} [onSource]
 * @returns {Promise<DroppedSource[]>}
 */
export async function partitionDirEntries(dirName, entries, files, onSource) {
	if (entries.length === 0) return [];
	const dirFormat = detectDirFormat(entries);
	if (dirFormat) {
		/** @type {DroppedSource} */
		const source = { kind: 'dir', dirName, entries, files };
		onSource?.(source);
		return [source];
	}
	/** @type {DroppedSource[]} */
	const sources = [];
	/** @type {Map<string, { entries: string[], files: SourceFile[] }>} */
	const subDirs = new Map();
	/** @type {SourceFile[]} */
	const looseFiles = [];
	entries.forEach((entry, i) => {
		const slash = entry.indexOf('/');
		if (slash === -1) {
			looseFiles.push(files[i]);
			return;
		}
		const child = entry.slice(0, slash);
		const rest = entry.slice(slash + 1);
		let bucket = subDirs.get(child);
		if (!bucket) {
			bucket = { entries: [], files: [] };
			subDirs.set(child, bucket);
		}
		bucket.entries.push(rest);
		bucket.files.push(files[i]);
	});
	sources.push(...(await looseImageSourcesAt(looseFiles, onSource)));
	for (const [child, bucket] of subDirs) {
		sources.push(
			...(await partitionDirEntries(
				child,
				bucket.entries,
				bucket.files,
				onSource,
			)),
		);
	}
	return sources;
}

/**
 * Finds where a disc's own format folder (e.g. a GOD ".data" folder)
 * starts within `name`. Tries the shortest suffix first and widens only
 * if that doesn't match - two discs in the same multiDiscSet can share
 * a parent folder, so we can't assume everything before the last '/'
 * belongs to this disc.
 * @param {string} name
 * @returns {{ parentPath: string, dirPath: string } | null} null if
 *   `name` isn't shaped like a dir-format leaf at any depth.
 */
function findDirFormatBoundary(name) {
	const segments = name.split('/');
	for (let depth = 2; depth <= segments.length; depth++) {
		const candidate = segments.slice(-depth).join('/');
		if (detectDirFormat([candidate])) {
			return {
				parentPath: segments.slice(0, segments.length - depth).join('/'),
				dirPath: segments.slice(0, -1).join('/'),
			};
		}
	}
	return null;
}

/**
 * GOD chunk filenames: always "Data" + 4 digits, no extension. FATX
 * (the Xbox 360's filesystem) is case-insensitive, so dump tools emit
 * any casing (DATA0000, data0001, Data0002) - matched case-insensitively.
 * @type {RegExp}
 */
const GOD_DATA_CHUNK_NAME = /^data\d{4}$/i;

/**
 * Given every entry path in a dropped folder already detected as 'god',
 * returns the indices of the actual source parts, in order: the
 * Data*.* files inside a "<title>.data/" directory, then any matching
 * header file beside it. Matched case-insensitively throughout, since
 * real-world dumps mix casing on ".data", "DataNNNN", and the
 * header/folder pairing.
 * @param {string[]} entries
 * @returns {number[]}
 */
export function godPartIndices(entries) {
	const indices = entries.map((_, i) => i);

	const dataIndices = indices.filter((i) => {
		const segs = entries[i].split('/');
		const name = segs[segs.length - 1];
		const parent = segs[segs.length - 2];
		return GOD_DATA_CHUNK_NAME.test(name) && /\.data$/i.test(parent ?? '');
	});

	const dataDirs = new Set(
		dataIndices.map((i) =>
			entries[i].split('/').slice(0, -1).join('/').toLowerCase(),
		),
	);
	const headerIndices = indices.filter((i) =>
		dataDirs.has(`${entries[i]}.data`.toLowerCase()),
	);

	return [...dataIndices, ...headerIndices].sort((a, b) =>
		entries[a] < entries[b] ? -1 : entries[a] > entries[b] ? 1 : 0,
	);
}

/**
 * Reconstructs one disc's own DroppedSource from a MultiDiscSet entry
 * name, plus every `entries` path belonging to it (`disc.name` only
 * points at the Data0000 file, not the whole disc). A GOD disc is
 * nested inside a ".data" folder; anything else is a plain 'files'
 * source.
 * @param {string} name
 * @param {string[]} entries
 * @param {SourceFile[]} files
 * @param {boolean} locked
 * @returns {{ source: MultiDiscEntry, claimedEntries: string[] }}
 */
function discSourceFor(name, entries, files, locked) {
	const slash = name.lastIndexOf('/');
	if (slash === -1) {
		return {
			source: { kind: 'files', files: [files[entries.indexOf(name)]], locked },
			claimedEntries: [name],
		};
	}
	const boundary = findDirFormatBoundary(name);
	if (!boundary) {
		// Has a folder prefix, but not this disc's own format folder. Treat
		// as a flat file rather than guess a dirPath that might belong to
		// another disc.
		return {
			source: { kind: 'files', files: [files[entries.indexOf(name)]], locked },
			claimedEntries: [name],
		};
	}
	const { parentPath, dirPath } = boundary;
	const dirName = dirPath.slice(parentPath ? parentPath.length + 1 : 0);
	const prefix = parentPath ? `${parentPath}/` : '';
	/** @type {string[]} */
	const dirEntries = [];
	/** @type {SourceFile[]} */
	const dirFiles = [];
	/** @type {string[]} */
	const claimedEntries = [];
	entries.forEach((e, i) => {
		if (e.startsWith(`${dirPath}/`)) {
			dirEntries.push(prefix ? e.slice(prefix.length) : e);
			dirFiles.push(files[i]);
			claimedEntries.push(e);
		}
	});
	// Redundant check: findDirFormatBoundary already confirmed the shape.
	if (detectDirFormat(dirEntries)) {
		// A GOD ".data" dir's CON/LIVE/PIRS header stub, when present, sits
		// *beside* the .data folder (not inside it), so the startsWith
		// pass above never claims it. It has no blocks of its own (its
		// data lives in the sibling Data#### files) and always fails to
		// open as a standalone STFS package, so claim-and-discard it here
		// rather than let it leak into looseImageSourcesAt() as a bogus
		// 'stfs' source. Matched case-insensitively, since real GOD dumps
		// aren't guaranteed lowercase.
		if (dirName.toLowerCase().endsWith('.data')) {
			const headerPath = `${prefix}${dirName.slice(0, -'.data'.length)}`;
			const headerEntry = entries.find(
				(e) =>
					!claimedEntries.includes(e) &&
					e.toLowerCase() === headerPath.toLowerCase(),
			);
			if (headerEntry) claimedEntries.push(headerEntry);
		}
		return {
			source: {
				kind: 'dir',
				dirName,
				entries: dirEntries,
				files: dirFiles,
				parentPath,
				locked,
			},
			claimedEntries,
		};
	}
	return {
		source: { kind: 'files', files: [files[entries.indexOf(name)]], locked },
		claimedEntries: [name],
	};
}

/**
 * Pulls MultiDiscSet groups, duplicate-disc-claim collisions, and
 * standalone results - all already classified by scanBatch() - out of
 * `entries`/`files`. Everything else falls through untouched to
 * partitionDirEntries()/groupInputFiles(). If a (titleId, discCount)
 * match's discs don't share one discSourceFor() kind, it isn't a
 * genuine multi-disc set - each disc is claimed and queued standalone
 * instead.
 * @param {string[]} entries
 * @param {SourceFile[]} files
 * @param {(source: DroppedSource) => void} [onSource]
 * @returns {Promise<{ discSets: DroppedSource[], remainingEntries: string[], remainingFiles: SourceFile[] }>}
 */
async function extractMultiDiscSets(entries, files, onSource) {
	if (entries.length < 2) {
		return { discSets: [], remainingEntries: entries, remainingFiles: files };
	}
	// Only probe plausible candidates (see isProbeCandidate). readFn/size/
	// byEntry below still cover the full entries list, since discSourceFor()
	// needs the whole tree, not just the probed subset.
	const probeEntries = entries.filter((e) => isProbeCandidate(e));
	if (probeEntries.length < 2) {
		return { discSets: [], remainingEntries: entries, remainingFiles: files };
	}
	const { readFn, size, byEntry } = entryReaders(entries, files);

	/** @type {DroppedSource[]} */
	const discSets = [];
	const claimed = new Set();

	/** @param {DroppedSource} source */
	const emit = (source) => {
		discSets.push(source);
		onSource?.(source);
	};

	/**
	 * Called both as results stream in early (via scanBatch's onItem) and
	 * for whatever's left once the batch resolves, so both get identical
	 * claiming/emission.
	 * @param {BatchResolution} result
	 */
	const handleResult = (result) => {
		// A same-disc-number collision is content-verified and never a
		// valid MultiDiscSet, so claim it as its own unresolved entry
		// rather than falling through to groupInputFiles().
		if (
			result.kind === 'unresolved' &&
			result.unresolvedKind === 'duplicateDiscClaim'
		) {
			// For a GOD folder, result.names is every Data#### chunk, not
			// a display-ready name. Reuse discSourceFor() to reconstruct it.
			const { source: claimant, claimedEntries } = discSourceFor(
				result.names[0],
				entries,
				files,
				false,
			);
			claimedEntries.forEach((e) => claimed.add(e));
			emit({
				kind: 'unresolved',
				files: claimant.files,
				reason: result.reason,
				unresolvedKind: 'duplicateDiscClaim',
				...(claimant.kind === 'dir' ? { dirName: claimant.dirName } : {}),
			});
			return;
		}
		if (result.kind === 'standalone') {
			// For a GOD folder, scanBatch()'s names list excludes the
			// header file. Reuse discSourceFor() to re-derive the full dirPath.
			const { source, claimedEntries } = discSourceFor(
				result.names[0],
				entries,
				files,
				false,
			);
			claimedEntries.forEach((e) => claimed.add(e));
			const { locked: _locked, ...standaloneSource } = source;
			emit(standaloneSource);
			return;
		}
		if (result.kind !== 'multiDiscSet') return;
		const resolvedDiscs = result.discs
			.slice()
			.sort((a, b) => a.discNumber - b.discNumber)
			.map((disc) => discSourceFor(disc.name, entries, files, true));
		const discs = resolvedDiscs.map((d) => d.source);

		// Defense-in-depth: a real multi-disc release's discs should
		// already be shape-pure, but confirm rather than assume.
		const allSameKind = discs.every((d) => d.kind === discs[0].kind);
		if (!allSameKind) {
			resolvedDiscs.forEach(({ source, claimedEntries }) => {
				claimedEntries.forEach((e) => claimed.add(e));
				const { locked: _locked, ...standaloneSource } = source;
				emit(standaloneSource);
			});
			return;
		}

		resolvedDiscs.forEach(({ claimedEntries }) => {
			claimedEntries.forEach((e) => claimed.add(e));
		});
		emit({
			kind: 'multi-disc',
			titleId: result.titleId,
			discCount: result.discCount,
			discs,
		});
	};

	// scanBatch's onItem calls handleResult synchronously for anything
	// that doesn't need whole-batch correlation, so most files are
	// already claimed before this await resolves.
	const results = await scanBatch(probeEntries, { readFn, size }, handleResult);
	for (const result of results) {
		handleResult(result);
	}

	const remainingEntries = entries.filter((e) => !claimed.has(e));
	const remainingFiles = remainingEntries.map(
		(e) => /** @type {SourceFile} */ (byEntry.get(e)),
	);
	return { discSets, remainingEntries, remainingFiles };
}

/**
 * Expands any top-level `.zip` File in `entries`/`files` into its own
 * contents, in place, at the zip's own path - so downstream functions
 * can't tell it apart from having been unzipped to disk and dropped.
 *
 * A zip containing any DEFLATE entry can't be randomly read without
 * buffering it in memory (see zipSource.js), so it's skipped silently,
 * same as any other file this app can't make sense of. A whole-zip
 * parse failure surfaces as a non-recoverable 'files' + invalidReason
 * source for that zip - same convention groupInputFiles() uses for a
 * mismatched split pair - rather than aborting the whole drop.
 *
 * Zips are expanded one at a time: each zip's own header resolution is
 * already internally concurrent (the actual Android IPC latency lives
 * there - see `resolveDataOffsetsBatched()` in zipSource.js), so
 * running multiple whole zips concurrently would mostly just contend
 * for the same `content://` provider.
 * @param {string[]} entries
 * @param {SourceFile[]} files
 * @param {(source: DroppedSource) => void} [onSource]
 * @returns {Promise<{ entries: string[], files: SourceFile[], zipErrors: DroppedSource[] }>}
 */
async function expandZipFiles(entries, files, onSource) {
	/** @type {string[]} */
	const outEntries = [];
	/** @type {SourceFile[]} */
	const outFiles = [];
	/** @type {DroppedSource[]} */
	const zipErrors = [];

	/** @param {DroppedSource} source */
	const emitError = (source) => {
		zipErrors.push(source);
		onSource?.(source);
	};

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const file = files[i];
		if (!(file instanceof File) || !ZIP_EXTENSION.test(entry)) {
			outEntries.push(entry);
			outFiles.push(file);
			continue;
		}
		const slash = entry.lastIndexOf('/');
		const prefix = slash === -1 ? '' : entry.slice(0, slash + 1);
		try {
			const {
				entries: zEntries,
				files: zFiles,
				unsupported,
			} = await expandZipFile(file, prefix);
			if (unsupported) continue; // Contains compressed entries - skip the whole archive.
			outEntries.push(...zEntries);
			outFiles.push(...zFiles);
		} catch (err) {
			emitError({
				kind: 'files',
				files: [file],
				invalidReason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { entries: outEntries, files: outFiles, zipErrors };
}

/**
 * Pulls multi-disc sets out first, since scanBatch's grouping spans the
 * whole tree in one pass including discs in different subdirectories,
 * then hands whatever's left to partitionDirEntries().
 * @param {string} dirName
 * @param {string[]} entries
 * @param {SourceFile[]} files
 * @param {(source: DroppedSource) => void} [onSource] called synchronously
 *   as each source resolves, so callers can stream results
 * @returns {Promise<DroppedSource[]>}
 */
export async function partitionDroppedFolder(
	dirName,
	entries,
	files,
	onSource,
) {
	if (entries.length === 0) return [];
	const {
		entries: expandedEntries,
		files: expandedFiles,
		zipErrors,
	} = await expandZipFiles(entries, files, onSource);

	// A zip-derived 'files' source can't get its final display name
	// (assignZipLabels(), sourceLabels.js) until every game from that
	// zip has resolved: a lone game gets the zip's own name, several
	// get their own parent folder, and there's no way to tell which
	// applies from just one source. So those are held back until the
	// whole batch is in, then labeled and released together. Everything
	// else (non-zip-derived, or a zip-derived 'dir'/'unresolved' source,
	// which names itself via its own dirName) streams through immediately.
	/** @type {DroppedSource[]} */
	const pendingZipSources = [];
	/** @param {DroppedSource} source */
	const relay = (source) => {
		if (
			source.kind === 'files' &&
			!source.invalidReason &&
			sourceZipFile(source.files)
		) {
			pendingZipSources.push(source);
			return;
		}
		onSource?.(source);
	};

	const { discSets, remainingEntries, remainingFiles } =
		await extractMultiDiscSets(expandedEntries, expandedFiles, relay);
	const dirSources = await partitionDirEntries(
		dirName,
		remainingEntries,
		remainingFiles,
		relay,
	);

	const pendingSet = new Set(pendingZipSources);
	const labeledZipSources = assignZipLabels(pendingZipSources);
	labeledZipSources.forEach((source) => onSource?.(source));

	return [
		...zipErrors,
		...discSets.filter((s) => !pendingSet.has(s)),
		...dirSources.filter((s) => !pendingSet.has(s)),
		...labeledZipSources,
	];
}
