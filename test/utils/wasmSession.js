/**
 * @import {
 *   ConversionSession,
 * } from 'iso2x'
 */

/** @param {Uint8Array} buf @returns {(offset: number, length: number) => Uint8Array} */
export function makeReadFn(buf) {
	return (offset, length) =>
		buf.subarray(offset, Math.min(offset + length, buf.length));
}

/**
 * Required before nextChunk() for ciso/cci targets, which need the full
 * source hashed up front to size their block index. No-ops for other
 * targets, so it's always safe to call regardless of format.
 * @param {ConversionSession} session
 */
export function driveSizingPass(session) {
	while (!session.hashNextPart()) {
		/* keep sizing */
	}
}

/**
 * @param {ConversionSession} session
 * @param {number} [chunkSize]
 * @returns {Uint8Array[]}
 */
export function collectChunks(session, chunkSize = 4 * 1024 * 1024) {
	/** @type {Uint8Array[]} */
	const chunks = [];
	let chunk;
	while ((chunk = session.nextChunk(chunkSize)) !== null) {
		chunks.push(chunk);
	}
	return chunks;
}
