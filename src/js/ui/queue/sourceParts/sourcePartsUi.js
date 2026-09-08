import { createDiscActionsController } from './sourcePartsDiscActions.js';
import { createSplitActionsController } from './sourcePartsSplitActions.js';
import { createSourcePartsRenderer } from './sourcePartsRender.js';

/**
 * @import { QueueEntry, DroppedSource, SourcePartsCoreDeps } from '../../../../types/global'
 */

/**
 * @typedef {SourcePartsCoreDeps & {
 *   beginReinspect: (item: QueueEntry) => void,
 *   displayFileName: (source: DroppedSource) => string,
 * }} SourcePartsDeps
 */

/**
 * Builds every disc/split-parts management function for the queue,
 * composing sourcePartsDiscActions.js, sourcePartsSplitActions.js,
 * and sourcePartsRender.js. Bound to the host module's dependencies
 * via `deps` rather than importing them directly - importing back
 * into queueUi.js would create a cycle, since queueUi.js needs
 * renderSourceParts()/runInspect(), the two functions this exports.
 *
 * The action controllers and the renderer need each other (an action
 * re-renders after mutating; the renderer wires actions to row
 * buttons), so `renderSourceParts` is threaded through as a late-bound
 * callback rather than a direct import in either direction.
 * @param {SourcePartsDeps} deps
 */
export function createSourcePartsController({
	getSwBridge,
	resolveSource,
	beginReinspect,
	displayFileName,
}) {
	/** @type {{ renderSourceParts: (item: QueueEntry) => void }} */
	let renderer;

	const discActions = createDiscActionsController({
		getSwBridge,
		resolveSource,
		renderSourceParts: (item) => renderer.renderSourceParts(item),
	});

	const splitActions = createSplitActionsController({
		getSwBridge,
		resolveSource,
		beginReinspect,
		renderSourceParts: (item) => renderer.renderSourceParts(item),
	});

	renderer = createSourcePartsRenderer({
		actions: { ...discActions, ...splitActions },
		displayFileName,
	});

	return {
		renderSourceParts: renderer.renderSourceParts,
		runInspect: splitActions.runInspect,
	};
}
