import { describe, it, expect } from 'vitest';

import {
	resolveGameTitle,
	outputFilenameFor,
	displayFileName,
} from './queueNaming.js';

/** @param {string} name */
function file(name) {
	return new File([new Uint8Array(4)], name);
}

describe('displayFileName', () => {
	it("joins a single-file source's own filename", () => {
		expect(displayFileName({ kind: 'files', files: [file('Game.iso')] })).toBe(
			'Game.iso',
		);
	});

	it('joins a split source\'s multiple filenames with " + "', () => {
		expect(
			displayFileName({
				kind: 'files',
				files: [file('Game.1.iso'), file('Game.2.iso')],
			}),
		).toBe('Game.1.iso + Game.2.iso');
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
		// The fallback is trusted input,
		// not user-typed - it should pass through untouched even if it
		// happens to carry whitespace of its own.
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
