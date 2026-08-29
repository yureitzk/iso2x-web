import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EVENTS, MSG } from '../../core/protocol.js';
import { queue } from '../../queue/queue.js';
import { createMockSwBridge } from '../../../../test/utils/swBridgeMock.js';

const { settings: mockSettings } = await vi.hoisted(async () => {
	const { createMockSettings } =
		await import('../../../../test/utils/settingsMock.js');
	return createMockSettings();
});
vi.mock('../../lib/settings.js', () => ({ settings: mockSettings }));

const { MockWorkerController, mockControllers } = await vi.hoisted(async () => {
	const { createMockWorkerController } =
		await import('../../../../test/utils/workerControllerMock.js');
	return createMockWorkerController();
});
vi.mock('../../workers/WorkerController.js', () => ({
	WorkerController: MockWorkerController,
}));
const { lastController: lastControllerOf } =
	await import('../../../../test/utils/workerControllerMock.js');
const lastController = () => lastControllerOf(mockControllers);

const { createConversionController } = await import('./queueConversion.js');

/**
 * @param {string} name
 * @param {number} [size]
 * @returns {File}
 */
function file(name, size = 8) {
	return new File([new Uint8Array(size)], name);
}

/**
 * @param {string} name
 * @returns {HTMLButtonElement}
 */
function button(name) {
	const el = document.createElement('button');
	el.dataset.name = name;
	return el;
}
/**
 * Minimal single-file QueueEntry - just enough DOM/state to drive
 * startConversion() down its non-multi-disc path.
 * @returns {any}
 */
function makeSingleEntry() {
	const titleEl = /** @type {HTMLInputElement} */ (
		document.createElement('input')
	);
	titleEl.value = '';

	return {
		status: 'idle',
		awaitingSlot: false,
		ctrl: null,
		progress: undefined,
		source: { kind: 'files', files: [file('game.iso')] },
		titleEl,
		logEl: document.createElement('pre'),
		clearBtn: button('clear'),
		copyBtn: button('copy'),
		scrollBottomBtn: button('scrollBottom'),
		options: { format: 'zar', zar: {} },
		generateAttachXbe: false,
		sourceIsOgx: false,
		godSigningKey: undefined,
	};
}

/**
 * Minimal multi-disc QueueEntry - just enough DOM/state for
 * createConversionController's multi-disc path to run against.
 * @param {{ discCount?: number }} [opts]
 * @returns {any}
 */
function makeMultiDiscEntry({ discCount = 2 } = {}) {
	const discs = Array.from({ length: discCount }, (_, i) => ({
		kind: 'files',
		files: [file(`Game (Disc ${i + 1}).iso`)],
	}));

	const titleEl = /** @type {HTMLInputElement} */ (
		document.createElement('input')
	);
	titleEl.value = '';

	return {
		status: 'idle',
		awaitingSlot: false,
		ctrl: null,
		discRun: undefined,
		progress: undefined,
		source: { kind: 'multi-disc', titleId: 'ABCD1234', discs },
		titleEl,
		logEl: document.createElement('pre'),
		clearBtn: button('clear'),
		copyBtn: button('copy'),
		scrollBottomBtn: button('scrollBottom'),
		options: {
			format: 'god',
			god: {},
		},
		generateAttachXbe: false,
		sourceIsOgx: false,
		godSigningKey: undefined,
	};
}

describe('createConversionController - multi-disc SW cancellation', () => {
	/** @type {ReturnType<typeof createConversionController>} */
	let conversion;
	/** @type {ReturnType<typeof createMockSwBridge>} */
	let swBridge;

	beforeEach(() => {
		mockControllers.length = 0;
		queue.length = 0;
		swBridge = createMockSwBridge();
		conversion = createConversionController({
			getSwBridge: () => /** @type {any} */ (swBridge),
			setStatus: (entry, status) => {
				entry.status = status;
			},
			updateProgressDisplay: () => {},
		});

		// Stub the keepalive timer worker startMultiDiscConversion() spins
		// up; unrelated to what this suite exercises.
		vi.stubGlobal(
			'Worker',
			class {
				postMessage() {}
				terminate() {}
			},
		);
	});

	afterEach(() => {
		queue.length = 0;
		vi.unstubAllGlobals();
	});

	it('terminates the active disc controller when the SW reports one of its streams cancelled', async () => {
		const entry = makeMultiDiscEntry({ discCount: 2 });
		queue.push(entry);

		conversion.startConversion(entry);
		await vi.waitFor(() => expect(mockControllers.length).toBe(1));

		const discCtrl = lastController();
		discCtrl.streamIds = ['stream-for-disc-1'];

		swBridge.dispatchEvent(
			new CustomEvent(MSG.CANCELLED, { detail: 'stream-for-disc-1' }),
		);

		await vi.waitFor(() => expect(discCtrl.terminate).toHaveBeenCalledOnce());
	});

	it('ignores an SW CANCELLED broadcast for a stream the current disc controller does not own', async () => {
		const entry = makeMultiDiscEntry({ discCount: 2 });
		queue.push(entry);

		conversion.startConversion(entry);
		await vi.waitFor(() => expect(mockControllers.length).toBe(1));

		const discCtrl = lastController();
		discCtrl.streamIds = ['stream-for-disc-1'];

		swBridge.dispatchEvent(
			new CustomEvent(MSG.CANCELLED, { detail: 'some-unrelated-stream' }),
		);

		// Give any (incorrect) handling a chance to run first.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(discCtrl.terminate).not.toHaveBeenCalled();
	});

	it('moves on to the second disc once the first disc controller reports CANCELLED', async () => {
		const entry = makeMultiDiscEntry({ discCount: 2 });
		queue.push(entry);

		conversion.startConversion(entry);
		await vi.waitFor(() => expect(mockControllers.length).toBe(1));

		const firstDiscCtrl = lastController();
		firstDiscCtrl.streamIds = ['stream-for-disc-1'];

		swBridge.dispatchEvent(
			new CustomEvent(MSG.CANCELLED, { detail: 'stream-for-disc-1' }),
		);
		await vi.waitFor(() =>
			expect(firstDiscCtrl.terminate).toHaveBeenCalledOnce(),
		);

		// The mock's terminate() is a stub - dispatch CANCELLED manually,
		// as the real WorkerController would via #teardownWorker().
		firstDiscCtrl.dispatchEvent(new CustomEvent(EVENTS.CANCELLED));

		await vi.waitFor(() => expect(entry.status).toBe('cancelled'));
		expect(mockControllers.length).toBe(1);
	});
});

describe('createConversionController - multi-download permission priming', () => {
	/** @type {ReturnType<typeof createConversionController>} */
	let conversion;
	/** @type {ReturnType<typeof createMockSwBridge>} */
	let swBridge;

	beforeEach(() => {
		mockControllers.length = 0;
		queue.length = 0;
		mockSettings.reset();
		swBridge = createMockSwBridge();
		conversion = createConversionController({
			getSwBridge: () => /** @type {any} */ (swBridge),
			setStatus: (entry, status) => {
				entry.status = status;
			},
			updateProgressDisplay: () => {},
		});

		vi.stubGlobal(
			'Worker',
			class {
				postMessage() {}
				terminate() {}
			},
		);
	});

	afterEach(() => {
		queue.length = 0;
		vi.unstubAllGlobals();
	});

	// Regression test: priming used to fire automatically on every
	// startConversion(), silently downloading two junk files before
	// the real output. Must stay opt-in via the settings panel only.
	it('never primes multi-download permission on its own', async () => {
		const entry = makeSingleEntry();
		queue.push(entry);

		conversion.startConversion(entry);
		await vi.waitFor(() => expect(mockControllers.length).toBe(1));

		expect(swBridge.primeMultiDownloadPermission).not.toHaveBeenCalled();
	});

	it('still does not prime across a batch started together', async () => {
		const entries = [makeSingleEntry(), makeSingleEntry(), makeSingleEntry()];
		for (const e of entries) queue.push(e);

		entries.forEach((e) => conversion.startConversion(e));
		await vi.waitFor(() => expect(mockControllers.length).toBe(3));

		expect(swBridge.primeMultiDownloadPermission).not.toHaveBeenCalled();
	});
});
