/** Size of the windowed FileReaderSync read cache's windows. */
export const SEQUENTIAL_WINDOW_BYTES = 16 * 1024 * 1024;

/** Number of windows kept resident at once (LRU-evicted past this). */
export const SEQUENTIAL_WINDOW_COUNT = 8;

/** Floor on a cold/scattered miss's fill size. */
export const SEQUENTIAL_MIN_FILL_BYTES = 4 * 1024 * 1024;
