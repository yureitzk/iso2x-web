import { createLogger } from './logger.js';
import { NOSLEEP_WEBM, NOSLEEP_MP4 } from '../constants/media.js';

const log = createLogger('wake-lock');

/** @type {WakeLockSentinel | null} */
let sentinel = null;
/** @type {HTMLVideoElement | null} */
let fallbackVideo = null;
/** @type {Promise<boolean> | null} */
let acquiringPromise = null;

let _enabled = false;
let _active = false;

const hasNativeWakeLock = () => 'wakeLock' in navigator;
const isSupported = () => !navigator.webdriver;

/** @returns {HTMLVideoElement} */
function getFallbackVideo() {
	if (fallbackVideo) return fallbackVideo;

	const video = document.createElement('video');
	video.setAttribute('title', 'keep-awake');
	video.setAttribute('playsinline', '');
	video.setAttribute('aria-hidden', 'true');
	video.muted = true;
	video.loop = true;
	Object.assign(video.style, {
		position: 'fixed',
		width: '1px',
		height: '1px',
		opacity: '0',
		pointerEvents: 'none',
	});

	/** @param {string} type @param {string} src */
	const addSource = (type, src) => {
		const source = document.createElement('source');
		source.type = type;
		source.src = src;
		video.appendChild(source);
	};
	addSource('video/webm', NOSLEEP_WEBM);
	addSource('video/mp4', NOSLEEP_MP4);

	document.body.appendChild(video);
	fallbackVideo = video;
	return video;
}

/** @returns {Promise<boolean>} */
function acquireNative() {
	if (sentinel) return Promise.resolve(true);
	if (acquiringPromise) return acquiringPromise;

	acquiringPromise = (async () => {
		try {
			sentinel = await navigator.wakeLock.request('screen');
			sentinel.addEventListener('release', () => {
				log.info('Wake lock released');
				sentinel = null;
			});
			log.info('Wake lock acquired (native)');
			return true;
		} catch (err) {
			log.warn('Wake lock request failed:', err);
			return false;
		} finally {
			acquiringPromise = null;
		}
	})();

	return acquiringPromise;
}

/** @returns {Promise<boolean>} */
async function acquireFallback() {
	const video = getFallbackVideo();
	if (!video.paused) return true;
	try {
		await video.play();
		log.info('Wake lock acquired (video fallback)');
		return true;
	} catch (err) {
		log.warn('Fallback video play failed:', err);
		return false;
	}
}

function releaseNative() {
	sentinel?.release();
	sentinel = null;
}

function releaseFallback() {
	fallbackVideo?.pause();
}

/** @returns {Promise<boolean>} */
async function sync() {
	if (!isSupported()) return false;

	const shouldHold =
		_enabled && _active && document.visibilityState === 'visible';
	if (!shouldHold) {
		if (hasNativeWakeLock()) releaseNative();
		else releaseFallback();
		return false;
	}

	return hasNativeWakeLock() ? acquireNative() : acquireFallback();
}

if (isSupported()) {
	document.addEventListener('visibilitychange', sync);
	document.addEventListener('fullscreenchange', sync);
}

/** @returns {boolean} */
export function isWakeLockActive() {
	return hasNativeWakeLock()
		? sentinel !== null
		: !!fallbackVideo && !fallbackVideo.paused;
}

/**
 * @param {boolean} enabled
 * @returns {Promise<boolean>}
 */
export function setWakeLockEnabled(enabled) {
	_enabled = enabled;
	return sync();
}

/** @returns {Promise<boolean>} */
export function notifyConversionStarted() {
	_active = true;
	return sync();
}

/** @returns {Promise<boolean>} */
export function notifyConversionFinished() {
	_active = false;
	return sync();
}
