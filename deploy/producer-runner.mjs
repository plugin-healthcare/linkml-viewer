/**
 * Shared producer execution boundary: process-group spawn, abort/timeout
 * termination and process-exit reaping for `produce.py`.
 *
 * This module is the single implementation of the R1.5 cleanup contract. It is
 * imported by the native Vite pipeline (`vite.config.ts`) and by the production
 * origin boundary (`deploy/serve.mjs`) so both execute the *same* producer with
 * the *same* lifecycle semantics — it is not a producer and contains no LinkML
 * logic.
 *
 * The call site owns the argv (including the `produce.py` path resolved against
 * its own `import.meta.url`); the runner owns only spawn/kill/timeout/abort.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Last-resort ceiling so a wedged producer cannot pin a child forever. */
export const DEFAULT_PRODUCER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolve the `uv` executable for the producer boundary.
 *
 * Under launchd the service runs with a minimal PATH (`/usr/bin:/bin:...`), so
 * `uv` (installed under `~/.local/bin`) is not discoverable by name. The runner
 * owns process spawning, so it resolves the binary here instead of relying on an
 * inherited PATH — the same execution boundary in every environment. `UV_BIN`
 * overrides when set.
 */
/** @type {string | undefined} */
let cachedUv;
export function resolveUv() {
	if (cachedUv) return cachedUv;
	if (process.env.UV_BIN) return (cachedUv = process.env.UV_BIN);
	const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
	const fromPath = (process.env.PATH ?? '')
		.split(process.platform === 'win32' ? ';' : ':')
		.filter(Boolean)
		.map((dir) => join(dir, exe))
		.find(existsSync);
	const fallback = [
		join(homedir(), '.local', 'bin', exe),
		join('/opt/homebrew/bin', exe),
		join('/usr/local/bin', exe)
	].find(existsSync);
	return (cachedUv = fromPath ?? fallback ?? exe);
}

/** Hard cap on an uploaded workspace body (server side). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Build the `uv run --locked produce.py <args>` argv.
 *
 * The producer environment is the repository's locked uv project
 * (`pyproject.toml` + `uv.lock` + `.python-version`). `--locked` refuses to run
 * if the lockfile is missing or stale, so no boundary can silently re-resolve a
 * different LinkML version: the pin has exactly one authority (the lock), not a
 * second copy in this file. The call site supplies its own `produce.py` path so
 * config bundling cannot relocate the entry point.
 *
 * @param {string} producerEntry absolute path to `produce.py`
 * @param {string[]} args producer CLI args
 * @returns {string[]}
 */
export function uvProducerArgs(producerEntry, args) {
	return ['run', '--locked', producerEntry, ...args];
}

// Every live producer child is tracked so it can be terminated as a process
// group. `uv run` is spawned detached so the grandchild `python` joins its own
// group: killing the group reaps both `uv` and `python` (a bare `uv` kill can
// orphan the interpreter). No child outlives the owning process.
/** @type {Set<import('node:child_process').ChildProcess>} */
const activeChildren = new Set();
let shutdownHooked = false;

/** @param {import('node:child_process').ChildProcess} child */
export function killChildTree(child) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	const pid = child.pid;
	const escalate = () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			if (process.platform === 'win32') child.kill('SIGKILL');
			else process.kill(-pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	};
	try {
		if (process.platform === 'win32') {
			child.kill('SIGKILL');
			return;
		}
		// Negative pid targets the detached process group (uv + python).
		process.kill(-pid, 'SIGTERM');
		const timer = setTimeout(escalate, 2000);
		timer.unref?.();
	} catch {
		try {
			child.kill('SIGKILL');
		} catch {
			/* already gone */
		}
	}
}

export function hookShutdown() {
	if (shutdownHooked) return;
	shutdownHooked = true;
	const killAll = () => {
		for (const child of activeChildren) killChildTree(child);
	};
	process.once('exit', killAll);
	for (const signal of ['SIGINT', 'SIGTERM']) {
		process.once(signal, () => {
			killAll();
			process.exit(0);
		});
	}
}

/**
 * Thin execution of the pinned producer: no semantics live in JavaScript.
 *
 * The child is registered for process-exit cleanup and, when a caller supplies
 * an `AbortSignal`, terminated (as a process group) the moment the request that
 * owns it goes away. A timed-out or aborted call rejects; normal calls resolve
 * with the producer's stdout/stderr/exit code.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} opts.args
 * @param {string} [opts.cwd]
 * @param {string} [opts.stdin]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @param {Record<string, string | undefined>} [opts.env]
 */
export function runProducer({
	command,
	args,
	cwd,
	stdin,
	signal,
	timeoutMs = DEFAULT_PRODUCER_TIMEOUT_MS,
	env
}) {
	return new Promise((resolve, reject) => {
		hookShutdown();
		const child = spawn(command === 'uv' ? resolveUv() : command, args, {
			cwd,
			env,
			detached: process.platform !== 'win32'
		});
		activeChildren.add(child);

		let stdout = '';
		let stderr = '';
		let settled = false;
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;

		const onAbort = () => {
			if (settled) return;
			killChildTree(child);
			settle(() => reject(new Error('producer request aborted')));
		};
		/** @param {() => void} fn */
		const settle = (fn) => {
			if (settled) return;
			settled = true;
			activeChildren.delete(child);
			if (timer) clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			fn();
		};

		child.stdout.setEncoding('utf-8');
		child.stderr.setEncoding('utf-8');
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('error', (e) => settle(() => reject(e)));
		child.on('close', (code) => settle(() => resolve({ stdout, stderr, code })));

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}
		timer = setTimeout(() => {
			killChildTree(child);
			settle(() => reject(new Error(`producer timed out after ${timeoutMs}ms`)));
		}, timeoutMs);

		if (stdin !== undefined) child.stdin.end(stdin);
	});
}

/** @param {import('node:http').IncomingMessage} req */
export function readBody(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('missing or oversized request body'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
	const data = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Content-Length', Buffer.byteLength(data));
	res.end(data);
}
