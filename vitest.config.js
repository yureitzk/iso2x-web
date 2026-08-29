import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'happy-dom',
		setupFiles: ['./vitest.setup.js'],
		include: ['src/**/*.test.js', 'test/**/*.test.js', '*.test.js'],
	},
});
