/**
 * Synchronous, per-file windowed read cache for FileReaderSync-backed
 * SourceReadFns.
 *
 * Batches wasm's small forward reads into fixed `windowBytes` windows, so
 * a sequential run that stays inside an already-filled window costs one
 * FileReaderSync call instead of one per read.
 *
 * A window fill can't be interrupted mid-call; this is bounded by
 * WorkerController's 2-second force-terminate fallback if a cancelled
 * worker never acks.
 *
 * Each call to makeWindowedReadFn() closes over its own window state, so
 * reads to two different Files (e.g. a split source's two parts) never
 * invalidate each other's cache.
 */

/**
 * @import { SourceReadFn } from 'iso2x'
 */

/**
 * @param {File} file
 * @param {number} windowBytes
 * @returns {SourceReadFn}
 */
export function makeWindowedReadFn(file, windowBytes) {
	/** File offset the cached window begins at; -1 until first fill. */
	let winStart = -1;
	/** Valid bytes in winView, starting at winStart. */
	let winLen = 0;
	/** @type {Uint8Array | null} */
	let winView = null;

	return (/** @type {number} */ offset, /** @type {number} */ length) => {
		const withinWindow =
			winView !== null &&
			offset >= winStart &&
			offset + length <= winStart + winLen;

		if (!withinWindow) {
			const end = Math.min(offset + windowBytes, file.size);
			winView = new Uint8Array(
				new FileReaderSync().readAsArrayBuffer(file.slice(offset, end)),
			);
			winStart = offset;
			winLen = winView.byteLength;
		}

		const relStart = offset - winStart;
		const actualLength = Math.min(length, winLen - relStart);

		// Should only trip on an offset/length bookkeeping bug above -
		// FileReaderSync either returns the full slice or throws.
		if (actualLength < length && offset + actualLength < file.size) {
			throw new Error(
				`windowedFileReader: short read of ${actualLength} of ${length} requested bytes ` +
					`at offset ${offset} (window [${winStart}, ${winStart + winLen}), ` +
					`file size ${file.size})`,
			);
		}

		return /** @type {Uint8Array} */ (winView).slice(
			relStart,
			relStart + actualLength,
		);
	};
}
