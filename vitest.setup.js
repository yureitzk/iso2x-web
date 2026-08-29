import { MessageChannel } from 'node:worker_threads';

if (typeof globalThis.MessageChannel === 'undefined') {
	globalThis.MessageChannel = MessageChannel;
}

if (typeof navigator !== 'undefined' && !navigator.serviceWorker) {
	const target = new EventTarget();
	Object.defineProperty(navigator, 'serviceWorker', {
		configurable: true,
		value: {
			addEventListener: target.addEventListener.bind(target),
			removeEventListener: target.removeEventListener.bind(target),
			dispatchEvent: target.dispatchEvent.bind(target),
			controller: { postMessage: () => {} },
			ready: Promise.resolve({ active: { postMessage: () => {} } }),
			register: () => Promise.resolve({ active: { postMessage: () => {} } }),
		},
	});
}
