export const TEXT = {
	/** @param {number=} pct */
	CONVERTING: (pct) =>
		pct != null ? `[converting ${pct}%]` : '[converting...]',
	DONE: '[done]',
	ERROR: '[error]',
	CANCELLED: '[cancelled]',
	WAITING: '[waiting]',
	UNRESOLVED: '[unresolved]',
	CLEAR: 'Clear',
	TITLE_PLACEHOLDER: 'Title override (optional)',
	RESUME: 'Resume',
	PAUSE: 'Pause',
	/** @param {number=} pct */
	PAUSED: (pct) => (pct != null ? `[paused ${pct}%]` : '[paused]'),
	/**
	 * @param {number} discIndex - 1-based
	 * @param {number} discCount
	 * @param {number=} pct
	 */
	DISC_CONVERTING: (discIndex, discCount, pct) =>
		pct != null
			? `[converting disc ${discIndex}/${discCount} ${pct}%]`
			: `[converting disc ${discIndex}/${discCount}]`,
	/**
	 * @param {number} discIndex - 1-based
	 * @param {number} discCount
	 * @param {number=} pct
	 */
	DISC_PAUSED: (discIndex, discCount, pct) =>
		pct != null
			? `[paused disc ${discIndex}/${discCount} ${pct}%]`
			: `[paused disc ${discIndex}/${discCount}]`,
	/** @param {number} discIndex - 1-based */
	DISC_ERROR: (discIndex) => `[error (disc ${discIndex})]`,
	/** @param {number} discIndex - 1-based */
	DISC_CANCELLED: (discIndex) => `[cancelled (disc ${discIndex})]`,
	ADD_DISC_FOLDER: 'Add disc (folder)',
	ADD_DISC_FILE: 'Add disc (file)',
	ADD_FILE: 'Add file',
	NOTIFICATION_DENIED:
		'Notification permission was denied.\n\nTo enable notifications you will need to allow them in your browser site settings and then reload the page.',
	COPY: 'Copy',
	COPY_LABEL: 'Copy log',
	COPY_SUCCESS: 'Copied',
	COPY_SUCCESS_LABEL: 'Copied',
	COPY_FAIL: 'Failed',
	COPY_FAIL_LABEL: 'Copy failed',
	CLEAR_LABEL: 'Clear log',
	INSPECTING: '[inspecting]',
	QUEUED: '[queued]',
	/** @param {string} title */
	NOTIFY_SUCCESS: (title) => `"${title}" converted successfully.`,
	/** @param {string} title */
	NOTIFY_ERROR: (title) => `"${title}" failed to convert.`,
	/** @param {string} title */
	NOTIFY_CANCELLED: (title) => `"${title}" was cancelled.`,

	/** @param {number} n */
	SELECTED_COUNT: (n) => `(${n} selected)`,
	BATCH_PAUSE: 'Pause All',
	BATCH_RESUME: 'Resume All',
	BATCH_PAUSE_RESUME: 'Pause / Resume',
	/** @param {number} pct */
	PROGRESS_PERCENT: (pct) => `(${pct}%)`,

	/** @param {number} bytes */
	PART_SIZE: (bytes) => `${bytes} bytes`,
	PART_NO_MATCH: '[no match]',

	/** @param {string=} name */
	DISC_MISMATCH: (name) =>
		`"${name ?? 'the new disc'}" doesn't look like another disc of this title.`,
	NO_FILES_REMAINING: 'No files left after removing the last one.',

	/**
	 * @param {string} baseTitle
	 * @param {number} discNumber - 1-based
	 */
	DISC_LOG_TITLE: (baseTitle, discNumber) => `${baseTitle} (Disc ${discNumber})`,
	/** @param {number} length */
	DEVICE_ID_INVALID_LENGTH: (length) =>
		`Device ID must be exactly 40 hex characters, got ${length}`,
	DEVICE_ID_INVALID_CHARS:
		'Device ID must contain only hex characters (0-9, a-f)',
};
