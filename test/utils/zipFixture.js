import zlib from 'node:zlib';

/**
 * @typedef {{ name: string, data: Uint8Array, compressionMethod?: number }} ZipFixtureEntry
 */

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

/**
 * Builds a plain (non-Zip64) zip archive buffer with the given entries.
 * `compressionMethod` only changes the label written into the headers -
 * `data` is always written verbatim, since these fixtures never need to
 * actually deflate anything: compression method is a field callers read,
 * not a codec this builder runs.
 *
 * @param {ZipFixtureEntry[]} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
	/** @type {Buffer[]} */
	const chunks = [];
	let pos = 0;
	const centralRecords = [];
	for (const { name, data, compressionMethod = 0 } of entries) {
		const nameBuf = Buffer.from(name, 'utf8');
		const crc = zlib.crc32(data) >>> 0;
		const localOffset = pos;
		const local = Buffer.concat([
			u32(0x04034b50),
			u16(20),
			u16(0),
			u16(compressionMethod),
			u16(0),
			u16(0),
			u32(crc),
			u32(data.length),
			u32(data.length),
			u16(nameBuf.length),
			u16(0),
			nameBuf,
		]);
		chunks.push(local, Buffer.from(data));
		pos += local.length + data.length;
		centralRecords.push({
			nameBuf,
			crc,
			size: data.length,
			localOffset,
			compressionMethod,
		});
	}
	const cdStart = pos;
	for (const r of centralRecords) {
		const cd = Buffer.concat([
			u32(0x02014b50),
			u16(20),
			u16(20),
			u16(0),
			u16(r.compressionMethod),
			u16(0),
			u16(0),
			u32(r.crc),
			u32(r.size),
			u32(r.size),
			u16(r.nameBuf.length),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(0),
			u32(r.localOffset),
			r.nameBuf,
		]);
		chunks.push(cd);
		pos += cd.length;
	}
	const cdEnd = pos;
	const eocd = Buffer.concat([
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(entries.length),
		u16(entries.length),
		u32(cdEnd - cdStart),
		u32(cdStart),
		u16(0),
	]);
	chunks.push(eocd);
	return Buffer.concat(chunks);
}
