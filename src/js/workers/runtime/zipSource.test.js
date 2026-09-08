import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import {
	parseCentralDirectory,
	resolveDataOffset,
	resolveZipEntries,
	resolveDataOffsetsBatchedOver,
	planHeaderReadBatches,
	makeCoalescedHeaderReadFn,
	ZipFormatError,
} from './zipSource.js';
import { buildZip } from '../../../../test/utils/zipFixture.js';

/**
 * `parseCentralDirectory()`/`resolveDataOffset()` only depend on a
 * `readRange(offset, length)` callback, not on `File`/`FileReaderSync` -
 * that's what makes the parsing logic testable here with a plain
 * buffer, the same way `fileReaders()`'s actual reads aren't exercised
 * in source.test.js (FileReaderSync only exists inside a real Worker).
 * @param {Uint8Array} buffer
 */
function readRangeOver(buffer) {
	return (/** @type {number} */ offset, /** @type {number} */ length) =>
		buffer.subarray(offset, offset + length);
}

/** @param {number} n */
function u16(n) {
	const b = Buffer.alloc(2);
	b.writeUInt16LE(n);
	return b;
}
/** @param {number} n */
function u32(n) {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n >>> 0);
	return b;
}
/** @param {number} n */
function u64(n) {
	const b = Buffer.alloc(8);
	b.writeBigUInt64LE(BigInt(n));
	return b;
}

/**
 * @typedef {{ name: string, data: Buffer, compressionMethod?: number }} FixtureEntry
 */

describe('parseCentralDirectory - plain (non-Zip64) archives', () => {
	it("reads every entry's name, size, and compression method", () => {
		const a = Buffer.from('a'.repeat(300));
		const b = Buffer.from('b'.repeat(150));
		const zip = buildZip([
			{ name: 'folder/a.iso', data: a },
			{ name: 'b.cci', data: b, compressionMethod: 8 },
		]);
		const entries = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		expect(entries).toEqual([
			expect.objectContaining({
				name: 'folder/a.iso',
				size: 300,
				compressionMethod: 0,
			}),
			expect.objectContaining({ name: 'b.cci', size: 150, compressionMethod: 8 }),
		]);
	});

	it("resolves a STORE entry's data offset past its local header + name", () => {
		const data = Buffer.from('hello world');
		const zip = buildZip([{ name: 'x.iso', data }]);
		const [entry] = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		const dataOffset = resolveDataOffset(readRangeOver(zip), entry);
		expect(zip.subarray(dataOffset, dataOffset + data.length)).toEqual(data);
	});

	it('rejects a strong-encrypted entry', () => {
		const data = Buffer.from('secret');
		const zip = buildZip([{ name: 'locked.iso', data }]);
		// Flip on the strong-encryption bit (0x40) in the central directory
		// entry's general-purpose flag field (offset 8, 2 bytes).
		const cdSignatureOffset = zip.indexOf(u32(0x02014b50));
		zip.writeUInt16LE(0x40, cdSignatureOffset + 8);
		expect(() =>
			parseCentralDirectory(zip, zip.length, readRangeOver(zip)),
		).toThrow(/encrypt/i);
	});

	it('rejects a multi-volume archive', () => {
		const zip = buildZip([{ name: 'x.iso', data: Buffer.from('x') }]);
		// Disk-number-start field, offset 34 within the central directory record.
		const cdSignatureOffset = zip.indexOf(u32(0x02014b50));
		zip.writeUInt16LE(1, cdSignatureOffset + 34);
		expect(() =>
			parseCentralDirectory(zip, zip.length, readRangeOver(zip)),
		).toThrow(/multi-volume/i);
	});

	it('throws when no EOCD record can be found', () => {
		const notAZip = Buffer.from('definitely not a zip file');
		expect(() =>
			parseCentralDirectory(notAZip, notAZip.length, readRangeOver(notAZip)),
		).toThrow(/end-of-central-directory/i);
	});
});

describe('resolveZipEntries - name and bounds safety', () => {
	/**
	 * @param {import('./zipSource.js').RawZipEntry[]} rawEntries
	 * @param {number} archiveLength
	 * @param {Buffer} buffer
	 */
	function resolveOver(rawEntries, archiveLength, buffer) {
		return resolveZipEntries(rawEntries, archiveLength, readRangeOver(buffer));
	}

	it('rejects an entry name that escapes upward via a ".." segment', () => {
		const zip = buildZip([
			{ name: '../../../etc/passwd', data: Buffer.from('x') },
		]);
		const rawEntries = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		expect(() => resolveOver(rawEntries, zip.length, zip)).toThrow(
			/unsafe|malformed/i,
		);
	});

	it('rejects an absolute entry name', () => {
		const zip = buildZip([{ name: '/etc/passwd', data: Buffer.from('x') }]);
		const rawEntries = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		expect(() => resolveOver(rawEntries, zip.length, zip)).toThrow(
			/unsafe|malformed/i,
		);
	});

	it('rejects two entries resolving to the same name', () => {
		const zip = buildZip([
			{ name: 'dupe.iso', data: Buffer.from('a') },
			{ name: 'dupe.iso', data: Buffer.from('bb') },
		]);
		const rawEntries = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		expect(() => resolveOver(rawEntries, zip.length, zip)).toThrow(/duplicate/i);
	});

	it("rejects a STORE entry whose declared size runs past the archive's end", () => {
		const zip = buildZip([{ name: 'truncated.iso', data: Buffer.from('hello') }]);
		const rawEntries = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		// Inflate the already-parsed entry's own size, as if the central
		// directory had claimed more data than the archive actually holds -
		// resolveZipEntries() shouldn't need a byte-for-byte corrupted
		// buffer to catch this, just a size that doesn't fit.
		rawEntries[0].size = zip.length * 2;
		expect(() => resolveOver(rawEntries, zip.length, zip)).toThrow(
			/past the end/i,
		);
	});

	it("rejects a STORE entry whose local header name/extra length walks its data offset into another entry's region", () => {
		// Two real entries, "a.txt" then "b.txt", laid out back to back.
		// Tamper only a.txt's *local* header extraLength field (never
		// touched by the central directory, which legitimately can and
		// does differ per spec) so resolveDataOffset() computes an offset
		// that lands inside b.txt's actual data - i.e. reading "a.txt"
		// would silently return b.txt's bytes instead of throwing.
		const aData = Buffer.from('a'.repeat(20));
		const bData = Buffer.from('b'.repeat(20));
		const zip = buildZip([
			{ name: 'a.txt', data: aData },
			{ name: 'b.txt', data: bData },
		]);
		const localSigOffset = zip.indexOf(u32(0x04034b50));
		// extraLength field is local header bytes 28-29; inflate it so the
		// data offset skips clean over a.txt's own data and lands exactly
		// on b.txt's data (whose local header + name is 30 + 5 = 35 bytes,
		// plus a.txt's own 20 bytes of data = 55 total to skip).
		zip.writeUInt16LE(20 + 35, localSigOffset + 28);
		const rawEntries = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		expect(() => resolveOver(rawEntries, zip.length, zip)).toThrow(
			/another entry's region/i,
		);
	});

	it('still resolves a normal multi-entry zip with no safety issues', () => {
		const zip = buildZip([
			{ name: 'a.iso', data: Buffer.from('aaaa') },
			{ name: 'folder/b.iso', data: Buffer.from('bbbb') },
		]);
		const rawEntries = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		const resolved = resolveOver(rawEntries, zip.length, zip);
		expect(resolved.map((e) => e.name)).toEqual(['a.iso', 'folder/b.iso']);
	});
	it('throws (not a raw RangeError) when entryCount claims more entries than the central directory actually contains', () => {
		const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
		// EOCD entry-count fields, offset 10 within the fixed 22-byte record.
		const eocdOffset = zip.length - 22;
		zip.writeUInt16LE(5, eocdOffset + 10);
		zip.writeUInt16LE(5, eocdOffset + 8);
		expect(() =>
			parseCentralDirectory(zip, zip.length, readRangeOver(zip)),
		).toThrow(ZipFormatError);
		expect(() =>
			parseCentralDirectory(zip, zip.length, readRangeOver(zip)),
		).toThrow(/more central directory entries/i);
	});

	it('throws (not a raw RangeError) when a truncated zip64 extra field is too short for the sizes it needs to supply', () => {
		const data = Buffer.from('x');
		const nameBuf = Buffer.from('huge.iso');
		const crc = zlib.crc32(data) >>> 0;
		// zip64 extra field declares id 0x0001 but only 4 bytes of payload -
		// nowhere near the 8 bytes needed for even one sentinel field.
		const shortZip64Extra = Buffer.concat([u16(0x0001), u16(4), Buffer.alloc(4)]);
		const cd = Buffer.concat([
			u32(0x02014b50),
			u16(45),
			u16(45),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(0xffffffff),
			u32(0xffffffff),
			u16(nameBuf.length),
			u16(shortZip64Extra.length),
			u16(0),
			u16(0),
			u16(0),
			u32(0),
			u32(0xffffffff),
			nameBuf,
			shortZip64Extra,
		]);
		const eocd = Buffer.concat([
			u32(0x06054b50),
			u16(0),
			u16(0),
			u16(1),
			u16(1),
			u32(cd.length),
			u32(0),
			u16(0),
		]);
		const zip = Buffer.concat([cd, eocd]);
		expect(() =>
			parseCentralDirectory(zip, zip.length, readRangeOver(zip)),
		).toThrow(ZipFormatError);
		expect(() =>
			parseCentralDirectory(zip, zip.length, readRangeOver(zip)),
		).toThrow(/zip64 extra field is too short/i);
	});
});

describe('parseCentralDirectory - Zip64 archives', () => {
	/**
	 * Builds a single-entry STORE zip whose central directory record
	 * carries Zip64 sentinel values (0xffffffff) for size/offset, backed
	 * by a real Zip64 extended-information extra field, EOCD64 record,
	 * and EOCD64 locator - forcing the Zip64 path through parsing logic
	 * without needing an actual multi-gigabyte fixture.
	 * @param {FixtureEntry} fixtureEntry
	 */
	function buildZip64Zip({ name, data }) {
		const nameBuf = Buffer.from(name, 'utf8');
		const crc = zlib.crc32(data) >>> 0;
		/** @type {Buffer[]} */
		const chunks = [];
		let pos = 0;

		const local = Buffer.concat([
			u32(0x04034b50),
			u16(45),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(data.length),
			u32(data.length),
			u16(nameBuf.length),
			u16(0),
			nameBuf,
		]);
		const localOffset = pos;
		chunks.push(local, data);
		pos += local.length + data.length;

		const zip64Extra = Buffer.concat([
			u16(0x0001),
			u16(24),
			u64(data.length), // original size
			u64(data.length), // compressed size
			u64(localOffset), // local header offset
		]);
		const cd = Buffer.concat([
			u32(0x02014b50),
			u16(45),
			u16(45),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(0xffffffff),
			u32(0xffffffff),
			u16(nameBuf.length),
			u16(zip64Extra.length),
			u16(0),
			u16(0),
			u16(0),
			u32(0),
			u32(0xffffffff),
			nameBuf,
			zip64Extra,
		]);
		const cdStart = pos;
		chunks.push(cd);
		pos += cd.length;
		const cdEnd = pos;

		const zip64EocdrOffset = pos;
		chunks.push(
			Buffer.concat([
				u32(0x06064b50),
				u64(44),
				u16(45),
				u16(45),
				u32(0),
				u32(0),
				u64(1),
				u64(1),
				u64(cdEnd - cdStart),
				u64(cdStart),
			]),
		);
		pos += 56;

		chunks.push(
			Buffer.concat([u32(0x07064b50), u32(0), u64(zip64EocdrOffset), u32(1)]),
		);
		pos += 20;

		chunks.push(
			Buffer.concat([
				u32(0x06054b50),
				u16(0),
				u16(0),
				u16(0xffff),
				u16(0xffff),
				u32(0xffffffff),
				u32(0xffffffff),
				u16(0),
			]),
		);

		return {
			zip: Buffer.concat(chunks),
			localOffset,
			cdEntryNameOffset: cdStart + 46,
		};
	}

	it('resolves sizes and offset through the zip64 extra field', () => {
		const data = Buffer.from('zip64 payload '.repeat(20));
		const { zip, localOffset } = buildZip64Zip({ name: 'huge.iso', data });
		const [entry] = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		expect(entry).toEqual(
			expect.objectContaining({
				name: 'huge.iso',
				size: data.length,
				compressedSize: data.length,
				compressionMethod: 0,
				localHeaderOffset: localOffset,
			}),
		);
		const dataOffset = resolveDataOffset(readRangeOver(zip), entry);
		expect(zip.subarray(dataOffset, dataOffset + data.length)).toEqual(data);
	});

	it('throws if a zip64 sentinel is present without the matching extra field', () => {
		const data = Buffer.from('x');
		const { zip, cdEntryNameOffset } = buildZip64Zip({ name: 'huge.iso', data });
		// Corrupt the zip64 extra field's header id - the 2 bytes right
		// after the central directory entry's name - so resolveZip64Extra()
		// can't find id 0x0001 and has nothing to resolve the sentinel from.
		zip.writeUInt16LE(0x9999, cdEntryNameOffset + 'huge.iso'.length);
		expect(() =>
			parseCentralDirectory(zip, zip.length, readRangeOver(zip)),
		).toThrow(/zip64 extra field/i);
	});
});

describe('planHeaderReadBatches', () => {
	it('returns nothing for no offsets', () => {
		expect(planHeaderReadBatches([])).toEqual([]);
	});

	it('covers a single offset with one 30-byte batch', () => {
		expect(planHeaderReadBatches([1000])).toEqual([{ start: 1000, length: 30 }]);
	});

	it('merges offsets within the coalesce gap into one batch', () => {
		// 30 bytes apart - well inside the coalesce gap.
		const batches = planHeaderReadBatches([0, 100, 200, 300]);
		expect(batches).toEqual([{ start: 0, length: 330 }]);
	});

	it('keeps far-apart offsets in separate batches', () => {
		// Gigabytes apart - the realistic "few huge zipped ISOs" shape.
		const offsets = [0, 4 * 1024 ** 3, 8 * 1024 ** 3];
		const batches = planHeaderReadBatches(offsets);
		expect(batches).toHaveLength(3);
		for (const [i, offset] of offsets.entries()) {
			expect(batches[i]).toEqual({ start: offset, length: 30 });
		}
	});

	it('never produces a batch larger than the max batch size', () => {
		// Many offsets each well within the coalesce gap of the last, but
		// spanning far more than one batch's worth in total.
		const offsets = [];
		for (let i = 0; i < 2000; i++) offsets.push(i * 50_000); // 50KB apart
		const batches = planHeaderReadBatches(offsets);
		expect(batches.length).toBeGreaterThan(1);
		for (const batch of batches) {
			expect(batch.length).toBeLessThanOrEqual(64 * 1024 * 1024);
		}
		// Every offset must still land inside exactly one batch.
		for (const offset of offsets) {
			const covering = batches.filter(
				(b) => offset >= b.start && offset + 30 <= b.start + b.length,
			);
			expect(covering).toHaveLength(1);
		}
	});
});

describe('makeCoalescedHeaderReadFn / resolveDataOffsetsBatchedOver', () => {
	/**
	 * @param {{name: string, data: Buffer}[]} entryDefs
	 */
	function buildStoreZip(entryDefs) {
		const zip = buildZip(entryDefs.map((e) => ({ name: e.name, data: e.data })));
		const rawEntries = parseCentralDirectory(zip, zip.length, readRangeOver(zip));
		return { zip, rawEntries };
	}

	it('resolves the same dataOffsets as one-read-per-entry, via few reads', () => {
		const { zip, rawEntries } = buildStoreZip([
			{ name: 'a.iso', data: Buffer.from('a'.repeat(500)) },
			{ name: 'b.iso', data: Buffer.from('b'.repeat(500)) },
			{ name: 'c.iso', data: Buffer.from('c'.repeat(500)) },
		]);

		const expected = new Map(
			rawEntries.map((e) => [
				e.localHeaderOffset,
				resolveDataOffset(readRangeOver(zip), e),
			]),
		);

		let calls = 0;
		const readRange = (
			/** @type {number} */ offset,
			/** @type {number} */ length,
		) => {
			calls++;
			return readRangeOver(zip)(offset, length);
		};
		const sortedOffsets = [
			...new Set(rawEntries.map((e) => e.localHeaderOffset)),
		].sort((a, b) => a - b);
		const coalesced = makeCoalescedHeaderReadFn(readRange, sortedOffsets);
		const actual = resolveDataOffsetsBatchedOver(coalesced, rawEntries);

		expect(actual).toEqual(expected);
		// Three tightly-packed entries collapse into a single batched read.
		expect(calls).toBe(1);
	});

	it("doesn't re-fetch a batch it has already read", () => {
		const { zip, rawEntries } = buildStoreZip([
			{ name: 'a.iso', data: Buffer.from('a'.repeat(50)) },
			{ name: 'b.iso', data: Buffer.from('b'.repeat(50)) },
		]);
		let calls = 0;
		const readRange = (
			/** @type {number} */ offset,
			/** @type {number} */ length,
		) => {
			calls++;
			return readRangeOver(zip)(offset, length);
		};
		const sortedOffsets = [
			...new Set(rawEntries.map((e) => e.localHeaderOffset)),
		].sort((a, b) => a - b);
		const coalesced = makeCoalescedHeaderReadFn(readRange, sortedOffsets);
		// Resolve every entry twice, in offset order both times - simulates
		// resolveDataOffsetsBatchedOver()'s own traversal.
		for (const entry of rawEntries) resolveDataOffset(coalesced, entry);
		for (const entry of rawEntries) resolveDataOffset(coalesced, entry);
		expect(calls).toBe(1);
	});
});
