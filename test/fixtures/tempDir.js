import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Disambiguates multiple calls within the same test - outputPath() is
// only guaranteed unique per test, not per call.
let counter = 0;

/**
 * Writes `{ name, bytes }` parts to a fresh directory under this test's
 * own Playwright output dir, preserving each part's relative path (same
 * shape as `.webkitRelativePath`) - suitable for
 * `page.locator('#folder-input').setInputFiles(dirPath)`.
 * @param {{ name: string, bytes: Uint8Array }[]} parts
 * @param {string} prefix
 * @returns {string} absolute path to the populated directory
 */
export function writePartsToTempDir(parts, prefix) {
	const dir = test.info().outputPath(`${prefix}-${++counter}`);
	for (const { name, bytes } of parts) {
		const rel = name.split('/').join(path.sep);
		const dest = path.join(dir, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, bytes);
	}
	return dir;
}
