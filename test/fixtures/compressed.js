import { setupWasm } from '../utils/wasmSetup.js';
import { ConversionSession, detectFormat } from 'iso2x';
import {
	makeReadFn,
	driveSizingPass,
	collectChunks,
} from '../utils/wasmSession.js';

/**
 * @import { CompressedFixtures } from '../../src/types/global'
 */

/**
 * Runs `session` to completion and concatenates its output into one Buffer.
 * @param {ConversionSession} session
 * @returns {Buffer}
 */
function drainToBuffer(session) {
	driveSizingPass(session);
	const chunks = collectChunks(session);
	session.free();
	return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Converts an xiso-shaped ISO fixture into real .cso/.cci/.zar outputs by
 * running an actual conversion through the wasm module.
 *
 * .cso/.cci both stay well under their split thresholds (~4.28 GB / ~4.06 GB,
 * from their 32-bit block-index sizing) for any fixture this suite
 * generates, so each always comes back as a single "<outputName>.1.cso" /
 * "<outputName>.1.cci" part; .zar is never split.
 *
 * @param {Uint8Array} isoBuffer
 * @param {string} [outputName]
 * @returns {Promise<CompressedFixtures>}
 */
export async function makeCompressedFixtures(isoBuffer, outputName = 'test') {
	await setupWasm();
	const readFn = makeReadFn(isoBuffer);
	const ref = { source: { format: detectFormat(readFn, isoBuffer.length) } };
	const cso = drainToBuffer(
		ConversionSession.open(
			readFn,
			isoBuffer.length,
			{ format: 'ciso', outputName },
			ref,
		),
	);
	const cci = drainToBuffer(
		ConversionSession.open(
			readFn,
			isoBuffer.length,
			{ format: 'cci', outputName },
			ref,
		),
	);
	const zar = drainToBuffer(
		ConversionSession.open(
			readFn,
			isoBuffer.length,
			{ format: 'zar', outputName },
			ref,
		),
	);
	return { cso, cci, zar };
}
