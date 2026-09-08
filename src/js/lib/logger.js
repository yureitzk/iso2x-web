/**
 * @import { LogLevel, Logger } from '../../types/global'
 */

/** @type {Record<LogLevel, number>} */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = 0;

/**
 * Set the minimum log level. Messages below this level are suppressed.
 * @param {LogLevel} level
 */
export function setLogLevel(level) {
	minLevel = LEVELS[level] ?? 0;
}

/**
 * @param {HTMLElement} el
 * @param {number}      [threshold=8]
 */
export function isScrolledToBottom(el, threshold = 8) {
	return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

/** @typedef {(...args: unknown[]) => void} ConsoleFn */
/** @typedef {{ text: string }} LogLine */

/**
 * @typedef {object} LogElState
 * @property {LogLine[]} history        Full backlog, oldest first; the
 *   DOM only ever shows a window into it.
 * @property {number}    renderStart    Index into `history` of the first
 *   line backed by a live DOM node.
 * @property {number}    renderEnd      Index into `history` one past the
 *   last line backed by a live DOM node.
 * @property {Text[]}    renderedNodes  Live text nodes, parallel to
 *   `history[renderStart:renderEnd]`, in DOM order.
 * @property {boolean}   flushScheduled A tail-append flush is queued for
 *   the next animation frame.
 * @property {boolean}   pageCheckScheduled A scroll-triggered page-in
 *   check is queued for the next animation frame.
 * @property {boolean}   pagingBound    Whether the scroll listener that
 *   pages older history back in is attached yet.
 */

/**
 * Per-<pre> log state, keyed by element rather than by `createLogger()`
 * call, since one log element gets a fresh `createLogger()` call per
 * conversion attempt (e.g. per disc in a multi-disc job) but all of them
 * share the same backlog and rendered window.
 * @type {WeakMap<HTMLElement, LogElState>}
 */
const logStates = new WeakMap();

// Log lines wrap (whitespace-pre-wrap), so there's no fixed line height
// to virtualize by pixel position. Instead this windows by *logical
// entry*: only MAX_RENDERED_LINES are ever live DOM nodes, and scrolling
// near the top pages older entries back in from `history`.
const MAX_RENDERED_LINES = 500;
const PAGE_SIZE = 200;
const TOP_PAGE_THRESHOLD_PX = 48;
// Backstop against a runaway producer (e.g. a stuck worker looping
// MSG.LOG); a real conversion never gets close to this.
const HISTORY_HARD_CAP = 20_000;

/** @param {HTMLElement} logEl */
function getState(logEl) {
	let state = logStates.get(logEl);
	if (!state) {
		state = {
			history: [],
			renderStart: 0,
			renderEnd: 0,
			renderedNodes: [],
			flushScheduled: false,
			pageCheckScheduled: false,
			pagingBound: false,
		};
		logStates.set(logEl, state);
	}
	return state;
}

/**
 * Removes `count` nodes from the given end of the rendered window and
 * keeps `renderStart`/`renderEnd`/`renderedNodes` in sync. Only called
 * on the end that's currently scrolled out of view.
 * @param {HTMLElement} logEl
 * @param {LogElState} state
 * @param {'start' | 'end'} edge
 * @param {number} count
 */
function dropRenderedNodes(logEl, state, edge, count) {
	for (let i = 0; i < count; i++) {
		const node =
			edge === 'start' ? state.renderedNodes.shift() : state.renderedNodes.pop();
		if (node?.parentNode === logEl) logEl.removeChild(node);
	}
	if (edge === 'start') state.renderStart += count;
	else state.renderEnd -= count;
}

/**
 * Appends every history line the DOM hasn't caught up to yet in one
 * fragment, then trims the top of the window if it's grown past the
 * cap - safe since while tailing, the top is scrolled out of view.
 * @param {HTMLElement} logEl
 * @param {LogElState} state
 */
function flushTail(logEl, state) {
	state.flushScheduled = false;
	if (state.renderEnd >= state.history.length) return;

	const atBottom = isScrolledToBottom(logEl);
	const fragment = document.createDocumentFragment();
	while (state.renderEnd < state.history.length) {
		const node = document.createTextNode(state.history[state.renderEnd].text);
		state.renderedNodes.push(node);
		fragment.appendChild(node);
		state.renderEnd++;
	}
	logEl.appendChild(fragment);

	const overflow = state.renderEnd - state.renderStart - MAX_RENDERED_LINES;
	if (overflow > 0) dropRenderedNodes(logEl, state, 'start', overflow);

	if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

/**
 * @param {HTMLElement} logEl
 * @param {LogElState} state
 */
function scheduleTailFlush(logEl, state) {
	if (state.flushScheduled) return;
	state.flushScheduled = true;
	requestAnimationFrame(() => flushTail(logEl, state));
}

/**
 * Pages an older chunk of history in above the current window when the
 * user scrolls near the top, dropping an equivalent chunk off the
 * (now off-screen) bottom to keep the rendered set bounded.
 * @param {HTMLElement} logEl
 * @param {LogElState} state
 */
function pageInOlderLines(logEl, state) {
	if (state.renderStart === 0) return;
	if (logEl.scrollTop > TOP_PAGE_THRESHOLD_PX) return;

	const count = Math.min(PAGE_SIZE, state.renderStart);
	const startIdx = state.renderStart - count;
	const fragment = document.createDocumentFragment();
	/** @type {Text[]} */
	const newNodes = [];
	for (let i = startIdx; i < state.renderStart; i++) {
		const node = document.createTextNode(state.history[i].text);
		newNodes.push(node);
		fragment.appendChild(node);
	}

	const beforeHeight = logEl.scrollHeight;
	logEl.insertBefore(fragment, logEl.firstChild);
	state.renderedNodes.unshift(...newNodes);
	state.renderStart = startIdx;
	// Prepend-compensation: shift scrollTop by exactly how much taller the
	// content got, measuring the real delta so it's correct regardless of
	// how lines wrap.
	logEl.scrollTop += logEl.scrollHeight - beforeHeight;

	const overflow = state.renderEnd - state.renderStart - MAX_RENDERED_LINES;
	if (overflow > 0) dropRenderedNodes(logEl, state, 'end', overflow);
}

/**
 * @param {HTMLElement} logEl
 * @param {LogElState} state
 */
function schedulePageCheck(logEl, state) {
	if (state.pageCheckScheduled) return;
	state.pageCheckScheduled = true;
	requestAnimationFrame(() => {
		state.pageCheckScheduled = false;
		pageInOlderLines(logEl, state);
	});
}

/**
 * @param {HTMLElement} logEl
 * @param {LogElState} state
 */
function ensurePagingBound(logEl, state) {
	if (state.pagingBound) return;
	state.pagingBound = true;
	logEl.addEventListener('scroll', () => schedulePageCheck(logEl, state));
}

/**
 * Full, untrimmed backlog for a log element - independent of however much
 * of it is currently rendered - as one string. Used for "copy full log".
 * @param {HTMLElement} logEl
 * @returns {string}
 */
export function getLogHistory(logEl) {
	const state = logStates.get(logEl);
	if (!state) return '';
	let out = '';
	for (const line of state.history) out += line.text;
	return out;
}

/**
 * Clears both the backlog and the rendered DOM window for a log element.
 * @param {HTMLElement} logEl
 */
export function clearLog(logEl) {
	const state = getState(logEl);
	state.history = [];
	state.renderedNodes = [];
	state.renderStart = 0;
	state.renderEnd = 0;
	state.flushScheduled = false;
	logEl.textContent = '';
}

/**
 * Rebuilds the rendered window to show the true tail of history (in case
 * paging backward had trimmed it off) and scrolls to the bottom. Used by
 * the "jump to bottom" button, since while paged away from the tail new
 * lines land in `history` without touching the DOM (see `write()`).
 * @param {HTMLElement} logEl
 */
export function jumpToTail(logEl) {
	const state = getState(logEl);
	const start = Math.max(0, state.history.length - MAX_RENDERED_LINES);
	if (state.renderStart !== start || state.renderEnd !== state.history.length) {
		logEl.textContent = '';
		state.renderedNodes = [];
		const fragment = document.createDocumentFragment();
		for (let i = start; i < state.history.length; i++) {
			const node = document.createTextNode(state.history[i].text);
			state.renderedNodes.push(node);
			fragment.appendChild(node);
		}
		logEl.appendChild(fragment);
		state.renderStart = start;
		state.renderEnd = state.history.length;
	}
	logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Forces any pending tail flush to run synchronously instead of waiting
 * on the next animation frame. Exists for tests and other callers that
 * need the DOM to reflect `history` immediately.
 * @param {HTMLElement} logEl
 */
export function flushLogNow(logEl) {
	const state = logStates.get(logEl);
	if (!state) return;
	flushTail(logEl, state);
}

/**
 * @typedef {object} LoggerOptions
 * @property {HTMLPreElement} [logEl]
 * @property {boolean}        [mirrorToConsole=false]
 * @property {LogLevel}       [level='debug']
 */

/**
 * Create a namespaced logger that respects the current log level.
 * @param {string}        prefix
 * @param {LoggerOptions} [options]
 * @returns {Logger}
 */
export function createLogger(prefix, options) {
	const { logEl, mirrorToConsole = false, level } = options ?? {};
	const hasExplicitLevel = level !== undefined;
	const loggerMinLevel = LEVELS[level ?? 'debug'] ?? 0;

	/** @param {ConsoleFn} consoleFn @param {LogLevel} lvl @param {unknown[]} args */
	function write(consoleFn, lvl, args) {
		const effectiveMin = hasExplicitLevel
			? loggerMinLevel
			: Math.max(minLevel, loggerMinLevel);
		if (LEVELS[lvl] < effectiveMin) return;
		if (!logEl || mirrorToConsole) consoleFn(`[${prefix}]`, ...args);
		if (!logEl) return;

		const state = getState(logEl);
		// Tailing = the rendered window reaches the live end of history,
		// i.e. the user hasn't scrolled away from the latest output. Only
		// then does a new line need to touch the DOM.
		const wasTailing = state.renderEnd === state.history.length;

		state.history.push({
			text: `[${lvl}] ${args.map(String).join(' ')}\n`,
		});
		if (state.history.length > HISTORY_HARD_CAP) {
			// Only drop entries before renderStart (no live DOM node), so
			// this can't desync renderedNodes from the window it mirrors.
			const excess = state.history.length - HISTORY_HARD_CAP;
			const drop = Math.min(excess, state.renderStart);
			if (drop > 0) {
				state.history.splice(0, drop);
				state.renderStart -= drop;
				state.renderEnd -= drop;
			}
		}

		if (wasTailing) {
			ensurePagingBound(logEl, state);
			scheduleTailFlush(logEl, state);
		}
	}

	return {
		debug: (...args) => write(console.debug, 'debug', args),
		info: (...args) => write(console.info, 'info', args),
		warn: (...args) => write(console.warn, 'warn', args),
		error: (...args) => write(console.error, 'error', args),
	};
}

export function setDefaultLogLevel() {
	setLogLevel(import.meta.env.DEV ? 'debug' : 'warn');
}
