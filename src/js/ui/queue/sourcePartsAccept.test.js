import { describe, it, expect } from 'vitest';
import {
	splitSiblingAccept,
	discAdditionAccept,
	isPromotableSource,
	isSplitCapableSource,
} from './sourcePartsAccept.js';
import { file, stubItem } from '../../../../test/utils/queueTestHelpers.js';

describe('sourcePartsAccept', () => {
	describe('splitSiblingAccept', () => {
		it('returns the fixed extension for sourceFormat xiso', () => {
			const item = stubItem({ sourceFormat: 'xiso' });
			expect(splitSiblingAccept(item)).toBe('.iso');
		});

		it('returns the fixed extension for sourceFormat cci', () => {
			const item = stubItem({ sourceFormat: 'cci' });
			expect(splitSiblingAccept(item)).toBe('.cci');
		});

		it('returns the ciso/cso extensions for sourceFormat ciso', () => {
			const item = stubItem({ sourceFormat: 'ciso' });
			expect(splitSiblingAccept(item)).toBe('.cso,.ciso');
		});

		it('falls back to the generic list for a sourceFormat with no fixed extension (god - folder picked)', () => {
			const item = stubItem({ sourceFormat: 'god' });
			expect(splitSiblingAccept(item)).toBe('.iso,.cso,.cci,.zar');
		});

		describe('sourceFormat unset - filename sniff fallback', () => {
			it('sniffs a .cci filename off an unresolved source', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'unresolved', files: [file('game.cci')], reason: 'x' },
				});
				expect(splitSiblingAccept(item)).toBe('.cci');
			});

			it('sniffs a .cso filename off a files source', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'files', files: [file('game.cso')] },
				});
				expect(splitSiblingAccept(item)).toBe('.cso,.ciso');
			});

			it('sniffs a .ciso filename off a files source', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'files', files: [file('game.ciso')] },
				});
				expect(splitSiblingAccept(item)).toBe('.cso,.ciso');
			});

			it('falls back to the generic list when the filename matches none of cci/cso/ciso', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'files', files: [file('game.iso')] },
				});
				expect(splitSiblingAccept(item)).toBe('.iso,.cso,.cci,.zar');
			});

			it('falls back to the generic list for a dir source (nothing to sniff)', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'dir', dirName: 'x', entries: [], files: [] },
				});
				expect(splitSiblingAccept(item)).toBe('.iso,.cso,.cci,.zar');
			});
		});
	});

	describe('discAdditionAccept', () => {
		it('returns the fixed extension for a multi-disc-capable format with one (xiso)', () => {
			const item = stubItem({ sourceFormat: 'xiso' });
			expect(discAdditionAccept(item)).toBe('.iso');
		});

		it('falls back to the generic list for god - multi-disc-capable but no fixed extension', () => {
			const item = stubItem({ sourceFormat: 'god' });
			expect(discAdditionAccept(item)).toBe('.iso,.cso,.cci,.zar');
		});

		it('falls back to the generic list for a format the batch scanner cannot group (cci)', () => {
			const item = stubItem({ sourceFormat: 'cci' });
			expect(discAdditionAccept(item)).toBe('.iso,.cso,.cci,.zar');
		});

		it('falls back to the generic list when sourceFormat is unset', () => {
			const item = stubItem({ sourceFormat: undefined });
			expect(discAdditionAccept(item)).toBe('.iso,.cso,.cci,.zar');
		});
	});

	describe('isPromotableSource', () => {
		it('is false for an unresolved source', () => {
			const item = stubItem({
				source: { kind: 'unresolved', files: [file('a.iso')], reason: 'x' },
				status: 'idle',
				sourceFormat: 'xiso',
			});
			expect(isPromotableSource(item)).toBe(false);
		});

		it('is false for an already multi-disc source', () => {
			const item = stubItem({
				source: {
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 2,
					discs: [],
				},
				status: 'idle',
				sourceFormat: 'xiso',
			});
			expect(isPromotableSource(item)).toBe(false);
		});

		it('is false for a files source with more than one file', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso'), file('b.iso')] },
				status: 'idle',
				sourceFormat: 'xiso',
			});
			expect(isPromotableSource(item)).toBe(false);
		});

		it('is false when status is neither idle nor cancelled', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso')] },
				status: 'running',
				sourceFormat: 'xiso',
			});
			expect(isPromotableSource(item)).toBe(false);
		});

		it('is false when sourceFormat is unset', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso')] },
				status: 'idle',
				sourceFormat: undefined,
			});
			expect(isPromotableSource(item)).toBe(false);
		});

		it('is false when sourceFormat is not multi-disc-capable (e.g. cci)', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso')] },
				status: 'idle',
				sourceFormat: 'cci',
			});
			expect(isPromotableSource(item)).toBe(false);
		});

		it('is true for a single-file xiso source that is idle', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso')] },
				status: 'idle',
				sourceFormat: 'xiso',
			});
			expect(isPromotableSource(item)).toBe(true);
		});

		it('is true for a dir (GOD) source that is cancelled - no file-count check applies to dir', () => {
			const item = stubItem({
				source: {
					kind: 'dir',
					dirName: 'Game',
					entries: ['Data0000'],
					files: [file('Data0000')],
				},
				status: 'cancelled',
				sourceFormat: 'god',
			});
			expect(isPromotableSource(item)).toBe(true);
		});
	});

	describe('isSplitCapableSource', () => {
		it('is false when sourceFormat is zar', () => {
			const item = stubItem({ sourceFormat: 'zar' });
			expect(isSplitCapableSource(item)).toBe(false);
		});

		it('is true for any other known sourceFormat', () => {
			const item = stubItem({ sourceFormat: 'xiso' });
			expect(isSplitCapableSource(item)).toBe(true);
		});

		it('is false when sourceFormat is stfs - a package is self-contained, no sibling to reattach', () => {
			const item = stubItem({ sourceFormat: 'stfs' });
			expect(isSplitCapableSource(item)).toBe(false);
		});

		describe('sourceFormat unset - filename sniff fallback', () => {
			it('is false for a .zar filename', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'files', files: [file('game.zar')] },
				});
				expect(isSplitCapableSource(item)).toBe(false);
			});

			it('is true for a non-.zar filename', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'files', files: [file('game.iso')] },
				});
				expect(isSplitCapableSource(item)).toBe(true);
			});

			it('is true for an unresolved source with a non-.zar filename', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'unresolved', files: [file('game.cso')], reason: 'x' },
				});
				expect(isSplitCapableSource(item)).toBe(true);
			});

			it('is true for a dir source (nothing to sniff, can never match .zar)', () => {
				const item = stubItem({
					sourceFormat: undefined,
					source: { kind: 'dir', dirName: 'x', entries: [], files: [] },
				});
				expect(isSplitCapableSource(item)).toBe(true);
			});
		});
	});
});
