import { loadEnv } from 'vite';

const env = loadEnv('development', process.cwd(), '');

export const PORT = Number(env.PORT ?? 5173);
export const BASE_PATH = env.BASE_PATH ?? '/';
