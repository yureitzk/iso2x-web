import yauzl from 'yauzl-promise';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads every entry from a zip matching `predicate`, fully draining each
 * into a Buffer. Directory entries (filename ending in `/`) are always
 * skipped - the zip spec makes them optional, but some writers include
 * them anyway, and they have no readable content of their own.
 * @param {string} filePath
 * @param {(name: string) => boolean} predicate
 * @returns {Promise<{ filename: string, bytes: Buffer }[]>}
 */
export async function readZipEntries(filePath, predicate) {
	const zip = await yauzl.open(filePath);
	/** @type {{ filename: string, bytes: Buffer }[]} */
	const found = [];
	try {
		for await (const entry of zip) {
			if (entry.filename.endsWith('/')) continue;
			if (!predicate(entry.filename)) continue;
			const stream = await entry.openReadStream();
			/** @type {Buffer[]} */
			const chunks = [];
			for await (const chunk of stream) chunks.push(chunk);
			found.push({ filename: entry.filename, bytes: Buffer.concat(chunks) });
		}
	} finally {
		await zip.close();
	}
	return found;
}

/**
 * Reads just the first `length` bytes of the first entry matching
 * `predicate` - cheaper than readZipEntries() when only a magic/header
 * prefix is needed, since it destroys the stream as soon as enough bytes
 * have arrived instead of draining the whole entry.
 * @param {string} filePath
 * @param {(name: string) => boolean} predicate
 * @param {number} [length]
 * @returns {Promise<Buffer>}
 */
export async function readZipEntryPrefix(filePath, predicate, length = 4) {
	const zip = await yauzl.open(filePath);
	/** @type {Buffer | undefined} */
	let prefix;
	try {
		for await (const entry of zip) {
			if (entry.filename.endsWith('/')) continue;
			if (!predicate(entry.filename)) continue;
			const readStream = await entry.openReadStream();
			prefix = await new Promise((resolve, reject) => {
				/** @type {Buffer[]} */
				const chunks = [];
				let total = 0;
				readStream.on('data', (chunk) => {
					chunks.push(chunk);
					total += chunk.length;
					if (total >= length) readStream.destroy();
				});
				readStream.on('close', () =>
					resolve(Buffer.concat(chunks).subarray(0, length)),
				);
				readStream.on('error', reject);
			});
			break;
		}
	} finally {
		await zip.close();
	}
	if (!prefix) throw new Error('No matching entry found in zip');
	return prefix;
}

/**
 * Extracts every file entry from `zipPath` into `destDir`, preserving the
 * zip's internal relative paths - what a person gets after unzipping a
 * real download onto disk.
 * @param {string} zipPath
 * @param {string} destDir
 */
export async function extractZipToDir(zipPath, destDir) {
	const zip = await yauzl.open(zipPath);
	try {
		for await (const entry of zip) {
			if (entry.filename.endsWith('/')) continue;
			const outPath = path.join(destDir, entry.filename);
			fs.mkdirSync(path.dirname(outPath), { recursive: true });
			const readStream = await entry.openReadStream();
			const writeStream = fs.createWriteStream(outPath);
			await new Promise((resolve, reject) => {
				readStream.pipe(writeStream);
				writeStream.on('finish', resolve);
				writeStream.on('error', reject);
				readStream.on('error', reject);
			});
		}
	} finally {
		await zip.close();
	}
}
