export {};

declare global {
	interface Window {
		/** Set by installWorkerHarness({ trackLive: true }) - tracks live Worker instances for cancellation/lifecycle tests. */
		__liveWorkers: Set<Worker>;

		/** Incremented by installWorkerHarness({ trackLive: true }) on every Worker#postMessage call - proves a real worker received a message. */
		__workerPostCount?: number;

		/** Set by QueuePage.idsAddedBy(). */
		__queueItemsAdded?: Promise<string[]>;
	}
}
