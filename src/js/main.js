import 'virtual:svg-icons-register';
import { setDefaultLogLevel } from './lib/logger.js';
import { initTheme } from './lib/theme.js';
import { initFavicon } from './lib/favicon.js';
import { initBadge } from './lib/badge.js';
import { initServiceWorker } from './serviceWorker/SwBridge.js';
import { initFeatures, setFeaturesSwBridge } from './ui/features.js';
import { applyHeaderAnimation, initSettingsPanel } from './ui/settingsPanel.js';
import { initQueue } from './ui/queue/queueUi.js';
import '../css/styles.css';
import { initQueueStats } from './ui/queue/queueStats.js';
import { EVENTS } from './core/protocol.js';

async function init() {
	setDefaultLogLevel();
	initTheme();
	initFavicon();
	initBadge();
	initFeatures();
	applyHeaderAnimation();
	initSettingsPanel();

	const swBridge = await initServiceWorker();
	setFeaturesSwBridge(swBridge);

	// Re-check for SW
	window.dispatchEvent(new Event(EVENTS.FEATURE_CHANGED));

	initQueue(swBridge);
	initQueueStats();
}

init();
