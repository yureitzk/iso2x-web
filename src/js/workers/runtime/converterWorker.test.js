import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG } from '../../core/protocol.js';

/**
 * @import { Mock } from 'vitest'
 */

/**
 * Faithful stand-in for wasm-bindgen's generated OpenedSource binding.
 *
 * `openConversionSession()` is declared `pub fn open_conversion_session(self, ...)`
 * on the Rust side - it takes `self` *by value*. wasm-bindgen's glue for a
 * by-value receiver always zeroes the JS wrapper's pointer and hands
 * ownership to Rust *before* the call happens, regardless of whether Rust
 * ends up returning `Ok` or `Err` - see OpenedSource.openConversionSession()
 * in iso2x's generated dist/wasm/iso2x.js:
 *
 *   openConversionSession(options) {
 *       const ptr = this.__destroy_into_raw();   // <- unconditional
 *       wasm.openedsource_openConversionSession(retptr, ptr, ...);
 *       if (r2) throw takeObject(r1);             // <- error surfaces after consuming
 *       ...
 *   }
 *
 * So a second `free()` call on the same handle after a failed
 * `openConversionSession()` is a real double-free: the wasm side receives
 * a null pointer and raises exactly the opaque
 * "Error: null pointer passed to rust" seen in the bug report, masking
 * whatever real error Rust returned (e.g. an oversized-image validation
 * failure).
 * @param {{ openConversionSessionError: Error | null }} opts
 */
function makeFakeOpenedSource({ openConversionSessionError }) {
	let consumed = false;
	const free = vi.fn(() => {
		if (consumed) {
			// Mirrors wasm.__wbg_openedsource_free(0, 0)'s real behavior.
			throw new Error('null pointer passed to rust');
		}
		consumed = true;
	});
	const openConversionSession = vi.fn(() => {
		// __destroy_into_raw() happens before the Rust call, unconditionally.
		consumed = true;
		if (openConversionSessionError) throw openConversionSessionError;
		return {};
	});
	return {
		free,
		openConversionSession,
		generateAttachXbe: vi.fn(() => new Uint8Array()),
	};
}

const { openSource } = await vi.hoisted(async () => {
	const { createIso2xMock } =
		await import('../../../../test/utils/iso2xMock.js');
	return { openSource: createIso2xMock().openSource };
});
vi.mock('iso2x', async () => {
	const { createIso2xMock } =
		await import('../../../../test/utils/iso2xMock.js');
	return {
		...createIso2xMock(),
		detectFormat: vi.fn(() => 'god'),
		openSource,
	};
});
vi.mock('iso2x/detect-advanced', async () => {
	const { createIso2xDetectAdvancedMock } =
		await import('../../../../test/utils/iso2xMock.js');
	return createIso2xDetectAdvancedMock();
});
vi.mock('client-zip', () => ({
	downloadZip: vi.fn(),
	predictLength: vi.fn(() => 0n),
}));

/**
 * Finds the single MSG.ERROR call posted to `postMessage` and returns its
 * payload, asserting it exists first so callers get a real `string`
 * instead of `string | undefined`.
 * @param {Mock} postMessage
 * @returns {string}
 */
function errorPayload(postMessage) {
	const call = postMessage.mock.calls.find(([msg]) => msg.type === MSG.ERROR);
	if (!call) throw new Error('No MSG.ERROR was posted');
	return call[0].payload;
}

describe('converterWorker: OpenedSource lifecycle on a failed openConversionSession()', () => {
	/** @type {Mock} */
	let postMessage;
	/** @type {EventListener} */
	let messageListener;

	beforeEach(async () => {
		vi.resetModules();
		postMessage = vi.fn();
		vi.spyOn(self, 'postMessage').mockImplementation(postMessage);

		// converterWorker.js registers its own 'message' listener as an
		// import side effect and never removes it - capture the handler so
		// it can be torn down after each test. Without this, re-importing
		// the module fresh in the next test would stack a second listener
		// on the same shared `self`, and one dispatched message would
		// drive two independent convertSource() runs at once.
		const addEventListenerSpy = vi.spyOn(self, 'addEventListener');
		await import('./converterWorker.js');
		const call = addEventListenerSpy.mock.calls.find(
			([type]) => type === 'message',
		);
		if (!call) throw new Error('No message listener registered on self');
		messageListener = /** @type {EventListener} */ (call[1]);
		addEventListenerSpy.mockRestore();

		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith({ type: MSG.READY }),
		);
		postMessage.mockClear();
	});

	afterEach(() => {
		self.removeEventListener('message', messageListener);
		vi.restoreAllMocks();
	});

	it('surfaces the real Rust error instead of a masking double-free crash', async () => {
		const realError = new Error(
			'ciso: image too large to represent in a CSO index table (aligned position overflowed u32)',
		);
		const fakeOpened = makeFakeOpenedSource({
			openConversionSessionError: realError,
		});
		openSource.mockReturnValue(fakeOpened);

		self.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: MSG.CONVERT,
					source: {
						kind: 'files',
						files: [{ name: 'game.xex', size: 6123102562 }],
					},
					gameTitle: 'SONIC UNLEASHED',
					format: 'god',
					options: { mode: 'full', sign: false },
					generateAttachXbe: false,
				},
			}),
		);

		await vi.waitFor(() => {
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: MSG.ERROR }),
			);
		});

		const payload = errorPayload(postMessage);
		expect(payload).toContain(
			'image too large to represent in a CSO index table',
		);
		expect(payload).not.toContain('null pointer passed to rust');

		// openConversionSession() already consumed/freed the handle on the
		// wasm side (whether it succeeded or threw) - free() must not be
		// called again afterwards.
		expect(fakeOpened.free).not.toHaveBeenCalled();
	});

	it('still frees the handle if generateAttachXbe() fails before the handle is consumed', async () => {
		const attachError = new Error(
			'attach XBE can only be generated for OGX sources',
		);
		const fakeOpened = makeFakeOpenedSource({ openConversionSessionError: null });
		fakeOpened.generateAttachXbe.mockImplementation(() => {
			throw attachError;
		});
		openSource.mockReturnValue(fakeOpened);

		self.dispatchEvent(
			new MessageEvent('message', {
				data: {
					type: MSG.CONVERT,
					source: { kind: 'files', files: [{ name: 'game.xex', size: 1024 }] },
					gameTitle: 'SONIC UNLEASHED',
					format: 'god',
					options: { mode: 'full', sign: false },
					generateAttachXbe: true,
				},
			}),
		);

		await vi.waitFor(() => {
			expect(postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: MSG.ERROR }),
			);
		});

		const payload = errorPayload(postMessage);
		expect(payload).toContain('attach XBE can only be generated for OGX sources');
		expect(payload).not.toContain('null pointer passed to rust');

		// generateAttachXbe() never consumes the handle - openConversionSession()
		// was never reached, so exactly one free() is correct here.
		expect(fakeOpened.free).toHaveBeenCalledTimes(1);
		expect(fakeOpened.openConversionSession).not.toHaveBeenCalled();
	});
});
