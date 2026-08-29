import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	hexToBytes,
	stripWhitespace,
	parseDeviceId,
	initClearableInput,
	relativeDirEntries,
	decodeAndroidSafPath,
	supportsFolderInput,
} from './helpers.js';
import { TEXT } from '../constants/messages.js';

describe('hexToBytes', () => {
	it.each([
		['00ff10', new Uint8Array([0x00, 0xff, 0x10])],
		['', new Uint8Array(0)],
	])('converts %s to the matching bytes', (input, expected) => {
		expect(hexToBytes(input)).toEqual(expected);
	});

	it('is case-insensitive', () => {
		expect(hexToBytes('AaBbCc')).toEqual(hexToBytes('aabbcc'));
	});

	it.each([
		['abc', /invalid hex string/],
		['zz', /invalid hex string/],
	])('throws for %s', (input, message) => {
		expect(() => hexToBytes(input)).toThrow(message);
	});
});

describe('stripWhitespace', () => {
	it.each([
		['a b c', 'abc'],
		['a\tb\nc', 'abc'],
		['aa  bb   cc', 'aabbcc'],
		['abcdef', 'abcdef'],
		['   \t\n  ', ''],
	])('normalizes %j to %j', (input, expected) => {
		expect(stripWhitespace(input)).toBe(expected);
	});
});

describe('parseDeviceId', () => {
	const VALID_40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

	describe('not-set (empty) case', () => {
		it.each([undefined, '', '   \t  '])('returns undefined for %j', (input) => {
			expect(parseDeviceId(input)).toBeUndefined();
		});
	});

	describe('valid input', () => {
		it('parses a valid 40-char lowercase hex string into 20 bytes', () => {
			const bytes = parseDeviceId(VALID_40);
			expect(bytes).toBeInstanceOf(Uint8Array);
			expect(bytes).toHaveLength(20);
			expect(bytes).toEqual(hexToBytes(VALID_40));
		});

		it('accepts uppercase hex characters', () => {
			expect(parseDeviceId(VALID_40.toUpperCase())).toEqual(
				parseDeviceId(VALID_40),
			);
		});

		it('accepts mixed-case hex characters', () => {
			const mixed = VALID_40.slice(0, 20).toUpperCase() + VALID_40.slice(20);
			expect(parseDeviceId(mixed)).toEqual(parseDeviceId(VALID_40));
		});

		it('strips leading/trailing whitespace before validating', () => {
			expect(parseDeviceId(`  ${VALID_40}  `)).toEqual(parseDeviceId(VALID_40));
		});

		it('strips internal whitespace before counting length', () => {
			// e.g. a byte-grouped paste with a stray space (raw length 41)
			const spaced = `${VALID_40.slice(0, 20)} ${VALID_40.slice(20)}`;
			expect(spaced).toHaveLength(41);
			expect(parseDeviceId(spaced)).toEqual(parseDeviceId(VALID_40));
		});
	});

	describe('invalid length', () => {
		it('throws the length-specific message when too short', () => {
			const short = VALID_40.slice(0, 39);
			expect(() => parseDeviceId(short)).toThrow(
				TEXT.DEVICE_ID_INVALID_LENGTH(39),
			);
		});

		it('throws the length-specific message when too long', () => {
			const long = `${VALID_40}a`;
			expect(() => parseDeviceId(long)).toThrow(TEXT.DEVICE_ID_INVALID_LENGTH(41));
		});

		it('reports the post-strip length, not the raw input length', () => {
			const padded = `  ${VALID_40.slice(0, 39)}    `;
			expect(() => parseDeviceId(padded)).toThrow(
				TEXT.DEVICE_ID_INVALID_LENGTH(39),
			);
		});
	});

	describe('invalid characters', () => {
		// 40 chars but not hex - must fail on chars, not length.
		const mashed = 'ssdasasdaasdsdaasasdasdasdasdasdsaasdasd';

		it('throws the character-specific message for a right-length, non-hex string', () => {
			expect(mashed).toHaveLength(40);
			expect(() => parseDeviceId(mashed)).toThrow(TEXT.DEVICE_ID_INVALID_CHARS);
		});

		it('does not report a length error for a right-length, non-hex string', () => {
			expect(() => parseDeviceId(mashed)).not.toThrow(
				TEXT.DEVICE_ID_INVALID_LENGTH(40),
			);
		});

		it('rejects a single non-hex character among otherwise valid hex', () => {
			const oneBad = `g${VALID_40.slice(1)}`;
			expect(() => parseDeviceId(oneBad)).toThrow(TEXT.DEVICE_ID_INVALID_CHARS);
		});
	});
});

describe('initClearableInput', () => {
	// EventTarget stand-ins avoid pulling in jsdom for this suite.
	class FakeInput extends EventTarget {
		value = '';
		classList = { add: vi.fn(), remove: vi.fn() };
	}
	class FakeButton extends EventTarget {
		hidden = true;
	}
	/** @param {FakeInput} fake @returns {HTMLInputElement} */
	const asInput = (fake) => /** @type {any} */ (fake);
	/** @param {FakeButton} fake @returns {HTMLButtonElement} */
	const asButton = (fake) => /** @type {any} */ (fake);

	it('shows the clear button once the input has a value, hides it once empty', () => {
		const input = new FakeInput();
		const clearBtn = new FakeButton();
		initClearableInput(asInput(input), asButton(clearBtn));

		expect(clearBtn.hidden).toBe(true);

		input.value = 'abc';
		input.dispatchEvent(new Event('input'));

		expect(clearBtn.hidden).toBe(false);
	});

	it('clears the value and calls onClear when the clear button is clicked', () => {
		const input = new FakeInput();
		const clearBtn = new FakeButton();
		input.value = 'abc';
		const onClear = vi.fn();
		initClearableInput(asInput(input), asButton(clearBtn), onClear);

		clearBtn.dispatchEvent(new Event('click'));

		expect(input.value).toBe('');
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it("notifies other 'input' listeners on the field when cleared programmatically", () => {
		// Regression: `input.value = ''` alone doesn't fire a native 'input' event.
		const input = new FakeInput();
		const clearBtn = new FakeButton();
		input.value = 'abc';
		const otherListener = vi.fn();
		input.addEventListener('input', otherListener);
		initClearableInput(asInput(input), asButton(clearBtn));

		clearBtn.dispatchEvent(new Event('click'));

		expect(otherListener).toHaveBeenCalledTimes(1);
		expect(otherListener.mock.calls[0][0].target.value).toBe('');
	});
});

describe('relativeDirEntries', () => {
	/**
	 * @param {string} name
	 * @param {string} webkitRelativePath
	 * @returns {File} minimal stand-in - only `name`/`webkitRelativePath` are read
	 */
	const file = (name, webkitRelativePath) =>
		/** @type {any} */ ({ name, webkitRelativePath });

	it('returns empty everything for an empty file list', () => {
		expect(relativeDirEntries([])).toEqual({
			dirName: '',
			entries: [],
			files: [],
		});
	});

	it('strips the shared top-level folder from each entry', () => {
		const files = [
			file('default.xex', 'MyGame/default.xex'),
			file('data.bin', 'MyGame/data.bin'),
		];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('MyGame');
		expect(entries).toEqual(['default.xex', 'data.bin']);
	});

	it('preserves nested subfolder structure below the root', () => {
		const files = [file('file.bin', 'MyGame/assets/textures/file.bin')];
		expect(relativeDirEntries(files).entries).toEqual([
			'assets/textures/file.bin',
		]);
	});

	it('normalizes backslash separators (Windows paths) before stripping', () => {
		const files = [
			file('default.xex', 'MyGame\\default.xex'),
			file('data.bin', 'MyGame\\sub\\data.bin'),
		];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('MyGame');
		expect(entries).toEqual(['default.xex', 'sub/data.bin']);
	});

	it('falls back to file.name when webkitRelativePath is empty (loose files, not a folder)', () => {
		const files = [file('default.xex', ''), file('data.bin', '')];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('');
		expect(entries).toEqual(['default.xex', 'data.bin']);
	});

	it('does not merge sibling folders that share a name prefix (e.g. "MyGame" vs "MyGameExtra")', () => {
		const files = [
			file('a.bin', 'MyGame/a.bin'),
			file('b.bin', 'MyGameExtra/b.bin'),
		];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('');
		expect(entries).toEqual(['MyGame/a.bin', 'MyGameExtra/b.bin']);
	});

	it('is case-sensitive when matching the shared root', () => {
		const files = [file('a.bin', 'MyGame/a.bin'), file('b.bin', 'mygame/b.bin')];
		expect(relativeDirEntries(files).dirName).toBe('');
	});

	it('handles a single file inside a folder', () => {
		const files = [file('default.xex', 'MyGame/default.xex')];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('MyGame');
		expect(entries).toEqual(['default.xex']);
	});

	it('preserves file order and identity between input and output', () => {
		const files = [
			file('default.xex', 'MyGame/default.xex'),
			file('data.bin', 'MyGame/data.bin'),
		];
		const { files: outFiles } = relativeDirEntries(files);
		expect(outFiles).toEqual(files);
		expect(outFiles[0]).toBe(files[0]);
		expect(outFiles[1]).toBe(files[1]);
	});

	it('accepts an array-like FileList, not just a real array', () => {
		const fileList = /** @type {any} */ ({
			0: file('default.xex', 'MyGame/default.xex'),
			1: file('data.bin', 'MyGame/data.bin'),
			length: 2,
		});
		const { dirName, entries, files } = relativeDirEntries(fileList);
		expect(dirName).toBe('MyGame');
		expect(entries).toEqual(['default.xex', 'data.bin']);
		expect(files).toHaveLength(2);
	});

	it('does not mistake a single flat file for its own shared root', () => {
		const files = [file('default.xex', 'default.xex')];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('');
		expect(entries).toEqual(['default.xex']);
	});

	it('an empty leading path safely degrades to no shared root, without corrupting the rest', () => {
		const files = [
			file('', ''),
			file('data.bin', 'MyGame/data.bin'),
			file('more.bin', 'MyGame/more.bin'),
		];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('');
		expect(entries).toEqual(['', 'MyGame/data.bin', 'MyGame/more.bin']);
	});

	it('a directory-only entry ("MyGame/") does not produce a false shared root or an empty entry', () => {
		const files = [file('', 'MyGame/'), file('data.bin', 'MyGame/data.bin')];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('');
		expect(entries).toEqual(['MyGame', 'MyGame/data.bin']);
	});

	it('collapses doubled path separators into a clean relative path', () => {
		const files = [file('file.bin', 'MyGame//sub/file.bin')];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('MyGame');
		expect(entries).toEqual(['sub/file.bin']);
	});

	it('resolves ".." segments instead of passing them through unresolved', () => {
		const files = [
			file('a.bin', 'MyGame/a.bin'),
			file('b.bin', 'MyGame/sub/../b.bin'),
		];
		const { dirName, entries } = relativeDirEntries(files);
		expect(dirName).toBe('MyGame');
		expect(entries).toEqual(['a.bin', 'b.bin']);
	});

	describe('Android SAF path corruption (Chrome/Edge/Samsung Internet on Android)', () => {
		it('recovers a clean root/entries pair from the unencoded corrupted shape', () => {
			// Real shape from Chromium issue 377716464 (folder "json" / "track.png").
			const files = [
				file(
					'track.png',
					'primary:Download/json/document/primary:Download/json/track.png',
				),
			];
			const { dirName, entries } = relativeDirEntries(files);
			expect(dirName).toBe('json');
			expect(entries).toEqual(['track.png']);
		});

		it('recovers a clean root/entries pair from the percent-encoded "tree/" shape', () => {
			// Real shape from device logs (folder "Pvz" / "bionicle.dat").
			const files = [
				file(
					'bionicle.dat',
					'tree/primary%3ADownload%2FPvz/document/primary%3ADownload%2FPvz%2Fbionicle.dat',
				),
			];
			const { dirName, entries } = relativeDirEntries(files);
			expect(dirName).toBe('Pvz');
			expect(entries).toEqual(['bionicle.dat']);
		});

		it('recovers nested subfolder structure below the corrupted root', () => {
			const files = [
				file(
					'default.xex',
					'tree/primary%3ADownload%2FPvz/document/primary%3ADownload%2FPvz%2Fdefault.xex',
				),
				file(
					'Bionicle_01.wmv',
					'tree/primary%3ADownload%2FPvz/document/primary%3ADownload%2FPvz%2FMovies%2FBionicle_01.wmv',
				),
			];
			const { dirName, entries } = relativeDirEntries(files);
			expect(dirName).toBe('Pvz');
			expect(entries).toEqual(['default.xex', 'Movies/Bionicle_01.wmv']);
		});
	});

	describe('Firefox for Android (pre-142) and iOS/iPadOS - always-empty webkitRelativePath', () => {
		// Both report an empty webkitRelativePath for every file (see
		// https://bugzilla.mozilla.org/show_bug.cgi?id=1973726 and
		// https://bugs.webkit.org/show_bug.cgi?id=271705), so this
		// degrades to flat, loose-files handling instead of a folder.

		it('degrades to loose files (no dirName, entries are bare filenames) for a single-level folder', () => {
			const files = [file('default.xex', ''), file('data.bin', '')];
			const { dirName, entries } = relativeDirEntries(files);
			expect(dirName).toBe('');
			expect(entries).toEqual(['default.xex', 'data.bin']);
		});

		it('loses (rather than corrupts) nested subfolder structure - files land flat by basename', () => {
			// On desktop this would be dirName "Pvz" + nested entries.
			const files = [file('default.xex', ''), file('Bionicle_01.wmv', '')];
			const { dirName, entries } = relativeDirEntries(files);
			expect(dirName).toBe('');
			expect(entries).toEqual(['default.xex', 'Bionicle_01.wmv']);
		});
	});
});

describe('decodeAndroidSafPath', () => {
	it.each(['', undefined, null])(
		'passes through %j unchanged (not a corrupted shape)',
		(input) => {
			expect(decodeAndroidSafPath(/** @type {any} */ (input))).toBe(input);
		},
	);

	it('leaves a normal desktop-style relative path untouched', () => {
		expect(decodeAndroidSafPath('MyGame/default.xex')).toBe('MyGame/default.xex');
	});

	it('leaves a bare filename (no directory) untouched', () => {
		expect(decodeAndroidSafPath('default.xex')).toBe('default.xex');
	});

	it('decodes the unencoded "<vol>:<path>/document/<vol>:<path>" shape', () => {
		expect(
			decodeAndroidSafPath(
				'primary:Download/json/document/primary:Download/json/track.png',
			),
		).toBe('json/track.png');
	});

	it('decodes the percent-encoded shape with a leading "tree/" segment', () => {
		expect(
			decodeAndroidSafPath(
				'tree/primary%3ADownload%2FPvz/document/primary%3ADownload%2FPvz%2Fbionicle.dat',
			),
		).toBe('Pvz/bionicle.dat');
	});

	it('decodes the percent-encoded shape without a leading "tree/" segment', () => {
		expect(
			decodeAndroidSafPath(
				'primary%3ADownload%2Fjson/document/primary%3ADownload%2Fjson%2Ftrack.png',
			),
		).toBe('json/track.png');
	});

	it('preserves nested subfolders inside the recovered relative path', () => {
		expect(
			decodeAndroidSafPath(
				'tree/primary%3ADownload%2FPvz/document/primary%3ADownload%2FPvz%2FMovies%2FBionicle_01.wmv',
			),
		).toBe('Pvz/Movies/Bionicle_01.wmv');
	});

	it('handles a picked folder nested several levels deep on the SD card', () => {
		expect(
			decodeAndroidSafPath(
				'tree/1234-5678%3AGames%2FXbox%2FPvz/document/1234-5678%3AGames%2FXbox%2FPvz%2Fdefault.xex',
			),
		).toBe('Pvz/default.xex');
	});

	it('is a no-op the second time it is applied to its own output (idempotent)', () => {
		const once = decodeAndroidSafPath(
			'tree/primary%3ADownload%2FPvz/document/primary%3ADownload%2FPvz%2Fbionicle.dat',
		);
		expect(decodeAndroidSafPath(once)).toBe(once);
	});

	it('leaves a path with an unrelated "document" path segment untouched', () => {
		expect(decodeAndroidSafPath('MyGame/document/notes.txt')).toBe(
			'MyGame/document/notes.txt',
		);
	});

	it('falls back to the raw string on a malformed percent-escape', () => {
		const malformed = 'tree/primary%/document/primary%';
		expect(decodeAndroidSafPath(malformed)).toBe(malformed);
	});

	it('falls back to the raw string when the "/document/" marker is missing', () => {
		const noMarker = 'primary%3ADownload%2Fjson%2Ftrack.png';
		expect(decodeAndroidSafPath(noMarker)).toBe(noMarker);
	});

	it('falls back to the raw string when neither side carries a volume prefix', () => {
		const noVolume = 'Foo/document/Bar/baz.bin';
		expect(decodeAndroidSafPath(noVolume)).toBe(noVolume);
	});

	it('falls back to the raw string when the tree/doc paths never converge', () => {
		const divergent = 'primary:Foo/document/primary:Bar/baz.bin';
		expect(decodeAndroidSafPath(divergent)).toBe(divergent);
	});

	it('falls back to the raw string when the recovered relative path would be empty', () => {
		// docPath equals treePath exactly - no file segment left after stripping.
		const noRelative = 'primary:Download/json/document/primary:Download/json';
		expect(decodeAndroidSafPath(noRelative)).toBe(noRelative);
	});
});

describe('supportsFolderInput', () => {
	// happy-dom doesn't implement `webkitdirectory` on input elements,
	// so these tests patch it onto the prototype to simulate real browsers.
	/** @type {PropertyDescriptor | undefined} */
	let originalWebkitdirectory;

	beforeEach(() => {
		originalWebkitdirectory = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			'webkitdirectory',
		);
	});

	afterEach(() => {
		if (originalWebkitdirectory) {
			Object.defineProperty(
				HTMLInputElement.prototype,
				'webkitdirectory',
				originalWebkitdirectory,
			);
		} else {
			Reflect.deleteProperty(HTMLInputElement.prototype, 'webkitdirectory');
		}
	});

	it('returns true when the property is present on input elements', () => {
		Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', {
			configurable: true,
			writable: true,
			value: false,
		});
		expect(supportsFolderInput()).toBe(true);
	});

	it('returns false when the property is absent', () => {
		Reflect.deleteProperty(HTMLInputElement.prototype, 'webkitdirectory');
		expect(supportsFolderInput()).toBe(false);
	});
});
