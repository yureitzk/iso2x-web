import { defineConfig, devices } from '@playwright/test';
import { PORT, BASE_PATH } from './env.config.js';

export default defineConfig({
	testDir: './test/e2e',
	fullyParallel: true,
	globalSetup: './test/e2e/global-setup.js',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? 'blob' : 'html',
	use: {
		baseURL: `http://localhost:${PORT}${BASE_PATH}`,
		trace: 'on-first-retry',
	},
	webServer: {
		command: process.env.CI ? 'npm run build && npm run preview' : 'npm run dev',
		url: `http://localhost:${PORT}${BASE_PATH}`,
		reuseExistingServer: !process.env.CI,
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
	],
});
