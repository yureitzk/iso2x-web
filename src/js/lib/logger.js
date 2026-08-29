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

	function isLogElAtBottom() {
		return logEl ? isScrolledToBottom(logEl) : false;
	}

	/** @param {ConsoleFn} consoleFn @param {LogLevel} lvl @param {unknown[]} args */
	function write(consoleFn, lvl, args) {
		const effectiveMin = hasExplicitLevel
			? loggerMinLevel
			: Math.max(minLevel, loggerMinLevel);
		if (LEVELS[lvl] < effectiveMin) return;
		if (!logEl || mirrorToConsole) consoleFn(`[${prefix}]`, ...args);
		if (logEl) {
			const atBottom = isLogElAtBottom();
			logEl.appendChild(
				document.createTextNode(`[${lvl}] ${args.map(String).join(' ')}\n`),
			);
			if (atBottom) logEl.scrollTop = logEl.scrollHeight;
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
