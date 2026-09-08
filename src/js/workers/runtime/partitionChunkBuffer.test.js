import { describe, it, expect } from 'vitest';
import { createPartitionChunkAccumulator } from './partitionChunkBuffer.js';

/** @param {string} name */
function file(name) {
	return /** @type {any} */ (new File(['x'], name));
}

describe('createPartitionChunkAccumulator', () => {
	it('reassembles a single chunkIndex 0/totalChunks 1 chunk (the unchunked case)', () => {
		const acc = createPartitionChunkAccumulator();
		const files = [file('a.iso'), file('b.iso')];
		const result = acc.push({
			dirName: 'MyGame',
			entries: ['a.iso', 'b.iso'],
			files,
			chunkIndex: 0,
			totalChunks: 1,
		});
		expect(result).toEqual({
			dirName: 'MyGame',
			entries: ['a.iso', 'b.iso'],
			files,
		});
	});

	it('returns null for every chunk before the last one', () => {
		const acc = createPartitionChunkAccumulator();
		expect(
			acc.push({
				dirName: 'd',
				entries: ['a'],
				files: [file('a')],
				chunkIndex: 0,
				totalChunks: 3,
			}),
		).toBeNull();
		expect(
			acc.push({
				entries: ['b'],
				files: [file('b')],
				chunkIndex: 1,
				totalChunks: 3,
			}),
		).toBeNull();
	});

	it('concatenates entries/files across chunks in arrival order', () => {
		const acc = createPartitionChunkAccumulator();
		const fa = file('a');
		const fb = file('b');
		const fc = file('c');
		acc.push({
			dirName: 'root',
			entries: ['a'],
			files: [fa],
			chunkIndex: 0,
			totalChunks: 3,
		});
		acc.push({ entries: ['b'], files: [fb], chunkIndex: 1, totalChunks: 3 });
		const result = acc.push({
			entries: ['c'],
			files: [fc],
			chunkIndex: 2,
			totalChunks: 3,
		});
		expect(result).toEqual({
			dirName: 'root',
			entries: ['a', 'b', 'c'],
			files: [fa, fb, fc],
		});
	});

	it('takes dirName only from the first chunk - later chunks omitting it do not clobber it', () => {
		const acc = createPartitionChunkAccumulator();
		acc.push({
			dirName: 'root',
			entries: [],
			files: [],
			chunkIndex: 0,
			totalChunks: 2,
		});
		const result = acc.push({
			entries: [],
			files: [],
			chunkIndex: 1,
			totalChunks: 2,
		});
		expect(result?.dirName).toBe('root');
	});

	it('defaults dirName to "" when the first chunk omits it', () => {
		const acc = createPartitionChunkAccumulator();
		const result = acc.push({
			entries: [],
			files: [],
			chunkIndex: 0,
			totalChunks: 1,
		});
		expect(result?.dirName).toBe('');
	});

	it('resets the buffer after the last chunk, so a second call starts fresh', () => {
		const acc = createPartitionChunkAccumulator();
		acc.push({
			dirName: 'first-call',
			entries: ['x'],
			files: [file('x')],
			chunkIndex: 0,
			totalChunks: 1,
		});

		const fy = file('y');
		const second = acc.push({
			dirName: 'second-call',
			entries: ['y'],
			files: [fy],
			chunkIndex: 0,
			totalChunks: 1,
		});
		expect(second).toEqual({
			dirName: 'second-call',
			entries: ['y'],
			files: [fy],
		});
	});

	it('a `chunkIndex: 0` chunk mid-stream discards whatever was buffered before it (defensive reset)', () => {
		const acc = createPartitionChunkAccumulator();
		acc.push({
			dirName: 'abandoned',
			entries: ['stale'],
			files: [file('stale')],
			chunkIndex: 0,
			totalChunks: 2,
		});

		const fFresh = file('fresh');
		const result = acc.push({
			dirName: 'restarted',
			entries: ['fresh'],
			files: [fFresh],
			chunkIndex: 0,
			totalChunks: 1,
		});
		expect(result).toEqual({
			dirName: 'restarted',
			entries: ['fresh'],
			files: [fFresh],
		});
	});

	it('handles the empty-tree case (one chunk, chunkIndex 0/totalChunks 1, empty arrays)', () => {
		const acc = createPartitionChunkAccumulator();
		const result = acc.push({
			dirName: '',
			entries: [],
			files: [],
			chunkIndex: 0,
			totalChunks: 1,
		});
		expect(result).toEqual({ dirName: '', entries: [], files: [] });
	});
});
