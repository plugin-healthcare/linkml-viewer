import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Connect, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	readBody,
	runProducer,
	sendJson,
	uvProducerArgs
} from './deploy/producer-runner.mjs';

// ---------------------------------------------------------------------------
// Native LinkML producer integration
//
// The authoritative LinkML producer (`produce.py`, pinned linkml 1.11.1
// SchemaView + generators) is invoked by this config — there is no standalone
// `producer/` directory and no separate `reconcile-service/` process.
//
//   * production build -> `buildStart` awaits `produce.py --all` before the
//     bundle is emitted, so a producer failure fails the build and every
//     `static/reconciled/*.json` artefact exists when `static/` is copied.
//   * dev server -> generation is started off the critical path by
//     `configureServer` (buildStart is a no-op in serve mode) and the viewer's
//     artefact fetch retries until it lands. This keeps dev-server availability
//     independent of a cold `uv` toolchain provision.
//   * uploads / hand-edited schemas -> Vite's native dev-server middleware
//     (`configureServer`) exposes `POST /reconcile`, which runs the *same*
//     `produce.py --reconcile` in a temporary dir and streams back the artefact.
//   * `vite preview` -> serves the already-built output. It deliberately has no
//     generation and no `/reconcile` (it mirrors the production static export);
//     `configurePreviewServer` only warns when the build lacks artefacts.
//
// The browser never runs LinkML: `src/lib/linkml.ts` only transports/projects
// the artefact. In dev, this config serves the upload endpoint. In production,
// the static SPA is served by `deploy/serve.mjs` behind the Cloudflare tunnel,
// and that same process now exposes the upload boundary (`POST /reconcile`).
// Both boundaries execute the *same* `produce.py` through the shared
// `deploy/producer-runner.mjs` cleanup/timeout implementation.
// ---------------------------------------------------------------------------

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const PRODUCER_ENTRY = join(REPO_ROOT, 'produce.py');

// Producer argv is resolved here, against this config's own location, and handed
// to the shared runner. The runner never resolves `import.meta.url` itself, so
// bundling the config cannot relocate the producer entry. The linkml/python pin
// lives in the shared runner (uvProducerArgs).
const PRODUCER_PREFIX = uvProducerArgs(PRODUCER_ENTRY, []);

/**
 * Thin execution of the pinned producer: no semantics live in TypeScript. The
 * spawn process-group, abort/timeout termination and process-exit reaping are
 * the shared `deploy/producer-runner.mjs` R1.5 implementation, reused verbatim
 * by the production origin boundary.
 */
function produce(
	args: string[],
	stdin?: string,
	signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return runProducer({
		command: 'uv',
		args: [...PRODUCER_PREFIX, ...args],
		cwd: REPO_ROOT,
		stdin,
		signal
	});
}

function linkmlProducer(
	log: (msg: string) => void,
	onError: (msg: string) => void
): Plugin {
	// One generation per process (single-flight); a failed attempt is retried on
	// the next call so a transient failure does not poison later requests.
	let generated: Promise<void> | null = null;
	// Set by configResolved: 'build' for `vite build`, 'serve' for dev/preview.
	let isBuild = false;

	function generateBundled(): Promise<void> {
		if (generated) return generated;
		generated = produce(['--all']).then(({ stdout, stderr, code }) => {
			if (code !== 0) {
				throw new Error(
					`linkml producer failed (exit ${code}): ${stderr.trim() || 'no output'}`
				);
			}
			log(`linkml producer: ${stdout.trim().split('\n').join('\n  ')}`);
		});
		generated.catch(() => {
			generated = null;
		});
		return generated;
	}

	async function handleReconcile(req: Connect.IncomingMessage, res: import('node:http').ServerResponse) {
		if (req.method === 'OPTIONS') {
			res.statusCode = 204;
			res.end();
			return;
		}
		if (req.method !== 'POST') {
			sendJson(res, 405, { error: 'method not allowed' });
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(await readBody(req));
		} catch (e) {
			sendJson(res, 400, { error: (e as Error).message });
			return;
		}
		// If the client goes away mid-producer, abort this request's child so no
		// `uv`/`python` survives a killed upload. `close` also fires on normal
		// completion, but by then the promise is already settled (no-op).
		const controller = new AbortController();
		const onClose = () => controller.abort();
		res.once('close', onClose);
		try {
			const { stdout, stderr, code } = await produce(
				['--reconcile'],
				JSON.stringify(payload),
				controller.signal
			);
			if (code === 0) {
				sendJson(res, 200, JSON.parse(stdout));
				return;
			}
			let detail = stderr.trim();
			try {
				detail = (JSON.parse(detail) as { error?: string }).error ?? detail;
			} catch {
				/* non-JSON producer error */
			}
			sendJson(res, code === 2 ? 400 : 500, { error: detail || 'producer failed' });
		} catch (e) {
			if (!controller.signal.aborted) {
				sendJson(res, 500, { error: (e as Error).message });
			}
		} finally {
			res.removeListener('close', onClose);
		}
	}

	return {
		name: 'linkml-producer',
		// Run before SvelteKit so the artefacts exist before static/ is copied and
		// before the SvelteKit plugin's own build hooks observe them.
		enforce: 'pre',

		configResolved(config) {
			isBuild = config.command === 'build';
		},

		// Only the build path blocks: a producer failure must fail `vite build`
		// with the producer's own message, never emit empty/missing artefacts.
		// In serve mode this hook is a no-op (Vite also runs buildStart for the
		// dev server); generation is deferred to configureServer.
		async buildStart() {
			if (isBuild) await generateBundled();
		},

		// Native Vite dev-server middleware — no separate service process.
		// Generation is kicked off off the critical path so dev-server
		// availability does not wait on a cold `uv` toolchain provision; the
		// viewer's artefact fetch retries until the output is written.
		async configureServer(server: ViteDevServer) {
			generateBundled().catch((e: Error) =>
				onError(`linkml producer (dev) failed: ${e.message}`)
			);
			server.middlewares.use('/reconcile', (req, res, next) => {
				void handleReconcile(req, res).catch(next);
			});
		},

		// `vite preview` serves the build output and mirrors the deployed static
		// export: no generation and no /reconcile endpoint. Build owns generation
		// (buildStart), so preview only surfaces a clear warning when the
		// adapter-static output lacks the pipeline artefacts, rather than
		// generating into it. adapter-static emits to `build/` (see deploy.yml).
		configurePreviewServer(_server: PreviewServer) {
			const reconciled = join(REPO_ROOT, 'build', 'reconciled');
			if (!existsSync(reconciled)) {
				onError(
					`linkml producer: ${reconciled} is missing — run the build ` +
						`(produce.py --all) before \`vite preview\`. ` +
						`preview does not generate and has no /reconcile endpoint.`
				);
			}
		},
	};
}

export default defineConfig({
	plugins: [
		linkmlProducer(
			(msg) => console.log(msg),
			(msg) => console.error(msg)
		),
		sveltekit(),
	],
	build: {
		// elkjs/lib/elk.bundled.js is ~1.4 MB minified — it's an inherently large layout engine.
		// The warning threshold is raised to avoid false-positive noise.
		chunkSizeWarningLimit: 1600,
	},
});
