import { test, expect } from './support/test.js';

test('app is served with Cross-Origin-Embedder-Policy for iframe embedding', async ({
	page,
}) => {
	const response = await page.goto('/');
	expect(response?.headers()['cross-origin-embedder-policy']).toBe(
		'require-corp',
	);
});

test('service worker registers successfully', async ({ page }) => {
	await page.goto('/');
	const swRegistered = await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.ready;
		return !!reg.active;
	});
	expect(swRegistered).toBe(true);
});

test('theme is applied before first paint', async ({ page }) => {
	await page.goto('/');
	const theme = await page.evaluate(() =>
		document.documentElement.getAttribute('data-theme'),
	);
	expect(['light', 'dark']).toContain(theme);
});
