import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// Static adapter for GitHub Pages deployment.
		// fallback: '404.html' enables client-side routing on GitHub Pages.
		// fallback: 'index.html' is required for Tauri SPA routing.
		// fallback: '404.html' is used for GitHub Pages client-side routing.
		// During Tauri builds TAURI_ENV_PLATFORM is set; use index.html then.
		adapter: adapter({
			fallback: process.env.TAURI_ENV_PLATFORM ? 'index.html' : '404.html'
		}),
		paths: {
			// In production the app is served at /plugin-link on GitHub Pages.
			// During Tauri builds (TAURI_ENV_PLATFORM is set) the base must be empty.
			// In development (npm run dev) the base is empty so relative paths work.
			// BASE_PATH overrides the production sub-path (e.g. /linkml-viewer).
			base:
				process.env.BASE_PATH ??
				(process.env.NODE_ENV === 'production' && !process.env.TAURI_ENV_PLATFORM
					? '/plugin-link'
					: '')
		}
	}
};

export default config;
