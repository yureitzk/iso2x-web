/**
 * Size of converterWorker.js's windowed FileReaderSync read cache (see
 * windowedFileReader.js). Also passed into iso2x's openSource() as a hint
 * for its own internal read batching.
 */
export const SEQUENTIAL_WINDOW_BYTES = 16 * 1024 * 1024;
