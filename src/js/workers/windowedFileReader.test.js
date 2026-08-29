import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeWindowedReadFn } from './windowedFileReader.js';

const WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Deterministic byte pattern so reads can be checked for correctness,
 * not just length.
 * @param {number} i
 */
function patternByte(i) {
	return i % 256;
}

/**
 * A minimal File-like stand-in, paired with the FileReaderSync stub
 * installed below (happy-dom has no real FileReaderSync to test against).
 * @param {number} size
 */
function makeFile(size) {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = patternByte(i);
	return {
		size,
		slice(/** @type {number} */ start = 0, /** @type {number} */ end = size) {
			return { bytes: bytes.slice(start, end) };
		},
	};
}

describe('windowedFileReader.js', () => {
	/** @type {typeof FileReaderSync | undefined} */
	let realFileReaderSync;

	beforeEach(() => {
		realFileReaderSync = globalThis.FileReaderSync;
		// @ts-expect-error - test stub, narrower than the real interface
		globalThis.FileReaderSync = class {
			/** @param {{ bytes: Uint8Array }} blob */
			readAsArrayBuffer(blob) {
				return blob.bytes.buffer;
			}
		};
	});

	afterEach(() => {
		globalThis.FileReaderSync = /** @type {typeof FileReaderSync} */ (
			realFileReaderSync
		);
	});

	describe('correctness', () => {
		it('returns correct bytes for a read entirely within the first window', () => {
			const file = makeFile(1024 * 1024);
			const readFn = makeWindowedReadFn(
				/** @type {File} */ (/** @type {unknown} */ (file)),
				WINDOW_BYTES,
			);

			const bytes = readFn(1000, 500);
			expect(bytes.length).toBe(500);
			for (let i = 0; i < bytes.length; i++) {
				expect(bytes[i]).toBe(patternByte(1000 + i));
			}
		});

		it('serves consecutive small forward reads from one window without re-fetching', () => {
			const file = makeFile(1024 * 1024);
			const sliceSpy = vi.spyOn(file, 'slice');
			const readFn = makeWindowedReadFn(
				/** @type {File} */ (/** @type {unknown} */ (file)),
				WINDOW_BYTES,
			);

			readFn(0, 1024);
			const callsAfterFirst = sliceSpy.mock.calls.length;
			expect(callsAfterFirst).toBeGreaterThan(0);

			for (let offset = 1024; offset < 200 * 1024; offset += 1024) {
				const bytes = readFn(offset, 1024);
				expect(bytes[0]).toBe(patternByte(offset));
			}

			// No new File.slice() calls - every read above was served out
			// of the window the first read already filled.
			expect(sliceSpy.mock.calls.length).toBe(callsAfterFirst);
		});

		it('re-fetches a fixed-size window (not grown) once a read crosses the previous boundary', () => {
			const file = makeFile(16 * 1024 * 1024);
			const sliceSpy = vi.spyOn(file, 'slice');
			const readFn = makeWindowedReadFn(
				/** @type {File} */ (/** @type {unknown} */ (file)),
				WINDOW_BYTES,
			);

			readFn(0, WINDOW_BYTES);
			const callsAfterFirst = sliceSpy.mock.calls.length;

			const offset = WINDOW_BYTES + 12345;
			const bytes = readFn(offset, 256);
			for (let i = 0; i < bytes.length; i++) {
				expect(bytes[i]).toBe(patternByte(offset + i));
			}
			expect(sliceSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);

			// The new window is bounded to exactly windowBytes, not grown
			// for the sequential run.
			const lastCall = sliceSpy.mock.calls.at(-1);
			if (!lastCall) {
				throw new Error('expected sliceSpy to have been called');
			}
			const [start, end] = lastCall;
			if (start === undefined || end === undefined) {
				throw new Error('expected slice to be called with explicit start and end');
			}
			expect(end - start).toBeLessThanOrEqual(WINDOW_BYTES);
		});

		it('truncates the returned length at end-of-file instead of reading past it', () => {
			const file = makeFile(1000);
			const readFn = makeWindowedReadFn(
				/** @type {File} */ (/** @type {unknown} */ (file)),
				WINDOW_BYTES,
			);

			const bytes = readFn(900, 500);
			expect(bytes.length).toBe(100); // only 100 bytes remain after offset 900
			for (let i = 0; i < bytes.length; i++) {
				expect(bytes[i]).toBe(patternByte(900 + i));
			}
		});

		it('re-reads correctly after a backward seek outside the current window', () => {
			const file = makeFile(16 * 1024 * 1024);
			const readFn = makeWindowedReadFn(
				/** @type {File} */ (/** @type {unknown} */ (file)),
				WINDOW_BYTES,
			);

			readFn(WINDOW_BYTES + 1000, 16); // fills window 2
			const back = readFn(0, 16); // seeks back to window 1
			expect(back[0]).toBe(patternByte(0));

			const forward = readFn(WINDOW_BYTES + 1000, 16); // window 2 again
			expect(forward[0]).toBe(patternByte(WINDOW_BYTES + 1000));
		});

		it('keeps two files backed by separate closures from invalidating each other', () => {
			const fileA = makeFile(1024);
			const fileB = makeFile(1024);
			fileB.slice = (start = 0, end = 1024) => ({
				bytes: new Uint8Array(end - start).fill(0xff),
			});
			const readA = makeWindowedReadFn(
				/** @type {File} */ (/** @type {unknown} */ (fileA)),
				WINDOW_BYTES,
			);
			const readB = makeWindowedReadFn(
				/** @type {File} */ (/** @type {unknown} */ (fileB)),
				WINDOW_BYTES,
			);

			expect(readA(0, 16)[0]).toBe(patternByte(0));
			expect(readB(0, 16)[0]).toBe(0xff);
			// Interleaved re-reads still resolve to the right file - each
			// readFn closure owns its own window state.
			expect(readA(0, 16)[0]).toBe(patternByte(0));
			expect(readB(0, 16)[0]).toBe(0xff);
		});

		it('propagates a FileReaderSync failure instead of returning partial data', () => {
			globalThis.FileReaderSync = /** @type {typeof FileReaderSync} */ (
				/** @type {unknown} */ (
					class {
						readAsArrayBuffer() {
							throw new DOMException('boom', 'NotReadableError');
						}
					}
				)
			);

			const file = makeFile(1024);
			const readFn = makeWindowedReadFn(
				/** @type {File} */ (/** @type {unknown} */ (file)),
				WINDOW_BYTES,
			);
			expect(() => readFn(0, 16)).toThrow('boom');
		});
	});
});
