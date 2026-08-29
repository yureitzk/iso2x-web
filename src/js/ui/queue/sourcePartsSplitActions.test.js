import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { EVENTS } from '../../core/protocol.js';
import { TEXT } from '../../constants/messages.js';
import { createSplitActionsController } from './sourcePartsSplitActions.js';
import {
	file,
	dispatchPartitionResult,
	stubItem,
	stubInput,
	sourceOf,
} from '../../../../test/utils/queueTestHelpers.js';
/**
 * @import { SingleDroppedSource, UnresolvedSource } from '../../../types/global'
 */

/**
 * Every SOURCE_INFO/SOURCE_ERROR/PARTITION_ITEM/PARTITION_RESULT/
 * VERIFY_RESULT this suite needs is dispatched by hand, so this
 * module's WorkerController round-trips never touch a real worker.
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

describe('sourcePartsSplitActions', () => {
	/** @type {ReturnType<typeof createSplitActionsController>} */
	let actions;
	/** @type {import('vitest').Mock} */
	let resolveSource;
	/** @type {import('vitest').Mock} */
	let beginReinspect;
	/** @type {import('vitest').Mock} */
	let renderSourceParts;

	beforeEach(() => {
		mockControllers.length = 0;
		resolveSource = vi.fn();
		beginReinspect = vi.fn();
		renderSourceParts = vi.fn();
		actions = createSplitActionsController({
			// Never actually invoked - WorkerController is mocked below, so
			// this stand-in only has to satisfy `() => SwBridge` at the
			// type level (SwBridge is a class, so it's nominal rather than
			// structural - see queueTestHelpers.js's DispatchableController
			// comment).
			getSwBridge: () =>
				/** @type {import('../../serviceWorker/SwBridge.js').SwBridge} */ (mock()),
			resolveSource,
			beginReinspect,
			renderSourceParts,
		});
	});

	describe('runInspect', () => {
		it('resolves with an info outcome and releases the worker on SOURCE_INFO', () => {
			const item = stubItem({});
			// Cast to stop `kind` widening from the literal 'files' to
			// plain `string` once assigned to an unannotated `const`.
			const source = /** @type {SingleDroppedSource} */ ({
				kind: 'files',
				files: [file('a.iso')],
			});
			const ctrl = actions.runInspect(item, source);
			expect(ctrl.inspect).toHaveBeenCalledWith(source);
			const payload = { titleId: 'ABCD1234', detectedTitle: 'Test Game' };
			ctrl.dispatchEvent(new CustomEvent(EVENTS.SOURCE_INFO, { detail: payload }));
			expect(resolveSource).toHaveBeenCalledWith(item, {
				kind: 'info',
				payload,
			});
			expect(ctrl.release).toHaveBeenCalled();
		});

		it('resolves with an error outcome and releases the worker on SOURCE_ERROR', () => {
			const item = stubItem({});
			const source = /** @type {SingleDroppedSource} */ ({
				kind: 'files',
				files: [file('a.iso')],
			});
			const ctrl = actions.runInspect(item, source);
			ctrl.dispatchEvent(
				new CustomEvent(EVENTS.SOURCE_ERROR, { detail: 'bad header' }),
			);
			expect(resolveSource).toHaveBeenCalledWith(item, {
				kind: 'error',
				message: 'bad header',
			});
			expect(ctrl.release).toHaveBeenCalled();
		});
	});

	describe('attachSibling', () => {
		it('is a no-op for a source that is neither files nor unresolved', () => {
			const item = stubItem({
				source: { kind: 'dir', dirName: 'x', entries: [], files: [] },
			});
			const input = stubInput([file('b.iso')]);
			actions.attachSibling(item, input);
			expect(mockControllers).toHaveLength(0);
		});

		it('is a no-op when the input has no files', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso')] },
			});
			const input = stubInput([]);
			actions.attachSibling(item, input);
			expect(mockControllers).toHaveLength(0);
		});

		it('re-resolves with the combined files and re-inspects on success', () => {
			const original = file('game.iso');
			const item = stubItem({
				source: { kind: 'files', files: [original] },
				lockedFiles: new Set([original]),
			});
			const newFile = file('sibling.iso');
			const input = stubInput([newFile], 'x');
			actions.attachSibling(item, input);
			expect(input.value).toBe('');
			const partitionCtrl = lastController();
			expect(partitionCtrl.partitionDir).toHaveBeenCalledWith(
				'',
				['game.iso', 'sibling.iso'],
				[original, newFile],
			);
			const resolvedA = file('game.iso');
			const resolvedB = file('sibling.iso');
			dispatchPartitionResult(partitionCtrl, [
				{ kind: 'files', files: [resolvedA, resolvedB] },
			]);
			expect(item.source).toEqual({
				kind: 'files',
				files: [resolvedA, resolvedB],
			});
			expect(item.files).toEqual([resolvedA, resolvedB]);
			// relockFiles() matches by name+size against the previous locked
			// set, so the original stays locked and the new sibling doesn't.
			expect(item.lockedFiles.has(resolvedA)).toBe(true);
			expect(item.lockedFiles.has(resolvedB)).toBe(false);
			expect(beginReinspect).toHaveBeenCalledWith(item);
			// A second WorkerController is spun up for the re-inspect.
			expect(mockControllers).toHaveLength(2);
			expect(mockControllers[1].inspect).toHaveBeenCalledWith(item.source);
		});

		it('routes an invalid combination to resolveSource as an error', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('game.iso')] },
			});
			const input = stubInput([file('sibling.iso')], 'x');
			actions.attachSibling(item, input);
			const partitionCtrl = lastController();
			dispatchPartitionResult(partitionCtrl, [
				{
					kind: 'files',
					files: [file('game.iso'), file('sibling.iso')],
					invalidReason: "these two don't form a valid split",
				},
			]);
			expect(resolveSource).toHaveBeenCalledWith(item, {
				kind: 'error',
				message: "these two don't form a valid split",
			});
			expect(beginReinspect).not.toHaveBeenCalled();
		});

		it('routes a still-unresolved result to resolveSource as unresolved', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('game.iso')] },
			});
			const input = stubInput([file('sibling.iso')], 'x');
			actions.attachSibling(item, input);
			const partitionCtrl = lastController();
			// Same widening-prevention cast as the SingleDroppedSource
			// casts in the runInspect tests above.
			const unresolved = /** @type {UnresolvedSource} */ ({
				kind: 'unresolved',
				files: [file('game.iso'), file('sibling.iso')],
				reason: 'no ordering verified',
			});
			dispatchPartitionResult(partitionCtrl, [unresolved]);
			expect(resolveSource).toHaveBeenCalledWith(item, {
				kind: 'unresolved',
				source: unresolved,
			});
		});

		it('is a no-op when the resolved result is a multi-disc source', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('game.iso')] },
			});
			const input = stubInput([file('sibling.iso')], 'x');
			actions.attachSibling(item, input);
			const partitionCtrl = lastController();
			dispatchPartitionResult(partitionCtrl, [
				{
					kind: 'multi-disc',
					titleId: 'ABCD1234',
					discCount: 2,
					discs: [],
				},
			]);
			expect(resolveSource).not.toHaveBeenCalled();
			expect(beginReinspect).not.toHaveBeenCalled();
			expect(item.source.kind).toBe('files');
		});
	});

	describe('detachSiblingFile', () => {
		it('is a no-op for a non-files source', () => {
			const item = stubItem({
				source: { kind: 'unresolved', files: [file('a.iso')], reason: 'x' },
			});
			actions.detachSiblingFile(item, 0);
			expect(mockControllers).toHaveLength(0);
		});

		it('is a no-op for an out-of-range index', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso')] },
			});
			actions.detachSiblingFile(item, 5);
			expect(mockControllers).toHaveLength(0);
		});

		it('is a no-op for a locked (originally-inserted) file', () => {
			const locked = file('a.iso');
			const item = stubItem({
				source: { kind: 'files', files: [locked, file('b.iso')] },
				lockedFiles: new Set([locked]),
			});
			actions.detachSiblingFile(item, 0);
			expect(mockControllers).toHaveLength(0);
		});

		it('re-resolves without the detached file for an unlocked one', () => {
			const locked = file('a.iso');
			const sibling = file('b.iso');
			const item = stubItem({
				source: { kind: 'files', files: [locked, sibling] },
				lockedFiles: new Set([locked]),
			});
			actions.detachSiblingFile(item, 1);
			const partitionCtrl = lastController();
			expect(partitionCtrl.partitionDir).toHaveBeenCalledWith(
				'',
				['a.iso'],
				[locked],
			);
		});
	});

	describe('moveUnresolvedFile', () => {
		it('is a no-op for a non-unresolved source', () => {
			const item = stubItem({
				status: 'unresolved',
				source: { kind: 'files', files: [file('a.iso'), file('b.iso')] },
			});
			actions.moveUnresolvedFile(item, 0, 1);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('is a no-op when status is not unresolved', () => {
			const item = stubItem({
				status: 'idle',
				source: {
					kind: 'unresolved',
					files: [file('a.iso'), file('b.iso')],
					reason: 'x',
				},
			});
			actions.moveUnresolvedFile(item, 0, 1);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});

		it('swaps two adjacent files and re-renders', () => {
			const item = stubItem({
				status: 'unresolved',
				source: {
					kind: 'unresolved',
					files: [file('a.iso'), file('b.iso')],
					reason: 'x',
				},
			});
			actions.moveUnresolvedFile(item, 0, 1);
			expect(sourceOf(item).files.map((/** @type {File} */ f) => f.name)).toEqual([
				'b.iso',
				'a.iso',
			]);
			expect(renderSourceParts).toHaveBeenCalledWith(item);
		});

		it('does nothing (and does not render) when the swap goes out of bounds', () => {
			const item = stubItem({
				status: 'unresolved',
				source: {
					kind: 'unresolved',
					files: [file('a.iso'), file('b.iso')],
					reason: 'x',
				},
			});
			actions.moveUnresolvedFile(item, 0, -1);
			expect(renderSourceParts).not.toHaveBeenCalled();
		});
	});

	describe('removeUnresolvedFile', () => {
		it('is a no-op for a non-unresolved source', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso')] },
			});
			actions.removeUnresolvedFile(item, 0);
			expect(mockControllers).toHaveLength(0);
			expect(resolveSource).not.toHaveBeenCalled();
		});

		it('reports NO_FILES_REMAINING instead of re-resolving when it would empty the set', () => {
			const item = stubItem({
				source: { kind: 'unresolved', files: [file('a.iso')], reason: 'x' },
			});
			actions.removeUnresolvedFile(item, 0);
			expect(mockControllers).toHaveLength(0);
			expect(resolveSource).toHaveBeenCalledWith(item, {
				kind: 'error',
				message: TEXT.NO_FILES_REMAINING,
			});
		});

		it('re-resolves the remaining files when at least one is left', () => {
			const remaining = file('b.iso');
			const item = stubItem({
				source: {
					kind: 'unresolved',
					files: [file('a.iso'), remaining],
					reason: 'x',
				},
			});
			actions.removeUnresolvedFile(item, 0);
			const partitionCtrl = lastController();
			expect(partitionCtrl.partitionDir).toHaveBeenCalledWith(
				'',
				['b.iso'],
				[remaining],
			);
		});
	});

	describe('verifyOrder', () => {
		it('is a no-op for a non-unresolved source', () => {
			const item = stubItem({
				source: { kind: 'files', files: [file('a.iso')] },
			});
			actions.verifyOrder(item);
			expect(mockControllers).toHaveLength(0);
		});

		it('is a no-op for a duplicateDiscClaim (no ordering to verify)', () => {
			const item = stubItem({
				source: {
					kind: 'unresolved',
					files: [file('a.iso')],
					reason: 'x',
					unresolvedKind: 'duplicateDiscClaim',
				},
			});
			actions.verifyOrder(item);
			expect(mockControllers).toHaveLength(0);
		});

		it('promotes to a resolved files source and re-inspects on a successful verify', () => {
			const item = stubItem({
				source: {
					kind: 'unresolved',
					files: [file('a.iso'), file('b.iso')],
					reason: 'x',
				},
			});
			actions.verifyOrder(item);
			const verifyCtrl = lastController();
			expect(verifyCtrl.verifyOrder).toHaveBeenCalledWith(
				['a.iso', 'b.iso'],
				sourceOf(item).files,
			);
			verifyCtrl.dispatchEvent(
				new CustomEvent(EVENTS.VERIFY_RESULT, {
					detail: { ok: true, checkedEntries: [] },
				}),
			);
			expect(verifyCtrl.release).toHaveBeenCalled();
			expect(item.source.kind).toBe('files');
			expect(beginReinspect).toHaveBeenCalledWith(item);
			expect(mockControllers).toHaveLength(2);
			expect(mockControllers[1].inspect).toHaveBeenCalledWith(item.source);
		});

		it('records the failed check and re-renders on a failed verify', () => {
			const item = stubItem({
				source: {
					kind: 'unresolved',
					files: [file('a.iso'), file('b.iso')],
					reason: 'x',
				},
			});
			actions.verifyOrder(item);
			const verifyCtrl = lastController();
			const checkedEntries = [{ path: 'a.iso', matched: true }];
			verifyCtrl.dispatchEvent(
				new CustomEvent(EVENTS.VERIFY_RESULT, {
					detail: { ok: false, checkedEntries, reason: 'header mismatch' },
				}),
			);
			expect(item.source.kind).toBe('unresolved');
			expect(sourceOf(item).lastVerifyResult).toEqual({
				ok: false,
				checkedEntries,
				reason: 'header mismatch',
			});
			expect(resolveSource).toHaveBeenCalledWith(item, {
				kind: 'unresolved',
				source: item.source,
			});
			expect(renderSourceParts).toHaveBeenCalledWith(item);
			expect(beginReinspect).not.toHaveBeenCalled();
		});

		it('ignores a VERIFY_RESULT that arrives after the entry was removed/re-resolved', () => {
			const item = stubItem({
				source: {
					kind: 'unresolved',
					files: [file('a.iso'), file('b.iso')],
					reason: 'x',
				},
			});
			actions.verifyOrder(item);
			const verifyCtrl = lastController();
			// Simulate the entry having already resolved to a plain files
			// source (e.g. via attachSibling()) before this VERIFY_RESULT
			// arrives.
			item.source = { kind: 'files', files: [file('a.iso'), file('b.iso')] };
			verifyCtrl.dispatchEvent(
				new CustomEvent(EVENTS.VERIFY_RESULT, {
					detail: { ok: true, checkedEntries: [] },
				}),
			);
			expect(verifyCtrl.release).toHaveBeenCalled();
			expect(resolveSource).not.toHaveBeenCalled();
			expect(beginReinspect).not.toHaveBeenCalled();
		});
	});
});
