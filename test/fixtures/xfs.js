/**
 * Generates a minimal valid Xbox ISO fixture for e2e conversion tests.
 *
 * Produces an XDVDFS volume containing a single launch executable -
 * `default.xbe` (platform: 'ogx') or a genuinely valid `default.xex`
 * (platform: 'x360') - optionally preceded by `rootOffset` bytes of
 * padding before the volume, and optionally a `$SystemUpdate` directory
 * (for exercising the "skip system update" conversion option end-to-end).
 *
 * This is a plain-JS sibling of the wasm test suite's own fixture builder
 * (test/utils/fixtures/xsf.ts) and stays byte-layout compatible with it,
 * but doesn't import from it - e2e specs run outside the wasm package, so
 * a couple of small helpers (writeAscii, the cert offset constants) are
 * duplicated here instead. It also supports `mediaId`/`discNumber`/
 * `discCount`, which xsf.ts doesn't need since only this suite's
 * multi-disc tests use them.
 *
 * The directory table is a minimal binary search tree, per the XDVDFS
 * spec: only one or two root entries are ever written here (the launch
 * executable, plus `$SystemUpdate` when requested), chained right-only in
 * the order they're written - see `writeDirectoryEntry`.
 */

// XDVDFS sector size: https://xboxdevwiki.net/XDVDFS
// Exported because split.js's makeUnresolvedSplitFragments() and
// test-data.js's splitIsoPair() both need to slice a fixture buffer on a
// sector boundary.
export const SECTOR_SIZE = 0x800;
const DIR_SECTOR = 0x21;
const XBE_SECTOR = 0x22;
const SYSTEM_UPDATE_DIR_SECTOR = 0x23;
const SYSTEM_UPDATE_FILE_SECTOR = 0x24;
const XBE_BASE_ADDR = 0x10000;
const XBE_CERT_OFFSET = 0x200;
const XBE_CERT_VIRT = XBE_BASE_ADDR + XBE_CERT_OFFSET;

// XBE certificate field layout: https://xboxdevwiki.net/Xbe#Certificate
const XBE_CERT_TITLE_ID_OFFSET = 0x08;
const XBE_CERT_VERSION_OFFSET = 0xac; // dw_version - NOT 0xb0 (that's bzLanKey)

// XEX2 optional-header field id for "ExecutionId".
// Field id table: https://free60.org/System-Software/Formats/XEX/
const XEX_FIELD_ID_EXECUTION_ID = 0x00040006;
// Offset of the 20-byte TitleExecutionInfo struct from the XEX header start.
const XEX_EXECUTION_INFO_OFFSET = 0x30;

const ATTR_ARCHIVE = 0x20;
const ATTR_DIRECTORY = 0x10;

const SYSTEM_UPDATE_DIR_NAME = '$SystemUpdate';
const SYSTEM_UPDATE_FILE_NAME = 'su20076000.000';
const SYSTEM_UPDATE_FILE_SIZE = 0x100;

export const XGD3_ROOT_OFFSET = 0x2080000;

/**
 * Default declared directory-entry size (bytes) for the fixture's
 * default.xbe/default.xex. Must be >= 0x3D0 to hold a full XBE
 * certificate (cert starts at entry offset 0x200, is 0x1D0 bytes wide)
 * and <= SECTOR_SIZE (0x800) to avoid needing extra physical sectors.
 *
 * Tests that want an undersized XBE (to exercise an out-of-bounds error
 * path) should pass an explicit `xbeDeclaredSize` below 0x3D0.
 */
export const DEFAULT_XBE_DECLARED_SIZE = 0x400;

/**
 * @param {{
 *   titleId?: number,
 *   version?: number,
 *   rootOffset?: number,
 *   platform?: 'ogx' | 'x360',
 *   xbeDeclaredSize?: number,
 *   mediaId?: number,
 *   discNumber?: number,
 *   discCount?: number,
 *   includeSystemUpdate?: boolean,
 * }} [opts]
 * @returns {Uint8Array}
 */
export function makeFixture(opts = {}) {
	const titleId = opts.titleId ?? 0x41560001;
	const version = opts.version ?? 0x00000001;
	const rootOffset = opts.rootOffset ?? 0;
	const platform = opts.platform ?? 'ogx';
	const xbeDeclaredSize = opts.xbeDeclaredSize ?? DEFAULT_XBE_DECLARED_SIZE;
	const includeSystemUpdate = opts.includeSystemUpdate ?? false;
	const exeName = platform === 'x360' ? 'default.xex' : 'default.xbe';

	// Only wired up for 'x360' - the OGX/XBE certificate also has a
	// disc-number field, but its offset isn't confirmed in this builder.
	const wantsDiscInfo =
		opts.mediaId !== undefined ||
		opts.discNumber !== undefined ||
		opts.discCount !== undefined;
	if (platform !== 'x360' && wantsDiscInfo) {
		throw new Error(
			"mediaId/discNumber/discCount are only wired up for platform: 'x360' " +
				"(the OGX/XBE certificate's disc-number field offset isn't confirmed " +
				'in this fixture builder yet - see the doc comment above makeFixture).',
		);
	}
	if (rootOffset % SECTOR_SIZE !== 0) {
		throw new Error(
			`rootOffset must be a multiple of SECTOR_SIZE (${SECTOR_SIZE}), got ${rootOffset}`,
		);
	}
	if (xbeDeclaredSize <= 0 || xbeDeclaredSize > SECTOR_SIZE) {
		throw new Error(
			`xbeDeclaredSize must be > 0 and <= SECTOR_SIZE (${SECTOR_SIZE}), got ${xbeDeclaredSize}`,
		);
	}

	const lastSector = includeSystemUpdate
		? SYSTEM_UPDATE_FILE_SECTOR
		: XBE_SECTOR;
	const volumeSize = (lastSector + 1) * SECTOR_SIZE;
	const buf = new Uint8Array(rootOffset + volumeSize);
	const view = new DataView(buf.buffer);

	// Volume descriptor at sector 0x20.
	const VD = rootOffset + 0x20 * SECTOR_SIZE;
	writeAscii(buf, VD + 0x00, 'MICROSOFT*XBOX*MEDIA');
	view.setUint32(VD + 0x14, DIR_SECTOR, true); // root_directory_sector
	view.setUint32(VD + 0x18, 64, true); // root_directory_size
	writeAscii(buf, VD + 0x7ec, 'MICROSOFT*XBOX*MEDIA');

	// Root directory table at sector 0x21: always the launch executable,
	// plus a $SystemUpdate entry when requested.
	const DIR = rootOffset + DIR_SECTOR * SECTOR_SIZE;
	const entryOffsets = [];
	let cursor = DIR;

	entryOffsets.push(cursor);
	cursor = writeDirectoryEntry(buf, view, cursor, {
		name: exeName,
		sector: XBE_SECTOR,
		size: xbeDeclaredSize,
		attributes: ATTR_ARCHIVE,
	});

	if (includeSystemUpdate) {
		entryOffsets.push(cursor);
		cursor = writeDirectoryEntry(buf, view, cursor, {
			name: SYSTEM_UPDATE_DIR_NAME,
			sector: SYSTEM_UPDATE_DIR_SECTOR,
			size: SECTOR_SIZE, // one sector holds the subdirectory's table
			attributes: ATTR_DIRECTORY,
		});
	}

	// Chain entries into a minimal right-only tree: each entry's `right`
	// points at the DWORD offset (from `DIR`) of the next entry written.
	// `left` stays 0 on every entry (see writeDirectoryEntry).
	for (let i = 0; i < entryOffsets.length - 1; i++) {
		const rightDwordOffset = (entryOffsets[i + 1] - DIR) / 4;
		view.setUint16(entryOffsets[i] + 2, rightDwordOffset, true);
	}

	if (includeSystemUpdate) {
		// $SystemUpdate directory table at sector 0x23, holding one dummy
		// file - only its presence/name matter for "skip system update"
		// tests, not its content, hence the arbitrary fill byte below.
		const SUB_DIR = rootOffset + SYSTEM_UPDATE_DIR_SECTOR * SECTOR_SIZE;
		writeDirectoryEntry(buf, view, SUB_DIR, {
			name: SYSTEM_UPDATE_FILE_NAME,
			sector: SYSTEM_UPDATE_FILE_SECTOR,
			size: SYSTEM_UPDATE_FILE_SIZE,
			attributes: ATTR_ARCHIVE,
		});

		const SU_FILE = rootOffset + SYSTEM_UPDATE_FILE_SECTOR * SECTOR_SIZE;
		buf.fill(0xaa, SU_FILE, SU_FILE + SYSTEM_UPDATE_FILE_SIZE);
	}

	// Stub executable at sector 0x22.
	const EXE = rootOffset + XBE_SECTOR * SECTOR_SIZE;
	if (platform === 'x360') {
		writeXexStub(buf, view, EXE, {
			titleId,
			version,
			mediaId: opts.mediaId,
			discNumber: opts.discNumber,
			discCount: opts.discCount,
		});
	} else {
		writeXbeStub(buf, view, EXE, { titleId, version });
	}
	return buf;
}

/**
 * Writes a minimal XBE-shaped stub with a valid header/certificate.
 * All multi-byte fields little-endian.
 *
 * @param {Uint8Array} buf
 * @param {DataView} view
 * @param {number} offset
 * @param {{ titleId: number, version: number }} info
 */
function writeXbeStub(buf, view, offset, info) {
	writeAscii(buf, offset + 0x000, 'XBEH');
	view.setUint32(offset + 0x104, XBE_BASE_ADDR, true);
	view.setUint32(offset + 0x118, XBE_CERT_VIRT, true);
	const CERT = offset + XBE_CERT_OFFSET;
	view.setUint32(CERT + XBE_CERT_TITLE_ID_OFFSET, info.titleId, true);
	view.setUint32(CERT + XBE_CERT_VERSION_OFFSET, info.version, true);
}

/**
 * Writes a minimal but genuinely valid XEX2-shaped stub: real "XEX2" magic
 * plus one optional-header field (ExecutionId) pointing at a
 * TitleExecutionInfo struct. Field layout reference:
 * https://free60.org/System-Software/Formats/XEX/
 * All multi-byte fields big-endian, unlike XBE's little-endian cert.
 *
 * media_id/disc_number/disc_count aren't read for a single opened source,
 * only by multi-disc batch grouping - defaults here (media_id 0,
 * disc_number 1, disc_count 1) match a genuine single-disc title.
 *
 * @param {Uint8Array} buf
 * @param {DataView} view
 * @param {number} offset
 * @param {{ titleId: number, version: number, mediaId?: number, discNumber?: number, discCount?: number }} info
 */
function writeXexStub(buf, view, offset, info) {
	writeAscii(buf, offset + 0x00, 'XEX2');
	view.setUint32(offset + 0x14, 1, false); // field_count = 1
	view.setUint32(offset + 0x18, XEX_FIELD_ID_EXECUTION_ID, false);
	view.setUint32(offset + 0x1c, XEX_EXECUTION_INFO_OFFSET, false);

	// TitleExecutionInfo, 20 bytes packed, all big-endian:
	const INFO = offset + XEX_EXECUTION_INFO_OFFSET;
	view.setUint32(INFO + 0x00, info.mediaId ?? 0, false); // media_id
	view.setUint32(INFO + 0x04, info.version, false); // version
	view.setUint32(INFO + 0x08, 0, false); // base_version
	view.setUint32(INFO + 0x0c, info.titleId, false); // title_id
	buf[INFO + 0x10] = 0; // platform
	buf[INFO + 0x11] = 0; // executable_type
	buf[INFO + 0x12] = info.discNumber ?? 1; // disc_number
	buf[INFO + 0x13] = info.discCount ?? 1; // disc_count
}

/**
 * Writes a single DirectoryEntry at `offset` and returns the offset of the
 * next entry (4-byte aligned). `subtree_left`/`subtree_right` default to 0
 * ("no child") - the caller wires up `right` pointers afterward when more
 * than one entry ends up in the same table.
 *
 * DirectoryEntry binary layout:
 *   +0  u16 LE subtree_left   (DWORD offset from table start; 0 = no child)
 *   +2  u16 LE subtree_right  (DWORD offset from table start; 0 = no child)
 *   +4  u32 LE sector
 *   +8  u32 LE size
 *  +12  u8  attributes        (0x20 = ARCHIVE, 0x10 = DIRECTORY)
 *  +13  u8  name_length
 *  +14  u8[] name (ASCII), padded to 4-byte alignment
 *
 * @param {Uint8Array} buf
 * @param {DataView} view
 * @param {number} offset
 * @param {{ name: string, sector: number, size: number, attributes: number }} entry
 * @returns {number}
 */
function writeDirectoryEntry(buf, view, offset, entry) {
	view.setUint16(offset + 0, 0x0000, true); // subtree_left
	view.setUint16(offset + 2, 0x0000, true); // subtree_right
	view.setUint32(offset + 4, entry.sector, true);
	view.setUint32(offset + 8, entry.size, true);
	buf[offset + 12] = entry.attributes;
	buf[offset + 13] = entry.name.length;
	writeAscii(buf, offset + 14, entry.name);
	const used = 14 + entry.name.length;
	return offset + Math.ceil(used / 4) * 4;
}

/**
 * Writes `s` as raw ASCII bytes (no NUL terminator) at `offset`.
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {string} s
 */
function writeAscii(buf, offset, s) {
	for (let i = 0; i < s.length; i++) {
		buf[offset + i] = s.charCodeAt(i);
	}
}
