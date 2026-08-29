import initWasm from 'iso2x';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let initialized = false;

/** Finds the .wasm binary by extension rather than a hardcoded filename. */
async function resolveWasmBinary() {
	const entryUrl = import.meta.resolve('iso2x');
	const pkgDir = dirname(fileURLToPath(entryUrl));
	const wasmDir = join(pkgDir, 'wasm');
	const wasmFile = (await readdir(wasmDir)).find((f) => f.endsWith('.wasm'));
	if (!wasmFile) {
		throw new Error(
			`no .wasm file found in ${wasmDir} (resolved from iso2x's entry point at ${pkgDir})`,
		);
	}
	return join(wasmDir, wasmFile);
}

/**
 * initWasm() needs the raw wasm bytes via `module_or_path` here, not a
 * fetchable URL - fetch() of a file:// URL doesn't work outside Vite.
 */
export async function setupWasm() {
	if (initialized) return;
	const wasmPath = await resolveWasmBinary();
	const wasmBuffer = await readFile(wasmPath);
	await initWasm({ module_or_path: wasmBuffer });
	initialized = true;
}
