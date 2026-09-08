/**
 * Final integrity gates for converterWorker.js's download paths: the
 * last checks, right before a stream closes / MSG.DONE is posted, that
 * actual bytes sent match what was predicted up front.
 */

/**
 * For single-stream formats (god/extracted zip, xiso, zar): throws if
 * total bytes streamed don't match the predicted size. `expectedSize`
 * is `undefined` for zar, whose real size isn't known until the footer
 * phase - a no-op in that case.
 *
 * @param {number} sentBytes
 * @param {bigint | undefined} expectedSize
 */
export function assertStreamComplete(sentBytes, expectedSize) {
	if (expectedSize === undefined) return;
	if (BigInt(sentBytes) !== expectedSize) {
		throw new Error(
			`Conversion incomplete: streamed ${sentBytes} bytes but expected ${expectedSize} - refusing to finalize what would be a corrupt download`,
		);
	}
}

/**
 * For the direct multi-file path (ciso/cci/split-xiso): throws if the
 * manifest entry that just finished is short of its expected bytes.
 * Called before that entry's stream closes, so truncation is caught
 * per-entry instead of only at the end of the batch (or not at all).
 *
 * @param {{ name: string, expected: number, sent: number } | null} current
 */
export function assertEntryComplete(current) {
	if (!current) return;
	if (current.sent !== current.expected) {
		throw new Error(
			`Conversion incomplete: ${current.name} streamed ${current.sent} of ${current.expected} expected bytes - refusing to finalize what would be a corrupt download`,
		);
	}
}
