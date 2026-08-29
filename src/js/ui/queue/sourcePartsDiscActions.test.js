import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { TEXT } from '../../constants/messages.js';
import { isEditable } from '../../queue/queue.js';
import { createDiscActionsController } from './sourcePartsDiscActions.js';
import {
	file,
	dispatchPartitionResult,
	stubItem,
	stubInput,
	sourceOf,
	FIXTURE_FILE_SIZE,
} from '../../../../test/utils/queueTestHelpers.js';

/**
 * @import { MultiDiscEntry, DroppedSource } from '../../../types/global'
 */

/**
 * Every PARTITION_ITEM/PARTITION_RESULT this suite needs is dispatched
 * by hand, so partitionDir() round-trips never touch a real worker.
 */
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

/**
 * isEditable() itself belongs to queue.js's status-permission table,
 * already covered by queue.test.js - mocked here (defaulting to true)
 * so this suite only exercises what sourcePartsDiscActions.js itself
 * does with the answer, not how STATUS_PERMISSIONS derives it.
 *
 * vi.mocked() is a type-only helper - it tells TypeScript that the
 * imported `isEditable` is really the mock vi.mock() installed above,
 * so `.mockReturnValue(...)` etc. are available with no runtime
 * change and no manual cast.
 */
vi.mock('../../queue/queue.js', () => ({ isEditable: vi.fn(() => true) }));
const mockIsEditable = vi.mocked(isEditable);

describe('sourcePartsDiscActions', () => {
	/** @type {ReturnType<typeof createDiscActionsController>} */
	let actions;
	/** @type {import('vitest').Mock} */
	let resolveSource;
	/** @type {import('vitest').Mock} */
	let renderSourceParts;

	beforeEach(() => {
		mockControllers.length = 0;
		resolveSource = vi.fn();
		renderSourceParts = vi.fn();
		mockIsEditable.mockReturnValue(true);
		actions = createDiscActionsController({
			// Never actually invoked - WorkerController is mocked below, so
			// this stand-in only has to satisfy `() => SwBridge` at the
			// type level. SwBridge is a class, so (like WorkerController -
			// see queueTestHelpers.js's DispatchableController comment)
			// it's nominal rather than structural: no amount of field
			// completeness, partial or otherwise, lets a plain object
			// satisfy it. vitest-mock-extended builds a Proxy and asserts
			// it against the type parameter internally, so the cast lives
			// in the library instead of here - no `any` needed on our side.
			getSwBridge: () =>
				/** @type {import('../../serviceWorker/SwBridge.js').SwBridge} */ (mock()),
			resolveSource,
			renderSourceParts,
		});
	});

	describe('updateFileSizeDisplay', () => {
		it('writes the sum of item.files sizes to fileSizeEl', () => {
			const item = stubItem({ files: [file('a.iso'), file('b.iso')] });
			actions.updateFileSizeDisplay(item);
			expect(item.fileSizeEl.textContent).toBe(String(FIXTURE_FILE_SIZE * 2));
		});
	});

	describe('moveDisc', () => {
		it('is a no-op for a non-multi-disc source', () => {
			const item = stubItem({ source: { kind: 'files', files: [file('a.iso')] } });
			actions.moveDisc(item, 0, 1);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('is a no-op when the entry is not editable', () => {
			mockIsEditable.mockReturnValue(false);
			/** @type {MultiDiscEntry[]} */
			const discs = [
				{ kind: 'files', files: [file('a.iso')], locked: true },
				{ kind: 'files', files: [file('b.iso')], locked: false },
			];
			const item = stubItem({
				source: { kind: 'multi-disc', titleId: 'ABCD1234', discCount: 2, discs },
			});
			actions.moveDisc(item, 0, 1);
			expect(discs[0].files[0].name).toBe('a.iso'); // unchanged
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('swaps two adjacent discs and re-renders', () => {
			/** @type {MultiDiscEntry} */
			const discA = { kind: 'files', files: [file('a.iso')], locked: true };
			/** @type {MultiDiscEntry} */
			const discB = { kind: 'files', files: [file('b.iso')], locked: false };
			const item = stubItem({
				source: {
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 2,
					discs: [discA, discB],
				},
			});
			actions.moveDisc(item, 0, 1);
			expect(sourceOf(item).discs).toEqual([discB, discA]);
			expect(renderSourceParts).toHaveBeenCalledWith(item);
		});

		it('does nothing (and does not render) when the swap goes out of bounds', () => {
			/** @type {MultiDiscEntry[]} */
			const discs = [{ kind: 'files', files: [file('a.iso')], locked: true }];
			const item = stubItem({
				source: { kind: 'multi-disc', titleId: 'ABCD1234', discCount: 1, discs },
			});
			actions.moveDisc(item, 0, -1);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});
	});

	describe('removeDisc', () => {
		it('is a no-op for a non-multi-disc source', () => {
			const item = stubItem({ source: { kind: 'files', files: [file('a.iso')] } });
			actions.removeDisc(item, 0);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('is a no-op when the entry is not editable', () => {
			mockIsEditable.mockReturnValue(false);
			/** @type {MultiDiscEntry[]} */
			const discs = [
				{ kind: 'files', files: [file('a.iso')], locked: true },
				{ kind: 'files', files: [file('b.iso')], locked: false },
			];
			const item = stubItem({
				source: { kind: 'multi-disc', titleId: 'ABCD1234', discCount: 2, discs },
			});
			actions.removeDisc(item, 1);
			expect(discs).toHaveLength(2);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('is a no-op for a locked disc', () => {
			/** @type {MultiDiscEntry[]} */
			const discs = [
				{ kind: 'files', files: [file('a.iso')], locked: true },
				{ kind: 'files', files: [file('b.iso')], locked: false },
			];
			const item = stubItem({
				source: { kind: 'multi-disc', titleId: 'ABCD1234', discCount: 2, discs },
			});
			actions.removeDisc(item, 0);
			expect(discs).toHaveLength(2);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('removes an unlocked disc, updates files/size, and re-renders when discs remain', () => {
			/** @type {MultiDiscEntry} */
			const discA = { kind: 'files', files: [file('a.iso')], locked: true };
			/** @type {MultiDiscEntry} */
			const discB = { kind: 'files', files: [file('b.iso')], locked: false };
			/** @type {MultiDiscEntry} */
			const discC = { kind: 'files', files: [file('c.iso')], locked: false };
			const item = stubItem({
				source: {
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 3,
					discs: [discA, discB, discC],
				},
			});
			actions.removeDisc(item, 1);
			expect(sourceOf(item).discs).toEqual([discA, discC]);
			expect(item.files).toEqual([discA.files[0], discC.files[0]]);
			expect(item.fileSizeEl.textContent).toBe(String(FIXTURE_FILE_SIZE * 2));
			expect(item.source.kind).toBe('multi-disc'); // still >1 disc - no dissolve
			expect(renderSourceParts).toHaveBeenCalledWith(item);
		});

		it('dissolves back to a plain single source when only one disc remains', () => {
			/** @type {MultiDiscEntry} */
			const discA = {
				kind: 'dir',
				dirName: 'Disc1.data',
				entries: ['Disc1.data/Data0000'],
				files: [file('Data0000', 'Disc1.data/Data0000')],
				locked: true,
			};
			/** @type {MultiDiscEntry} */
			const discB = {
				kind: 'dir',
				dirName: 'Disc2.data',
				entries: ['Disc2.data/Data0000'],
				files: [file('Data0000', 'Disc2.data/Data0000')],
				locked: false,
			};
			const item = stubItem({
				source: {
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 2,
					discs: [discA, discB],
				},
			});
			actions.removeDisc(item, 1);
			expect(item.source).toBe(discA);
			expect(item.files).toEqual(discA.files);
			expect(renderSourceParts).toHaveBeenCalledWith(item);
		});
	});

	describe('addDisc', () => {
		it('is a no-op for a non-multi-disc source', () => {
			const item = stubItem({ source: { kind: 'files', files: [file('a.iso')] } });
			const input = stubInput([file('b.iso')]);
			actions.addDisc(item, input);
			expect(mockControllers).toHaveLength(0);
		});

		it('is a no-op when the input has no files', () => {
			/** @type {MultiDiscEntry[]} */
			const discs = [{ kind: 'files', files: [file('a.iso')], locked: true }];
			const item = stubItem({
				source: { kind: 'multi-disc', titleId: 'ABCD1234', discCount: 1, discs },
			});
			const input = stubInput([]);
			actions.addDisc(item, input);
			expect(mockControllers).toHaveLength(0);
		});

		it('appends a new unlocked disc once the merged batch confirms a shared titleId (raw-file discs)', () => {
			/** @type {MultiDiscEntry} */
			const disc1 = { kind: 'files', files: [file('disc1.iso')], locked: true };
			const item = stubItem({
				source: {
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 1,
					discs: [disc1],
				},
			});
			const newFile = file('disc2.iso');
			const input = stubInput([newFile], 'x');
			actions.addDisc(item, input);
			expect(input.value).toBe('');
			const partitionCtrl = lastController();
			expect(partitionCtrl.partitionDir).toHaveBeenCalledWith(
				'',
				['disc1.iso', 'disc2.iso'],
				[disc1.files[0], newFile],
			);
			const resolvedDisc2 = file('disc2.iso');
			dispatchPartitionResult(partitionCtrl, [
				{
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 2,
					discs: [
						{ kind: 'files', files: [file('disc1.iso')], locked: true },
						{ kind: 'files', files: [resolvedDisc2], locked: false },
					],
				},
			]);
			const resultDiscs = sourceOf(item).discs;
			expect(resultDiscs).toHaveLength(2);
			expect(resultDiscs[0]).toBe(disc1); // original disc object, re-locked in place
			expect(resultDiscs[0].locked).toBe(true);
			expect(resultDiscs[1]).toEqual({
				kind: 'files',
				files: [resolvedDisc2],
				locked: false,
			});
			expect(item.files).toEqual([disc1.files[0], resolvedDisc2]);
			expect(item.fileSizeEl.textContent).toBe(String(FIXTURE_FILE_SIZE * 2));
			expect(renderSourceParts).toHaveBeenCalledWith(item);
		});

		it('reports DISC_MISMATCH and leaves the disc count unchanged when the merge check fails', () => {
			/** @type {MultiDiscEntry} */
			const disc1 = { kind: 'files', files: [file('disc1.iso')], locked: true };
			const item = stubItem({
				source: {
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 1,
					discs: [disc1],
				},
			});
			const newFile = file('unrelated.iso');
			const input = stubInput([newFile], 'x');
			actions.addDisc(item, input);
			const partitionCtrl = lastController();
			// Only 1 disc resolves (no shared titleId match), not the
			// expected 2 - resolveDiscAddition() treats that as a failure.
			dispatchPartitionResult(partitionCtrl, [
				{
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 1,
					discs: [{ kind: 'files', files: [file('disc1.iso')], locked: true }],
				},
			]);
			expect(resolveSource).toHaveBeenCalledWith(item, {
				kind: 'error',
				message: TEXT.DISC_MISMATCH('unrelated.iso'),
			});
			expect(sourceOf(item).discs).toHaveLength(1);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('reconstructs the parentPath/dirName/entries of an existing GOD disc for the merge round trip', () => {
			/** @type {MultiDiscEntry} */
			const disc1 = {
				kind: 'dir',
				dirName: 'Disc1.data',
				entries: ['Disc1.data/Data0000'],
				files: [file('Data0000', 'Set/Disc1.data/Data0000')],
				parentPath: 'Set',
				locked: true,
			};
			const item = stubItem({
				source: {
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 1,
					discs: [disc1],
				},
			});
			const disc2File = file('Data0000', 'Disc2.data/Data0000');
			const input = stubInput([disc2File], 'x');
			actions.addDisc(item, input);
			const partitionCtrl = lastController();
			// Not pinning the exact partitionDir() args here (they depend
			// on relativeDirEntries()'s own entry-building, covered by
			// helpers.test.js) - checking the rendered outcome instead.
			/** @type {MultiDiscEntry} */
			const disc2 = {
				kind: 'dir',
				dirName: 'Disc2.data',
				entries: ['Disc2.data/Data0000'],
				files: [disc2File],
				locked: false,
			};
			dispatchPartitionResult(partitionCtrl, [
				{
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 2,
					discs: [disc1, disc2],
				},
			]);
			const resultDiscs = sourceOf(item).discs;
			expect(resultDiscs).toHaveLength(2);
			expect(resultDiscs[0]).toEqual({ ...disc1, locked: true });
			expect(resultDiscs[1]).toEqual({ ...disc2, locked: false });
		});
	});

	describe('promoteToMultiDisc', () => {
		it('is a no-op for a source that is neither files nor dir', () => {
			const item = stubItem({
				source: { kind: 'unresolved', files: [file('a.iso')], reason: 'x' },
			});
			const input = stubInput([file('b.iso')]);
			actions.promoteToMultiDisc(item, input);
			expect(mockControllers).toHaveLength(0);
		});

		it('is a no-op when the input has no files', () => {
			const item = stubItem({ source: { kind: 'files', files: [file('a.iso')] } });
			const input = stubInput([]);
			actions.promoteToMultiDisc(item, input);
			expect(mockControllers).toHaveLength(0);
		});

		it('promotes a single-file source: original locked as disc 1, new file unlocked as disc 2', () => {
			const original = file('game.iso');
			const item = stubItem({ source: { kind: 'files', files: [original] } });
			const newFile = file('disc2.iso');
			const input = stubInput([newFile], 'x');
			actions.promoteToMultiDisc(item, input);
			expect(input.value).toBe('');
			const partitionCtrl = lastController();
			expect(partitionCtrl.partitionDir).toHaveBeenCalledWith(
				'',
				['game.iso', 'disc2.iso'],
				[original, newFile],
			);
			const resolvedDisc2 = file('disc2.iso');
			dispatchPartitionResult(partitionCtrl, [
				{
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 2,
					discs: [
						{ kind: 'files', files: [file('game.iso')], locked: true },
						{ kind: 'files', files: [resolvedDisc2], locked: false },
					],
				},
			]);
			expect(item.source).toEqual({
				kind: 'multi-disc',
				titleId: 'ABCD1234',
				discCount: 2,
				discs: [
					{ kind: 'files', files: [original], locked: true },
					{ kind: 'files', files: [resolvedDisc2], locked: false },
				],
			});
			expect(item.files).toEqual([original, resolvedDisc2]);
			expect(item.fileSizeEl.textContent).toBe(String(FIXTURE_FILE_SIZE * 2));
			expect(renderSourceParts).toHaveBeenCalledWith(item);
		});

		it('reports DISC_MISMATCH and leaves the source a single file when the merge check fails', () => {
			const original = file('game.iso');
			const item = stubItem({ source: { kind: 'files', files: [original] } });
			const newFile = file('unrelated.iso');
			const input = stubInput([newFile], 'x');
			actions.promoteToMultiDisc(item, input);
			const partitionCtrl = lastController();
			dispatchPartitionResult(partitionCtrl, [
				{
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 1,
					discs: [{ kind: 'files', files: [file('game.iso')], locked: true }],
				},
			]);
			expect(resolveSource).toHaveBeenCalledWith(item, {
				kind: 'error',
				message: TEXT.DISC_MISMATCH('unrelated.iso'),
			});
			expect(item.source.kind).toBe('files');
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('promotes a standalone GOD folder, preserving its dirName/entries/parentPath as locked disc 1', () => {
			/** @type {Extract<DroppedSource, { kind: 'dir' }>} */
			const source = {
				kind: 'dir',
				dirName: 'Disc1.data',
				entries: ['Data0000'],
				files: [file('Data0000', 'Set/Disc1.data/Data0000')],
				parentPath: 'Set',
			};
			const item = stubItem({ source });
			const disc2File = file('Data0000', 'Disc2.data/Data0000');
			const input = stubInput([disc2File], 'x');
			actions.promoteToMultiDisc(item, input);
			const partitionCtrl = lastController();
			/** @type {MultiDiscEntry} */
			const disc2 = {
				kind: 'dir',
				dirName: 'Disc2.data',
				entries: ['Disc2.data/Data0000'],
				files: [disc2File],
				locked: false,
			};
			dispatchPartitionResult(partitionCtrl, [
				{
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 2,
					discs: [{ ...source, locked: true }, disc2],
				},
			]);
			const resultDiscs = sourceOf(item).discs;
			expect(resultDiscs[0]).toEqual({
				kind: 'dir',
				dirName: 'Disc1.data',
				entries: ['Data0000'],
				files: source.files,
				parentPath: 'Set',
				locked: true,
			});
			expect(resultDiscs[1]).toEqual({ ...disc2, locked: false });
		});
	});
});
