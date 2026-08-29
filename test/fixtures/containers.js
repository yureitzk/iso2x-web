import { setupWasm } from '../utils/wasmSetup.js';
import { ConversionSession } from 'iso2x';
import {
	makeReadFn,
	driveSizingPass,
	collectChunks,
} from '../utils/wasmSession.js';
import { writePartsToTempDir } from './tempDir.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Memoizes convertToParts() by (isoBuffer identity, format, keepHeader).
 * Caches the promise so concurrent calls share one in-flight run.
 * @type {WeakMap<Uint8Array, Map<string, Promise<{ name: string, bytes: Uint8Array }[]>>>}
 */
const partsCache = new WeakMap();

/**
 * Runs a real conversion (xiso -> `format`) through the wasm module and
 * returns each output manifest entry's bytes, in manifest order.
 * @param {Uint8Array} isoBuffer
 * @param {'god' | 'extracted'} format
 * @param {{ keepHeader?: boolean }} [opts] - for `format: 'god'`, keep the
 *   trailing CON header entry instead of dropping it. No effect for
 *   'extracted'.
 * @returns {Promise<{ name: string, bytes: Uint8Array }[]>}
 */
async function convertToParts(isoBuffer, format, { keepHeader = false } = {}) {
	let byKey = partsCache.get(isoBuffer);
	if (!byKey) {
		byKey = new Map();
		partsCache.set(isoBuffer, byKey);
	}
	const key = `${format}:${keepHeader}`;
	let pending = byKey.get(key);
	if (!pending) {
		pending = runConversion(isoBuffer, format, keepHeader);
		byKey.set(key, pending);
		// Don't cache a rejected promise - let the next call retry.
		pending.catch(() => byKey.delete(key));
	}
	return pending;
}

/**
 * @param {Uint8Array} isoBuffer
 * @param {'god' | 'extracted'} format
 * @param {boolean} keepHeader
 * @returns {Promise<{ name: string, bytes: Uint8Array }[]>}
 */
async function runConversion(isoBuffer, format, keepHeader) {
	await setupWasm();
	const readFn = makeReadFn(isoBuffer);
	const session = ConversionSession.open(
		readFn,
		isoBuffer.length,
		{ format },
		{ source: { format: 'xiso' } },
	);
	driveSizingPass(session);
	const manifest = session.outputManifest();
	const chunks = collectChunks(session);
	session.free();
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const all = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		all.set(c, offset);
		offset += c.length;
	}
	let cursor = 0;
	const parts = manifest.map(({ name, size }) => {
		const bytes = all.slice(cursor, cursor + size);
		cursor += size;
		return { name, bytes };
	});
	// A 'god' manifest lists every Data%04d part plus a trailing CON header;
	// drop the header unless the caller asked to keep it.
	return format === 'god' && !keepHeader ? parts.slice(0, -1) : parts;
}

/**
 * Builds a real GoD-shaped fixture folder (Data%04d parts under
 * titleId/contentType/mediaId/<name>.data/, no CON header file) from an
 * xiso fixture, on disk, ready for `#folder-input`.
 * @param {Uint8Array} isoBuffer
 * @param {object} [options]
 * @param {string|boolean} [options.casedDataFolder] - renames the fixture's
 *   ".data" directory to a differently-cased variant, since detectDirFormat
 *   matches it case-insensitively and real GoD dumps aren't guaranteed
 *   lowercase. `true` for the default ".DATA", or a specific string (e.g.
 *   ".Data").
 * @returns {Promise<string>} absolute path to the fixture folder
 */
export async function makeGodDirFixture(isoBuffer, { casedDataFolder } = {}) {
	const parts = await convertToParts(isoBuffer, 'god');
	const dir = await writePartsToTempDir(parts, 'god-fixture');
	if (casedDataFolder) {
		const suffix =
			typeof casedDataFolder === 'string' ? casedDataFolder : '.DATA';
		if (!renameDataDir(dir, suffix)) {
			throw new Error(
				'makeGodDirFixture: no ".data" directory found in fixture to rename for casedDataFolder',
			);
		}
	}
	return dir;
}

/**
 * Same as makeGodDirFixture, but keeps the trailing CON header file - for
 * regression tests covering the read side's handling of it.
 * @param {Uint8Array} isoBuffer
 * @returns {Promise<string>} absolute path to the fixture folder
 */
export async function makeGodDirFixtureWithHeader(isoBuffer) {
	const parts = await convertToParts(isoBuffer, 'god', { keepHeader: true });
	return writePartsToTempDir(parts, 'god-fixture-with-header');
}

/**
 * Returns the raw `{ name, bytes }[]` parts of a real GoD conversion -
 * the Data%04d chunk(s) plus the trailing CON/LIVE/PIRS header file -
 * without writing them to disk. For mixing into a custom
 * `makeBatchDirFixture()` call alongside unrelated files, e.g. to
 * reproduce a batch drop containing both a GoD folder and other loose
 * sources in the same directory.
 * @param {Uint8Array} isoBuffer
 * @returns {Promise<{ name: string, bytes: Uint8Array }[]>}
 */
export async function makeGodPartsWithHeader(isoBuffer) {
	return convertToParts(isoBuffer, 'god', { keepHeader: true });
}

/**
 * Renames the fixture's "<name>.data" directory to a differently-cased
 * variant, in place. See makeGodDirFixture()'s `casedDataFolder` doc.
 * @param {string} dir
 * @param {string} suffix - the differently-cased ".data" variant to use
 */
function renameDataDir(dir, suffix) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (!entry.isDirectory()) continue;
		if (entry.name.toLowerCase().endsWith('.data')) {
			const base = entry.name.slice(0, -'.data'.length);
			fs.renameSync(full, path.join(dir, `${base}${suffix}`));
			return true;
		}
		if (renameDataDir(full, suffix)) return true;
	}
	return false;
}

/**
 * Builds a real extracted/XEX-shaped fixture folder (default.xbe at root,
 * plus any other loose files) from an xiso fixture, ready for `#folder-input`.
 * @param {Uint8Array} isoBuffer
 * @returns {Promise<string>} absolute path to the fixture folder
 */
export async function makeExtractedDirFixture(isoBuffer) {
	const parts = await convertToParts(isoBuffer, 'extracted');
	return writePartsToTempDir(parts, 'extracted-fixture');
}

/**
 * Builds a real extracted/XEX-shaped fixture folder from an x360-platform
 * xiso fixture (`makeFixture({ platform: 'x360' })`).
 * @param {Uint8Array} isoBuffer
 * @returns {Promise<string>} absolute path to the fixture folder
 */
export async function makeExtractedDirFixtureXex(isoBuffer) {
	const parts = await convertToParts(isoBuffer, 'extracted');
	if (!parts.some((part) => part.name === 'default.xex')) {
		throw new Error(
			'makeExtractedDirFixtureXex: expected a root "default.xex" entry ' +
				'in the extracted parts. Make sure to generate the isoBuffer with ' +
				"`makeFixture({ platform: 'x360' })`. Got: " +
				parts.map((p) => p.name).join(', '),
		);
	}
	return writePartsToTempDir(parts, 'extracted-fixture-xex');
}

/**
 * Deliberately creates a corrupt XEX fixture by renaming an XBE file.
 * Used strictly for testing inspection errors on invalid XEX files.
 *
 * @param {Uint8Array} isoBuffer
 * @returns {Promise<string>} absolute path to the fixture folder
 */
export async function makeCorruptExtractedDirFixtureXex(isoBuffer) {
	const parts = await convertToParts(isoBuffer, 'extracted');
	const xexParts = parts.map((part) =>
		part.name === 'default.xbe' ? { ...part, name: 'default.xex' } : part,
	);
	return writePartsToTempDir(xexParts, 'extracted-fixture-corrupt-xex');
}
