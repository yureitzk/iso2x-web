import { test as base } from '@playwright/test';
import { QueuePage } from '../pages/queue-page.js';

/**
 * @typedef {object} Fixtures
 * @property {QueuePage} queuePage
 */

/**
 * @type {import('@playwright/test').TestType<
 *   import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions & Fixtures,
 *   import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions
 * >}
 */
export const test = base.extend({
	queuePage: async ({ page }, use) => {
		await use(new QueuePage(page));
	},
});

export { expect } from '@playwright/test';
