import { describe, it, expect, beforeEach } from 'vitest';
import {
	createLogger,
	getLogHistory,
	clearLog,
	jumpToTail,
	flushLogNow,
	isScrolledToBottom,
	setLogLevel,
} from './logger.js';

/** Waits for a real animation frame so rAF-scheduled flushes/page-checks run. */
function nextFrame() {
	return new Promise((resolve) =>
		requestAnimationFrame(() => resolve(undefined)),
	);
}

/** @returns {HTMLPreElement} */
function makeLogEl() {
	const el = document.createElement('pre');
	// happy-dom doesn't compute real layout, so scrollHeight/clientHeight
	// stay 0 by default; fake them out so isScrolledToBottom() and the
	// scrollTop-compensation math have something to work with.
	Object.defineProperty(el, 'scrollHeight', {
		configurable: true,
		get: () => el.childNodes.length * 20,
	});
	Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 });
	document.body.appendChild(el);
	return /** @type {HTMLPreElement} */ (el);
}

beforeEach(() => {
	setLogLevel('debug');
	document.body.innerHTML = '';
});

describe('createLogger', () => {
	it('writes to console when there is no logEl', () => {
		let called;
		const logger = createLogger('x', {
			mirrorToConsole: true,
		});
		const orig = console.info;
		console.info = (...args) => (called = args);
		logger.info('hello', 1);
		console.info = orig;
		expect(called).toEqual(['[x]', 'hello', 1]);
	});

	it('filters below the configured level', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl, level: 'warn' });
		logger.info('nope');
		logger.warn('yep');
		flushLogNow(logEl);
		expect(getLogHistory(logEl)).toBe('[warn] yep\n');
	});

	it('joins multiple args like console methods do', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		logger.info('a', 1, true);
		flushLogNow(logEl);
		expect(getLogHistory(logEl)).toBe('[info] a 1 true\n');
	});
});

describe('rendering', () => {
	it('does not touch the DOM until the next animation frame (coalesces bursts)', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 50; i++) logger.info(`line ${i}`);
		expect(logEl.childNodes.length).toBe(0);
		flushLogNow(logEl);
		expect(logEl.childNodes.length).toBe(50);
	});

	it('coalesces a burst within one frame into a single appendChild', async () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		let mutations = 0;
		new MutationObserver(() => mutations++).observe(logEl, { childList: true });
		for (let i = 0; i < 200; i++) logger.info(`line ${i}`);
		await nextFrame();
		// MutationObserver callbacks are themselves batched by the browser/
		// happy-dom per microtask turn, so this should be exactly one
		// batch of 200 additions, not 200 separate ones.
		await Promise.resolve();
		expect(mutations).toBeLessThanOrEqual(1);
		expect(logEl.childNodes.length).toBe(200);
	});

	it('keeps small logs fully rendered, unaffected by the cap', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 10; i++) logger.info(`line ${i}`);
		flushLogNow(logEl);
		expect(logEl.childNodes.length).toBe(10);
		expect(getLogHistory(logEl).split('\n').filter(Boolean).length).toBe(10);
	});

	it('caps rendered DOM nodes while tailing a long-running log', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 4000; i++) logger.info(`chunk ${i}`);
		flushLogNow(logEl);
		expect(logEl.childNodes.length).toBe(500);
		// oldest lines dropped first: the last node still standing should
		// be the newest line, and the first node the oldest of the window.
		expect(logEl.textContent?.endsWith('[info] chunk 3999\n')).toBe(true);
		expect(logEl.textContent?.startsWith('[info] chunk 3500\n')).toBe(true);
	});

	it('keeps full, untrimmed history for getLogHistory() even once capped', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 4000; i++) logger.info(`chunk ${i}`);
		flushLogNow(logEl);
		const history = getLogHistory(logEl).split('\n').filter(Boolean);
		expect(history.length).toBe(4000);
		expect(history[0]).toBe('[info] chunk 0');
		expect(history[3999]).toBe('[info] chunk 3999');
	});

	it('getLogHistory includes lines written but not yet flushed to the DOM', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		logger.info('unflushed');
		expect(logEl.childNodes.length).toBe(0);
		expect(getLogHistory(logEl)).toBe('[info] unflushed\n');
	});

	it('auto-scrolls only when already at the bottom', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 20; i++) logger.info(`line ${i}`);
		flushLogNow(logEl);
		// started empty -> was "at bottom" -> should have followed to the new bottom
		expect(logEl.scrollTop).toBe(logEl.scrollHeight);

		logEl.scrollTop = 0; // simulate having scrolled away from the bottom
		logger.info('more');
		flushLogNow(logEl);
		expect(logEl.scrollTop).toBe(0);
	});
});

describe('paging older history back in on scroll-up', () => {
	it('does nothing when there is no trimmed-off history to page in', async () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 10; i++) logger.info(`line ${i}`);
		flushLogNow(logEl);
		logEl.scrollTop = 0;
		logEl.dispatchEvent(new Event('scroll'));
		await nextFrame();
		expect(logEl.childNodes.length).toBe(10);
	});

	it('pages older lines back in above the window when scrolled to the top', async () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 1000; i++) logger.info(`chunk ${i}`);
		flushLogNow(logEl);
		expect(logEl.childNodes.length).toBe(500);
		expect(logEl.textContent?.startsWith('[info] chunk 500\n')).toBe(true);

		logEl.scrollTop = 0;
		logEl.dispatchEvent(new Event('scroll'));
		await nextFrame();

		// paged in 200 older lines, trimmed 200 off the (now off-screen)
		// bottom to keep the rendered count capped - net count unchanged.
		expect(logEl.childNodes.length).toBe(500);
		expect(logEl.textContent?.startsWith('[info] chunk 300\n')).toBe(true);
		expect(logEl.textContent?.includes('chunk 999')).toBe(false);
	});

	it('compensates scrollTop by exactly the height of the content it prepended', async () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 1000; i++) logger.info(`chunk ${i}`);
		flushLogNow(logEl);

		logEl.scrollTop = 0;
		logEl.dispatchEvent(new Event('scroll'));
		await nextFrame();

		// PAGE_SIZE (200) lines were prepended above the old top of the
		// window; an equal number were trimmed off the (now off-screen)
		// bottom to hold the total rendered count steady, so the net
		// scrollHeight doesn't change - but the viewport itself must be
		// pushed down by exactly the height of what was prepended, or the
		// content the user was looking at would visibly jump.
		expect(logEl.scrollTop).toBe(200 * 20);
	});

	it('new lines while paged away from the tail land in history without touching the DOM', async () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 1000; i++) logger.info(`chunk ${i}`);
		flushLogNow(logEl);
		logEl.scrollTop = 0;
		logEl.dispatchEvent(new Event('scroll'));
		await nextFrame();

		const countBefore = logEl.childNodes.length;
		logger.info('chunk 1000');
		flushLogNow(logEl);
		expect(logEl.childNodes.length).toBe(countBefore);
		expect(getLogHistory(logEl).includes('chunk 1000')).toBe(true);
	});
});

describe('jumpToTail', () => {
	it('rebuilds the tail window after paging away and scrolls to the bottom', async () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 1000; i++) logger.info(`chunk ${i}`);
		flushLogNow(logEl);
		logEl.scrollTop = 0;
		logEl.dispatchEvent(new Event('scroll'));
		await nextFrame();
		expect(logEl.textContent?.includes('chunk 999')).toBe(false);

		jumpToTail(logEl);
		expect(logEl.textContent?.endsWith('[info] chunk 999\n')).toBe(true);
		expect(logEl.childNodes.length).toBe(500);
		expect(logEl.scrollTop).toBe(logEl.scrollHeight);
	});

	it('is a no-op (beyond scrolling) when already showing the tail', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 10; i++) logger.info(`line ${i}`);
		flushLogNow(logEl);
		jumpToTail(logEl);
		expect(logEl.childNodes.length).toBe(10);
	});
});

describe('clearLog', () => {
	it('clears both the rendered DOM and the full history', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		for (let i = 0; i < 10; i++) logger.info(`line ${i}`);
		flushLogNow(logEl);
		clearLog(logEl);
		expect(logEl.childNodes.length).toBe(0);
		expect(getLogHistory(logEl)).toBe('');
	});

	it('lets a logger keep writing normally after a clear', () => {
		const logEl = makeLogEl();
		const logger = createLogger('x', { logEl });
		logger.info('before');
		flushLogNow(logEl);
		clearLog(logEl);
		logger.info('after');
		flushLogNow(logEl);
		expect(getLogHistory(logEl)).toBe('[info] after\n');
	});
});

describe('multiple createLogger() calls sharing one logEl', () => {
	it('continues the same backlog and rendered window (e.g. per-disc loggers in a multi-disc job)', () => {
		const logEl = makeLogEl();
		const discOneLog = createLogger('disc1', { logEl, level: 'info' });
		discOneLog.info('disc 1 done');
		flushLogNow(logEl);

		const discTwoLog = createLogger('disc2', { logEl, level: 'info' });
		discTwoLog.info('disc 2 done');
		flushLogNow(logEl);

		expect(getLogHistory(logEl)).toBe('[info] disc 1 done\n[info] disc 2 done\n');
		expect(logEl.childNodes.length).toBe(2);
	});
});

describe('getLogHistory / flushLogNow on an untouched element', () => {
	it('returns empty string and no-ops safely', () => {
		const logEl = makeLogEl();
		expect(getLogHistory(logEl)).toBe('');
		expect(() => flushLogNow(logEl)).not.toThrow();
	});
});

describe('isScrolledToBottom', () => {
	it('is true within the default threshold', () => {
		const el = /** @type {HTMLElement} */ ({
			scrollHeight: 100,
			scrollTop: 95,
			clientHeight: 10,
		});
		expect(isScrolledToBottom(el)).toBe(true);
	});

	it('is false outside the threshold', () => {
		const el = /** @type {HTMLElement} */ ({
			scrollHeight: 100,
			scrollTop: 50,
			clientHeight: 10,
		});
		expect(isScrolledToBottom(el)).toBe(false);
	});
});
