/// <reference types="vite/client" />

import { EVENTS, MSG } from '../js/core/protocol.js';
import type { ContentType, TitleVersion, InvalidKind } from 'iso2x';

export type { InvalidKind };

export type Theme = 'light' | 'dark' | 'system';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = {
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
};

export type MsgType = typeof MSG;
export type EventType = typeof EVENTS;

export type OutputFormat =
	| 'god'
	| 'xiso'
	| 'extracted'
	| 'ciso'
	| 'cci'
	| 'zar';

/**
 * Every format iso2x can detect as an input source, including `'stfs'`
 * (an Xbox 360 "CON "/"LIVE"/"PIRS" package). Read-only: there's no
 * `<option value="stfs">` in the format `<select>`, so this can appear
 * as `item.sourceFormat` but never as a `ConversionOptions` key.
 */
export type SourceFormat = OutputFormat | 'stfs';
export type ModeTargetFormat = 'god' | 'xiso' | 'ciso' | 'cci';
export type XisoMode = 'trim' | 'zero' | 'full';
export type ScrubMode = 'none' | 'partial' | 'full';
export type ConversionStatus =
	| 'inspecting'
	| 'idle'
	| 'running'
	| 'paused'
	| 'done'
	| 'error'
	| 'cancelled'
	| 'unresolved';

export type SingleDroppedSource =
	| {
			kind: 'files';
			files: File[];
			invalidReason?: string;
			invalidKind?: InvalidKind;
	  }
	| {
			kind: 'dir';
			files: File[];
			dirName: string;
			entries: string[];
			parentPath?: string;
	  };

export type MultiDiscEntry = SingleDroppedSource & { locked: boolean };

export type MultiDiscSource = {
	kind: 'multi-disc';
	titleId: string;
	discCount: number;
	discs: MultiDiscEntry[];
};

export type CheckedEntry = { path: string; matched: boolean };

export type UnresolvedSource = {
	kind: 'unresolved';
	files: File[];
	reason: string;
	/**
	 * Why this entry is unresolved:
	 * - `duplicateDiscClaim`: two complete, distinct images both claim
	 *   the same disc number. Not a fragment set - "Verify order" is
	 *   hidden for it, since reordering can't turn two complete images
	 *   into a split.
	 * - `ambiguousHeaders`: two or more files each independently look
	 *   like a valid part-1 header, with nothing to disambiguate them.
	 *   "Verify order" is the only recovery path here - the person
	 *   promotes the real header to position 0 and re-verifies.
	 * Omitted for the plain reorder-and-verify case.
	 */
	unresolvedKind?: 'duplicateDiscClaim' | 'ambiguousHeaders';
	/**
	 * Set only for a `duplicateDiscClaim` whose `files` are every
	 * `Data####` chunk of one dir-format (e.g. GOD) folder that
	 * collided with another claimant - i.e. `files` isn't a flat pile
	 * of independent parts, it's one folder's insides. Lets the UI
	 * render a single "<dirName>/" row for it, the same way a resolved
	 * `dir` source already does, instead of one row per chunk file.
	 * Unset for a flat single-file (or genuine multi-file split)
	 * collision, where `files` really is the thing to list.
	 */
	dirName?: string;
	lastVerifyResult?: {
		ok: boolean;
		checkedEntries: CheckedEntry[];
		reason?: string;
	};
};

export type DroppedSource =
	| SingleDroppedSource
	| MultiDiscSource
	| UnresolvedSource;

export type FeatureCheckResult = { status: string; text: string };
export type FeatureAction = {
	label: string | ((status: string) => string);
	onClick: () => void | Promise<void>;
};

export interface GodOptions {
	mode: ScrubMode;
	sign: boolean;
	deviceId?: string;
}
export interface XisoOptions {
	mode: XisoMode;
	split: boolean;
}
export interface ExtractedOptions {
	skipSystemUpdate: boolean;
	allowedMediaPatch: boolean;
	renameTitle: boolean;
}
export interface CisoOptions {
	mode: ScrubMode;
}
export interface CciOptions {
	mode: ScrubMode;
}
export type ZarOptions = Record<string, never>;

export type FormatOptions =
	| GodOptions
	| XisoOptions
	| ExtractedOptions
	| CisoOptions
	| CciOptions
	| ZarOptions;

export interface ConversionOptions {
	format: OutputFormat;
	generateAttachXbe: boolean;
	god: GodOptions;
	xiso: XisoOptions;
	extracted: ExtractedOptions;
	ciso: CisoOptions;
	cci: CciOptions;
	zar: ZarOptions;
}

export type Source = {
	gameTitle: string;
	files: File[];
	format: OutputFormat;
	options: FormatOptions;
	generateAttachXbe?: boolean;
};
export interface SourceConverter extends Source {
	id: string;
}

export interface PendingConvert {
	source: SingleDroppedSource;
	gameTitle: string;
	format: OutputFormat;
	options: FormatOptions;
	generateAttachXbe?: boolean;
	godSigningKey?: Uint8Array;
}
export type NormalizedConvert = PendingConvert;

export type SourceInfoPayload = {
	titleId: string;
	contentType: ContentType;
	version: TitleVersion;
	detectedTitle: string | undefined;
	fileSize: number;
	sourceFormat: SourceFormat;
	icon?: Uint8Array;
};

export interface InspectMessage {
	type: MsgType['INSPECT'];
	source: SingleDroppedSource;
}
export interface ConvertMessage {
	type: MsgType['CONVERT'];
	source: SingleDroppedSource;
	gameTitle: string;
	format: OutputFormat;
	options: FormatOptions;
	generateAttachXbe?: boolean;
	godSigningKey?: Uint8Array;
	id: string;
}
export interface PauseMessage {
	type: MsgType['PAUSE'];
}
export interface CancelMessage {
	type: MsgType['CANCEL'];
}
export interface ResumeMessage {
	type: MsgType['RESUME'];
}
export interface PartitionDirMessage {
	type: MsgType['PARTITION_DIR'];
	dirName: string;
	entries: string[];
	files: File[];
}
export interface VerifyOrderMessage {
	type: MsgType['VERIFY_ORDER'];
	/** Candidate ordering to verify, header part first. */
	names: string[];
	files: File[];
}
export type ControllerMessage =
	| PauseMessage
	| CancelMessage
	| ResumeMessage
	| InspectMessage
	| ConvertMessage
	| PartitionDirMessage
	| VerifyOrderMessage;

export type WorkerMessage =
	| { type: MsgType['READY'] }
	| { type: MsgType['PAUSED'] }
	| { type: MsgType['PROGRESS']; payload: number }
	| {
			type: MsgType['SOURCE_INFO'];
			payload: SourceInfoPayload;
			bytesRead: number;
	  }
	| { type: MsgType['SOURCE_ERROR']; payload: string; bytesRead: number }
	| { type: MsgType['LOG']; payload: string }
	| { type: MsgType['DONE'] }
	| { type: MsgType['PARTITION_ITEM']; payload: DroppedSource }
	| {
			type: MsgType['PARTITION_RESULT'];
			payload: { count: number };
			bytesRead: number;
	  }
	| {
			type: MsgType['VERIFY_RESULT'];
			payload: { ok: boolean; checkedEntries: CheckedEntry[]; reason?: string };
			bytesRead: number;
	  }
	| { type: MsgType['ERROR']; payload: string }
	| {
			type: MsgType['STREAM_INFO'];
			payload: { filename?: string; totalSize: bigint };
	  }
	| { type: MsgType['STREAM_READY']; id: string; highWaterMark: number }
	| {
			type: MsgType['STREAM_CHUNK'];
			payload: { id: string; chunk: ArrayBuffer };
	  }
	| { type: MsgType['STREAM_CLOSE']; payload: { id: string } };

export type SwMessage =
	| {
			type: MsgType['STREAM_REGISTER'];
			id: string;
			filename: string;
			totalSize: bigint | null;
	  }
	| { type: MsgType['HEARTBEAT']; streamIds: string[] }
	| { type: MsgType['STREAM_CHUNK']; id: string; chunk: ArrayBuffer }
	| { type: MsgType['STREAM_ABORT']; id: string }
	| { type: MsgType['STREAM_CLOSE']; id: string };

export type FeatureCheck = () => Promise<FeatureCheckResult>;
export type Feature = {
	label: string;
	check: FeatureCheck;
	action?: FeatureAction;
};

export type EphemeralSettings = {
	godSigningKey?: Uint8Array;
	godSigningKeyName?: string;
};

export type SiteSettings = {
	showNotifications: boolean;
	notifyIgnoreFocus: boolean;
	theme: Theme;
	keepScreenAwake: boolean;
	multiFileDownloadsPrimed: boolean;
	headerAnimation: boolean;
	faviconEnabled: boolean;
	faviconPulseAnimation: boolean;
	badgeEnabled: boolean;
	defaultConversionOptions: ConversionOptions;
	maxConcurrentConversions: number | null;
	maxConcurrentDownloadStreams: number;
};

export type DiscConversionStatus =
	| 'queued'
	| 'converting'
	| 'done'
	| 'error'
	| 'cancelled';

/** Per-disc status plus the currently-converting disc's own progress, for a multi-disc QueueEntry. */
export interface DiscRunProgress {
	statuses: DiscConversionStatus[];
	current?: number;
}

export interface QueueEntry {
	id: string;
	files: File[];
	source: DroppedSource;
	/**
	 * The File objects this entry had at creation time, compared by
	 * identity. Anything in `source.files` not in this set was attached
	 * later via attachSibling() and can be removed individually.
	 */
	lockedFiles: Set<File>;
	sourceIsOgx: boolean | undefined;
	generateAttachXbe: boolean;
	status: ConversionStatus;
	titleEl: HTMLInputElement;
	metaEl: HTMLElement;
	optionsEl: HTMLElement;
	titleIdEl: HTMLElement;
	titleHeaderEl: HTMLElement;
	contentTypeEl: HTMLElement;
	pausing: boolean;
	fileSizeEl: HTMLElement;
	errorEl: HTMLElement;
	statusEl: HTMLElement;
	convertBtn: HTMLButtonElement;
	pauseBtn: HTMLButtonElement;
	removeBtn: HTMLButtonElement;
	cancelBtn: HTMLButtonElement;
	clearBtn: HTMLButtonElement;
	copyBtn: HTMLButtonElement;
	logEl: HTMLPreElement;
	iconFallbackEl: SVGElement;
	iconEl: HTMLImageElement;
	iconSpinnerEl: SVGElement;
	iconObjectUrl?: string;
	partsEl: HTMLElement;
	partsCountEl: HTMLElement;
	partsListEl: HTMLElement;
	verifyOrderBtn: HTMLButtonElement;
	scrollBottomBtn: HTMLButtonElement;
	section: HTMLElement;
	options: ConversionOptions;
	ctrl: WorkerController | null;
	formatSelectEl: HTMLSelectElement;
	moveUpBtn: HTMLButtonElement;
	moveDownBtn: HTMLButtonElement;
	progress?: number;
	awaitingSlot?: boolean;
	sourceFormat?: SourceFormat;
	/**
	 * Title parsed off the source by the worker, kept separate from
	 * titleEl.value (which falls back to a stripped filename).
	 */
	detectedTitle?: string;
	discRun?: DiscRunProgress;
	modeSelects: Record<ModeTargetFormat, HTMLSelectElement>;
	allowedMediaPatchCheckBoxEl: HTMLInputElement;
	renameTitleCheckBoxEl: HTMLInputElement;
	attachXbeCheckBoxEl: HTMLInputElement;
	godKeyvaultInputEl: HTMLInputElement;
	godSignCheckBoxEl: HTMLInputElement;
	godDeviceIdInputEl: HTMLInputElement;
	godDeviceIdErrorEl: HTMLElement;
	godDeviceIdClearBtn: HTMLButtonElement;
	godSigningKey?: Uint8Array;
	selectCheckboxEl: HTMLInputElement;
}

/** Single-file compressed/archive fixture bytes used for testing. */
export interface CompressedFixtures {
	cso: Buffer;
	cci: Buffer;
	zar: Buffer;
}

export interface StatusPermissions {
	convertible: boolean;
	removable: boolean;
	pausable?: boolean;
	cancellable?: boolean;
}

export interface ModeConstraint {
	allowed: (ScrubMode | XisoMode)[];
}

/** Concurrency-limited slot queue returned by createSlotQueue() in queue.js. */
export interface SlotQueue {
	acquire: (entry: QueueEntry) => Promise<void>;
	dequeue: (entry: QueueEntry) => void;
	release: () => void;
	/**
	 * Changes the concurrency cap in place. An increase immediately
	 * drains any queued waiters up to the new cap; a decrease never
	 * disturbs slots already granted - the next grant simply waits
	 * until the running count drops under the new cap on its own.
	 */
	setMaxConcurrent: (n: number) => void;
	readonly runningCount: number;
	readonly pendingCount: number;
}

export interface QueueCommand {
	canRun: (item: QueueEntry) => boolean;
	run: (item: QueueEntry) => void;
}

export type SourceOutcome =
	| { kind: 'info'; payload: SourceInfoPayload }
	| { kind: 'error'; message: string }
	| { kind: 'unresolved'; source: UnresolvedSource };

export interface PendingPartition {
	dirName: string;
	entries: string[];
	files: File[];
}

export interface PendingVerify {
	names: string[];
	files: File[];
}
