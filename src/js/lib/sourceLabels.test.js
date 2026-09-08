import { describe, it, expect } from 'vitest';

/**
 * @import { SourceFile } from '../../types/global'
 */

import {
	getFilenameWithoutExtension,
	sourceZipFile,
	zipArchiveDisplayName,
	entryParentFolder,
	assignZipLabels,
	dirRowFolderName,
	discRowName,
	baseNameForFiles,
	displayFileName,
	resolveGameTitle,
	outputFilenameFor,
	sourceLogLabel,
} from './sourceLabels.js';

/** @param {string} name */
function file(name) {
	return new File([new Uint8Array(4)], name);
}

/**
 * @param {string} name
 * @param {File} zipFile
 * @param {string} [entryPath] - defaults to `name` at the zip's root
 * @returns {import('../../types/global').ZipEntryFileRef}
 */
function zipEntry(name, zipFile, entryPath) {
	return {
		kind: 'zipEntry',
		name,
		size: 4,
		zipFile,
		dataOffset: 0,
		entryPath: entryPath ?? name,
	};
}

/**
 * @param {SourceFile[]} files
 * @param {Partial<import('../../types/global').SingleDroppedSource & { kind: 'files' }>} [overrides]
 * @returns {import('../../types/global').SingleDroppedSource & { kind: 'files' }}
 */
function filesSource(files, overrides) {
	return { kind: 'files', files, ...overrides };
}

describe('getFilenameWithoutExtension', () => {
	it('strips a normal extension', () => {
		expect(getFilenameWithoutExtension('Game.iso')).toBe('Game');
	});

	it('strips the compound .xiso.iso extension as one unit', () => {
		expect(getFilenameWithoutExtension('Game.xiso.iso')).toBe('Game');
	});

	it('is case-insensitive for the .xiso.iso special case', () => {
		expect(getFilenameWithoutExtension('Game.XISO.ISO')).toBe('Game');
	});

	it('returns the name unchanged when there is no extension', () => {
		expect(getFilenameWithoutExtension('Game')).toBe('Game');
	});
});

describe('sourceZipFile', () => {
	it('returns undefined for an empty files array', () => {
		expect(sourceZipFile([])).toBeUndefined();
	});

	it('returns undefined when the first file is a real File, not a zip entry', () => {
		expect(sourceZipFile([file('Game.iso')])).toBeUndefined();
	});

	it('returns the shared zip File when every entry comes from the same archive', () => {
		const zip = file('MyGame.zip');
		expect(
			sourceZipFile([zipEntry('Data0000', zip), zipEntry('Data0001', zip)]),
		).toBe(zip);
	});

	it('returns undefined when entries span more than one archive', () => {
		expect(
			sourceZipFile([
				zipEntry('Data0000', file('First.zip')),
				zipEntry('Data0001', file('Second.zip')),
			]),
		).toBeUndefined();
	});
});

describe('zipArchiveDisplayName', () => {
	it("returns the zip's own name, extension stripped, when every file is from it", () => {
		const zip = file('MyGame.zip');
		expect(
			zipArchiveDisplayName([
				zipEntry('Data0000', zip),
				zipEntry('Data0001', zip),
			]),
		).toBe('MyGame');
	});

	it('returns undefined for a non-zip-backed source', () => {
		expect(zipArchiveDisplayName([file('Data0000')])).toBeUndefined();
	});
});

describe('entryParentFolder', () => {
	it('returns the immediate parent folder for a nested entry path', () => {
		expect(entryParentFolder('HaloCE/HaloCE.iso')).toBe('HaloCE');
	});

	it('returns the full parent path for a deeper entry', () => {
		expect(entryParentFolder('Games/HaloCE/HaloCE.iso')).toBe('Games/HaloCE');
	});

	it('returns undefined for a root-level entry with no slash', () => {
		expect(entryParentFolder('HaloCE.iso')).toBeUndefined();
	});

	it('returns undefined for an undefined entryPath', () => {
		expect(entryParentFolder(undefined)).toBeUndefined();
	});
});

describe('assignZipLabels', () => {
	it("labels a zip's single valid game with the zip's own filename", () => {
		const zip = file('MyGame.zip');
		const source = filesSource([zipEntry('game.iso', zip, 'game.iso')]);
		const [result] = assignZipLabels([source]);
		expect(result.kind).toBe('files');
		expect(/** @type {any} */ (result).zipLabel).toBe('MyGame');
	});

	it('labels each of several games in the same zip with its own parent folder', () => {
		const zip = file('Bundle.zip');
		const halo = filesSource([zipEntry('HaloCE.iso', zip, 'HaloCE/HaloCE.iso')]);
		const cod = filesSource([zipEntry('CoD2.iso', zip, 'CoD2/CoD2.iso')]);
		const [labeledHalo, labeledCod] = assignZipLabels([halo, cod]);
		expect(/** @type {any} */ (labeledHalo).zipLabel).toBe('HaloCE');
		expect(/** @type {any} */ (labeledCod).zipLabel).toBe('CoD2');
	});

	it('leaves a game unlabeled when its zip bundles several games flat at the root (no parent folder)', () => {
		const zip = file('Bundle.zip');
		const first = filesSource([zipEntry('Game1.iso', zip, 'Game1.iso')]);
		const second = filesSource([zipEntry('Game2.iso', zip, 'Game2.iso')]);
		const [labeledFirst, labeledSecond] = assignZipLabels([first, second]);
		expect(/** @type {any} */ (labeledFirst).zipLabel).toBeUndefined();
		expect(/** @type {any} */ (labeledSecond).zipLabel).toBeUndefined();
	});

	it('leaves non-zip-backed sources untouched', () => {
		const source = filesSource([file('Game.iso')]);
		const [result] = assignZipLabels([source]);
		expect(result).toBe(source);
	});

	it("leaves 'dir'-kind sources untouched even when zip-backed - they already carry dirName", () => {
		const zip = file('MyGame.zip');
		/** @type {import('../../types/global').DroppedSource} */
		const dirSource = {
			kind: 'dir',
			dirName: '',
			entries: ['Data0000'],
			files: [zipEntry('Data0000', zip)],
		};
		const [result] = assignZipLabels([dirSource]);
		expect(result).toBe(dirSource);
	});

	it('never labels a source that failed to resolve (invalidReason set)', () => {
		const zip = file('MyGame.zip');
		const source = filesSource([zipEntry('game.iso', zip, 'game.iso')], {
			invalidReason: 'not a valid image',
		});
		const [result] = assignZipLabels([source]);
		expect(result).toBe(source);
	});

	it('is pure: returns a new array and only replaces the affected sources', () => {
		const zip = file('MyGame.zip');
		const zipSource = filesSource([zipEntry('game.iso', zip, 'game.iso')]);
		const plainSource = filesSource([file('Other.iso')]);
		const input = [zipSource, plainSource];
		const result = assignZipLabels(input);
		expect(result).not.toBe(input);
		expect(result[1]).toBe(plainSource);
		expect(input[0]).toBe(zipSource); // original untouched
		expect(/** @type {any} */ (input[0]).zipLabel).toBeUndefined();
	});

	it('returns the same array reference when nothing needs labeling', () => {
		const source = filesSource([file('Game.iso')]);
		const input = [source];
		expect(assignZipLabels(input)).toBe(input);
	});
});

describe('dirRowFolderName', () => {
	it('returns the real dirName when present', () => {
		expect(
			dirRowFolderName({
				kind: 'dir',
				dirName: 'MyGame',
				files: [],
				entries: [],
			}),
		).toBe('MyGame');
	});

	it("falls back to the zip archive's own file name (extension included) when dirName is empty and every file came from the same zip", () => {
		// A single-game zip whose GOD structure sits directly at its root
		// (no wrapping folder) has no real dirName - the zip's own file
		// name is the only thing left to call this source, and it's a
		// real file, not a folder, so it keeps its extension.
		const zip = file('Star Wars Battlefront 2 (GoD).zip');
		expect(
			dirRowFolderName({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000', 'Data0001'],
				files: [zipEntry('Data0000', zip), zipEntry('Data0001', zip)],
			}),
		).toBe('Star Wars Battlefront 2 (GoD).zip');
	});

	it('returns undefined (caller falls back to "N files") for a dirless, non-zip-backed source', () => {
		expect(
			dirRowFolderName({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000'],
				files: [file('Data0000')],
			}),
		).toBeUndefined();
	});
});

describe('discRowName', () => {
	it('shows just the position when a dir disc has neither a dirName nor a zip origin', () => {
		expect(
			discRowName(
				{
					kind: 'dir',
					dirName: '',
					entries: ['Data0000'],
					files: [file('Data0000')],
					locked: true,
				},
				0,
			),
		).toBe('1/');
	});

	it('falls back to the zip archive file name (extension included) for a zip-backed dir disc with no dirName', () => {
		const zip = file('Disc2.zip');
		expect(
			discRowName(
				{
					kind: 'dir',
					dirName: '',
					entries: ['Data0000'],
					files: [zipEntry('Data0000', zip)],
					locked: true,
				},
				1,
			),
		).toBe('2/ Disc2.zip');
	});

	it('prefers a real dirName over the zip archive name', () => {
		const zip = file('Disc2.zip');
		expect(
			discRowName(
				{
					kind: 'dir',
					dirName: 'Whatever.data',
					entries: ['Data0000'],
					files: [zipEntry('Data0000', zip)],
					locked: true,
				},
				0,
			),
		).toBe('1/ Whatever.data');
	});

	it('joins filenames for a files-kind disc', () => {
		expect(
			discRowName({ kind: 'files', files: [file('Disc1.iso')], locked: true }, 0),
		).toBe('Disc1.iso');
	});
});

describe('baseNameForFiles', () => {
	it('falls back to the zip archive name for a dir source with no dirName, ahead of a bare chunk filename', () => {
		const zip = file('MyGame.zip');
		expect(
			baseNameForFiles({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000', 'Data0001'],
				files: [zipEntry('Data0000', zip), zipEntry('Data0001', zip)],
			}),
		).toBe('MyGame');
	});

	it('falls back to the first chunk filename when a dirless dir source is not zip-backed', () => {
		expect(
			baseNameForFiles({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000'],
				files: [file('Data0000')],
			}),
		).toBe('Data0000');
	});

	it('prefers a real dirName over the zip archive name', () => {
		const zip = file('MyGame.zip');
		expect(
			baseNameForFiles({
				kind: 'dir',
				dirName: 'Whatever.data',
				entries: ['Data0000'],
				files: [zipEntry('Data0000', zip)],
			}),
		).toBe('Whatever.data');
	});

	it('prefers an assigned zipLabel over the raw internal filename for a files-kind source', () => {
		expect(
			baseNameForFiles(filesSource([file('game.iso')], { zipLabel: 'MyGame' })),
		).toBe('MyGame');
	});

	it('falls back to the (extension-stripped) internal filename when there is no zipLabel', () => {
		expect(baseNameForFiles(filesSource([file('game.iso')]))).toBe('game');
	});
});

describe('displayFileName', () => {
	it("joins a single-file source's own filename", () => {
		expect(displayFileName(filesSource([file('Game.iso')]))).toBe('Game.iso');
	});

	it('joins a split source\'s multiple filenames with " + "', () => {
		expect(
			displayFileName(filesSource([file('Game.1.iso'), file('Game.2.iso')])),
		).toBe('Game.1.iso + Game.2.iso');
	});

	it('prefers an assigned zipLabel over the raw filename join', () => {
		expect(
			displayFileName(filesSource([file('game.iso')], { zipLabel: 'MyGame' })),
		).toBe('MyGame');
	});

	it('uses the folder name with a trailing slash for a dir source', () => {
		expect(
			displayFileName({
				kind: 'dir',
				dirName: 'MyGame',
				files: [],
				entries: [],
			}),
		).toBe('MyGame/');
	});

	it('falls back to the zip archive file name (extension included, no trailing slash - it is a file, not a folder) for a dir source with no dirName, when every file came from the same zip', () => {
		const zip = file('MyGame.zip');
		expect(
			displayFileName({
				kind: 'dir',
				dirName: '',
				entries: ['Whatever.data/Data0000', 'Whatever.data/Data0001'],
				files: [zipEntry('Data0000', zip), zipEntry('Data0001', zip)],
			}),
		).toBe('MyGame.zip');
	});

	it('still falls back to "N files" for a dirless dir source not backed by a zip', () => {
		expect(
			displayFileName({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000', 'Data0001'],
				files: [file('Data0000'), file('Data0001')],
			}),
		).toBe('2 files');
	});

	it('still falls back to "N files" when a dirless dir source spans more than one zip', () => {
		expect(
			displayFileName({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000', 'Data0001'],
				files: [
					zipEntry('Data0000', file('First.zip')),
					zipEntry('Data0001', file('Second.zip')),
				],
			}),
		).toBe('2 files');
	});

	it('prefers a real dirName over the zip archive name', () => {
		const zip = file('MyGame.zip');
		expect(
			displayFileName({
				kind: 'dir',
				dirName: 'Whatever.data',
				entries: ['Data0000'],
				files: [zipEntry('Data0000', zip)],
			}),
		).toBe('Whatever.data/');
	});

	it('falls back to the zip archive file name (extension included) for a dirName-carrying unresolved duplicate-disc-claim source', () => {
		const zip = file('MyGame.zip');
		expect(
			displayFileName({
				kind: 'unresolved',
				reason: 'duplicate',
				unresolvedKind: 'duplicateDiscClaim',
				dirName: '',
				files: [zipEntry('Data0000', zip), zipEntry('Data0001', zip)],
			}),
		).toBe('MyGame.zip');
	});

	it('never applies the zip-name fallback to a flat pile of unresolved parts (no dirName property at all)', () => {
		const zip = file('MyGame.zip');
		expect(
			displayFileName({
				kind: 'unresolved',
				reason: 'ambiguous headers',
				unresolvedKind: 'ambiguousHeaders',
				files: [zipEntry('Game.1.iso', zip), zipEntry('Game.2.iso', zip)],
			}),
		).toBe('2 unresolved parts');
	});

	it('never falls back to titleId for a multi-disc source - it must show real input filenames', () => {
		const result = displayFileName({
			kind: 'multi-disc',
			titleId: '4B4E0809',
			discCount: 2,
			discs: [
				{ kind: 'files', files: [file('Disc1.iso')], locked: true },
				{ kind: 'files', files: [file('Disc2.iso')], locked: true },
			],
		});
		expect(result).not.toContain('4B4E0809');
		expect(result).toBe('Disc1.iso, Disc2.iso');
	});

	it('joins per-disc filenames for a multi-disc source with split discs', () => {
		const result = displayFileName({
			kind: 'multi-disc',
			titleId: '4B4E0809',
			discCount: 2,
			discs: [
				{
					kind: 'files',
					files: [file('D1.1.iso'), file('D1.2.iso')],
					locked: true,
				},
				{
					kind: 'dir',
					dirName: 'Disc2',
					files: [],
					entries: [],
					locked: true,
				},
			],
		});
		expect(result).toBe('D1.1.iso + D1.2.iso, Disc2/');
	});
});

describe('sourceLogLabel', () => {
	it("joins a single-file source's own filename", () => {
		expect(sourceLogLabel(filesSource([file('Game.iso')]))).toBe('Game.iso');
	});

	it('joins a split source\'s multiple filenames with " + "', () => {
		expect(
			sourceLogLabel(filesSource([file('Game.1.iso'), file('Game.2.iso')])),
		).toBe('Game.1.iso + Game.2.iso');
	});

	it('prefers an assigned zipLabel over the raw filename join', () => {
		expect(
			sourceLogLabel(filesSource([file('game.iso')], { zipLabel: 'MyGame' })),
		).toBe('MyGame');
	});

	it('uses the folder name with a trailing slash for a dir source', () => {
		expect(
			sourceLogLabel({
				kind: 'dir',
				dirName: 'MyGame',
				files: [],
				entries: [],
			}),
		).toBe('MyGame/');
	});

	it('falls back to the zip archive file name (extension included) for a dir source with no dirName, when every file came from the same zip', () => {
		// The converterWorker.js counterpart to the sourcePartsRender.js
		// regression: a zip-derived GOD/extracted source whose dirName
		// never gets populated (see zipArchiveFileName()'s doc comment
		// above) must still log its real file name, not "N files" and
		// not the extension-stripped/slash-appended folder treatment.
		const zip = file('Star Wars Battlefront 2 (GoD).zip');
		expect(
			sourceLogLabel({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000', 'Data0001'],
				files: [zipEntry('Data0000', zip), zipEntry('Data0001', zip)],
			}),
		).toBe('Star Wars Battlefront 2 (GoD).zip');
	});

	it('falls back to "N files" for a dirless dir source not backed by a zip', () => {
		expect(
			sourceLogLabel({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000', 'Data0001'],
				files: [file('Data0000'), file('Data0001')],
			}),
		).toBe('2 files');
	});

	it('falls back to "N files" when a dirless dir source spans more than one zip', () => {
		expect(
			sourceLogLabel({
				kind: 'dir',
				dirName: '',
				entries: ['Data0000', 'Data0001'],
				files: [
					zipEntry('Data0000', file('First.zip')),
					zipEntry('Data0001', file('Second.zip')),
				],
			}),
		).toBe('2 files');
	});

	it('prefers a real dirName over the zip archive name', () => {
		const zip = file('MyGame.zip');
		expect(
			sourceLogLabel({
				kind: 'dir',
				dirName: 'Whatever.data',
				entries: ['Data0000'],
				files: [zipEntry('Data0000', zip)],
			}),
		).toBe('Whatever.data/');
	});
});

describe('resolveGameTitle', () => {
	it('returns the value unchanged when it has no surrounding whitespace', () => {
		expect(resolveGameTitle('My Game', 'fallback')).toBe('My Game');
	});

	it('trims leading and trailing whitespace', () => {
		expect(resolveGameTitle('  My Game  ', 'fallback')).toBe('My Game');
	});

	it('trims tabs and newlines, not just spaces', () => {
		expect(resolveGameTitle('\t\nMy Game\n\t', 'fallback')).toBe('My Game');
	});

	it('preserves internal whitespace between words', () => {
		expect(resolveGameTitle('  My   Game  ', 'fallback')).toBe('My   Game');
	});

	it('falls back when the value is an empty string', () => {
		expect(resolveGameTitle('', 'fallback')).toBe('fallback');
	});

	it('falls back when the value is whitespace-only', () => {
		expect(resolveGameTitle('   ', 'fallback')).toBe('fallback');
		expect(resolveGameTitle('\t\t', 'fallback')).toBe('fallback');
		expect(resolveGameTitle('\n', 'fallback')).toBe('fallback');
	});

	it('does NOT fall back for a whitespace-only value the way `value || fallback` would incorrectly keep it', () => {
		// Regression guard: `'   ' || fallback` evaluates to '   ' because
		// a non-empty string is truthy, silently producing a blank/
		// space-only title. resolveGameTitle must catch this case.
		const result = resolveGameTitle('   ', 'Detected Title');
		expect(result).toBe('Detected Title');
		expect(result).not.toBe('   ');
	});

	it('returns the fallback verbatim, without trimming it', () => {
		// The fallback is trusted input, not user-typed - it should pass
		// through untouched even if it happens to carry whitespace of
		// its own.
		expect(resolveGameTitle('', '  fallback  ')).toBe('  fallback  ');
	});
});

describe('resolveGameTitle x outputFilenameFor - trailing whitespace never reaches the output filename', () => {
	it('a trailing-space title does not leak a space before the extension', () => {
		const gameTitle = resolveGameTitle('My Game   ', 'fallback');
		expect(
			outputFilenameFor(gameTitle, 'god', { mode: 'full', sign: false }),
		).toBe('My Game (GoD).zip');
	});

	it('a leading-space title does not leak a space at the start of a multi-file-direct output', () => {
		const gameTitle = resolveGameTitle('   My Game', 'fallback');
		expect(outputFilenameFor(gameTitle, 'cci', { mode: 'full' })).toBe('My Game');
	});

	it('a whitespace-only title falls back cleanly to a sane filename instead of a blank one', () => {
		const gameTitle = resolveGameTitle('   ', 'Detected Title');
		expect(
			outputFilenameFor(gameTitle, 'xiso', { mode: 'full', split: false }),
		).toBe('Detected Title.xiso.iso');
	});
});
