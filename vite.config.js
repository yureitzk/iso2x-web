import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons';
import path from 'path';
import * as pkg from './package.json';
import { PORT, BASE_PATH } from './env.config.js';

function getCommitHash() {
	try {
		return execSync('git rev-parse --short HEAD').toString().trim();
	} catch {
		return 'unknown';
	}
}

export default defineConfig(() => {
	return {
		root: './src',
		base: BASE_PATH,
		define: {
			__SETTINGS_KEY__: JSON.stringify('iso2x:settings'),
		},
		plugins: [
			tailwindcss(),
			{
				name: 'html-inject-pkg',
				transformIndexHtml(html) {
					html = Object.entries({
						'%APP_DISPLAY_NAME%': pkg.displayName,
						'%APP_DESCRIPTION%': pkg.description,
						'%APP_VERSION%': pkg.version,
						'%COMMIT_HASH%': getCommitHash(),
					}).reduce((acc, [key, val]) => acc.replaceAll(key, val), html);
					return html;
				},
			},
			createSvgIconsPlugin({
				iconDirs: [path.resolve(process.cwd(), 'src/assets/icons')],
				symbolId: 'icon-[name]',
				inject: 'body-last',
			}),
			VitePWA({
				strategies: 'injectManifest',
				srcDir: '.',
				filename: 'sw.js',
				injectRegister: null,
				manifest: {
					name: pkg.displayName,
					short_name: pkg.displayName,
					description: pkg.description,
					theme_color: '#ffffff',
					background_color: '#ffffff',
					display: 'standalone',
					icons: [
						{ src: 'favicon-96x96.png', sizes: '96x96', type: 'image/png' },
						{ src: 'favicon-320x320.png', sizes: '320x320', type: 'image/png' },
					],
				},
				workbox: {
					globPatterns: ['**/*.{js,css,html,wasm,svg,png,ico,woff2}'],
				},
				devOptions: {
					enabled: true,
					type: 'classic',
				},
			}),
		],
		worker: { format: 'iife' },
		build: {
			ssCodeSplit: false,
			outDir: '../dist',
			emptyOutDir: true,
		},
		server: {
			port: PORT,
			fs: { allow: ['../..'] },
			headers: {
				// require-corp so any embedded iframe must opt in with its own
				// CORP/COEP header.
				'Cross-Origin-Embedder-Policy': 'require-corp',
			},
		},
		preview: { port: PORT },
	};
});
