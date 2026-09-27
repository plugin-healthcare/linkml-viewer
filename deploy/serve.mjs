import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DEFAULT_PRODUCER_TIMEOUT_MS,
	readBody,
	runProducer,
	sendJson,
	uvProducerArgs
} from './producer-runner.mjs';

const BASE = '/linkml-viewer';
const PORT = Number(process.env.PORT ?? 4180);
const HOST = '127.0.0.1';
const ROOT = resolve(fileURLToPath(new URL('../build', import.meta.url)));
const SHELL = join(ROOT, '404.html');
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PRODUCER_ENTRY = join(REPO_ROOT, 'produce.py');
// Same timeout semantics as the Vite plugin's producer boundary; overridable for
// tests/tuning without changing the default.
const PRODUCER_TIMEOUT_MS = Number(
	process.env.PRODUCER_TIMEOUT_MS ?? DEFAULT_PRODUCER_TIMEOUT_MS
);

// The production upload boundary is the *same* producer as the build path,
// executed through the same shared process-group cleanup/reaping runner. It is
// an execution boundary only: it writes the uploaded workspace to a temp dir and
// runs `produce.py --reconcile`; it never parses LinkML itself.
const PRODUCER_PREFIX = uvProducerArgs(PRODUCER_ENTRY, []);
// Dev parity (`VITE_RECONCILE_URL=''`) posts to `/reconcile`; the production
// static build is served under BASE, and the Cloudflare ingress already routes
// `/linkml-viewer/*` to this origin, so both spellings are accepted.
const RECONCILE_PATHS = new Set([`${BASE}/reconcile`, '/reconcile']);

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.yaml': 'text/yaml; charset=utf-8',
	'.yml': 'text/yaml; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.map': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8'
};

async function send(res, status, body, type) {
	res.writeHead(status, { 'content-type': type ?? 'application/octet-stream' });
	res.end(body);
}

async function handleReconcile(req, res) {
	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.end();
		return;
	}
	if (req.method !== 'POST') {
		sendJson(res, 405, { error: 'method not allowed' });
		return;
	}
	let payload;
	try {
		payload = JSON.parse(await readBody(req));
	} catch (e) {
		sendJson(res, 400, { error: e.message });
		return;
	}
	// If the client goes away mid-producer, abort this request's child so no
	// `uv`/`python` survives a killed upload. `close` also fires on normal
	// completion, but by then the promise is already settled (no-op).
	const controller = new AbortController();
	const onClose = () => controller.abort();
	res.once('close', onClose);
	try {
		const { stdout, stderr, code } = await runProducer({
			command: 'uv',
			args: [...PRODUCER_PREFIX, '--reconcile'],
			cwd: REPO_ROOT,
			stdin: JSON.stringify(payload),
			signal: controller.signal,
			timeoutMs: PRODUCER_TIMEOUT_MS
		});
		if (code === 0) {
			sendJson(res, 200, JSON.parse(stdout));
			return;
		}
		let detail = stderr.trim();
		try {
			detail = JSON.parse(detail).error ?? detail;
		} catch {
			/* non-JSON producer error */
		}
		sendJson(res, code === 2 ? 400 : 500, { error: detail || 'producer failed' });
	} catch (e) {
		if (!controller.signal.aborted) {
			sendJson(res, 500, { error: e.message });
		}
	} finally {
		res.removeListener('close', onClose);
	}
}

const server = createServer(async (req, res) => {
	try {
		const { pathname } = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
		const decoded = decodeURIComponent(pathname);

		if (RECONCILE_PATHS.has(decoded)) {
			return await handleReconcile(req, res);
		}

		if (decoded === BASE) {
			res.writeHead(301, { location: `${BASE}/` });
			return res.end();
		}
		if (!decoded.startsWith(`${BASE}/`)) {
			return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
		}

		const rel = normalize(decoded.slice(BASE.length + 1)).replace(/^(\.\.[/\\])+/, '');
		const candidate = resolve(ROOT, rel);

		if (candidate !== ROOT && !candidate.startsWith(ROOT)) {
			return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
		}

		let target = candidate === ROOT ? SHELL : candidate;
		try {
			const info = await stat(target);
			if (info.isDirectory()) target = join(target, 'index.html');
		} catch {
			target = SHELL;
		}

		const body = await readFile(target).catch(() => readFile(SHELL));
		return send(res, 200, body, MIME[extname(target)] ?? MIME['.html']);
	} catch (err) {
		return send(res, 500, String(err?.message ?? err), 'text/plain; charset=utf-8');
	}
});

server.listen(PORT, HOST, () => {
	console.log(`linkml-viewer serving ${ROOT} at http://${HOST}:${PORT}${BASE}/`);
	console.log(`linkml-viewer reconcile boundary at ${[...RECONCILE_PATHS].join(' , ')}`);
});
