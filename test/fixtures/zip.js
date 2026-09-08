import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { buildZip } from '../utils/zipFixture.js';

// Disambiguates multiple calls within the same test, same reasoning as
// tempDir.js's own counter.
let counter = 0;

/**
 * Writes a zip archive fixture to a fresh temp file, for
 * `queuePage.addSource()`/`queuePage.sourceInput.setInputFiles()` e2e
 * drops. Built on top of `buildZip()` (test/utils/zipFixture.js).
 *
 * `parts` mirrors `makeBatchDirFixture()`'s `{ name, bytes }[]` shape so
 * fixtures built for a folder drop (e.g. `makeGodPartsWithHeader()`) can
 * be handed to this unchanged to build the zipped equivalent of that
 * same drop.
 * @param {{ name: string, bytes: Uint8Array, compressionMethod?: number }[]} parts
 * @param {string} [zipName]
 * @returns {string} absolute path to the written .zip file
 */
export function makeZipFixture(parts, zipName = 'test.zip') {
	const dir = test.info().outputPath(`zip-fixture-${++counter}`);
	fs.mkdirSync(dir, { recursive: true });
	const zipPath = path.join(dir, zipName);
	const buffer = buildZip(
		parts.map(({ name, bytes, compressionMethod }) => ({
			name,
			data: bytes,
			compressionMethod,
		})),
	);
	fs.writeFileSync(zipPath, buffer);
	return zipPath;
}
