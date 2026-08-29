/**
 * Tracks bytes actually read by FileReaderSync for one probe task.
 * Used by WorkerController for WorkerPool recycle-size checks.
 */
let _bytesRead = 0;

/**
 * Tracks bytes actually returned by a FileReaderSync read.
 * @param {number} n
 */
export function trackRead(n) {
	_bytesRead += n;
}

/**
 * Returns and resets the bytes-read total.
 * @returns {number}
 */
export function takeBytesRead() {
	const total = _bytesRead;
	_bytesRead = 0;
	return total;
}
