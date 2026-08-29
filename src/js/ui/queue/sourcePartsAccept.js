/**
 * @import { QueueEntry, OutputFormat, SourceFormat } from '../../../types/global'
 */

/**
 * Per-format file-picker `accept` hint. Only 'xiso'/'cci'/'ciso' have
 * one: 'god'/'extracted' use the folder picker instead, 'zar' has no
 * multi-part concept at all (a .zar source can't be split or given a
 * sibling disc), and 'stfs' has no fixed extension of its own, so both
 * are intentionally absent.
 * @type {Partial<Record<SourceFormat, string>>}
 */
const SOURCE_FORMAT_ACCEPT = {
	xiso: '.iso',
	cci: '.cci',
	ciso: '.cso,.ciso',
};

/**
 * Source formats the batch scanner can group into a multi-disc set:
 * raw-XISO images and GOD folders. Every other format (ciso/cci/zar/
 * stfs, a structured 'extracted' folder) is always routed to
 * `Unresolved` instead, so offering "add another disc" for them can
 * never succeed.
 * @type {ReadonlySet<SourceFormat>}
 */
const MULTI_DISC_CAPABLE_FORMATS = new Set(
	/** @type {OutputFormat[]} */ (['xiso', 'god']),
);

const ZAR_FILENAME = /\.zar$/i;

/**
 * Source formats with no "other half" concept - each is a single
 * self-contained file, so there's never a missing sibling to reattach.
 * @type {ReadonlySet<SourceFormat>}
 */
const NO_SIBLING_FORMATS = new Set(
	/** @type {SourceFormat[]} */ (['zar', 'stfs']),
);

/**
 * Fallback accept for a split-sibling reattach when the format can't
 * be narrowed to one extension - either it has no fixed naming
 * convention (a raw XISO fragment), or `item.sourceFormat` isn't
 * known yet. Not left blank: every real source fragment carries one
 * of these, and the real content round-trip still validates whatever
 * gets picked regardless of what the picker pre-filtered.
 */
const KNOWN_SOURCE_EXTENSIONS_ACCEPT = '.iso,.cso,.cci,.zar';

/**
 * Accept hint for reattaching a missing/broken split sibling.
 * `item.sourceFormat` is unset for two cases: a pair that never
 * resolved at all (skips inspection entirely), or a single file that
 * inspected but failed content validation. Both fall back to a
 * cci/cso/ciso filename sniff, then to the generic extension list.
 * @param {QueueEntry} item
 * @returns {string}
 */
export function splitSiblingAccept(item) {
	if (item.sourceFormat) {
		return (
			SOURCE_FORMAT_ACCEPT[item.sourceFormat] ?? KNOWN_SOURCE_EXTENSIONS_ACCEPT
		);
	}
	const { source } = item;
	const files =
		source.kind === 'files' || source.kind === 'unresolved' ? source.files : [];
	const match = /\.(cci|cso|ciso)$/i.exec(files[0]?.name ?? '');
	if (!match) return KNOWN_SOURCE_EXTENSIONS_ACCEPT;
	return match[1].toLowerCase() === 'cci'
		? (SOURCE_FORMAT_ACCEPT.cci ?? KNOWN_SOURCE_EXTENSIONS_ACCEPT)
		: (SOURCE_FORMAT_ACCEPT.ciso ?? KNOWN_SOURCE_EXTENSIONS_ACCEPT);
}

/**
 * Narrows the "add another disc" picker to the existing disc(s)' own
 * format - a real multi-disc release's discs share one raw container
 * shape, so offering every format the app understands just invites a
 * wrong pick that fails the title-match check downstream. This is UX
 * narrowing only; that title-match check still runs regardless.
 * @param {QueueEntry} item
 * @returns {string}
 */
export function discAdditionAccept(item) {
	if (!item.sourceFormat || !MULTI_DISC_CAPABLE_FORMATS.has(item.sourceFormat)) {
		return KNOWN_SOURCE_EXTENSIONS_ACCEPT;
	}
	return (
		SOURCE_FORMAT_ACCEPT[item.sourceFormat] ?? KNOWN_SOURCE_EXTENSIONS_ACCEPT
	);
}

/**
 * Whether `item` can become disc 1 of a brand-new multi-disc set.
 * Requires a single-file/single-dir idle-or-cancelled source in a
 * format the batch scanner can actually group (see
 * MULTI_DISC_CAPABLE_FORMATS) - status idle/cancelled always follows
 * a successful inspection, so `sourceFormat` is guaranteed set here.
 * @param {QueueEntry} item
 */
export function isPromotableSource(item) {
	const { source } = item;
	if (source.kind !== 'files' && source.kind !== 'dir') return false;
	if (source.kind === 'files' && source.files.length !== 1) return false;
	if (item.status !== 'idle' && item.status !== 'cancelled') return false;
	return (
		!!item.sourceFormat && MULTI_DISC_CAPABLE_FORMATS.has(item.sourceFormat)
	);
}

/**
 * Whether `item`'s format has any multi-part concept at all - i.e.
 * whether a broken/missing-sibling reattach could ever fix it. Zar and
 * stfs sources have no "other half" (see NO_SIBLING_FORMATS); falls
 * back to sniffing the filename for zar when `sourceFormat` isn't
 * known yet, same as splitSiblingAccept().
 * @param {QueueEntry} item
 */
export function isSplitCapableSource(item) {
	if (item.sourceFormat) return !NO_SIBLING_FORMATS.has(item.sourceFormat);
	const { source } = item;
	const files =
		source.kind === 'files' || source.kind === 'unresolved' ? source.files : [];
	return !ZAR_FILENAME.test(files[0]?.name ?? '');
}
