// Returns base url without trailing slash.
export const PUBLIC_PATH = import.meta.env.BASE_URL.endsWith('/')
	? import.meta.env.BASE_URL.slice(0, -1)
	: import.meta.env.BASE_URL;
