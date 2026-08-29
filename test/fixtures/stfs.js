/**
 * Generates a minimal, structurally valid STFS (LIVE/PIRS/CON) package
 * fixture for e2e conversion tests.
 *
 * Layout reference: https://free60.org/System-Software/Formats/STFS/
 *
 * Physical layout (headerSize fixed at 0x1000, blockSeparation fixed at
 * 1, so firstHashTableAddress = 0x1000, shift 0, no spacer block):
 *   0x000:          magic (4 bytes: "CON ", "LIVE", or "PIRS")
 *   0x340:          header_size (u32 BE)
 *   0x379..0x39D:   volume descriptor (0x24 bytes)
 *   0x1000..0x2000: the package's only hash table block - entries for
 *                   block 0 (file-table) and block 1 (data)
 *   0x2000..0x3000: file-table block - one entry for `fileName`
 *   0x3000..0x4000: file data - a minimal XEX2 stub, or `fileBytes`
 */

// "Content Packages" header table:
// https://free60.org/System-Software/Formats/STFS/#content-packages
const HEADER_SIZE_FIELD_OFFSET = 0x340;
const VOLUME_DESCRIPTOR_OFFSET = 0x379;

// Hash-tree record layout, "Hash Tables / Block Offsets":
// https://free60.org/System-Software/Formats/STFS/#hash-tables-block-offsets
const HASH_ENTRY_SIZE = 0x18; // 0x14-byte hash + 1-byte status + 3-byte next-block
const STATUS_BYTE_OFFSET = 0x14;
const NEXT_BLOCK_OFFSET = 0x15;
const CHAIN_TERMINATOR = 0xffffff;
const BLOCK_SIZE = 0x1000;

// A level-0 hash table covers 0xAA (170) blocks - this fixture is always
// well under that (2 allocated blocks), so only the level-0 math is
// needed here (no level-1/level-2 group-size constants, no blockStep).
const LEVEL0_GROUP_SIZE = 0xaa;

// Optional-header entry for MediaID/Version/BaseVersion/TitleID:
// https://free60.org/System-Software/Formats/XEX/
const XEX_FIELD_ID_EXECUTION_ID = 0x00040006;
const XEX_EXECUTION_INFO_OFFSET = 0x30;

/**
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {string} s
 */
function writeAscii(buf, offset, s) {
	for (let i = 0; i < s.length; i++) {
		buf[offset + i] = s.charCodeAt(i);
	}
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @param {number} value
 */
function writeInt24LE(view, offset, value) {
	view.setUint8(offset, value & 0xff);
	view.setUint8(offset + 1, (value >> 8) & 0xff);
	view.setUint8(offset + 2, (value >> 16) & 0xff);
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @param {number} value
 */
function writeInt24BE(view, offset, value) {
	view.setUint8(offset, (value >> 16) & 0xff);
	view.setUint8(offset + 1, (value >> 8) & 0xff);
	view.setUint8(offset + 2, value & 0xff);
}

// Matches Velocity/XboxInternals's StfsPackage::ComputeBackingDataBlockNumber
// term for term, restricted to the n < LEVEL0_GROUP_SIZE case (the only
// one this fixture builder ever exercises).
/**
 * @param {number} n
 * @param {number} shift
 */
function computeBackingDataBlockNumber(n, shift) {
	return (Math.floor((n + LEVEL0_GROUP_SIZE) / LEVEL0_GROUP_SIZE) << shift) + n;
}

/**
 * @param {number} backingBlock
 * @param {number} firstHashTableAddress
 */
function blockToFileAddress(backingBlock, firstHashTableAddress) {
	return (backingBlock << 0xc) + firstHashTableAddress;
}

/**
 * Writes one hash-tree record's status+next-block fields (allocated,
 * chain-terminated) at `localOffset`. The hash itself is left zeroed -
 * the reader never verifies it.
 * @param {Uint8Array} buf
 * @param {DataView} view
 * @param {number} localOffset
 */
function writeHashEntry(buf, view, localOffset) {
	buf[localOffset + STATUS_BYTE_OFFSET] = 0x80; // status: allocated
	writeInt24BE(view, localOffset + NEXT_BLOCK_OFFSET, CHAIN_TERMINATOR);
}

/**
 * Same field layout as xfs.js's XEX2 stub writer, all fields big-endian.
 * @param {Uint8Array} buf
 * @param {DataView} view
 * @param {number} offset
 * @param {{ titleId: number, version: number }} info
 */
function writeXexStub(buf, view, offset, info) {
	writeAscii(buf, offset + 0x00, 'XEX2');
	view.setUint32(offset + 0x14, 1, false); // field_count
	view.setUint32(offset + 0x18, XEX_FIELD_ID_EXECUTION_ID, false);
	view.setUint32(offset + 0x1c, XEX_EXECUTION_INFO_OFFSET, false);
	const INFO = offset + XEX_EXECUTION_INFO_OFFSET;
	view.setUint32(INFO + 0x00, 0, false); // media_id
	view.setUint32(INFO + 0x04, info.version, false);
	view.setUint32(INFO + 0x08, 0, false); // base_version
	view.setUint32(INFO + 0x0c, info.titleId, false);
	buf[INFO + 0x10] = 0; // platform
	buf[INFO + 0x11] = 0; // executable_type
	buf[INFO + 0x12] = 1; // disc_number
	buf[INFO + 0x13] = 1; // disc_count
}

/**
 * @param {{
 *   magic?: 'CON ' | 'LIVE' | 'PIRS',
 *   titleId?: number,
 *   version?: number,
 *   fileName?: string,
 *   fileBytes?: Uint8Array,
 * }} [opts]
 * @returns {Uint8Array}
 */
export function makeStfsFixture(opts = {}) {
	const magic = opts.magic ?? 'CON ';
	const headerSize = 0x1000;
	const blockSeparation = 1;
	const titleId = opts.titleId ?? 0x5a5a0001;
	const version = opts.version ?? 1;
	const fileName = opts.fileName ?? 'default.xex';
	const fileBytes = opts.fileBytes;

	if (fileName.length === 0 || fileName.length > 0x28) {
		throw new Error(
			`fileName must be 1-40 ASCII characters, got length ${fileName.length}`,
		);
	}
	if (fileBytes && fileBytes.length > BLOCK_SIZE) {
		throw new Error(
			`fileBytes must fit in one data block (<= ${BLOCK_SIZE} bytes), got ${fileBytes.length}`,
		);
	}

	const FILE_TABLE_BLOCK = 0;
	const DATA_BLOCK = 1;
	const ALLOCATED_BLOCK_COUNT = 2;
	const shift = ~blockSeparation & 1;
	const firstHashTableAddress = (headerSize + 0xfff) & 0xfffff000;

	/** @param {number} blockNum */
	function blockToAddress(blockNum) {
		return blockToFileAddress(
			computeBackingDataBlockNumber(blockNum, shift),
			firstHashTableAddress,
		);
	}
	/** @param {number} blockNum */
	function hashAddressOfBlock(blockNum) {
		// The level-0 backing hash block number is always 0 here, since
		// both blocks in this fixture are under LEVEL0_GROUP_SIZE.
		return (
			(0 << 0xc) +
			firstHashTableAddress +
			(blockNum % LEVEL0_GROUP_SIZE) * HASH_ENTRY_SIZE +
			((blockSeparation & 2) << 0xb)
		);
	}

	const fileTableAddr = blockToAddress(FILE_TABLE_BLOCK);
	const dataAddr = blockToAddress(DATA_BLOCK);
	const declaredSize = fileBytes ? fileBytes.length : 0x100;
	const totalSize = dataAddr + 0x1000;
	const buf = new Uint8Array(totalSize);
	const view = new DataView(buf.buffer);

	// header
	writeAscii(buf, 0, magic);
	view.setUint32(HEADER_SIZE_FIELD_OFFSET, headerSize, false);

	// volume descriptor @ 0x379
	const VD = VOLUME_DESCRIPTOR_OFFSET;
	buf[VD + 0] = 0x24; // descriptor's own size
	buf[VD + 1] = 0;
	buf[VD + 2] = blockSeparation;
	view.setUint16(VD + 3, 1, true);
	writeInt24LE(view, VD + 5, FILE_TABLE_BLOCK);
	view.setUint32(VD + 0x1c, ALLOCATED_BLOCK_COUNT, false);
	view.setUint32(VD + 0x20, 0, false);

	// the one hash table block, at firstHashTableAddress
	for (const block of [FILE_TABLE_BLOCK, DATA_BLOCK]) {
		writeHashEntry(buf, view, hashAddressOfBlock(block));
	}

	// file-table block (block 0): one entry for fileName
	writeAscii(buf, fileTableAddr, fileName);
	buf[fileTableAddr + 0x28] = fileName.length;
	writeInt24LE(view, fileTableAddr + 0x29, 1); // blocksForFile
	writeInt24LE(view, fileTableAddr + 0x2c, 1); // copy of 0x29
	writeInt24LE(view, fileTableAddr + 0x2f, DATA_BLOCK);
	view.setUint16(fileTableAddr + 0x32, 0xffff, false); // pathIndicator = root
	view.setUint32(fileTableAddr + 0x34, declaredSize, false);

	// file data (block 1): caller-supplied bytes, or a minimal XEX2 stub
	if (fileBytes) {
		buf.set(fileBytes, dataAddr);
	} else {
		writeXexStub(buf, view, dataAddr, { titleId, version });
	}

	return buf;
}
