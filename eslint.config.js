import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
	js.configs.recommended,
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'docker/**',
			'playwright-report/**',
			'test-results/**',
		],
	},
	{
		files: ['**/*.js'],
		rules: {
			'no-unused-vars': [
				'error',
				{ varsIgnorePattern: '^_', ignoreRestSiblings: true },
			],
		},
	},
	{
		// Node-context config files
		files: ['*.config.js', 'env.config.js', 'jsconfig.json'],
		languageOptions: {
			globals: globals.node,
			sourceType: 'module',
		},
	},
	{
		// Browser app code
		files: ['src/js/**/*.js', 'src/main.js'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: {
				...globals.browser,
				__SETTINGS_KEY__: 'readonly',
			},
		},
	},
	{
		// Service worker + workers
		files: [
			'src/sw.js',
			'src/js/workers/**/*.js',
			'src/js/serviceWorker/**/*.js',
		],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: globals.worker,
		},
	},
	{
		// Test files
		files: [
			'**/*.test.js',
			'test/**/*.js',
			'vitest.setup.js',
			'playwright.config.js',
		],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
	},
	prettier,
];
