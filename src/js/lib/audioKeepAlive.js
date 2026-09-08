import { createLogger } from './logger.js';
import { TEXT } from '../constants/messages.js';

const log = createLogger('audio-keepalive');

function buildSilentWavUrl(seconds = 1, sampleRate = 8000) {
	const numSamples = seconds * sampleRate;
	const bytes = 44 + numSamples * 2;
	const buffer = new ArrayBuffer(bytes);
	const view = new DataView(buffer);
	/**
	 * @param {number} offset
	 * @param {string} str
	 */
	const write = (offset, str) => {
		for (let i = 0; i < str.length; i++)
			view.setUint8(offset + i, str.charCodeAt(i));
	};

	write(0, 'RIFF');
	view.setUint32(4, bytes - 8, true);

	write(8, 'WAVE');
	write(12, 'fmt ');

	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);

	write(36, 'data');

	view.setUint32(40, numSamples * 2, true);

	return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

/** @type {HTMLAudioElement | null} */
let audioEl = null;
let _enabled = false;
let _active = false;

const isSupported = () => typeof Audio !== 'undefined' && !navigator.webdriver;

function ensureElement() {
	if (audioEl) return audioEl;

	const el = new Audio(buildSilentWavUrl(20, 8000));
	el.loop = true;
	el.volume = 1;
	el.muted = false;
	el.preload = 'auto';
	el.setAttribute('playsinline', '');
	audioEl = el;
	return el;
}

const hasMediaSession = () => 'mediaSession' in navigator;

// Only binds to the existing <audio> element (no <video>, no canvas,
// no captureStream()); just a metadata/action-handler registration on
// top of the element already created in ensureElement().
function configureMediaSession() {
	if (!hasMediaSession()) return;
	try {
		navigator.mediaSession.metadata = new MediaMetadata({
			title: TEXT.AUDIO_KEEPALIVE_MEDIA_TITLE,
			artist: TEXT.AUDIO_KEEPALIVE_MEDIA_ARTIST,
		});
		// No-ops: we don't want the OS media keys/notification actually
		// pausing our keepalive tone out from under a running conversion.
		navigator.mediaSession.setActionHandler('play', () => play());
		navigator.mediaSession.setActionHandler('pause', () => {});
	} catch (err) {
		log.warn('mediaSession setup failed:', err);
	}
}

/** @param {MediaSessionPlaybackState} state */
function setMediaSessionState(state) {
	if (!hasMediaSession()) return;
	try {
		navigator.mediaSession.playbackState = state;
	} catch {
		// non-critical, ignore
	}
}

async function play() {
	if (!isSupported()) return;
	const el = ensureElement();
	try {
		await el.play();
		configureMediaSession();
		setMediaSessionState('playing');
		log.info('Silent keepalive audio playing');
	} catch (err) {
		log.warn('Keepalive play() rejected, will retry on interaction:', err);
	}
}

function pause() {
	audioEl?.pause();
	setMediaSessionState('paused');
}

if (isSupported()) {
	const retry = () => {
		if (_enabled && _active && audioEl?.paused) play();
	};
	document.addEventListener('visibilitychange', retry);
	['pointerdown', 'keydown'].forEach((evt) =>
		document.addEventListener(evt, retry, { passive: true }),
	);
}

/** @param {boolean} enabled */
export function setAudioKeepAliveEnabled(enabled) {
	if (!isSupported()) return;

	_enabled = enabled;
	if (_enabled && _active) {
		play();
	} else {
		pause();
	}
}

export function notifyConversionStarted() {
	if (!isSupported()) return;

	_active = true;
	if (_enabled) play();
}

export function notifyConversionFinished() {
	if (!isSupported()) return;

	_active = false;
	pause();
}
