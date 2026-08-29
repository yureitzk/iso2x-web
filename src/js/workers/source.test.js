import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * @import { DroppedSource } from '../../types/global'
 */

/**
 * Reimplements looks_god's rule from source.rs so this suite can test
 * against the real parts.len() <= 4 cap without booting wasm. Must stay
 * in sync with the Rust version.
 * @param {string[]} entries
 */
function looksGod(entries) {
	return entries.some((path) => {
		const parts = path.split('/');
		if (parts.length > 4 || parts.length < 2) return false;
		const last = parts[parts.length - 1];
		if (!last.startsWith('Data')) return false;
		const parent = parts[parts.length - 2];
		return /\.data$/i.test(parent);
	});
}

const { scanBatch, resolveBatchEntry, checkIsoCompleteness, detectFormat } =
	vi.hoisted(() => ({
		scanBatch: vi.fn().mockResolvedValue([]),
		resolveBatchEntry: vi.fn(),
		checkIsoCompleteness: vi.fn(() => undefined),
		detectFormat: vi.fn(),
	}));
vi.mock('iso2x', () => ({
	detectDirFormat: (/** @type {string[]} */ entries) =>
		looksGod(entries) ? 'god' : undefined,
	detectFormat,
	scanBatch,
	resolveBatchEntry,
	defaultFetchSize: () => 16 * 1024 * 1024,
}));
vi.mock('iso2x/detect-advanced', () => ({ checkIsoCompleteness }));

const {
	partitionDroppedFolder,
	partitionDirEntries,
	groupInputFiles,
	godPartIndices,
} = await import('./source.js');

/** @param {string} name */
function file(name) {
	return new File([new Uint8Array(4)], name.split('/').pop() ?? name);
}

describe('partitionDroppedFolder - GOD detection through recursion', () => {
	it('a GOD folder nested deeper than the 4-segment cap still resolves, via recursion', async () => {
		const entries = [
			'Some/Arbitrarily/Renamed/Path/Whatever.data/Data0000',
			'Some/Arbitrarily/Renamed/Path/Whatever.data/Data0001',
		];
		const files = entries.map(file);
		/** @type {DroppedSource[]} */
		const sources = await partitionDroppedFolder('', entries, files);
		expect(sources).toHaveLength(1);
		expect(sources[0].kind).toBe('dir');
	});

	it('a GOD folder within the cap resolves the same way, for comparison', async () => {
		const entries = ['Whatever.data/Data0000', 'Whatever.data/Data0001'];
		const files = entries.map(file);
		/** @type {DroppedSource[]} */
		const sources = await partitionDroppedFolder('', entries, files);
		expect(sources).toHaveLength(1);
		expect(sources[0].kind).toBe('dir');
	});
});

describe('partitionDirEntries - loose-file STFS magic sniffing', () => {
	beforeEach(() => {
		resolveBatchEntry.mockReset();
		checkIsoCompleteness.mockReset();
		checkIsoCompleteness.mockReturnValue(undefined);
		detectFormat.mockReset();
	});

	it('an extensionless file with STFS magic is included, not filtered out by name', async () => {
		checkIsoCompleteness.mockReturnValueOnce(undefined); // completeness pre-pass: not a raw XDVDFS image
		detectFormat.mockReturnValueOnce('stfs');
		resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'stfs' });

		const sources = await partitionDirEntries(
			'',
			['SaveGameData'],
			[file('SaveGameData')],
		);

		expect(detectFormat).toHaveBeenCalledTimes(1);
		expect(sources).toHaveLength(1);
		const [source] = sources;
		if (source.kind !== 'files')
			throw new Error(`expected 'files', got ${source.kind}`);
		expect(source.files.map((f) => f.name)).toEqual(['SaveGameData']);
	});

	it('extensionless junk with no STFS magic stays excluded', async () => {
		detectFormat.mockReturnValueOnce('xiso'); // detect()'s fallback for non-magic bytes

		const sources = await partitionDirEntries(
			'',
			['random.dat.nonsense'],
			[file('random.dat.nonsense')],
		);

		expect(sources).toHaveLength(0);
		expect(resolveBatchEntry).not.toHaveBeenCalled();
	});

	it('a known-extension file is grouped without ever consulting detectFormat', async () => {
		checkIsoCompleteness.mockReturnValueOnce(undefined);
		resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'xiso' });

		const sources = await partitionDirEntries(
			'',
			['game.iso'],
			[file('game.iso')],
		);

		expect(detectFormat).not.toHaveBeenCalled();
		expect(sources).toHaveLength(1);
		const [source] = sources;
		if (source.kind !== 'files')
			throw new Error(`expected 'files', got ${source.kind}`);
		expect(source.files.map((f) => f.name)).toEqual(['game.iso']);
	});

	it('a file too small to hold a magic number is excluded without calling detectFormat', async () => {
		const tiny = new File([new Uint8Array(2)], 'headerless');
		const sources = await partitionDirEntries('', ['headerless'], [tiny]);

		expect(detectFormat).not.toHaveBeenCalled();
		expect(sources).toHaveLength(0);
	});

	it('detectFormat throwing (e.g. a read error) is treated as non-STFS, not a crash', async () => {
		detectFormat.mockImplementationOnce(() => {
			throw new Error('read failed');
		});

		const sources = await partitionDirEntries(
			'',
			['weird-file'],
			[file('weird-file')],
		);

		expect(sources).toHaveLength(0);
	});
});

describe('groupInputFiles - real wasm outcomes mapped to DroppedSource groups', () => {
	beforeEach(() => {
		resolveBatchEntry.mockReset();
		checkIsoCompleteness.mockReset();
		checkIsoCompleteness.mockReturnValue(undefined);
	});

	it('a verified raw split ("dir" outcome) becomes a "files" group in the wasm-resolved order, not input order', async () => {
		const b = file('b.iso');
		const a = file('a.iso');
		resolveBatchEntry.mockResolvedValueOnce({
			kind: 'dir',
			format: 'xiso',
			parts: [{ name: 'a.iso' }, { name: 'b.iso' }], // resolved order differs from [b, a] passed in
		});
		const groups = await groupInputFiles([b, a]);
		expect(groups).toHaveLength(1);
		const [group] = groups;
		if (group.kind !== 'files')
			throw new Error(`expected 'files', got ${group.kind}`);
		expect(group.files.map((f) => f.name)).toEqual(['a.iso', 'b.iso']);
		expect(resolveBatchEntry).toHaveBeenCalledTimes(1);
	});

	it('an "unresolvedOrdering" invalid outcome becomes an "unresolved" group carrying the reason, not "files"', async () => {
		resolveBatchEntry.mockResolvedValueOnce({
			kind: 'invalid',
			names: ['part.a.iso', 'part.b.iso'],
			reason: 'no ordering of these parts verified as a valid split',
			invalidKind: 'unresolvedOrdering',
		});
		const groups = await groupInputFiles([
			file('part.a.iso'),
			file('part.b.iso'),
		]);
		expect(groups).toHaveLength(1);
		const [group] = groups;
		if (group.kind !== 'unresolved') {
			throw new Error(`expected 'unresolved', got ${group.kind}`);
		}
		expect(group.reason).toBe(
			'no ordering of these parts verified as a valid split',
		);
	});

	it('an "ambiguousHeaders" invalid outcome becomes an "unresolved" group tagged unresolvedKind: "ambiguousHeaders"', async () => {
		resolveBatchEntry.mockResolvedValueOnce({
			kind: 'invalid',
			names: ['header-a.bin', 'header-b.bin'],
			reason:
				'multiple ambiguous truncated-header candidates in this batch - resolve manually',
			invalidKind: 'ambiguousHeaders',
		});
		const groups = await groupInputFiles([
			file('header-a.bin'),
			file('header-b.bin'),
		]);
		expect(groups).toHaveLength(1);
		const [group] = groups;
		if (group.kind !== 'unresolved') {
			throw new Error(`expected 'unresolved', got ${group.kind}`);
		}
		expect(group.unresolvedKind).toBe('ambiguousHeaders');
		expect(group.reason).toContain('ambiguous truncated-header candidates');
		expect(group.files.map((f) => f.name).sort()).toEqual([
			'header-a.bin',
			'header-b.bin',
		]);
	});

	it('an "unresolvedOrdering" outcome leaves unresolvedKind unset', async () => {
		resolveBatchEntry.mockResolvedValueOnce({
			kind: 'invalid',
			names: ['part.a.iso', 'part.b.iso'],
			reason: 'no ordering of these parts verified as a valid split',
			invalidKind: 'unresolvedOrdering',
		});
		const groups = await groupInputFiles([
			file('part.a.iso'),
			file('part.b.iso'),
		]);
		const [group] = groups;
		if (group.kind !== 'unresolved') {
			throw new Error(`expected 'unresolved', got ${group.kind}`);
		}
		expect(group.unresolvedKind).toBeUndefined();
	});

	it('a "mismatch" invalid outcome stays a "files" group, carrying invalidReason/invalidKind - not "unresolved"', async () => {
		resolveBatchEntry.mockResolvedValueOnce({
			kind: 'invalid',
			names: ['game.1.cci', 'game.2.cci'],
			reason: "found the named pair but they don't form a valid Cci split",
			invalidKind: 'mismatch',
		});
		const groups = await groupInputFiles([
			file('game.1.cci'),
			file('game.2.cci'),
		]);
		expect(groups).toHaveLength(1);
		const [group] = groups;
		if (group.kind !== 'files')
			throw new Error(`expected 'files', got ${group.kind}`);
		expect(group.invalidKind).toBe('mismatch');
		expect(group.invalidReason).toContain("don't form a valid");
	});

	// Regression guard: groupInputFiles() must never delete `file.name`
	// from `remaining` without giving it a group, even if resolveBatchEntry
	// wrongly reports a split match that excludes entries[0].
	it('never drops the anchor file, even if resolveBatchEntry returns a split resolution that does not include it', async () => {
		const zar = file('other-game.zar');
		const xiso1 = file('game.1.iso');
		const xiso2 = file('game.2.iso');

		resolveBatchEntry.mockResolvedValueOnce({
			kind: 'dir',
			format: 'xiso',
			parts: [{ name: 'game.1.iso' }, { name: 'game.2.iso' }],
		});
		resolveBatchEntry.mockResolvedValueOnce({
			kind: 'dir',
			format: 'xiso',
			parts: [{ name: 'game.1.iso' }, { name: 'game.2.iso' }],
		});

		const groups = await groupInputFiles([zar, xiso1, xiso2]);
		expect(groups).toHaveLength(2);
		for (const g of groups) {
			if (g.kind === 'multi-disc') throw new Error('expected a "files" group');
		}
		const fileGroups =
			/** @type {Extract<DroppedSource, { files: File[] }>[]} */ (groups);

		const allFiles = fileGroups.flatMap((g) => g.files.map((f) => f.name)).sort();
		expect(allFiles).toEqual(
			['game.1.iso', 'game.2.iso', 'other-game.zar'].sort(),
		);

		const zarGroup = fileGroups.find((g) =>
			g.files.some((f) => f.name === zar.name),
		);
		expect(zarGroup?.files.map((f) => f.name)).toEqual(['other-game.zar']);

		const splitGroup = fileGroups.find((g) =>
			g.files.some((f) => f.name === xiso1.name),
		);
		expect(splitGroup?.files.map((f) => f.name).sort()).toEqual([
			'game.1.iso',
			'game.2.iso',
		]);
	});

	it('a "file" outcome consumes only that one file, leaving the rest for the next iteration', async () => {
		resolveBatchEntry
			.mockResolvedValueOnce({ kind: 'file', format: 'xiso' })
			.mockResolvedValueOnce({ kind: 'file', format: 'xiso' });
		const groups = await groupInputFiles([
			file('standalone.iso'),
			file('another.iso'),
		]);
		expect(groups).toHaveLength(2);
		const names = groups.map((g) => {
			if (g.kind !== 'files') throw new Error(`expected 'files', got ${g.kind}`);
			return g.files[0].name;
		});
		expect(names.sort()).toEqual(['another.iso', 'standalone.iso']);
		expect(resolveBatchEntry).toHaveBeenCalledTimes(2);
	});
});

describe('partitionDroppedFolder - multi-disc set extraction (scanBatch)', () => {
	beforeEach(() => {
		scanBatch.mockReset();
		resolveBatchEntry.mockReset();
		checkIsoCompleteness.mockReset();
		checkIsoCompleteness.mockReturnValue(undefined);
	});

	it("turns a multiDiscSet result into one multi-disc source, sorted by discNumber and locked, regardless of scanBatch's own array order", async () => {
		const entries = ['GameDisc1.iso', 'GameDisc2.iso'];
		const files = [file('GameDisc1.iso'), file('GameDisc2.iso')];
		scanBatch.mockResolvedValueOnce([
			{
				kind: 'multiDiscSet',
				titleId: '4744F00D',
				discCount: 2,
				// Deliberately out of order - exercises extractMultiDiscSets()'s sort.
				discs: [
					{ name: 'GameDisc2.iso', mediaId: '00000002', discNumber: 2 },
					{ name: 'GameDisc1.iso', mediaId: '00000001', discNumber: 1 },
				],
			},
		]);
		const sources = await partitionDroppedFolder('', entries, files);
		expect(sources).toHaveLength(1);
		const [multiDisc] = sources;
		expect(multiDisc.kind).toBe('multi-disc');
		if (multiDisc.kind !== 'multi-disc') throw new Error('unreachable');
		expect(multiDisc.titleId).toBe('4744F00D');
		expect(multiDisc.discs.map((d) => d.files[0].name)).toEqual([
			'GameDisc1.iso',
			'GameDisc2.iso',
		]);
		expect(multiDisc.discs.every((d) => d.locked)).toBe(true);
	});

	it('reconstructs a GOD-shaped disc as a "dir" source with its own dirName/parentPath - same-named leaves across discs told apart by parent folder alone', async () => {
		const entries = ['Set/Disc1.data/Data0000', 'Set/Disc2.data/Data0000'];
		const files = [file('Data0000'), file('Data0000')];
		scanBatch.mockResolvedValueOnce([
			{
				kind: 'multiDiscSet',
				titleId: '4744F00D',
				discCount: 2,
				discs: [
					{ name: 'Set/Disc1.data/Data0000', mediaId: '1', discNumber: 1 },
					{ name: 'Set/Disc2.data/Data0000', mediaId: '2', discNumber: 2 },
				],
			},
		]);
		const sources = await partitionDroppedFolder('', entries, files);
		const [multiDisc] = sources;
		if (multiDisc.kind !== 'multi-disc') throw new Error('unreachable');
		const [disc1, disc2] = multiDisc.discs;
		if (disc1.kind !== 'dir' || disc2.kind !== 'dir') {
			throw new Error(`expected dir discs, got ${disc1.kind}/${disc2.kind}`);
		}
		expect(disc1.dirName).toBe('Disc1.data');
		expect(disc1.parentPath).toBe('Set');
		expect(disc1.entries).toEqual(['Disc1.data/Data0000']);
		expect(disc2.dirName).toBe('Disc2.data');
		expect(disc2.parentPath).toBe('Set');
	});

	it('a multiDiscSet mixing a GOD-shaped disc with a flat raw disc is NOT grouped - each disc becomes its own standalone source', async () => {
		const entries = ['Set/Disc1.data/Data0000', 'Disc2.iso'];
		const files = [file('Data0000'), file('Disc2.iso')];
		scanBatch.mockResolvedValueOnce([
			{
				kind: 'multiDiscSet',
				titleId: '4744F00D',
				discCount: 2,
				discs: [
					{ name: 'Disc2.iso', mediaId: '2', discNumber: 2 },
					{ name: 'Set/Disc1.data/Data0000', mediaId: '1', discNumber: 1 },
				],
			},
		]);
		const sources = await partitionDroppedFolder('', entries, files);
		expect(sources).toHaveLength(2);
		expect(sources.every((s) => s.kind !== 'multi-disc')).toBe(true);

		const dirSource = sources.find((s) => s.kind === 'dir');
		if (!dirSource || dirSource.kind !== 'dir') {
			throw new Error('expected a dir source for the GOD-shaped disc');
		}
		expect(dirSource.dirName).toBe('Disc1.data');
		expect(dirSource.parentPath).toBe('Set');
		expect(dirSource.entries).toEqual(['Disc1.data/Data0000']);

		const filesSource = sources.find((s) => s.kind === 'files');
		if (!filesSource || filesSource.kind !== 'files') {
			throw new Error('expected a files source for the flat disc');
		}
		expect(filesSource.files.map((f) => f.name)).toEqual(['Disc2.iso']);
	});

	it('a mixed-shape set where the flat disc shares a parent folder with the GOD disc still resolves each disc correctly, without one disc absorbing the other, and without grouping them', async () => {
		const entries = ['Set/Disc1.data/Data0000', 'Set/Disc2.iso'];
		const files = [file('Data0000'), file('Disc2.iso')];
		scanBatch.mockResolvedValueOnce([
			{
				kind: 'multiDiscSet',
				titleId: '4744F00D',
				discCount: 2,
				discs: [
					{ name: 'Set/Disc2.iso', mediaId: '2', discNumber: 2 },
					{ name: 'Set/Disc1.data/Data0000', mediaId: '1', discNumber: 1 },
				],
			},
		]);
		const sources = await partitionDroppedFolder('', entries, files);
		expect(sources).toHaveLength(2);
		expect(sources.every((s) => s.kind !== 'multi-disc')).toBe(true);

		const dirSource = sources.find((s) => s.kind === 'dir');
		if (!dirSource || dirSource.kind !== 'dir') {
			throw new Error('expected a dir source for the GOD-shaped disc');
		}
		expect(dirSource.dirName).toBe('Disc1.data');
		expect(dirSource.parentPath).toBe('Set');
		// Guards against Disc2.iso leaking into Disc1's entries.
		expect(dirSource.entries).toEqual(['Disc1.data/Data0000']);

		const filesSource = sources.find((s) => s.kind === 'files');
		if (!filesSource || filesSource.kind !== 'files') {
			throw new Error('expected a files source for the flat disc');
		}
		expect(filesSource.files.map((f) => f.name)).toEqual(['Disc2.iso']);
	});

	it('never calls scanBatch for fewer than 2 entries - falls straight through to single-file handling', async () => {
		resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'xiso' });
		const sources = await partitionDroppedFolder(
			'',
			['solo.iso'],
			[file('solo.iso')],
		);
		expect(scanBatch).not.toHaveBeenCalled();
		expect(sources).toHaveLength(1);
		expect(sources[0].kind).toBe('files');
	});
});

describe('partitionDroppedFolder - "standalone" scanBatch results (discSourceFor)', () => {
	beforeEach(() => {
		scanBatch.mockReset();
		resolveBatchEntry.mockReset();
		checkIsoCompleteness.mockReset();
		checkIsoCompleteness.mockReturnValue(undefined);
		detectFormat.mockReset();
	});

	it('a lone GOD-shaped "standalone" result reconstructs a single dir source via discSourceFor', async () => {
		// At least 2 entries - extractMultiDiscSets() skips scanBatch()
		// entirely below that, which would exercise the unrelated
		// per-directory detectDirFormat() branch in partitionDirEntries()
		// instead of discSourceFor().
		const entries = [
			'Title/CType/Media/Media.data/Data0000',
			'Title/CType/Media/Media.data/Data0001',
		];
		const files = entries.map(file);
		scanBatch.mockResolvedValueOnce([{ kind: 'standalone', names: entries }]);
		const sources = await partitionDroppedFolder('', entries, files);
		expect(sources).toHaveLength(1);
		const [source] = sources;
		if (source.kind !== 'dir')
			throw new Error(`expected 'dir', got ${source.kind}`);
		expect(source.dirName).toBe('Media.data');
		expect(source.parentPath).toBe('Title/CType/Media');
	});

	// A GOD ".data" dir's sibling CON/LIVE/PIRS header stub has no
	// allocated blocks of its own (its data lives in the sibling
	// Data#### files), so StfsReader::open always rejects it - it must
	// never reach the loose single-file path at all.
	it("a GOD disc's sibling CON-header stub is claimed and discarded alongside the .data dir, not left to leak into a bogus loose 'stfs' source", async () => {
		const dataEntries = [
			'Title/CType/Media/Media.data/Data0000',
			'Title/CType/Media/Media.data/Data0001',
		];
		const headerEntry = 'Title/CType/Media/Media';
		const entries = [headerEntry, ...dataEntries];
		const files = entries.map(file);
		// scanBatch's 'standalone' names list for a GOD disc excludes the
		// header file - these mocks simulate the header leaking through
		// to looseImageSourcesAt() as a real CON-magic file would, so the
		// assertions below fail without the fix.
		scanBatch.mockResolvedValueOnce([{ kind: 'standalone', names: dataEntries }]);
		detectFormat.mockReturnValue('stfs');
		resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'stfs' });

		const sources = await partitionDroppedFolder('', entries, files);

		// Exactly one source: the GOD dir. No second 'files'/'unresolved'
		// item for the header stub, and detectFormat (the STFS magic
		// fallback) must never even be asked about it.
		expect(sources).toHaveLength(1);
		expect(sources[0].kind).toBe('dir');
		expect(detectFormat).not.toHaveBeenCalled();
	});

	it('the header-claiming match is case-insensitive, matching real GOD dumps that are not guaranteed lowercase', async () => {
		const dataEntries = ['Title/CType/Media/MEDIA.DATA/Data0000'];
		const headerEntry = 'Title/CType/Media/Media'; // differs in case from the .DATA dir's own base
		const entries = [headerEntry, ...dataEntries];
		const files = entries.map(file);
		scanBatch.mockResolvedValueOnce([{ kind: 'standalone', names: dataEntries }]);

		const sources = await partitionDroppedFolder('', entries, files);

		expect(sources).toHaveLength(1);
		expect(sources[0].kind).toBe('dir');
		expect(detectFormat).not.toHaveBeenCalled();
	});
});

describe('probe-candidate filtering (SAF round-trip reduction)', () => {
	// scanBatch/detectFormat are mocked, so what's under test is which
	// entries get offered up for a probe at all - not the probe's own
	// result handling, which the other describe blocks already cover.
	beforeEach(() => {
		scanBatch.mockReset();
		resolveBatchEntry.mockReset();
		checkIsoCompleteness.mockReset();
		checkIsoCompleteness.mockReturnValue(undefined);
		detectFormat.mockReset();
	});

	describe('extractMultiDiscSets (via partitionDroppedFolder)', () => {
		it('scanBatch only receives probe candidates, never ordinary-extension files', async () => {
			const entries = [
				'GameDisc1.iso',
				'GameDisc2.iso',
				'BoxArt.png',
				'Trailer.mp4',
				'readme.txt',
			];
			const files = entries.map(file);
			scanBatch.mockResolvedValueOnce([]);
			// Nothing claimed -> both .iso files fall through to
			// looseImageSourcesAt -> groupInputFiles.
			resolveBatchEntry.mockResolvedValue({ kind: 'file', format: 'xiso' });

			await partitionDroppedFolder('', entries, files);

			expect(scanBatch).toHaveBeenCalledTimes(1);
			const [probedEntries] = scanBatch.mock.calls[0];
			expect(probedEntries).toEqual(['GameDisc1.iso', 'GameDisc2.iso']);
		});

		it('every LOOSE_IMAGE_EXTENSIONS format (.iso/.cso/.cci/.zar) counts as a probe candidate', async () => {
			const entries = ['Game.iso', 'Game.cso', 'Game.cci', 'Game.zar', 'Game.txt'];
			const files = entries.map(file);
			scanBatch.mockResolvedValueOnce([]);
			resolveBatchEntry.mockResolvedValue({ kind: 'file', format: 'xiso' });

			await partitionDroppedFolder('', entries, files);

			expect(scanBatch.mock.calls[0][0]).toEqual([
				'Game.iso',
				'Game.cso',
				'Game.cci',
				'Game.zar',
			]);
		});

		// A lone candidate can't form a multi-disc set, so scanBatch is
		// skipped below 2 - but it must still reach isStfsMagic downstream.
		it('a lone extensionless candidate skips scanBatch but still reaches the single-file magic probe', async () => {
			const entries = ['SaveGameData', 'Notes.txt'];
			const files = entries.map(file);
			detectFormat.mockReturnValueOnce('stfs');
			resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'stfs' });

			const sources = await partitionDroppedFolder('', entries, files);

			expect(scanBatch).not.toHaveBeenCalled();
			expect(detectFormat).toHaveBeenCalledTimes(1);
			expect(sources).toHaveLength(1);
			const [source] = sources;
			if (source.kind !== 'files')
				throw new Error(`expected 'files', got ${source.kind}`);
			expect(source.files.map((f) => f.name)).toEqual(['SaveGameData']);
		});

		it('a known image extension is matched case-insensitively', async () => {
			const entries = ['Game1.ISO', 'Game2.Cci', 'cover.jpg'];
			const files = entries.map(file);
			scanBatch.mockResolvedValueOnce([]);
			resolveBatchEntry.mockResolvedValue({ kind: 'file', format: 'xiso' });

			await partitionDroppedFolder('', entries, files);

			expect(scanBatch.mock.calls[0][0]).toEqual(['Game1.ISO', 'Game2.Cci']);
		});

		it("a dotfile ('.gitignore') counts as extensionless, not an empty extension", async () => {
			const entries = ['.gitignore', 'readme.txt'];
			const files = entries.map(file);
			detectFormat.mockReturnValueOnce('stfs');
			resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'stfs' });

			const sources = await partitionDroppedFolder('', entries, files);

			expect(scanBatch).not.toHaveBeenCalled();
			expect(detectFormat).toHaveBeenCalledTimes(1);
			expect(sources).toHaveLength(1);
		});

		it('the extension check looks only at the final path segment', async () => {
			const entries = ['My.Weird.Folder/Data0000', 'My.Weird.Folder/notes.pdf'];
			const files = entries.map(file);
			detectFormat.mockReturnValueOnce('stfs');
			resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'stfs' });

			const sources = await partitionDroppedFolder('', entries, files);

			expect(scanBatch).not.toHaveBeenCalled();
			expect(detectFormat).toHaveBeenCalledTimes(1);
			expect(sources).toHaveLength(1);
			const [source] = sources;
			if (source.kind !== 'files')
				throw new Error(`expected 'files', got ${source.kind}`);
			expect(source.files.map((f) => f.name)).toEqual(['Data0000']);
		});

		it('skips scanBatch below 2 probe candidates, but non-candidates still reach partitionDirEntries', async () => {
			const entries = ['Movie1.wmv', 'Movie2.wmv', 'default.xex'];
			const files = entries.map(file);

			const sources = await partitionDroppedFolder('', entries, files);

			expect(scanBatch).not.toHaveBeenCalled();
			expect(detectFormat).not.toHaveBeenCalled();
			expect(sources).toHaveLength(0);
		});

		it('a real multi-disc set mixed with irrelevant files: only the discs get probed', async () => {
			const entries = [
				'GameDisc1.iso',
				'GameDisc2.iso',
				'Extras/Trailer.mp4',
				'Extras/BoxArt.png',
			];
			const files = entries.map(file);
			scanBatch.mockResolvedValueOnce([
				{
					kind: 'multiDiscSet',
					titleId: '4744F00D',
					discCount: 2,
					discs: [
						{ name: 'GameDisc1.iso', mediaId: '1', discNumber: 1 },
						{ name: 'GameDisc2.iso', mediaId: '2', discNumber: 2 },
					],
				},
			]);

			const sources = await partitionDroppedFolder('', entries, files);

			expect(sources).toHaveLength(1);
			expect(sources[0].kind).toBe('multi-disc');
			expect(detectFormat).not.toHaveBeenCalled();
			expect(scanBatch.mock.calls[0][0]).toEqual([
				'GameDisc1.iso',
				'GameDisc2.iso',
			]);
		});
	});

	describe('looseImageSourcesAt (via partitionDirEntries)', () => {
		it('an ordinary extension is excluded without calling detectFormat', async () => {
			const sources = await partitionDirEntries(
				'',
				['Trailer.mp4'],
				[file('Trailer.mp4')],
			);

			expect(detectFormat).not.toHaveBeenCalled();
			expect(sources).toHaveLength(0);
		});

		it('an extensionless file still gets the STFS magic probe', async () => {
			detectFormat.mockReturnValueOnce('stfs');
			resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'stfs' });

			const sources = await partitionDirEntries(
				'',
				['4D53000012345678'],
				[file('4D53000012345678')],
			);

			expect(detectFormat).toHaveBeenCalledTimes(1);
			expect(sources).toHaveLength(1);
		});

		it('a known image extension bypasses the magic probe entirely', async () => {
			checkIsoCompleteness.mockReturnValueOnce(undefined);
			resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'xiso' });

			const sources = await partitionDirEntries(
				'',
				['game.zar'],
				[file('game.zar')],
			);

			expect(detectFormat).not.toHaveBeenCalled();
			expect(sources).toHaveLength(1);
		});

		it('mixed loose files: only extensionless and known-extension entries are probed', async () => {
			checkIsoCompleteness.mockReturnValue(undefined);
			detectFormat.mockReturnValueOnce('stfs'); // for the one extensionless entry
			resolveBatchEntry.mockResolvedValueOnce({ kind: 'file', format: 'stfs' });

			const entries = ['SaveBlob', 'screenshot.png', 'notes.txt', 'video.wmv'];
			const sources = await partitionDirEntries('', entries, entries.map(file));

			expect(detectFormat).toHaveBeenCalledTimes(1); // only SaveBlob
			expect(sources).toHaveLength(1);
			const [source] = sources;
			if (source.kind !== 'files')
				throw new Error(`expected 'files', got ${source.kind}`);
			expect(source.files.map((f) => f.name)).toEqual(['SaveBlob']);
		});
	});

	describe('a dir-shaped folder never triggers loose-file probing', () => {
		it('a GOD folder with bundled files (xex/dat/movie) never probes those bundled entries', async () => {
			const entries = [
				'default.xex',
				'bionicle.dat',
				'BigTitle.data/Data0000',
				'BigTitle.data/Data0001',
				'Movies/Intro.wmv',
			];
			const files = entries.map(file);
			scanBatch.mockResolvedValueOnce([]); // lone GOD folder, nothing to correlate

			const sources = await partitionDroppedFolder('', entries, files);

			expect(sources).toHaveLength(1);
			expect(sources[0].kind).toBe('dir');
			if (sources[0].kind !== 'dir') throw new Error('unreachable');
			// Bundled entries are still part of the dir source - nothing
			// dropped, just never individually probed.
			expect(sources[0].entries.sort()).toEqual(entries.slice().sort());
			expect(detectFormat).not.toHaveBeenCalled();
			// Only the 2 extensionless Data#### chunks get probed.
			expect(scanBatch).toHaveBeenCalledTimes(1);
			expect(scanBatch.mock.calls[0][0]).toEqual([
				'BigTitle.data/Data0000',
				'BigTitle.data/Data0001',
			]);
		});
	});
});

describe('godPartIndices', () => {
	it('matches ".data" case-insensitively, so a ".DATA" folder still resolves', () => {
		const entries = ['MyGame.DATA/Data0000', 'MyGame.DATA/Data0001'];

		expect(godPartIndices(entries)).toEqual([0, 1]);
	});

	it('matches a mixed-case ".Data" folder too', () => {
		const entries = ['MyGame.Data/Data0000'];

		expect(godPartIndices(entries)).toEqual([0]);
	});

	it('still works for the plain lowercase ".data" folder', () => {
		const entries = ['MyGame.data/Data0000', 'MyGame.data/Data0001'];

		expect(godPartIndices(entries)).toEqual([0, 1]);
	});

	it('ignores files that are not part of the Data folder', () => {
		const entries = ['MyGame.data/Data0000', 'MyGame.iso.txt'];

		expect(godPartIndices(entries)).toEqual([0]);
	});
});
