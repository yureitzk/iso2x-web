import { EVENTS } from '../../src/js/core/protocol.js';

/**
 * @import { QueueEntry, DroppedSource } from '../../src/types/global'
 * @import { PartialDeep } from 'type-fest'
 */

export const FIXTURE_FILE_SIZE = 8;

/**
 * @param {string} name
 * @param {string} [webkitRelativePath] set when simulating a webkitdirectory drop
 * @returns {File}
 */
export function file(name, webkitRelativePath) {
	const f = new File([new Uint8Array(FIXTURE_FILE_SIZE)], name);
	if (webkitRelativePath) {
		Object.defineProperty(f, 'webkitRelativePath', {
			value: webkitRelativePath,
			configurable: true,
		});
	}
	return f;
}

/**
 * `.value` is seeded via Object.defineProperty because a real file
 * input throws InvalidStateError if set to anything but '' directly.
 * @param {File[]} files
 * @param {string} [value]
 * @returns {HTMLInputElement}
 */
export function stubInput(files, value = '') {
	const input = document.createElement('input');
	input.type = 'file';
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	input.files = dt.files;
	Object.defineProperty(input, 'value', {
		value,
		writable: true,
		configurable: true,
	});
	return input;
}

/**
 * Escape hatch for reading `item.source` in assertions without fighting
 * TS's narrowing of the DroppedSource union through a mocked round trip.
 * @param {QueueEntry} item
 * @returns {any}
 */
export function sourceOf(item) {
	return item.source;
}

/**
 * Duck-typed since a mock can't satisfy WorkerController's real type
 * directly - TS treats classes with #-private fields as nominal
 * (https://github.com/microsoft/TypeScript/issues/28128).
 * @typedef {{ dispatchEvent: (event: Event) => void }} DispatchableController
 */

/**
 * @param {DispatchableController} ctrl
 * @param {DroppedSource[]} sources
 */
export function dispatchPartitionResult(ctrl, sources) {
	for (const source of sources) {
		ctrl.dispatchEvent(
			new CustomEvent(EVENTS.PARTITION_ITEM, { detail: source }),
		);
	}
	ctrl.dispatchEvent(
		new CustomEvent(EVENTS.PARTITION_RESULT, {
			detail: { count: sources.length },
		}),
	);
}

/**
 * @param {PartialDeep<QueueEntry>} overrides
 * @returns {QueueEntry}
 */
export function stubItem(overrides) {
	/** @type {any} */
	const stub = {
		fileSizeEl: { textContent: '' },
		files: [],
		lockedFiles: new Set(),
		status: 'idle',
		...overrides,
	};
	return stub;
}
