/**
 * @import { SourceFile } from '../../../types/global'
 */

/**
 * Reassembles a chunked `partitionDir()` call (see WorkerController's
 * `#postPartitionDir()`) back into the single `{ dirName, entries,
 * files }` triple `partitionDroppedFolder()` expects.
 *
 * Split out from converterWorker.js so the accumulation logic - the
 * only genuinely new behavior chunking introduces - can be unit
 * tested on its own, without booting the wasm module converterWorker.js
 * initializes at import time.
 *
 * @returns {{
 *   push: (chunk: { dirName?: string, entries: string[], files: SourceFile[], chunkIndex: number, totalChunks: number }) =>
 *     { dirName: string, entries: string[], files: SourceFile[] } | null
 * }}
 */
export function createPartitionChunkAccumulator() {
	/** @type {{ dirName: string, entries: string[], files: SourceFile[] }} */
	let buffer = { dirName: '', entries: [], files: [] };

	return {
		/**
		 * Feeds one chunk in. Returns the reassembled result once the
		 * last chunk arrives, else null. `chunkIndex === 0` always
		 * (re)starts the buffer - defensive against a lost last-chunk.
		 * @param {{ dirName?: string, entries: string[], files: SourceFile[], chunkIndex: number, totalChunks: number }} chunk
		 * @returns {{ dirName: string, entries: string[], files: SourceFile[] } | null}
		 */
		push(chunk) {
			if (chunk.chunkIndex === 0) {
				buffer = { dirName: chunk.dirName ?? '', entries: [], files: [] };
			}
			buffer.entries.push(...chunk.entries);
			buffer.files.push(...chunk.files);

			if (chunk.chunkIndex !== chunk.totalChunks - 1) return null;

			const result = buffer;
			buffer = { dirName: '', entries: [], files: [] };
			return result;
		},
	};
}
