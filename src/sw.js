/// <reference lib="webworker" />

import { precacheAndRoute } from 'workbox-precaching';
import { createHandlers } from './js/serviceWorker/runtime/swHandlers.js';
import { setDefaultLogLevel } from './js/lib/logger.js';

setDefaultLogLevel();

const sw = /** @type {ServiceWorkerGlobalScope} */ (
	/** @type {unknown} */ (self)
);

// This is a workaround to ensure our Cross-Origin-Embedder-Policy header
// (required so embedded iframes must declare their own CORP/COEP policy)
// still applies even when Workbox bypasses our standard fetch listeners by
// serving files directly from the precache.
sw.addEventListener('fetch', (e) => {
	const originalRespondWith = e.respondWith.bind(e);

	e.respondWith = function (promise) {
		originalRespondWith(
			Promise.resolve(promise).then((response) => {
				if (
					!response ||
					response.status === 0 ||
					response.type === 'opaque' ||
					response.type === 'error' ||
					response.type === 'opaqueredirect'
				) {
					return response;
				}

				const headers = new Headers(response.headers);
				headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

				return new Response(response.body, {
					status: response.status,
					statusText: response.statusText,
					headers,
				});
			}),
		);
	};
});

if (!import.meta.env.DEV) {
	precacheAndRoute(self.__WB_MANIFEST ?? []);
}

const { onMessage, onFetch, onActivate } = createHandlers(sw);

sw.addEventListener('activate', onActivate);
sw.addEventListener('message', onMessage);
sw.addEventListener('fetch', onFetch);
