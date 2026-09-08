/**
 * @import { SourceFile } from '../../src/types/global'
 */

/**
 * Deterministic byte pattern so reads can be checked for correctness,
 * not just length. Shared by every test that exercises the windowed
 * read cache in scheduledWindowedFileReader.js.
 * @param {number} i
 */
export function patternByte(i) {
	return i % 256;
}

/**
 * @typedef {{
 *   size: number,
 *   slice: (start?: number, end?: number) => { bytes: Uint8Array },
 * }} FakeFile
 */

/**
 * A minimal File-like stand-in, paired with `installFileReaderSyncStub()`
 * below (happy-dom has no real FileReaderSync to test against). Only
 * `size` and `slice()` are used by the reader code under test - a real
 * `File` has many more properties, so this is intentionally narrower
 * than `SourceFile` and typed as its own `FakeFile` shape rather than
 * pretending to satisfy `File`. Pass the result through `asSourceFile()`
 * at the point it's handed to reader code that's typed against
 * `SourceFile`.
 * @param {number} size
 * @returns {FakeFile}
 */
export function makeFile(size) {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = patternByte(i);
	return {
		size,
		slice(start = 0, end = size) {
			return { bytes: bytes.slice(start, end) };
		},
	};
}

/**
 * Casts a `makeFile()` fake through to `SourceFile`, for handing to
 * reader code typed against the real union (`File | ZipEntryFileRef`).
 * Centralizes the cast-through-unknown dance so call sites don't each
 * repeat it.
 * @param {FakeFile} file
 * @returns {SourceFile}
 */
export function asSourceFile(file) {
	return /** @type {SourceFile} */ (/** @type {unknown} */ (file));
}

/**
 * Installs a `FileReaderSync` stub that reads back the `{ bytes }` shape
 * `makeFile()`'s `.slice()` returns, and returns a restore function.
 * Call the restore function in `afterEach()`.
 *
 * ```js
 * describe('...', () => {
 *   let restoreFileReaderSync;
 *   beforeEach(() => { restoreFileReaderSync = installFileReaderSyncStub(); });
 *   afterEach(() => restoreFileReaderSync());
 * });
 * ```
 * @returns {() => void}
 */
export function installFileReaderSyncStub() {
	const realFileReaderSync = globalThis.FileReaderSync;
	// @ts-expect-error - test stub, narrower than the real interface
	globalThis.FileReaderSync = class {
		/** @param {{ bytes: Uint8Array }} blob */
		readAsArrayBuffer(blob) {
			return blob.bytes.buffer;
		}
	};
	return () => {
		globalThis.FileReaderSync = /** @type {typeof FileReaderSync} */ (
			realFileReaderSync
		);
	};
}
