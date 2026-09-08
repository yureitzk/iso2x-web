import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

// Ensures repeated calls in the same test use unique directories.
let counter = 0;

/**
 * Writes arbitrary data to a fixture file in the current test's
 * Playwright output directory. Useful for e2e tests that need a file
 * on disk without creating a real archive or disk image.
 *
 * @param {string} name
 * @param {Uint8Array | string} data
 * @param {object} [options]
 * @param {boolean} [options.freshDir] - When true (default), writes to a
 *   unique subdirectory. When false, writes to the output root and reuses
 *   the existing file if the path already exists.
 * @returns {string} Absolute path to the fixture file.
 */
export function writeFixtureFile(name, data, { freshDir = true } = {}) {
	if (!freshDir) {
		const flatPath = test.info().outputPath(name);
		if (!fs.existsSync(flatPath)) fs.writeFileSync(flatPath, data);
		return flatPath;
	}

	const dir = test.info().outputPath(`raw-fixture-${++counter}`);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, data);
	return filePath;
}
