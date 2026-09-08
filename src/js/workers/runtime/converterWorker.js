import initWasm, {
	inspectSource as wasmInspectSource,
	openSource,
	detectFormat,
	detectDirFormat,
	resolveBatchEntry,
	cisoSizingBatchSectors,
	cciSizingBatchSectors,
	ConversionSession,
} from 'iso2x';
import { verifySplitCandidate, sourceParts } from 'iso2x/detect-advanced';
import { downloadZip, predictLength } from 'client-zip';
import { MSG } from '../../core/protocol.js';
import { createLogger, setDefaultLogLevel } from '../../lib/logger.js';
import {
	partitionDroppedFolder,
	fileReaders,
	godPartIndices,
} from './source.js';
import { createPartitionChunkAccumulator } from './partitionChunkBuffer.js';
import { sliceSourceFile } from './zipSource.js';
import { sourceLogLabel } from '../../lib/sourceLabels.js';
import { parseDeviceId } from '../../lib/helpers';
import { SEQUENTIAL_WINDOW_BYTES } from '../../constants/reading.js';
import {
	ScheduledSourceReader,
	WindowPool,
	parseFlatSchedule,
} from './scheduledWindowedFileReader.js';
import { trackRead, takeBytesRead } from '../../lib/readTracker.js';
import {
	assertStreamComplete,
	assertEntryComplete,
} from './streamSizeGuard.js';

/**
 * @import {
 *   ConvertMessage,
 *   InspectMessage,
 *   PartitionDirMessage,
 *   VerifyOrderMessage,
 *   PendingConvert,
 *   ControllerMessage,
 *   GodOptions,
 *   XisoOptions,
 *   CisoOptions,
 *   CciOptions,
 *   ExtractedOptions,
 *   OutputFormat,
 *   FormatOptions,
 *   SingleDroppedSource,
 *   SourceFile
 * } from '../../../types/global'
 * @import { InputWithoutMeta } from 'client-zip'
 * @import {
 *   SourceReadFn,
 *   SourcePart,
 *   ConversionFormat,
 *   OpenConversionSessionOptions,
 *   SourceOptions,
 *   OpenedSource,
 * } from 'iso2x'
 */

setDefaultLogLevel();
const converterLogger = createLogger('converterWorker');

/** @type {Promise<void> | null} */
let _pausePromise = null;
/** @type {(() => void) | null} */
let _pauseResolve = null;
let _currentReader =
	/** @type {ReadableStreamDefaultReader<Uint8Array> | null} */ (null);
let _cancelled = false;
/** @type {() => void} */
let _cancelResolve = () => {};
const _cancelPromise = new Promise((resolve) => {
	_cancelResolve = () => resolve(undefined);
});

/**
 * Accumulates a chunked PARTITION_DIR call (see WorkerController's
 * #postPartitionDir) until the last chunk (`chunkIndex === totalChunks
 * - 1`) arrives, at which point partitionDroppedFolder() runs against
 * the fully reassembled entries/files - identical to what it would
 * have received from a single, unchunked message.
 */
const partitionAccumulator = createPartitionChunkAccumulator();

const CHUNK_BYTES = 2 * 1024 * 1024;
const SECTOR_SIZE = 2048;
// Matches CHUNK_BYTES so xiso's own internal reads aren't fragmented any
// smaller than the granularity we're already streaming at.
const XISO_SECTORS_PER_CHUNK = CHUNK_BYTES / SECTOR_SIZE;

/**
 * Decides whether this conversion's target format is a Full-mode
 * XDVDFS reauthor (which reads source files in a very different order
 * than physical disc layout - see core/read_schedule.rs), and if so,
 * fetches the real read schedule for it. Kept out of convertSource()'s
 * own control flow so the gating logic is independently testable.
 *
 * Scoped to the common single-part case: it's not yet confirmed
 * whether `fullModeReadSchedule()`'s absolute, whole-source offsets
 * line up with a per-part reader's own offset space without remapping,
 * so multi-part sources keep today's plain-LRU behavior instead. Purely
 * a missed optimization, never a correctness risk - see
 * `ScheduledSourceReader`'s own fallback on a schedule mismatch.
 * @param {OpenedSource} opened
 * @param {string} format
 * @param {FormatOptions} options
 * @param {unknown[] | undefined} sourceParts
 * @returns {{ schedule: {offset: number, size: number}[], scheduledFileBytes: number } | null}
 */
function tryGetFullModeSchedule(opened, format, options, sourceParts) {
	const xisoMode =
		format === 'xiso' ? /** @type {XisoOptions} */ (options).mode : undefined;
	const isFullModeRebuild =
		format === 'god' ||
		format === 'cci' ||
		format === 'ciso' ||
		(format === 'xiso' && (xisoMode ?? 'full') === 'full');
	if (!isFullModeRebuild || sourceParts !== undefined) return null;

	try {
		const schedule = parseFlatSchedule(opened.fullModeReadSchedule());
		const scheduledFileBytes = schedule.reduce((sum, e) => sum + e.size, 0);
		converterLogger.debug(
			`fullModeReadSchedule applied: ${schedule.length} scheduled entries, ` +
				`totaling ${scheduledFileBytes} bytes`,
		);
		return { schedule, scheduledFileBytes };
	} catch (err) {
		// Could be an extracted-files source (no XDVDFS directory table
		// to schedule from), or probing just failed for some other
		// reason. Either way, fall back silently to the existing LRU
		// behavior; this is purely a prefetch hint and nothing here is
		// required for a correct conversion.
		converterLogger.debug(
			`fullModeReadSchedule unavailable, continuing without it: ${err}`,
		);
		return null;
	}
}

/**
 * Resolves a standalone file or a wasm-verified multi-file group (a
 * named CCI/CISO split pair, or a raw XISO split across two or more
 * fragments) to a ConversionSession.open()/inspectSource()-ready
 * source. Grouping and verification already happened in the UI layer -
 * this only builds the readFn(s) and resolves *format* for the
 * standalone case.
 *
 * For a multi-file group, `readFn`/`fileSize` are just part 1's, kept
 * only as required-but-ignored arguments once `sourceParts` is supplied.
 * @param {SourceFile[]} files
 * @param {(file: SourceFile, index: number) => SourceReadFn} makePartReadFn
 * @returns {{
 *   format: ConversionFormat,
 *   readFn: SourceReadFn,
 *   fileSize: number,
 *   sourceParts: SourcePart[] | undefined,
 * }}
 */
function resolveMultiFileSource(files, makePartReadFn) {
	if (files.length === 0) {
		throw new Error('expected at least 1 file, got 0');
	}

	const readFn0 = makePartReadFn(files[0], 0);

	if (files.length === 1) {
		const format = detectFormat(readFn0, files[0].size);
		return {
			format,
			readFn: readFn0,
			fileSize: files[0].size,
			sourceParts: undefined,
		};
	}

	// Multi-file group is already content-verified as a real split, so
	// just detect format off part 1 and build SourceParts for the rest.
	const format = detectFormat(readFn0, files[0].size);
	/** @type {SourcePart[]} */
	const sourceParts = files.map((f, i) => ({
		name: f.name,
		size: f.size,
		readFn: i === 0 ? readFn0 : makePartReadFn(f, i),
	}));
	return { format, readFn: readFn0, fileSize: files[0].size, sourceParts };
}

/**
 * @param {SingleDroppedSource} source
 * @param {(file: SourceFile, index: number) => SourceReadFn} makePartReadFn
 * @returns {Promise<{
 *   format: ConversionFormat,
 *   readFn: SourceReadFn,
 *   fileSize: number,
 *   sourceParts: SourcePart[] | undefined,
 * }>}
 */
async function resolveDroppedSource(source, makePartReadFn) {
	if (source.kind !== 'dir') {
		return resolveMultiFileSource(source.files, makePartReadFn);
	}

	const { files, entries } = source;
	if (files.length !== entries.length) {
		throw new Error('dropped folder: files and entries length mismatch');
	}

	const dirFormat = detectDirFormat(entries);
	if (dirFormat) {
		const indices = entries.map((_, i) => i);
		const partIndices = dirFormat === 'god' ? godPartIndices(entries) : indices;

		/** @type {SourcePart[]} */
		const sourceParts = partIndices.map((i) => ({
			name: entries[i],
			size: files[i].size,
			readFn: makePartReadFn(files[i], i),
		}));
		return {
			format: dirFormat,
			readFn: sourceParts[0].readFn,
			fileSize: sourceParts[0].size,
			sourceParts,
		};
	}

	// Not god/extracted-shaped. The folder might instead hold one
	// (possibly split) image rather than loose files. resolveBatchEntry
	// is async because it may need to byte-verify a split pair before
	// committing to it.
	const byName = new Map(entries.map((name, i) => [name, files[i]]));
	const resolved = await resolveBatchEntry(entries, {
		readFn: (name) => {
			const file = /** @type {SourceFile} */ (byName.get(name));
			return makePartReadFn(file, entries.indexOf(name));
		},
		size: (name) => /** @type {SourceFile} */ (byName.get(name)).size,
	});

	if (resolved.kind === 'invalid') {
		// A folder with a named CCI/CISO pair whose content doesn't
		// verify; surface the real reason through inspectSource()'s catch block.
		throw new Error(resolved.reason);
	}
	if (resolved.kind === 'dir') {
		return {
			format: resolved.format,
			readFn: resolved.parts[0].readFn,
			fileSize: resolved.parts[0].size,
			sourceParts: resolved.parts,
		};
	}
	return {
		format: resolved.format,
		readFn: resolved.readFn,
		fileSize: resolved.fileSize,
		sourceParts: undefined,
	};
}

/** @param {SingleDroppedSource} source */
async function inspectSource(source) {
	const label = sourceLogLabel(source);
	converterLogger.debug('inspecting', label);
	try {
		/**
		 * Direct per-request synchronous read, deliberately with no
		 * window/page cache: inspection's reads have no real locality
		 * (each one jumps to wherever iso2x's detector asks next), so
		 * ScheduledSourceReader's windowed cache would overfetch without
		 * cutting the read count enough to be worth it.
		 * @param {SourceFile} file
		 */
		const makeSyncReadFn =
			(file) => (/** @type {number} */ offset, /** @type {number} */ length) => {
				const blob = sliceSourceFile(file, offset, length);
				const bytes = new Uint8Array(new FileReaderSync().readAsArrayBuffer(blob));
				trackRead(bytes.length);
				return bytes;
			};

		const { format, readFn, fileSize, sourceParts } = await resolveDroppedSource(
			source,
			(file) => makeSyncReadFn(file),
		);
		const info = wasmInspectSource(
			readFn,
			fileSize,
			{ source: { format }, parts: sourceParts },
			true,
		);
		const { thumbnail, titleThumbnail, ...restInfo } = info;
		// titleThumbnail (game icon) wins over thumbnail (a content-specific
		// icon, e.g. a save's own icon). Mirrors XBE's own priority of
		// $$XTIMAGE over $$XSIMAGE.
		const icon = titleThumbnail ?? thumbnail;
		self.postMessage(
			{
				type: MSG.SOURCE_INFO,
				payload: {
					...restInfo,
					fileSize: source.files.reduce((sum, f) => sum + f.size, 0),
					sourceFormat: format,
					icon,
				},
				bytesRead: takeBytesRead(),
			},
			icon ? [icon.buffer] : [],
		);
	} catch (err) {
		converterLogger.error('inspection failed:', err);
		self.postMessage({
			type: MSG.SOURCE_ERROR,
			payload: String(err),
			bytesRead: takeBytesRead(),
		});
	}
}

/**
 * Builds a progress reporter that maps a 0..1 "how far through this
 * phase" fraction onto a sub-range of one combined 0..100 bar. For
 * 'god' (hashing, then writing): hashing occupies 0..50, writing
 * 50..100. Every other format has one phase and gets the whole range.
 * @param {[number, number]} range - [start, end] percentage this phase maps onto
 * @returns {(fraction: number) => void}
 */
function makeProgressReporter([start, end]) {
	return (fraction) => {
		const clamped = Math.max(0, Math.min(1, fraction));
		self.postMessage({
			type: MSG.PROGRESS,
			payload: Math.round(start + clamped * (end - start)),
		});
	};
}

/**
 * Shared pump loop for every chunk-streaming generator in this file:
 * drives session.nextChunk() under cancellation/pause/backpressure, and
 * hands each chunk to `onChunk` to decide what to yield.
 *
 * A throw from `onChunk` itself propagates as a plain error - only a
 * throw from the `yield` expression gets the "chunk yield threw" log
 * treatment, tagged with `errorContext` when supplied.
 * @template T
 * @param {ConversionSession} session
 * @param {() => Promise<void>} waitForRoom
 * @param {(chunk: Uint8Array<ArrayBuffer>) => { value: T, errorContext?: string }} onChunk
 * @returns {AsyncGenerator<T>}
 */
async function* pumpSessionChunks(session, waitForRoom, onChunk) {
	while (!session.isDone()) {
		if (_cancelled) return;
		if (_pausePromise) {
			self.postMessage({ type: MSG.PAUSED });
			await _pausePromise;
		}

		await waitForRoom();
		if (_cancelled) return;

		const chunk = session.nextChunk(CHUNK_BYTES);
		if (!chunk) break;

		const { value, errorContext } = onChunk(chunk);
		try {
			yield value;
		} catch (e) {
			converterLogger.error(
				`chunk yield threw${errorContext ? ` ${errorContext}` : ''}:`,
				e,
			);
			throw e;
		}

		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * Pulls chunks out of a session, grouping them by output file via
 * currentEntryName() so they can be handed to client-zip as separate
 * named entries. Used for 'god' and 'extracted' - 'ciso' also produces
 * more than one file but streams them directly (see multiFileChunks()).
 * @param {ConversionSession} session
 * @param {() => Promise<void>} waitForRoom
 * @returns {AsyncGenerator<{ name: string, chunk: Uint8Array }>}
 */
async function* namedChunks(session, waitForRoom) {
	/** @type {string | null} */
	let lastName = null;
	yield* pumpSessionChunks(session, waitForRoom, (chunk) => {
		const name = session.currentEntryName();
		if (name === null) {
			throw new Error('namedChunks: session produced a chunk with no entry name');
		}
		if (name !== lastName) {
			converterLogger.debug(`writing entry: ${name}`);
			self.postMessage({ type: MSG.LOG, payload: `Writing ${name}...` });
			lastName = name;
		}
		return { value: { name, chunk }, errorContext: `for entry ${name}` };
	});
}

/**
 * Streams `{ name, size, input }` entries to client-zip one at a time,
 * instead of pre-building an array of every manifest entry up front.
 * Matters for formats like 'extracted' with hundreds of files: an
 * eagerly-built array lets client-zip run ahead across it, pulling from
 * many `entryContent()` generators before their bytes are written,
 * driving RAM usage up. Yielding one entry at a time avoids that.
 * @param {ConversionSession} session
 * @param {Array<{ name: string, size: number }>} manifest
 * @param {() => Promise<void>} waitForRoom
 * @returns {AsyncGenerator<InputWithoutMeta>}
 */
async function* zipInputsFromSession(session, manifest, waitForRoom) {
	/** @type {AsyncGenerator<{ name: string, chunk: Uint8Array }> | null} */
	let shared = null;
	/** @type {{ name: string, chunk: Uint8Array } | null} */
	let buffered = null;

	function ensureStarted() {
		if (!shared) shared = namedChunks(session, waitForRoom);
		return shared;
	}

	/**
	 * @param {string} entryName
	 * @returns {AsyncGenerator<Uint8Array>}
	 */
	async function* entryContent(entryName) {
		const source = ensureStarted();
		while (true) {
			if (_cancelled) return;
			let item = buffered;
			buffered = null;
			if (!item) {
				const next = await source.next();
				if (next.done) return;
				item = next.value;
			}
			if (item.name !== entryName) {
				buffered = item;
				return;
			}
			yield item.chunk;
		}
	}

	for (const entry of manifest) {
		if (_cancelled) return;
		yield {
			name: entry.name,
			size: entry.size,
			input: entryContent(entry.name),
		};
	}
}

/**
 * @param {ConversionSession} session
 * @param {Array<{ name: string, size: number }>} manifest
 * @param {() => Promise<void>} waitForRoom
 * @param {(fraction: number) => void} reportProgress
 * @returns {AsyncGenerator<ArrayBuffer>}
 */
async function* zipChunks(session, manifest, waitForRoom, reportProgress) {
	self.postMessage({
		type: MSG.LOG,
		payload: `Writing ${manifest.length} file${manifest.length === 1 ? '' : 's'}...`,
	});

	const zipInput = zipInputsFromSession(session, manifest, waitForRoom);
	const body = downloadZip(zipInput, { metadata: manifest }).body;
	if (!body) throw new Error('Zip returned a response with no body');

	const totalSize = manifest.reduce((sum, e) => sum + e.size, 0);
	let done = 0;
	const reader = body.getReader();
	_currentReader = reader;

	try {
		while (true) {
			const { done: readerDone, value } = await reader.read();
			if (readerDone || _cancelled) break;
			done += value.byteLength;
			reportProgress(done / Math.max(totalSize, 1));
			yield value.buffer.slice(
				value.byteOffset,
				value.byteOffset + value.byteLength,
			);
		}
	} finally {
		_currentReader = null;
		session.free();
	}
}

/**
 * Single-stream formats (xiso, zar).
 *
 * @param {ConversionSession} session
 * @param {number} totalUnits
 * @param {() => Promise<void>} waitForRoom
 * @param {(fraction: number) => void} reportProgress
 * @param {number} [unitBytes] - bytes per totalUnits unit; SECTOR_SIZE for
 *   xiso, 1 for zar (whose total is raw bytes, not compressed size).
 * @returns {AsyncGenerator<ArrayBuffer>}
 */
async function* streamChunks(
	session,
	totalUnits,
	waitForRoom,
	reportProgress,
	unitBytes = SECTOR_SIZE,
) {
	let sectorsDone = 0;
	let chunkCount = 0;
	self.postMessage({
		type: MSG.LOG,
		payload: `Repacking (${totalUnits} units)...`,
	});
	try {
		yield* pumpSessionChunks(session, waitForRoom, (chunk) => {
			chunkCount++;
			// session.unitsDone(), when non-null, is authoritative (zar's
			// nextChunk() bytes are compressed output, not 1:1 with
			// totalUnits()). Everything else sums chunk.byteLength instead.
			const unitsDone = session.unitsDone();
			if (unitsDone !== null) {
				sectorsDone = Math.min(unitsDone, totalUnits);
			} else {
				const sectorsInChunk = Math.ceil(chunk.byteLength / unitBytes);
				sectorsDone = Math.min(sectorsDone + sectorsInChunk, totalUnits);
			}

			reportProgress(sectorsDone / Math.max(totalUnits, 1));
			self.postMessage({
				type: MSG.LOG,
				payload: `Wrote chunk ${chunkCount}...`,
			});

			// `chunk` comes from session.nextChunk(), which allocates a
			// brand-new, exclusively-owned ArrayBuffer sized exactly to
			// the chunk, so it's safe to transfer directly instead of
			// copying it again first.
			return {
				value: chunk.buffer,
				errorContext: `at unit ${sectorsDone}`,
			};
		});
	} finally {
		session.free();
	}
}

/**
 * Direct (non-zip) multi-file streaming. A chunk never straddles two
 * entry names (session-guaranteed), so a name change is a clean file
 * boundary and entries arrive in order.
 * @param {ConversionSession} session
 * @param {Array<{ name: string, size: number }>} manifest
 * @param {() => Promise<void>} waitForRoom
 * @param {(fraction: number) => void} reportProgress
 * @returns {AsyncGenerator<{ name: string, chunk: ArrayBuffer, isNewFile: boolean }>}
 */
async function* multiFileChunks(
	session,
	manifest,
	waitForRoom,
	reportProgress,
) {
	const totalSize = manifest.reduce((sum, e) => sum + e.size, 0);
	let done = 0;
	/** @type {string | null} */
	let lastName = null;
	let chunkCount = 0;

	self.postMessage({
		type: MSG.LOG,
		payload: `Writing ${manifest.length} file${manifest.length === 1 ? '' : 's'}...`,
	});

	try {
		yield* pumpSessionChunks(session, waitForRoom, (chunk) => {
			const name = session.currentEntryName();
			if (name === null) {
				throw new Error(
					'multiFileChunks: session produced a chunk with no entry name',
				);
			}

			const isNewFile = name !== lastName;
			if (isNewFile) {
				converterLogger.debug(`writing entry: ${name}`);
				self.postMessage({ type: MSG.LOG, payload: `Writing ${name}...` });
				lastName = name;
				chunkCount = 0;
			}

			chunkCount++;
			done += chunk.byteLength;
			reportProgress(done / Math.max(totalSize, 1));
			self.postMessage({
				type: MSG.LOG,
				payload: `Wrote chunk ${chunkCount}...`,
			});

			// Same reasoning as streamChunks() above: transfer the buffer
			// directly instead of copying it first.
			return {
				value: {
					name,
					chunk: chunk.buffer,
					isNewFile,
				},
				errorContext: `for entry ${name}`,
			};
		});
	} finally {
		session.free();
	}
}

/**
 * @param {ConversionSession} session
 * @param {(fraction: number) => void} reportProgress
 * @param {{ label: string, unitsPerCall: number }} opts - label for progress
 *   lines (e.g. 'Hashing part'); unitsPerCall is totalUnits() advanced per
 *   hashNextPart() call (1 for god, the sizing batch size for ciso).
 * @returns {Promise<boolean>}
 */
async function drivePreStreamPhase(
	session,
	reportProgress,
	{ label, unitsPerCall },
) {
	const totalUnits = session.totalUnits();
	const totalCalls = Math.max(1, Math.ceil(totalUnits / unitsPerCall));

	const logEvery = Math.max(1, Math.ceil(totalCalls / 50));
	let unitsDone = 0;
	let callsDone = 0;
	let done = false;

	while (!done) {
		if (_cancelled) return false;

		if (_pausePromise) {
			self.postMessage({ type: MSG.PAUSED });
			await _pausePromise;
		}

		if (_cancelled) return false;

		done = session.hashNextPart();

		callsDone++;
		unitsDone = Math.min(unitsDone + unitsPerCall, totalUnits);

		if (callsDone % logEvery === 0 || done) {
			self.postMessage({
				type: MSG.LOG,
				payload: `${label} ${unitsDone}/${totalUnits}...`,
			});
		}

		converterLogger.debug(`${label.toLowerCase()} ${unitsDone}/${totalUnits}`);

		reportProgress(unitsDone / Math.max(totalUnits, 1));

		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	return !_cancelled;
}

/**
 * Write-side (target-format) options for ConversionSession.open().
 * `fetchSize` is excluded - it's a read-side setting from
 * `buildSourceOptions()`.
 * @param {OutputFormat} format
 * @param {FormatOptions} options - the format-specific options for
 *   `format` (entry.options[format]).
 * @param {string} gameTitle
 * @param {Uint8Array} [godSigningKey] - only meaningful for `format === 'god'`,
 *   already gated by the caller.
 * @returns {OpenConversionSessionOptions}
 */
function buildSessionOptions(format, options, gameTitle, godSigningKey) {
	switch (format) {
		case 'god': {
			const { mode, deviceId } = /** @type {GodOptions} */ (options);
			return {
				format,
				mode,
				gameTitle,
				signingKey: godSigningKey,
				deviceId: parseDeviceId(deviceId),
			};
		}
		case 'xiso': {
			const { mode, split } = /** @type {XisoOptions} */ (options);
			return {
				format,
				mode,
				split,
				sectorsPerChunk: XISO_SECTORS_PER_CHUNK,
				outputName: gameTitle,
			};
		}
		case 'ciso': {
			const { mode } = /** @type {CisoOptions} */ (options);
			return { format, mode, outputName: gameTitle };
		}
		case 'cci': {
			const { mode } = /** @type {CciOptions} */ (options);
			return { format, mode, outputName: gameTitle };
		}
		case 'extracted': {
			const { skipSystemUpdate, allowedMediaPatch, renameTitle } =
				/** @type {ExtractedOptions} */ (options);
			return {
				format,
				skipSystemUpdate,
				allowedMediaPatch,
				// renameTitle here is just the checkbox's boolean state,
				// not a string; the actual title comes from the game-title input.
				renameTitle: renameTitle ? gameTitle : undefined,
			};
		}
		case 'zar': {
			return { format, outputName: gameTitle };
		}
		default:
			throw new Error(`Unknown format: ${format}`);
	}
}

/**
 * Read-side `SourceOptions` for ConversionSession.open()/inspectSource().
 * `fetchSize` belongs here, not on the write-side options.
 * @param {ConversionFormat} sourceFormat - the *input* file's format,
 *   resolved via `resolveDroppedSource()` - not the target `format`
 *   passed to `buildSessionOptions()`.
 * @returns {SourceOptions}
 */
function buildSourceOptions(sourceFormat) {
	return { format: sourceFormat };
}

/**
 * Registers one download stream with the main thread and returns the
 * plumbing to feed it chunks with backpressure. Used once per file for
 * single-file formats, and once per manifest entry for 'ciso'.
 * @param {string | undefined} filename - omit to reuse the filename
 *   WorkerController was constructed with (single-file formats).
 * @param {bigint} totalSize
 * @returns {Promise<{
 *   id: string,
 *   waitForRoom: () => Promise<void>,
 *   sendChunk: (chunk: ArrayBuffer) => Promise<void>,
 *   close: () => Promise<void>,
 * } | null>} null if cancelled before the stream became ready.
 */
async function openDownloadStream(filename, totalSize) {
	self.postMessage({ type: MSG.STREAM_INFO, payload: { filename, totalSize } });

	/** @type {{ id: string, highWaterMark: number } | null} */
	let streamReady = null;
	await Promise.race([
		new Promise((resolve) => {
			const handler = (/** @type {MessageEvent} */ e) => {
				if (e.data.type === MSG.STREAM_READY) {
					self.removeEventListener('message', handler);
					streamReady = { id: e.data.id, highWaterMark: e.data.highWaterMark };
					resolve(undefined);
				}
			};
			self.addEventListener('message', handler);
		}),
		_cancelPromise,
	]);

	if (_cancelled || !streamReady) return null;

	const { id, highWaterMark } = streamReady;
	const ackTarget = new EventTarget();
	let inFlight = 0;

	const ackHandler = (/** @type {MessageEvent} */ e) => {
		if (e.data.type === MSG.CHUNK_ACK && e.data.id === id) {
			inFlight--;
			ackTarget.dispatchEvent(new Event('ack'));
		}
	};
	self.addEventListener('message', ackHandler);

	const waitForRoom = async () => {
		while (inFlight >= highWaterMark) {
			await Promise.race([
				new Promise((r) => ackTarget.addEventListener('ack', r, { once: true })),
				_cancelPromise,
			]);
		}
	};

	return {
		id,
		waitForRoom,
		async sendChunk(chunk) {
			if (_cancelled) return;
			await waitForRoom();
			if (_cancelled) return;
			inFlight++;
			self.postMessage({ type: MSG.STREAM_CHUNK, payload: { id, chunk } }, [
				chunk,
			]);
		},
		async close() {
			if (!_cancelled) {
				while (inFlight > 0) {
					await Promise.race([
						new Promise((r) => ackTarget.addEventListener('ack', r, { once: true })),
						_cancelPromise,
					]);
					if (_cancelled) break;
				}
				self.postMessage({ type: MSG.STREAM_CLOSE, payload: { id } });
			}
			self.removeEventListener('message', ackHandler);
		},
	};
}

/**
 * Streams the already-generated attach.xbe bytes as a second, independent
 * SW download after the primary output's own stream has closed.
 * @param {Uint8Array} bytes
 * @param {string} gameTitle
 */
async function sendAttachXbeStream(bytes, gameTitle) {
	const stream = await openDownloadStream(
		`${gameTitle}.xbe`,
		BigInt(bytes.byteLength),
	);
	if (!stream) return;

	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	await stream.sendChunk(buffer);
	await stream.close();
}

/**
 * Direct multi-file download path for formats that produce more than one
 * output file with no zip involved - one SW stream per file, opened and
 * closed in sequence as multiFileChunks() crosses entry boundaries. Used
 * by 'ciso' (always) and 'xiso' when split is enabled.
 * @param {ConversionSession} session
 * @param {Array<{ name: string, size: number }>} manifest
 * @param {(fraction: number) => void} reportProgress
 * @returns {Promise<void>}
 */
async function streamMultiFileDirect(session, manifest, reportProgress) {
	/** @type {Awaited<ReturnType<typeof openDownloadStream>>} */
	let stream = null;
	/** @type {{ name: string, expected: number, sent: number } | null} */
	let current = null;

	const chunks = multiFileChunks(
		session,
		manifest,
		async () => {
			await stream?.waitForRoom();
		},
		reportProgress,
	);

	for await (const item of chunks) {
		if (_cancelled) break;

		if (item.isNewFile) {
			if (stream) {
				// See streamSizeGuard.js.
				assertEntryComplete(current);
				await stream.close();
			}
			const entry = manifest.find((m) => m.name === item.name);
			current = { name: item.name, expected: entry?.size ?? 0, sent: 0 };
			stream = await openDownloadStream(item.name, BigInt(entry?.size ?? 0));
			if (!stream) break;
		}

		if (current) current.sent += item.chunk.byteLength;
		await stream?.sendChunk(item.chunk);
	}

	if (stream) {
		if (!_cancelled) assertEntryComplete(current);
		await stream.close();
	}
}

/** @param {PendingConvert} convert */
async function convertSource(convert) {
	const {
		source,
		gameTitle,
		format,
		options,
		generateAttachXbe: shouldGenerateAttachXbe,
		godSigningKey,
	} = convert;
	const totalFileSize = source.files.reduce((sum, f) => sum + f.size, 0);
	const fileLabel = sourceLogLabel(source);

	converterLogger.info(
		`starting conversion: ${fileLabel} (${totalFileSize} bytes), format=${format}, options=${JSON.stringify(options)}`,
	);
	self.postMessage({
		type: MSG.LOG,
		payload: `File: ${fileLabel}`,
	});

	/** @type {ConversionSession | null} */
	let session = null;
	let ackHandler = null;

	try {
		// This detects the input file's format once up front (also
		// verifying a CCI split pair or resolving a god/extracted-shaped
		// folder), then builds one ScheduledSourceReader per part (see
		// scheduledWindowedFileReader.js). Each reader wraps a windowed
		// FileReaderSync cache that becomes upgradeable to schedule-aware
		// eviction below once the source is open, and every part's reader
		// shares one WindowPool so resident cache memory stays capped no
		// matter how many parts there are (see WindowPool's doc comment).
		const pool = new WindowPool();
		/** @type {ScheduledSourceReader | undefined} */
		let primaryReader;
		const {
			format: sourceFormat,
			readFn,
			fileSize,
			sourceParts,
		} = await resolveDroppedSource(source, (file, index) => {
			const reader = new ScheduledSourceReader(file, index, pool);
			// tryGetFullModeSchedule() bails out whenever sourceParts is
			// set, so only the single-part case ever gets a schedule
			// applied below. That means part 0 is the sole reader in every
			// case this applies to, and can't end up pointing at some
			// other part's reader.
			if (index === 0) primaryReader = reader;
			return reader.read;
		});

		converterLogger.debug(
			`source shape: format=${sourceFormat}, parts=${sourceParts?.length ?? 1}, ` +
				`totalFileSize=${totalFileSize}, avgPartSize=${(
					totalFileSize / Math.max(sourceParts?.length ?? 1, 1)
				).toFixed(0)}`,
		);

		// Opened once and reused below (attach-XBE generation, then the
		// conversion session), instead of re-opening the source at each
		// step. See OpenedSource's doc comment in iso2x.
		const opened = openSource(
			readFn,
			fileSize,
			buildSourceOptions(sourceFormat),
			sourceParts,
			SEQUENTIAL_WINDOW_BYTES,
		);

		// See tryGetFullModeSchedule()'s own doc comment for what this is
		// and why it's scoped to single-part sources for now.
		const scheduleResult = tryGetFullModeSchedule(
			opened,
			format,
			options,
			sourceParts,
		);
		if (scheduleResult) {
			primaryReader?.setSchedule(scheduleResult.schedule);
		}

		/** @type {Uint8Array | null} */
		let attachXbeBytes = null;
		if (shouldGenerateAttachXbe) {
			self.postMessage({ type: MSG.LOG, payload: 'Generating attach XBE...' });
			try {
				// Called before openConversionSession(), so a non-OGX
				// source aborts immediately rather than only failing after
				// the primary output has finished. generateAttachXbe()
				// only borrows `opened`, it doesn't consume it, so on
				// failure here `opened` is still live and needs to be
				// freed ourselves.
				attachXbeBytes = opened.generateAttachXbe();
			} catch (err) {
				opened.free();
				throw err;
			}
		}

		// opened.openConversionSession() returns iso2x's raw wasm-bindgen
		// ConversionSession (undefined-based); wrap it so every helper
		// below gets the null-based shape it expects.
		//
		// Unlike generateAttachXbe(), openConversionSession() takes
		// `opened` *by value* on the Rust side. wasm-bindgen's glue hands
		// over ownership (and zeroes our JS handle) before the call
		// happens, so `opened` is already consumed whether this succeeds
		// or throws. Do NOT call opened.free() here: doing so double-frees
		// the already-consumed handle, which raises an opaque "null
		// pointer passed to rust" error that masks whatever real error
		// Rust returned (e.g. an oversized-image validation failure).
		session = ConversionSession.wrap(
			opened.openConversionSession(
				buildSessionOptions(format, options, gameTitle, godSigningKey),
			),
		);

		if (session === null) {
			// Unreachable in practice, since the catch above rethrows on
			// any failure. It's here only because TS can't narrow across
			// a try/catch boundary.
			throw new Error(
				'converterWorker: session not assigned after openConversionSession()',
			);
		}

		const writeProgress = makeProgressReporter(
			format === 'god' || format === 'ciso' || format === 'cci'
				? [50, 100]
				: [0, 100],
		);

		if (format === 'god' || format === 'ciso' || format === 'cci') {
			self.postMessage({
				type: MSG.LOG,
				payload: format === 'god' ? 'Hashing parts...' : 'Sizing sectors...',
			});

			const hashProgress = makeProgressReporter([0, 50]);
			const completed = await drivePreStreamPhase(session, hashProgress, {
				label: format === 'god' ? 'Hashing part' : 'Sizing sector',
				unitsPerCall:
					format === 'god'
						? 1
						: format === 'cci'
							? cciSizingBatchSectors()
							: cisoSizingBatchSectors(),
			});

			if (!completed || _cancelled) return;
			self.postMessage({
				type: MSG.LOG,
				payload:
					format === 'god'
						? 'Hashing complete, writing files...'
						: 'Sizing complete, writing output...',
			});
		}

		/** @type {Array<{ name: string, size: number }>} */
		let manifest = [];

		const isXisoSplit =
			format === 'xiso' && /** @type {XisoOptions} */ (options).split;
		const isMultiFileDirect =
			format === 'ciso' || format === 'cci' || isXisoSplit;

		if (format === 'god' || format === 'extracted' || isMultiFileDirect) {
			manifest = session.outputManifest();
		}

		// This is the direct, unzipped, one-download-per-split-file path,
		// used by 'ciso' (always split) and 'xiso' when the split option is on.
		if (isMultiFileDirect) {
			await streamMultiFileDirect(session, manifest, writeProgress);
			session = null;
			if (attachXbeBytes && !_cancelled) {
				await sendAttachXbeStream(attachXbeBytes, gameTitle);
			}
			if (!_cancelled) {
				self.postMessage({ type: MSG.DONE });
			}
			return;
		}

		let totalSize;
		if (format === 'god' || format === 'extracted') {
			totalSize = predictLength(manifest);
		} else if (format === 'xiso') {
			totalSize = BigInt(Math.round(session.totalUnits() * 2048));
		} else if (format === 'zar') {
			// Real compressed size isn't known until the footer phase
			totalSize = undefined;
		} else {
			throw new Error(`Unknown format: ${format}`);
		}

		self.postMessage({ type: MSG.STREAM_INFO, payload: { totalSize } });

		/** @type {{ id: number, highWaterMark: number } | null} */
		let streamReady = null;
		await Promise.race([
			new Promise((resolve) => {
				const handler = (/** @type {MessageEvent} */ e) => {
					if (e.data.type === MSG.STREAM_READY) {
						self.removeEventListener('message', handler);
						streamReady = {
							id: e.data.id,
							highWaterMark: e.data.highWaterMark,
						};
						resolve(undefined);
					}
				};
				self.addEventListener('message', handler);
			}),
			_cancelPromise,
		]);

		if (_cancelled || !streamReady) {
			session.free();
			return;
		}

		const { id, highWaterMark } = streamReady;

		const ackTarget = new EventTarget();
		let inFlight = 0;

		ackHandler = (/** @type {MessageEvent} */ e) => {
			if (e.data.type === MSG.CHUNK_ACK && e.data.id === id) {
				inFlight--;
				ackTarget.dispatchEvent(new Event('ack'));
			}
		};

		self.addEventListener('message', ackHandler);
		const waitForRoom = async () => {
			while (inFlight >= highWaterMark) {
				await Promise.race([
					new Promise((r) => ackTarget.addEventListener('ack', r, { once: true })),
					_cancelPromise,
				]);
			}
		};

		const chunks =
			format === 'god' || format === 'extracted'
				? zipChunks(session, manifest, waitForRoom, writeProgress)
				: streamChunks(
						session,
						session.totalUnits(),
						waitForRoom,
						writeProgress,
						format === 'zar' ? 1 : SECTOR_SIZE,
					);
		session = null;

		let sentBytes = 0;
		for await (const chunk of chunks) {
			if (_cancelled) break;

			await waitForRoom();
			if (_cancelled) break;
			inFlight++;
			sentBytes += chunk.byteLength;
			self.postMessage({ type: MSG.STREAM_CHUNK, payload: { id, chunk } }, [
				chunk,
			]);
		}

		if (_cancelled) {
			_currentReader?.cancel().catch(() => {});
		} else {
			while (inFlight > 0) {
				await Promise.race([
					new Promise((r) => ackTarget.addEventListener('ack', r, { once: true })),
					_cancelPromise,
				]);
				if (_cancelled) break;
			}
		}

		if (!_cancelled) {
			// See streamSizeGuard.js.
			assertStreamComplete(sentBytes, totalSize);
			self.postMessage({ type: MSG.STREAM_CLOSE, payload: { id } });
			if (attachXbeBytes) {
				await sendAttachXbeStream(attachXbeBytes, gameTitle);
			}
			self.postMessage({ type: MSG.DONE });
		}
	} finally {
		if (ackHandler) self.removeEventListener('message', ackHandler);
		session?.free();
		_currentReader = null;
		if (_cancelled) {
			converterLogger.debug('finally block reached, posting CANCEL_ACK');
			self.postMessage({ type: MSG.CANCEL_ACK });
		}
	}
}

/** @param {MessageEvent<ControllerMessage>} e */
async function onMessage(e) {
	const { type } = e.data;
	try {
		if (type === MSG.PAUSE) {
			_pausePromise = new Promise((resolve) => {
				_pauseResolve = resolve;
			});
			return;
		}
		if (type === MSG.CANCEL) {
			converterLogger.debug('cancel received');
			_cancelled = true;
			_cancelResolve();
			// Release a pending pause too, so a pause-then-cancel wakes the
			// pump loop instead of hanging on `await _pausePromise`.
			if (_pauseResolve) {
				_pauseResolve();
				_pauseResolve = null;
				_pausePromise = null;
			}
			_currentReader?.cancel().catch(() => {});
			// Don't post CANCEL_ACK here. convertSource()'s own `finally`
			// block runs session.free() and posts it once cleanup is done.
			return;
		}
		if (type === MSG.RESUME) {
			if (_pauseResolve) {
				_pauseResolve();
				_pauseResolve = null;
				_pausePromise = null;
			}
			return;
		}
		if (type === MSG.INSPECT) {
			await inspectSource(/** @type {InspectMessage} */ (e.data).source);
		} else if (type === MSG.PARTITION_DIR) {
			const assembled = partitionAccumulator.push(
				/** @type {PartitionDirMessage} */ (e.data),
			);
			if (!assembled) return;

			let count = 0;
			await partitionDroppedFolder(
				assembled.dirName,
				assembled.entries,
				assembled.files,
				(source) => {
					count++;
					self.postMessage({ type: MSG.PARTITION_ITEM, payload: source });
				},
			);
			// The payload here is just a count. Every source already went
			// out individually as PARTITION_ITEM; this only signals that
			// the batch is done.
			self.postMessage({
				type: MSG.PARTITION_RESULT,
				payload: { count },
				bytesRead: takeBytesRead(),
			});
		} else if (type === MSG.VERIFY_ORDER) {
			// `names[0]` is the header candidate; the rest are the
			// continuation ordering picked via the "Verify order" UI.
			const { names, files } = /** @type {VerifyOrderMessage} */ (e.data);
			const byName = new Map(names.map((n, i) => [n, files[i]]));
			const parts = sourceParts(names, fileReaders(byName));
			const result = verifySplitCandidate(parts);
			self.postMessage({
				type: MSG.VERIFY_RESULT,
				payload: result,
				bytesRead: takeBytesRead(),
			});
		} else if (type === MSG.CONVERT) {
			const {
				source,
				gameTitle,
				format,
				options,
				generateAttachXbe,
				godSigningKey,
			} = /** @type {ConvertMessage} */ (e.data);
			await convertSource({
				source,
				gameTitle,
				format,
				options,
				generateAttachXbe,
				godSigningKey,
			});
		}
	} catch (err) {
		converterLogger.error('caught error:', err);
		self.postMessage({ type: MSG.ERROR, payload: String(err) });
	}
}

async function init() {
	self.addEventListener('message', onMessage);
	await initWasm();
	converterLogger.info('wasm initialized');
	self.postMessage({ type: MSG.READY });
}

init();
