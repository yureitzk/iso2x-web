import { trackRead } from '../../lib/readTracker.js';

/**
 * @import { SourceFile, ZipEntryFileRef } from '../../../types/global'
 */

/**
 * Minimal ZIP central-directory reader: enumerates entries and, for
 * STORE (uncompressed) entries only, returns a synchronous, random-access
 * read straight off the dropped zip File (same `File.slice()` +
 * `FileReaderSync` approach `fileReaders()` in source.js uses). DEFLATE
 * entries are inherently sequential to decompress, so callers should
 * treat `compressionMethod !== 0` as unsupported rather than loading
 * them whole - never inflating anything also means this is immune to
 * zip bombs.
 *
 * Rejects the same hostile shapes other zip readers guard against:
 * strong encryption, multi-volume archives, unsafe entry paths,
 * duplicate names, and out-of-bounds STORE data (see
 * `isUnsafeEntryName()` / `resolveZipEntries()`).
 */

const EOCDR_SIGNATURE = 0x06054b50;
const EOCDR_FIXED_SIZE = 22; // signature..comment length, before the comment bytes
const MAX_COMMENT_SIZE = 0xffff; // comment length is a 2-byte field
const ZIP64_EOCDL_SIGNATURE = 0x07064b50;
const ZIP64_EOCDL_SIZE = 20;
const ZIP64_EOCDR_SIGNATURE = 0x06064b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const CENTRAL_DIRECTORY_FIXED_SIZE = 46; // signature..comment length, before name/extra/comment
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_FIXED_SIZE = 30; // signature..extra field length, before name/extra
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ENCRYPTED_FLAG = 0x1;
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

/** @typedef {{ name: string, size: number, compressedSize: number, compressionMethod: number, encrypted: boolean, localHeaderOffset: number }} RawZipEntry */

export class ZipFormatError extends Error {}

const utf8Decoder = new TextDecoder();

/**
 * `readRange()` calls silently clamp reads past the end of the source
 * instead of throwing, so a header field lying about a length/offset
 * would otherwise surface later as a raw `RangeError` instead of a
 * catchable `ZipFormatError`. This makes that check explicit.
 * @param {Uint8Array} bytes
 * @param {number} minLength
 * @param {string} message
 */
function requireLength(bytes, minLength, message) {
	if (bytes.byteLength < minLength) {
		throw new ZipFormatError(message);
	}
}

/** @param {DataView} view @param {number} offset */
function u16(view, offset) {
	return view.getUint16(offset, true);
}
/** @param {DataView} view @param {number} offset */
function u32(view, offset) {
	return view.getUint32(offset, true);
}
/**
 * 64-bit little-endian read via two 32-bit reads (values here never
 * approach Number.MAX_SAFE_INTEGER for anything this app deals with).
 * @param {DataView} view
 * @param {number} offset
 */
function u64(view, offset) {
	return u32(view, offset) + u32(view, offset + 4) * 0x100000000;
}

/**
 * Locates the End Of Central Directory record within the last `tail`
 * bytes of the archive (`tail` = up to 22 + 65535 comment bytes, the
 * format's own ceiling on how far back it can be). Scans backward,
 * validating that each signature match's comment length reaches exactly
 * to EOF, so a comment that coincidentally contains the EOCDR signature
 * doesn't get mistaken for the real record.
 * @param {Uint8Array} tail bytes at the very end of the archive
 * @param {number} archiveLength total length of the archive
 * @returns {{ offsetInTail: number, view: DataView }}
 */
function locateEocdr(tail, archiveLength) {
	const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	for (let i = tail.length - EOCDR_FIXED_SIZE; i >= 0; i--) {
		if (u32(view, i) !== EOCDR_SIGNATURE) continue;
		const commentLength = u16(view, i + 20);
		if (i + EOCDR_FIXED_SIZE + commentLength === tail.length) {
			return { offsetInTail: i, view };
		}
		// A coincidental match, e.g. inside a comment; keep scanning back.
	}
	throw new ZipFormatError(
		`no end-of-central-directory record found in the last ${tail.length} of ${archiveLength} bytes - not a zip file, or a multi-volume archive`,
	);
}

/**
 * @param {number} rawEntryCount count field as read (0xffff sentinel means "see Zip64")
 * @param {number} centralDirectoryOffset offset field as read (0xffffffff sentinel means "see Zip64")
 * @returns {boolean}
 */
function needsZip64Locator(rawEntryCount, centralDirectoryOffset) {
	return (
		rawEntryCount === ZIP64_SENTINEL_16 ||
		centralDirectoryOffset === ZIP64_SENTINEL_32
	);
}

/**
 * Reads the Zip64 locator and the EOCDR record it points to, used in
 * place of the fields the plain EOCDR couldn't hold.
 * @param {(offset: number, length: number) => Uint8Array} readRange
 * @param {number} eocdrFileOffset
 * @returns {{ entryCount: number, centralDirectorySize: number, centralDirectoryOffset: number }}
 */
function readZip64Locator(readRange, eocdrFileOffset) {
	const locatorOffset = eocdrFileOffset - ZIP64_EOCDL_SIZE;
	const locatorBytes = readRange(locatorOffset, ZIP64_EOCDL_SIZE);
	requireLength(
		locatorBytes,
		ZIP64_EOCDL_SIZE,
		'archive is truncated where a zip64 end-of-central-directory locator was expected',
	);
	const locatorView = new DataView(
		locatorBytes.buffer,
		locatorBytes.byteOffset,
		locatorBytes.byteLength,
	);
	if (u32(locatorView, 0) !== ZIP64_EOCDL_SIGNATURE) {
		throw new ZipFormatError('invalid zip64 end-of-central-directory locator');
	}
	const zip64EocdrOffset = u64(locatorView, 8);

	const eocdrBytes = readRange(zip64EocdrOffset, 56);
	requireLength(
		eocdrBytes,
		56,
		'archive is truncated where a zip64 end-of-central-directory record was expected',
	);
	const eocdrView = new DataView(
		eocdrBytes.buffer,
		eocdrBytes.byteOffset,
		eocdrBytes.byteLength,
	);
	if (u32(eocdrView, 0) !== ZIP64_EOCDR_SIGNATURE) {
		throw new ZipFormatError('invalid zip64 end-of-central-directory record');
	}
	return {
		entryCount: u64(eocdrView, 32),
		centralDirectorySize: u64(eocdrView, 40),
		centralDirectoryOffset: u64(eocdrView, 48),
	};
}

/**
 * Parses one Central Directory File Header at `cursor`, resolving any
 * Zip64 extra field for values the 32-bit header couldn't hold. Rejects
 * multi-disk members and strong encryption; DEFLATE entries are left
 * for the caller to reject, since they're legitimate zip members - just
 * not randomly-readable by this module.
 * @param {Uint8Array} buffer central directory bytes, from `cursor` onward
 * @param {number} cursor
 * @returns {{ entry: RawZipEntry, nextCursor: number }}
 */
function parseCentralDirectoryEntry(buffer, cursor) {
	requireLength(
		buffer.subarray(cursor),
		CENTRAL_DIRECTORY_FIXED_SIZE,
		'the archive claims more central directory entries than its central ' +
			'directory actually contains',
	);
	const view = new DataView(
		buffer.buffer,
		buffer.byteOffset + cursor,
		buffer.byteLength - cursor,
	);
	if (u32(view, 0) !== CENTRAL_DIRECTORY_SIGNATURE) {
		throw new ZipFormatError(
			`invalid central directory file header at offset ${cursor}`,
		);
	}
	const generalPurposeFlag = u16(view, 8);
	if (generalPurposeFlag & 0x40) {
		throw new ZipFormatError('strong-encrypted zip entries are not supported');
	}
	const diskNumberStart = u16(view, 34);
	if (diskNumberStart !== 0) {
		throw new ZipFormatError('multi-volume zip files are not supported');
	}

	const compressionMethod = u16(view, 10);
	let compressedSize = u32(view, 20);
	let uncompressedSize = u32(view, 24);
	const nameLength = u16(view, 28);
	const extraLength = u16(view, 30);
	const commentLength = u16(view, 32);
	let localHeaderOffset = u32(view, 42);

	const nextCursor =
		cursor +
		CENTRAL_DIRECTORY_FIXED_SIZE +
		nameLength +
		extraLength +
		commentLength;
	requireLength(
		buffer,
		nextCursor,
		'a central directory entry claims a name/extra/comment length that ' +
			"runs past the central directory's own declared size",
	);

	const nameStart = cursor + CENTRAL_DIRECTORY_FIXED_SIZE;
	const name = utf8Decoder.decode(
		buffer.subarray(nameStart, nameStart + nameLength),
	);

	const extraStart = nameStart + nameLength;
	if (
		uncompressedSize === ZIP64_SENTINEL_32 ||
		compressedSize === ZIP64_SENTINEL_32 ||
		localHeaderOffset === ZIP64_SENTINEL_32
	) {
		const resolved = resolveZip64Extra(buffer, extraStart, extraLength, {
			uncompressedSize,
			compressedSize,
			localHeaderOffset,
		});
		uncompressedSize = resolved.uncompressedSize;
		compressedSize = resolved.compressedSize;
		localHeaderOffset = resolved.localHeaderOffset;
	}

	return {
		entry: {
			name,
			size: uncompressedSize,
			compressedSize,
			compressionMethod,
			encrypted: !!(generalPurposeFlag & ENCRYPTED_FLAG),
			localHeaderOffset,
		},
		nextCursor,
	};
}

/**
 * Reads the Zip64 Extended Information extra field to recover whichever
 * of the three sentinel-valued (0xffffffff) fields need it, in the
 * fixed order the spec defines (original size, then compressed size,
 * then header offset - present only when their 32-bit counterpart was
 * a sentinel, so the field's actual length depends on which apply).
 * @param {Uint8Array} buffer
 * @param {number} extraStart
 * @param {number} extraLength
 * @param {{ uncompressedSize: number, compressedSize: number, localHeaderOffset: number }} sentinelValues
 */
function resolveZip64Extra(buffer, extraStart, extraLength, sentinelValues) {
	const extra = buffer.subarray(extraStart, extraStart + extraLength);
	const extraView = new DataView(
		extra.buffer,
		extra.byteOffset,
		extra.byteLength,
	);
	let i = 0;
	/** @type {Uint8Array | null} */
	let zip64Field = null;
	while (i + 4 <= extra.length) {
		const id = u16(extraView, i);
		const size = u16(extraView, i + 2);
		if (id === ZIP64_EXTRA_FIELD_ID) {
			zip64Field = extra.subarray(i + 4, i + 4 + size);
			break;
		}
		i += 4 + size;
	}
	if (!zip64Field) {
		throw new ZipFormatError(
			'entry needs a zip64 extra field but none was present',
		);
	}
	const fieldView = new DataView(
		zip64Field.buffer,
		zip64Field.byteOffset,
		zip64Field.byteLength,
	);
	let cursor = 0;
	let { uncompressedSize, compressedSize, localHeaderOffset } = sentinelValues;
	if (uncompressedSize === ZIP64_SENTINEL_32) {
		requireLength(
			zip64Field.subarray(cursor),
			8,
			'zip64 extra field is too short to supply the original size it needs to',
		);
		uncompressedSize = u64(fieldView, cursor);
		cursor += 8;
	}
	if (compressedSize === ZIP64_SENTINEL_32) {
		requireLength(
			zip64Field.subarray(cursor),
			8,
			'zip64 extra field is too short to supply the compressed size it needs to',
		);
		compressedSize = u64(fieldView, cursor);
		cursor += 8;
	}
	if (localHeaderOffset === ZIP64_SENTINEL_32) {
		requireLength(
			zip64Field.subarray(cursor),
			8,
			'zip64 extra field is too short to supply the header offset it needs to',
		);
		localHeaderOffset = u64(fieldView, cursor);
		cursor += 8;
	}
	return { uncompressedSize, compressedSize, localHeaderOffset };
}

/**
 * Pure parsing entry point: given the archive's tail chunk (enough to
 * contain the EOCDR + comment) and a `readRange` for fetching further
 * small ranges on demand (Zip64 locator/record, central directory),
 * returns every entry's metadata. No `File`/`FileReaderSync` dependency,
 * which is what makes this testable with plain buffers (zipSource.test.js).
 * @param {Uint8Array} tail
 * @param {number} archiveLength
 * @param {(offset: number, length: number) => Uint8Array} readRange
 * @returns {RawZipEntry[]}
 */
export function parseCentralDirectory(tail, archiveLength, readRange) {
	const { offsetInTail, view } = locateEocdr(tail, archiveLength);
	const eocdrFileOffset = archiveLength - (tail.length - offsetInTail);

	let entryCount = u16(view, offsetInTail + 10);
	let centralDirectorySize = u32(view, offsetInTail + 12);
	let centralDirectoryOffset = u32(view, offsetInTail + 16);

	if (needsZip64Locator(entryCount, centralDirectoryOffset)) {
		const zip64 = readZip64Locator(readRange, eocdrFileOffset);
		entryCount = zip64.entryCount;
		centralDirectorySize = zip64.centralDirectorySize;
		centralDirectoryOffset = zip64.centralDirectoryOffset;
	}

	const cdBytes = readRange(centralDirectoryOffset, centralDirectorySize);
	requireLength(
		cdBytes,
		centralDirectorySize,
		'central directory claims to extend past the end of the archive',
	);
	/** @type {RawZipEntry[]} */
	const entries = [];
	let cursor = 0;
	for (let i = 0; i < entryCount; i++) {
		const { entry, nextCursor } = parseCentralDirectoryEntry(cdBytes, cursor);
		entries.push(entry);
		cursor = nextCursor;
	}
	return entries;
}

/**
 * Given a raw central-directory entry, reads that entry's *local* file
 * header (which can carry a different name/extra-field length than the
 * central directory's copy of it - the only spec-correct way to find
 * where the actual file data starts) and returns the absolute file
 * offset the data begins at.
 * @param {(offset: number, length: number) => Uint8Array} readRange
 * @param {RawZipEntry} entry
 * @returns {number}
 */
export function resolveDataOffset(readRange, entry) {
	const header = readRange(entry.localHeaderOffset, LOCAL_HEADER_FIXED_SIZE);
	requireLength(
		header,
		LOCAL_HEADER_FIXED_SIZE,
		`"${entry.name}"'s local file header at offset ${entry.localHeaderOffset} ` +
			'runs past the end of the archive',
	);
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	if (u32(view, 0) !== LOCAL_HEADER_SIGNATURE) {
		throw new ZipFormatError(
			`invalid local file header for "${entry.name}" at offset ${entry.localHeaderOffset}`,
		);
	}
	const nameLength = u16(view, 26);
	const extraLength = u16(view, 28);
	return (
		entry.localHeaderOffset + LOCAL_HEADER_FIXED_SIZE + nameLength + extraLength
	);
}

/**
 * @typedef {{
 *   name: string,
 *   size: number,
 *   compressionMethod: number,
 *   dataOffset: number | null,
 * }} ZipEntryInfo
 * `dataOffset` is only populated (and only meaningful) for STORE
 * entries - see the module doc comment for why DEFLATE can't get one.
 */

/**
 * Reads `length` bytes at `offset` from `file` synchronously. Only
 * valid inside a Worker (`FileReaderSync` is a Worker-only global) -
 * same constraint as `fileReaders()` in source.js.
 * @param {File} file
 * @param {number} offset
 * @param {number} length
 * @returns {Uint8Array}
 */
function syncReadRange(file, offset, length) {
	const reader = new FileReaderSync();
	const bytes = new Uint8Array(
		reader.readAsArrayBuffer(file.slice(offset, offset + length)),
	);
	trackRead(bytes.length);
	return bytes;
}

/**
 * True for a name that's absolute, escapes upward via a `..` segment, or
 * contains a raw NUL byte - the classic "Zip Slip" shape, e.g.
 * `../../../etc/passwd`. This app never extracts to a real filesystem
 * path, so there's nothing to escape, but rejecting the shape up front
 * keeps a hostile name out of the entries[] tree entirely.
 * @param {string} name
 * @returns {boolean}
 */
function isUnsafeEntryName(name) {
	if (name.includes('\0')) return true;
	if (name.startsWith('/') || name.startsWith('\\')) return true;
	return name.split(/[/\\]/).includes('..');
}

/**
 * The validation/dataOffset-resolution half of readZipEntries(), split
 * out as its own pure function (only `readRange` + plain data in, no
 * `File`/`FileReaderSync`) so it's directly testable with the same
 * plain-buffer `readRange` stand-in parseCentralDirectory() already is -
 * see this module's test file.
 * @param {RawZipEntry[]} rawEntries
 * @param {number} archiveLength
 * @param {(offset: number, length: number) => Uint8Array} readRange
 * @param {(entry: RawZipEntry) => number | null} [resolveOffset] override for
 *   how a STORE entry's dataOffset gets resolved. Defaults to one
 *   `resolveDataOffset(readRange, entry)` call per entry - readZipEntries()
 *   passes a batched version instead (see resolveDataOffsetsBatched()) so
 *   this stays the pure/testable default rather than every caller needing
 *   to know about batching.
 * @returns {ZipEntryInfo[]}
 */
export function resolveZipEntries(
	rawEntries,
	archiveLength,
	readRange,
	resolveOffset = (e) =>
		e.compressionMethod === 0 ? resolveDataOffset(readRange, e) : null,
) {
	/** Catches two entries resolving to the same name - lets an archive
	 * smuggle different content past whatever reads an entry first (e.g.
	 * a scanner) vs. whatever reads it last. */
	const seenNames = new Set();

	/**
	 * Each STORE entry's data region is bounded to end before the next
	 * entry's local header (by physical file offset, not CD listing
	 * order). Without this, a forged/inflated extraLength in an entry's
	 * *local* header - which legitimately can differ from the central
	 * directory's copy - could walk resolveDataOffset()'s computed offset
	 * past this entry's own data and into a later entry's, returning that
	 * entry's bytes under this entry's name/size.
	 */
	const sortedOffsets = [
		...new Set(rawEntries.map((e) => e.localHeaderOffset)),
	].sort((a, b) => a - b);
	/** @param {number} localHeaderOffset @returns {number} */
	function nextEntryBoundary(localHeaderOffset) {
		let lo = 0;
		let hi = sortedOffsets.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sortedOffsets[mid] <= localHeaderOffset) lo = mid + 1;
			else hi = mid;
		}
		return lo < sortedOffsets.length ? sortedOffsets[lo] : archiveLength;
	}

	return rawEntries
		.filter((e) => !(e.size === 0 && e.name.endsWith('/'))) // directory entries
		.map((e) => {
			if (e.encrypted) {
				throw new ZipFormatError(`"${e.name}" is encrypted and can't be read`);
			}
			if (isUnsafeEntryName(e.name)) {
				throw new ZipFormatError(`"${e.name}" has an unsafe or malformed path`);
			}
			if (seenNames.has(e.name)) {
				throw new ZipFormatError(`duplicate entry name "${e.name}"`);
			}
			seenNames.add(e.name);
			const dataOffset = resolveOffset(e);
			if (dataOffset !== null) {
				if (dataOffset + e.size > archiveLength) {
					throw new ZipFormatError(
						`"${e.name}" claims data past the end of the archive`,
					);
				}
				if (dataOffset + e.size > nextEntryBoundary(e.localHeaderOffset)) {
					throw new ZipFormatError(
						`"${e.name}"'s local header name/extra-field length pushes its ` +
							`data into another entry's region - the archive is malformed ` +
							`or was crafted to substitute another entry's content`,
					);
				}
			}
			return {
				name: e.name,
				size: e.size,
				compressionMethod: e.compressionMethod,
				dataOffset,
			};
		});
}

/**
 * Resolves every STORE entry's dataOffset via `windowedRead` (a
 * `makeWindowedReadFn()`-shaped cache) instead of one raw read per entry.
 * Split out from resolveDataOffsetsBatched() as a pure function - only a
 * read callback + plain data in - so it's directly testable with a
 * spy/counting stand-in, the same way parseCentralDirectory() and
 * resolveZipEntries() already are in this module.
 *
 * Walking entries in offset order means each entry is either already
 * covered by the current cached window (free) or triggers exactly one
 * fill for the next stretch - never redundant re-reads of the same
 * region, regardless of how the caller ordered `entries`.
 * @param {(offset: number, length: number) => Uint8Array} windowedRead
 * @param {RawZipEntry[]} entries STORE entries only (compressionMethod === 0)
 * @returns {Map<number, number>} localHeaderOffset -> resolved dataOffset
 */
export function resolveDataOffsetsBatchedOver(windowedRead, entries) {
	/** @type {Map<number, number>} */
	const offsetByHeader = new Map();
	const sorted = [...entries].sort(
		(a, b) => a.localHeaderOffset - b.localHeaderOffset,
	);
	for (const entry of sorted) {
		// The same offset can legitimately repeat if two CD records
		// somehow point at the same header (caught as a duplicate name
		// elsewhere), so there's no need to resolve it twice.
		if (offsetByHeader.has(entry.localHeaderOffset)) continue;
		offsetByHeader.set(
			entry.localHeaderOffset,
			resolveDataOffset(windowedRead, entry),
		);
	}
	return offsetByHeader;
}

/**
 * Two headers are combined into the same batched read as long as the gap
 * between them is no larger than this - i.e. we're willing to fetch (and
 * throw away) up to this many bytes of "don't care" filler if it means
 * saving a whole extra round trip. Local headers are only ever 30 bytes
 * of *useful* payload each, so this is chosen to be generous enough to
 * fully collapse a densely-packed archive (thousands of small entries a
 * few hundred bytes to a few KB apart - ROM/homebrew-style collections)
 * into a handful of reads, while still being small change next to a
 * single IPC round trip's fixed latency.
 */
const HEADER_COALESCE_GAP_BYTES = 256 * 1024;

/**
 * Hard ceiling on one batched read, regardless of how many headers it
 * covers or how tightly they're packed. Bounds both peak memory (each
 * batch is discarded once we've moved past it - see
 * makeCoalescedHeaderReadFn()) and worst-case waste for a pathological
 * archive with many entries individually just under the coalesce gap.
 * `HEADER_COALESCE_GAP_BYTES` (not this) is what stops the sparse,
 * multi-gigabyte-apart case from ever reaching it.
 */
const HEADER_BATCH_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Groups sorted, deduplicated local-header offsets into the smallest
 * number of sequential byte ranges such that every header's
 * `LOCAL_HEADER_FIXED_SIZE` bytes are fully covered by exactly one range,
 * two headers only share a range when the gap between them is within
 * `HEADER_COALESCE_GAP_BYTES`, and no range exceeds `HEADER_BATCH_MAX_BYTES`.
 *
 * This app's real workload - multi-gigabyte Xbox ISOs zipped together -
 * has entries gigabytes apart, so a fixed-size scan window buys nothing
 * there while still fetching bytes it'll never use. Coalescing by
 * actual gap size adapts to both shapes: dense entries collapse into
 * one read, sparse entries each get one tight ~30-byte read instead.
 * @param {number[]} sortedOffsets strictly increasing, deduplicated
 * @returns {{ start: number, length: number }[]}
 */
export function planHeaderReadBatches(sortedOffsets) {
	if (sortedOffsets.length === 0) return [];
	/** @type {{ start: number, length: number }[]} */
	const batches = [];
	let start = sortedOffsets[0];
	let end = start + LOCAL_HEADER_FIXED_SIZE;
	for (let i = 1; i < sortedOffsets.length; i++) {
		const offset = sortedOffsets[i];
		const prospectiveEnd = offset + LOCAL_HEADER_FIXED_SIZE;
		const gap = offset - end;
		if (
			gap <= HEADER_COALESCE_GAP_BYTES &&
			prospectiveEnd - start <= HEADER_BATCH_MAX_BYTES
		) {
			end = prospectiveEnd;
		} else {
			batches.push({ start, length: end - start });
			start = offset;
			end = prospectiveEnd;
		}
	}
	batches.push({ start, length: end - start });
	return batches;
}

/**
 * Builds a `windowedRead`-shaped function (same `(offset, length) =>
 * Uint8Array` shape `makeWindowedReadFn()` produces) over a precomputed
 * batch plan (see `planHeaderReadBatches()`) instead of a fixed-size
 * cache. Only one batch's bytes are ever held at a time - it's replaced,
 * not merged, the moment a read moves past it - which callers can rely
 * on since `resolveDataOffsetsBatchedOver()` always visits headers in
 * ascending offset order.
 * @param {(offset: number, length: number) => Uint8Array} readRange
 * @param {number[]} sortedOffsets strictly increasing, deduplicated
 * @returns {(offset: number, length: number) => Uint8Array}
 */
export function makeCoalescedHeaderReadFn(readRange, sortedOffsets) {
	const batches = planHeaderReadBatches(sortedOffsets);
	let batchIndex = 0;
	/** @type {{ start: number, bytes: Uint8Array } | null} */
	let cached = null;
	return (/** @type {number} */ offset, /** @type {number} */ length) => {
		while (
			batchIndex < batches.length - 1 &&
			offset >= batches[batchIndex].start + batches[batchIndex].length
		) {
			batchIndex++;
		}
		const batch = batches[batchIndex];
		if (!cached || cached.start !== batch.start) {
			cached = { start: batch.start, bytes: readRange(batch.start, batch.length) };
		}
		const relStart = offset - cached.start;
		return cached.bytes.subarray(relStart, relStart + length);
	};
}

/**
 * How many header batches to have in flight at once during
 * `prefetchHeaderBatches()`. `File.slice().arrayBuffer()` is I/O-bound
 * (waiting on IPC/disk, not CPU) so this is chosen the same way
 * `WorkerPool`'s own concurrency cap is: high enough to overlap a lot of
 * round trips, low enough not to flood a slow `content://` provider with
 * more concurrent requests than it can usefully pipeline.
 */
const HEADER_PREFETCH_CONCURRENCY = 16;

/**
 * Fetches every batch `planHeaderReadBatches()` computed concurrently
 * (bounded by `HEADER_PREFETCH_CONCURRENCY`) instead of one at a time.
 *
 * Matters most for archives like a few thousand entries a couple
 * megabytes apart: too sparse for `HEADER_COALESCE_GAP_BYTES` to
 * collapse into few batches, so it's still roughly one batch per entry
 * - but `Blob.arrayBuffer()` is async, so firing several off at once
 * lets their `content://` IPC round trips overlap instead of
 * serializing. A dense archive that already collapsed to one or two
 * batches just runs those concurrently too, harmlessly.
 * @param {File} file
 * @param {{ start: number, length: number }[]} batches
 * @returns {Promise<Uint8Array[]>} bytes for each batch, same order/index as `batches`
 */
async function prefetchHeaderBatches(file, batches) {
	/** @type {Uint8Array[]} */
	const results = new Array(batches.length);
	let nextIndex = 0;
	async function runLane() {
		for (;;) {
			const i = nextIndex++;
			if (i >= batches.length) return;
			const { start, length } = batches[i];
			const buffer = await file.slice(start, start + length).arrayBuffer();
			results[i] = new Uint8Array(buffer);
			trackRead(length);
		}
	}
	const laneCount = Math.min(HEADER_PREFETCH_CONCURRENCY, batches.length);
	await Promise.all(Array.from({ length: laneCount }, runLane));
	return results;
}

/**
 * Same `(offset, length) => Uint8Array` shape `makeCoalescedHeaderReadFn()`
 * produces, but served from bytes already fetched by
 * `prefetchHeaderBatches()` instead of fetching lazily as the cursor
 * reaches each batch. Callers must still visit offsets in ascending
 * order (same requirement `resolveDataOffsetsBatchedOver()` already
 * meets).
 * @param {{ start: number, length: number }[]} batches
 * @param {Uint8Array[]} batchBytes same order/index as `batches`
 * @returns {(offset: number, length: number) => Uint8Array}
 */
function makePrefetchedHeaderReadFn(batches, batchBytes) {
	let batchIndex = 0;
	return (/** @type {number} */ offset, /** @type {number} */ length) => {
		while (
			batchIndex < batches.length - 1 &&
			offset >= batches[batchIndex].start + batches[batchIndex].length
		) {
			batchIndex++;
		}
		const batch = batches[batchIndex];
		const relStart = offset - batch.start;
		return batchBytes[batchIndex].subarray(relStart, relStart + length);
	};
}

/**
 * Resolves every STORE entry's local-header offset, fetching the
 * (gap-coalesced, see `planHeaderReadBatches()`) header batches
 * concurrently rather than one at a time.
 *
 * A `File` backed by an Android `content://` URI routes each
 * `File.slice().arrayBuffer()` call through IPC to the document
 * provider, and per-call latency there can dominate completely - a zip
 * with thousands of entries a few megabytes apart barely coalesces
 * (past `HEADER_COALESCE_GAP_BYTES`), so it's still nearly one round
 * trip per entry. Fetching those concurrently instead of sequentially
 * is what actually fixes that shape: the round trips still happen, but
 * overlap instead of queueing.
 * @param {File} file
 * @param {RawZipEntry[]} entries STORE entries only (compressionMethod === 0)
 * @returns {Promise<Map<number, number>>} localHeaderOffset -> resolved dataOffset
 */
async function resolveDataOffsetsBatched(file, entries) {
	if (entries.length === 0) return new Map();
	const sortedOffsets = [
		...new Set(entries.map((e) => e.localHeaderOffset)),
	].sort((a, b) => a - b);
	const batches = planHeaderReadBatches(sortedOffsets);
	const batchBytes = await prefetchHeaderBatches(file, batches);
	const readFn = makePrefetchedHeaderReadFn(batches, batchBytes);
	return resolveDataOffsetsBatchedOver(readFn, entries);
}

/**
 * Parses `file`'s central directory and returns every entry's metadata,
 * with `dataOffset` resolved for STORE entries so they're immediately
 * ready for random-access reads via `sliceSourceFile()`. Must run
 * inside a Worker.
 * @param {File} file the dropped/selected zip file
 * @returns {Promise<ZipEntryInfo[]>}
 */
export async function readZipEntries(file) {
	const archiveLength = file.size;
	const tailLength = Math.min(
		EOCDR_FIXED_SIZE + MAX_COMMENT_SIZE,
		archiveLength,
	);
	const tail = syncReadRange(file, archiveLength - tailLength, tailLength);
	const readRange = (
		/** @type {number} */ offset,
		/** @type {number} */ length,
	) => syncReadRange(file, offset, length);

	// Locating the EOCDR/central directory is always just a couple of
	// reads regardless of entry count, so this stays on the plain
	// synchronous path. Only per-entry header resolution below scales
	// with entry count and actually needs the concurrent prefetch.
	const rawEntries = parseCentralDirectory(tail, archiveLength, readRange);

	// See resolveDataOffsetsBatched(): it resolves every STORE entry's
	// dataOffset via concurrently-fetched header batches instead of one
	// blocking read per entry. That's the difference between this
	// returning instantly and taking a minute or more on Android
	// content:// files with a couple thousand entries.
	const storeEntries = rawEntries.filter((e) => e.compressionMethod === 0);
	const batchedOffsets = await resolveDataOffsetsBatched(file, storeEntries);
	const resolveOffset = (/** @type {RawZipEntry} */ e) =>
		e.compressionMethod === 0
			? (batchedOffsets.get(e.localHeaderOffset) ?? null)
			: null;

	return resolveZipEntries(rawEntries, archiveLength, readRange, resolveOffset);
}

/**
 * `File.prototype.slice()`, generalized to also accept a
 * `ZipEntryFileRef`. The only place in the app that needs to know a
 * `SourceFile` might be a zip entry - every read site calls this
 * instead of `.slice()` directly. Branches on the `kind: 'zipEntry'`
 * tag rather than `instanceof File` so any other `.slice()`-shaped
 * value passes through untouched.
 * @param {SourceFile} file
 * @param {number} offset
 * @param {number} length
 * @returns {Blob}
 */
export function sliceSourceFile(file, offset, length) {
	if ('kind' in file) {
		return file.zipFile.slice(
			file.dataOffset + offset,
			file.dataOffset + offset + length,
		);
	}
	return file.slice(offset, offset + length);
}

/**
 * @typedef {{ entries: string[], files: ZipEntryFileRef[], unsupported: boolean }} ZipExpansion
 */

/**
 * Expands one dropped zip `File` into the `(entries[], files[])` shape
 * the drop-partitioning pipeline (source.js) works with, as if it had
 * been extracted in place at `pathPrefix`.
 *
 * If the archive contains any DEFLATE entry it's entirely unreadable by
 * this random-access reader (see module doc comment), so this returns
 * `unsupported: true` with empty `entries`/`files` rather than partially
 * expanding the STORE entries. Directory entries are dropped silently.
 *
 * Must run inside a Worker. Throws if the zip can't be parsed at all -
 * callers should catch this and surface it like any other whole-source
 * failure, not as a raw unhandled rejection.
 * @param {File} zipFile
 * @param {string} pathPrefix e.g. '' or 'Games/'
 * @returns {Promise<ZipExpansion>}
 */
export async function expandZipFile(zipFile, pathPrefix) {
	const rawEntries = await readZipEntries(zipFile);

	if (rawEntries.some((entry) => entry.compressionMethod !== 0)) {
		return { entries: [], files: [], unsupported: true };
	}

	/** @type {string[]} */
	const entries = [];
	/** @type {ZipEntryFileRef[]} */
	const files = [];

	for (const entry of rawEntries) {
		const base = entry.name.slice(entry.name.lastIndexOf('/') + 1);
		entries.push(pathPrefix + entry.name);
		files.push({
			kind: 'zipEntry',
			name: base,
			size: entry.size,
			zipFile,
			// The early return above guarantees every entry here is
			// STORE (compressionMethod === 0), so dataOffset is
			// always resolved (see resolveZipEntries()).
			dataOffset: /** @type {number} */ (entry.dataOffset),
			// The entry's own path *inside* the zip, not
			// pathPrefix-qualified; see ZipEntryFileRef's doc comment.
			// Used by sourceLabels.js's assignZipLabels() to find a
			// per-game parent folder for a multi-game zip.
			entryPath: entry.name,
		});
	}

	return { entries, files, unsupported: false };
}
