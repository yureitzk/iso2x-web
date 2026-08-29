import {
	detectDirFormat,
	detectFormat,
	resolveBatchEntry,
	scanBatch,
} from 'iso2x';
import { checkIsoCompleteness } from 'iso2x/detect-advanced';
import { trackRead } from '../lib/readTracker.js';
/**
 * @import { DroppedSource, MultiDiscEntry } from '../../types/global'
 * @import { BatchResolution } from 'iso2x'
 */

/** Files that aren't part of a whole god/extracted game folder (handled separately by detectDirFormat). */
const LOOSE_IMAGE_EXTENSIONS = /\.(iso|cso|cci|zar)$/i;

/**
 * True if `name`'s final path segment has no file extension - the shape
 * real-world STFS packages and GOD "Data####" chunks always take (see
 * isStfsMagic's doc comment). A leading dot alone ("`.gitignore`") isn't
 * treated as an extension.
 * @param {string} name
 * @returns {boolean}
 */
function isExtensionless(name) {
	const base = name.slice(name.lastIndexOf('/') + 1);
	return base.lastIndexOf('.') <= 0;
}

/**
 * Whether `name` is worth a content-based magic-byte probe at all.
 * extractMultiDiscSets/looseImageSourcesAt only ever resolve to a
 * disc-image container - raw XISO/CSO/CCI/ZAR, or an extensionless STFS
 * package / GOD Data#### chunk - never a movie, save, executable, or
 * anything else with an ordinary extension. Gating on this matters on
 * Android, where these reads are often blocking SAF IPC round trips
 * (content:// URIs) rather than local disk reads.
 * @param {string} name
 * @returns {boolean}
 */
function isProbeCandidate(name) {
	return LOOSE_IMAGE_EXTENSIONS.test(name) || isExtensionless(name);
}

/**
 * `InvalidKind` values a person could resolve by hand (reorder, pick the
 * real header) - unlike `'mismatch'`, which never recovers. Drives
 * groupInputFiles()'s choice between 'unresolved' and a dead-end
 * 'files' + invalidReason error.
 * @type {ReadonlySet<string>}
 */
const RECOVERABLE_INVALID_KINDS = new Set([
	'unresolvedOrdering',
	'ambiguousHeaders',
]);

/**
 * Reads are synchronous (FileReaderSync), so this only works inside a
 * Worker. Shaped as a `FileAccessor` (`{ readFn, size }`).
 * @param {Map<string, File>} byName
 */
export function fileReaders(byName) {
	return {
		/** @param {string} name */
		readFn: (name) => {
			const file = /** @type {File} */ (byName.get(name));
			return (/** @type {number} */ offset, /** @type {number} */ length) => {
				const reader = new FileReaderSync();
				const bytes = new Uint8Array(
					reader.readAsArrayBuffer(file.slice(offset, offset + length)),
				);
				trackRead(bytes.length);
				return bytes;
			};
		},
		/** @param {string} name */
		size: (name) => /** @type {File} */ (byName.get(name)).size,
	};
}

/**
 * Same as fileReaders(), but keyed by full relative-path entry, since GOD
 * candidates can sit several directories deep and same-named leaves need
 * telling apart by path.
 * @param {string[]} entries
 * @param {File[]} files
 */
function entryReaders(entries, files) {
	const byEntry = new Map(entries.map((e, i) => [e, files[i]]));
	return {
		/** @param {string} name */
		readFn: (name) => {
			const file = /** @type {File} */ (byEntry.get(name));
			return (/** @type {number} */ offset, /** @type {number} */ length) => {
				const reader = new FileReaderSync();
				const bytes = new Uint8Array(
					reader.readAsArrayBuffer(file.slice(offset, offset + length)),
				);
				trackRead(bytes.length);
				return bytes;
			};
		},
		/** @param {string} name */
		size: (name) => /** @type {File} */ (byEntry.get(name)).size,
		byEntry,
	};
}

/**
 * Groups `files` into DroppedSource entries using the wasm layer's
 * content-verified split detection (resolveBatchEntry), not a
 * filename-only guess. A mismatched named pair gets `invalidReason` +
 * `invalidKind` and is never recoverable; an ambiguous or unresolved raw
 * XISO fragment set becomes 'unresolved' so the UI can offer manual
 * reorder/verify recovery (see RECOVERABLE_INVALID_KINDS).
 *
 * Must run inside a Worker (see fileReaders()). `files` must all come
 * from the same flat location - File.name has no path.
 *
 * Perf: resolveBatchEntry() re-probes every candidate sibling on each
 * call, so calling it once per file is O(n^2). The pre-pass below
 * resolves complete standalone images up front for O(n) probes instead.
 * @param {File[]} files
 * @param {(source: DroppedSource) => void} [onSource] called synchronously
 *   as each group resolves, so a caller can stream results.
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

	// One completeness probe per file, not per (file, sibling) pair.
	for (const name of [...remaining]) {
		let info;
		try {
			info = checkIsoCompleteness(accessor.readFn(name), accessor.size(name));
		} catch {
			continue; // Not a raw XDVDFS-parseable file (e.g. cci/cso).
		}
		if (info?.isComplete) {
			remaining.delete(name);
			emit({ kind: 'files', files: [/** @type {File} */ (byName.get(name))] });
		}
	}

	for (const file of files) {
		if (!remaining.has(file.name)) continue; // Already claimed above.
		const siblings = [...remaining].filter((n) => n !== file.name);
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

		// unresolvedKind is only stamped for 'ambiguousHeaders', not
		// 'unresolvedOrdering' - both are "verifiable" for
		// sourcePartsUi.js's duplicateDiscClaim checks either way.
		if (
			resolved.kind === 'invalid' &&
			RECOVERABLE_INVALID_KINDS.has(resolved.invalidKind)
		) {
			emit({
				kind: 'unresolved',
				files: names.map((n) => /** @type {File} */ (byName.get(n))),
				reason: resolved.reason,
				...(resolved.invalidKind === 'ambiguousHeaders'
					? { unresolvedKind: 'ambiguousHeaders' }
					: {}),
			});
		} else {
			emit({
				kind: 'files',
				files: names.map((n) => /** @type {File} */ (byName.get(n))),
				...(resolved.kind === 'invalid'
					? { invalidReason: resolved.reason, invalidKind: resolved.invalidKind }
					: {}),
			});
		}
	}
	return groups;
}

/**
 * STFS packages ("CON "/"LIVE"/"PIRS" containers) are identified purely
 * by magic bytes, not by extension, so a filename-only gate would drop
 * real ones (extensionless, or named after a hex title/save ID).
 * Reuses the wasm layer's own detectFormat() rather than duplicating
 * the magic constants here.
 * @param {File} file
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
 * @param {File[]} files
 * @param {(source: DroppedSource) => void} [onSource]
 * @returns {Promise<DroppedSource[]>}
 */
async function looseImageSourcesAt(files, onSource) {
	const accessor = fileReaders(new Map(files.map((f) => [f.name, f])));
	const images = files.filter((f) => {
		if (LOOSE_IMAGE_EXTENSIONS.test(f.name)) return true;
		// isStfsMagic() is a real content read - only worth it for names
		// shaped like a real STFS package (see isProbeCandidate).
		return isExtensionless(f.name) && isStfsMagic(f, accessor);
	});
	return groupInputFiles(images, onSource);
}

/**
 * Recursively splits a dropped folder into DroppedSource entries.
 * @param {string} dirName
 * @param {string[]} entries
 * @param {File[]} files
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
	/** @type {Map<string, { entries: string[], files: File[] }>} */
	const subDirs = new Map();
	/** @type {File[]} */
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
 * Finds where a disc's own dedicated format folder (e.g. a GOD ".data"
 * folder) starts within `name`. Two discs in the same multiDiscSet can
 * share a parent folder, so this tries the shortest suffix first and
 * widens only if that doesn't match, rather than assuming everything
 * before the last '/' belongs to this disc.
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
 * Given every entry path in a dropped folder already detected as 'god',
 * picks out (in order) the indices for the actual source parts: the
 * Data*.* files inside a "<title>.data/" directory, then any matching
 * header file next to that directory. Case-insensitive on ".data" to
 * match detectDirFormat's own rule.
 * @param {string[]} entries
 * @returns {number[]}
 */
export function godPartIndices(entries) {
	const indices = entries.map((_, i) => i);

	const dataIndices = indices.filter((i) => {
		const segs = entries[i].split('/');
		const name = segs[segs.length - 1];
		const parent = segs[segs.length - 2];
		return name.startsWith('Data') && /\.data$/i.test(parent ?? '');
	});

	const dataDirs = new Set(
		dataIndices.map((i) => entries[i].split('/').slice(0, -1).join('/')),
	);
	const headerIndices = indices.filter((i) =>
		dataDirs.has(`${entries[i]}.data`),
	);

	return [...dataIndices, ...headerIndices].sort((a, b) =>
		entries[a] < entries[b] ? -1 : entries[a] > entries[b] ? 1 : 0,
	);
}

/**
 * Reconstructs one disc's own DroppedSource from a MultiDiscSet entry
 * name, plus every `entries` path that belongs to it (`disc.name` only
 * points at the Data0000 file, not the whole disc). A GOD disc is nested
 * inside a ".data" folder; anything else is a plain 'files' source.
 * @param {string} name
 * @param {string[]} entries
 * @param {File[]} files
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
		// Folder prefix present, but not this disc's own format folder -
		// treat as a flat file rather than guess a dirPath that might
		// belong to a different disc.
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
	/** @type {File[]} */
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
	// Defense in depth - findDirFormatBoundary already confirmed the shape.
	if (detectDirFormat(dirEntries)) {
		// A GOD ".data" dir's own CON/LIVE/PIRS header stub, when present,
		// sits *beside* the .data folder rather than inside it, so the
		// startsWith(`${dirPath}/`) pass above never claims it. It has no
		// allocated blocks of its own (its data lives in the sibling
		// Data#### files), so opening it as a standalone STFS package
		// always fails - claim-and-discard it here so it never leaks into
		// looseImageSourcesAt()'s magic-byte fallback as a bogus 'stfs'
		// source. Matched case-insensitively: real GOD dumps aren't
		// guaranteed lowercase.
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
 * Standalone results - all already classified by scanBatch() - out of
 * `entries`/`files`. Everything else falls through untouched to
 * partitionDirEntries()/groupInputFiles(). A (titleId, discCount) match
 * whose discs don't share one discSourceFor() kind isn't a genuine
 * multi-disc set - each disc is claimed and queued standalone instead.
 * @param {string[]} entries
 * @param {File[]} files
 * @param {(source: DroppedSource) => void} [onSource]
 * @returns {Promise<{ discSets: DroppedSource[], remainingEntries: string[], remainingFiles: File[] }>}
 */
async function extractMultiDiscSets(entries, files, onSource) {
	if (entries.length < 2) {
		return { discSets: [], remainingEntries: entries, remainingFiles: files };
	}
	// Only probe plausible candidates (see isProbeCandidate); readFn/size/
	// byEntry still cover the full entries below, since discSourceFor()
	// needs the whole tree to reconstruct results, not just the probed subset.
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
		// A same-disc-number collision - content-verified, never a valid
		// MultiDiscSet. Claimed as its own unresolved entry rather than
		// falling through to groupInputFiles().
		if (
			result.kind === 'unresolved' &&
			result.unresolvedKind === 'duplicateDiscClaim'
		) {
			// For a GOD folder, result.names is every Data#### chunk, not a
			// display-ready name - reuse discSourceFor() to reconstruct.
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
			// For a GOD folder, scanBatch()'s names list excludes the header
			// file - reuse discSourceFor() to re-derive the full dirPath.
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
		(e) => /** @type {File} */ (byEntry.get(e)),
	);
	return { discSets, remainingEntries, remainingFiles };
}

/**
 * Pulls multi-disc sets out first, since scanBatch's grouping spans the
 * whole tree in one pass including discs in different subdirectories,
 * then hands whatever's left to partitionDirEntries().
 * @param {string} dirName
 * @param {string[]} entries
 * @param {File[]} files
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
	const { discSets, remainingEntries, remainingFiles } =
		await extractMultiDiscSets(entries, files, onSource);
	return [
		...discSets,
		...(await partitionDirEntries(
			dirName,
			remainingEntries,
			remainingFiles,
			onSource,
		)),
	];
}
