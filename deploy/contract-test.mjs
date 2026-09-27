#!/usr/bin/env node
/**
 * Production execution-boundary contract test.
 *
 * Exercises the *production* upload boundary — the `POST /linkml-viewer/reconcile`
 * endpoint added to `deploy/serve.mjs`, which runs the same `produce.py` through
 * the same `deploy/producer-runner.mjs` process-group cleanup as the Vite plugin.
 *
 * It does NOT go through Vite; it boots the real launchd entry point
 * (`deploy/serve.mjs`) and drives the HTTP boundary. Enumerated cases:
 *
 *   valid OMOP · inherited schema · cross-schema import · malformed YAML ·
 *   missing root · missing import · producer failure · concurrent uploads ·
 *   client disconnect · timeout · process cleanup (no orphans)
 *
 * plus the R2.4 artefact-identity assertion (bundled ≡ uploaded same schema).
 *
 * Run: `bun run test:contract` (or `node deploy/contract-test.mjs`).
 */

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = join(REPO_ROOT, 'deploy', 'serve.mjs');
const RECONCILE_PATH = '/linkml-viewer/reconcile';
const ALT_RECONCILE_PATH = '/reconcile';
const PRODUCER_MATCH = 'produce.py';

const results = [];
let failures = 0;

function record(name, pass, detail) {
	results.push({ name, pass, detail });
	if (!pass) failures += 1;
	const tag = pass ? 'PASS' : 'FAIL';
	process.stdout.write(`  ${tag}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

async function waitForServer(port, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/linkml-viewer/`);
			await res.arrayBuffer();
			return;
		} catch {
			if (Date.now() > deadline) throw new Error(`server on ${port} did not start`);
			await sleep(100);
		}
	}
}

function startServer(env = {}) {
	const port = 20000 + Math.floor(Math.random() * 20000);
	const child = spawn(process.execPath, [SERVE], {
		cwd: REPO_ROOT,
		env: { ...process.env, PORT: String(port), ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.setEncoding('utf-8');
	child.stderr.setEncoding('utf-8');
	let log = '';
	child.stdout.on('data', (c) => (log += c));
	child.stderr.on('data', (c) => (log += c));
	return { port, child, log: () => log };
}

async function stopServer(server) {
	server.child.kill('SIGTERM');
	await new Promise((r) => {
		const t = setTimeout(() => {
			server.child.kill('SIGKILL');
			r();
		}, 4000);
		server.child.once('exit', () => {
			clearTimeout(t);
			r();
		});
	});
}

// ---------------------------------------------------------------------------
// HTTP boundary
// ---------------------------------------------------------------------------

async function post(port, payload, { path = RECONCILE_PATH, signal } = {}) {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
		signal
	});
	let body = null;
	try {
		body = await res.json();
	} catch {
		/* non-JSON */
	}
	return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// producer process observation
// ---------------------------------------------------------------------------

function producerPids() {
	try {
		const out = execFileSync('pgrep', ['-f', PRODUCER_MATCH], { encoding: 'utf-8' });
		return out.trim().split('\n').filter(Boolean).map(Number);
	} catch {
		return [];
	}
}

async function waitForNoOrphans(timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const pids = producerPids();
		if (pids.length === 0) return [];
		if (Date.now() > deadline) return pids;
		await sleep(250);
	}
}

// ---------------------------------------------------------------------------
// canonical identity (R2.4)
// ---------------------------------------------------------------------------

function canonical(obj) {
	if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
	if (obj && typeof obj === 'object') {
		return `{${Object.keys(obj)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(obj);
}

function sha256(text) {
	return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

/**
 * Canonical artefact identity: everything the producer emits except the
 * location-dependent `reproducibility.schema_path` label (bundled path is
 * repo-relative; the reconcile boundary labels with the uploaded root name) and
 * the derived `output_digest` field itself.
 */
function canonicalIdentityDigest(artifact) {
	const clone = JSON.parse(JSON.stringify(artifact));
	delete clone.reproducibility.output_digest;
	clone.reproducibility.schema_path = '<schema>';
	return sha256(canonical(clone));
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

const OMOP = read('static/omop_cdm.yaml');
const SYNTHETIC = read('static/synthetic_inheritance.yaml');
const BUNDLED_SYNTHETIC = JSON.parse(
	read('static/reconciled/synthetic_inheritance.json')
);

const CROSS_ROOT = `id: https://example.org/root
name: root
prefixes:
  linkml: https://w3id.org/linkml/
default_range: string
imports:
- linkml:types
- dep
classes:
  Root:
    is_a: Base
    attributes:
      thing:
        range: DepThing
`;

const CROSS_DEP = `id: https://example.org/dep
name: dep
prefixes:
  linkml: https://w3id.org/linkml/
default_range: string
imports:
- linkml:types
classes:
  Base:
    attributes:
      id:
        identifier: true
      label:
  DepThing:
    is_a: Base
    attributes:
      dep_value:
`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
	process.stdout.write('production boundary contract test\n');

	const baseline = producerPids();
	record('baseline: no stray producer processes', baseline.length === 0, `pids=${baseline.join(',')}`);

	const server = startServer();
	await waitForServer(server.port);
	process.stdout.write(`\nserver: http://127.0.0.1:${server.port} (pid ${server.child.pid})\n`);

	// --- 1. valid OMOP upload ------------------------------------------------
	{
		const { status, body } = await post(server.port, {
			name: 'omop_cdm.yaml',
			files: { 'omop_cdm.yaml': OMOP }
		});
		const ok =
			status === 200 &&
			body?.artifact?.format === 'linkml-viewer-reconciled' &&
			body?.classes?.length > 0 &&
			body?.reproducibility?.linkml_version === '1.11.1';
		record(
			'valid OMOP upload',
			ok,
			`status=${status} classes=${body?.classes?.length} linkml=${body?.reproducibility?.linkml_version}`
		);
	}

	// --- 2. inherited schema (is_a) -----------------------------------------
	{
		const { status, body } = await post(server.port, {
			name: 'synthetic_inheritance.yaml',
			files: { 'synthetic_inheritance.yaml': SYNTHETIC }
		});
		const inherited = (body?.classes ?? [])
			.flatMap((c) => c.slots ?? [])
			.filter((s) => s.inherited_from);
		record(
			'inherited schema (is_a)',
			status === 200 && inherited.length > 0,
			`status=${status} inherited_slots=${inherited.length} e.g. ${inherited[0]?.name}<-${inherited[0]?.inherited_from}`
		);
	}

	// --- 3. cross-schema import ---------------------------------------------
	{
		const { status, body } = await post(server.port, {
			name: 'root.yaml',
			files: { 'root.yaml': CROSS_ROOT, 'dep.yaml': CROSS_DEP }
		});
		const names = (body?.classes ?? []).map((c) => c.name).sort();
		const fromSchemas = new Set((body?.classes ?? []).map((c) => c.from_schema));
		const ok =
			status === 200 &&
			['Base', 'DepThing', 'Root'].every((n) => names.includes(n)) &&
			fromSchemas.size === 2;
		record(
			'cross-schema import',
			ok,
			`status=${status} classes=${names.join(',')} from_schema=${fromSchemas.size}`
		);
	}

	// --- 4. malformed YAML ---------------------------------------------------
	{
		const { status, body } = await post(server.port, {
			name: 'bad.yaml',
			files: { 'bad.yaml': 'classes: [unclosed\n  x: {' }
		});
		record(
			'malformed YAML rejected',
			status === 500 && typeof body?.error === 'string',
			`status=${status} error=${String(body?.error).split('\n')[0]}`
		);
	}

	// --- 5. missing root -----------------------------------------------------
	{
		const { status, body } = await post(server.port, {
			name: 'missing.yaml',
			files: { 'present.yaml': CROSS_DEP }
		});
		record(
			'missing root rejected',
			status === 400 && /root file/.test(String(body?.error)),
			`status=${status} error=${body?.error}`
		);
	}

	// --- 6. missing import ---------------------------------------------------
	{
		const root = CROSS_ROOT.replace('- dep', '- does_not_exist');
		const { status, body } = await post(server.port, {
			name: 'root.yaml',
			files: { 'root.yaml': root }
		});
		record(
			'missing import rejected',
			status === 500 && /FileNotFoundError|No such file/.test(String(body?.error)),
			`status=${status} error=${String(body?.error).split('\n')[0]}`
		);
	}

	// --- 7. producer failure (semantic, exit 2) -----------------------------
	{
		const ghost = CROSS_DEP.replace('is_a: Base', 'is_a: Ghost');
		const { status, body } = await post(server.port, {
			name: 'dep.yaml',
			files: { 'dep.yaml': ghost }
		});
		record(
			'producer semantic failure rejected',
			status === 400 && /No such class/.test(String(body?.error)),
			`status=${status} error=${body?.error}`
		);
	}

	// --- 8. concurrent uploads ----------------------------------------------
	{
		const n = 4;
		const responses = await Promise.all(
			Array.from({ length: n }, () =>
				post(server.port, {
					name: 'synthetic_inheritance.yaml',
					files: { 'synthetic_inheritance.yaml': SYNTHETIC }
				})
			)
		);
		const ok =
			responses.every((r) => r.status === 200) &&
			responses.every(
				(r) =>
					r.body.reproducibility.output_digest ===
					responses[0].body.reproducibility.output_digest
			);
		record(
			`concurrent uploads (N=${n})`,
			ok,
			`statuses=${responses.map((r) => r.status).join(',')} digest=${responses[0]?.body?.reproducibility?.output_digest}`
		);
	}

	// --- 9. dev-parity path --------------------------------------------------
	{
		const { status } = await post(
			server.port,
			{ name: 'synthetic_inheritance.yaml', files: { 'synthetic_inheritance.yaml': SYNTHETIC } },
			{ path: ALT_RECONCILE_PATH }
		);
		record('dev-parity path /reconcile', status === 200, `status=${status}`);
	}

	// --- 10. client disconnect ----------------------------------------------
	{
		const controller = new AbortController();
		const pending = post(
			server.port,
			{ name: 'omop_cdm.yaml', files: { 'omop_cdm.yaml': OMOP } },
			{ signal: controller.signal }
		).catch(() => 'aborted');
		await sleep(400);
		controller.abort();
		await pending;
		const orphans = await waitForNoOrphans();
		const alive = await post(server.port, {
			name: 'synthetic_inheritance.yaml',
			files: { 'synthetic_inheritance.yaml': SYNTHETIC }
		});
		record(
			'client disconnect → child reaped, server alive',
			orphans.length === 0 && alive.status === 200,
			`orphans=${orphans.join(',') || 'none'} followup=${alive.status}`
		);
	}

	// --- 11. timeout ---------------------------------------------------------
	{
		const timeoutServer = startServer({ PRODUCER_TIMEOUT_MS: '150' });
		await waitForServer(timeoutServer.port);
		const { status, body } = await post(timeoutServer.port, {
			name: 'omop_cdm.yaml',
			files: { 'omop_cdm.yaml': OMOP }
		});
		const orphans = await waitForNoOrphans();
		record(
			'timeout → 500 + child reaped',
			status === 500 && /timed out/.test(String(body?.error)) && orphans.length === 0,
			`status=${status} error=${body?.error} orphans=${orphans.join(',') || 'none'}`
		);
		await stopServer(timeoutServer);
	}

	// --- 12. R2.4 artefact identity -----------------------------------------
	{
		const { status, body } = await post(server.port, {
			name: 'synthetic_inheritance.yaml',
			files: { 'synthetic_inheritance.yaml': SYNTHETIC }
		});
		const bundledDigest = canonicalIdentityDigest(BUNDLED_SYNTHETIC);
		const uploadedDigest = canonicalIdentityDigest(body);
		const sameFingerprint =
			BUNDLED_SYNTHETIC.reproducibility.schema_fingerprint ===
			body?.reproducibility?.schema_fingerprint;
		const sameLinkml =
			BUNDLED_SYNTHETIC.reproducibility.linkml_version ===
			body?.reproducibility?.linkml_version;
		const sameGenerator =
			canonical(BUNDLED_SYNTHETIC.reproducibility.generator) ===
			canonical(body?.reproducibility?.generator);
		record(
			'artefact identity: bundled ≡ uploaded (canonical digest)',
			status === 200 &&
				sameFingerprint &&
				sameLinkml &&
				sameGenerator &&
				bundledDigest === uploadedDigest,
			`fingerprint=${sameFingerprint} linkml=${body?.reproducibility?.linkml_version} generator=${sameGenerator} canonical=${bundledDigest.slice(0, 23)}…==${uploadedDigest.slice(0, 23)}…`
		);
	}

	// --- 13. process cleanup on server shutdown ------------------------------
	{
		await stopServer(server);
		const orphans = await waitForNoOrphans();
		record(
			'SIGTERM server → 0 orphan producers',
			orphans.length === 0,
			`orphans=${orphans.join(',') || 'none'}`
		);
	}

	process.stdout.write(
		`\n${results.length - failures}/${results.length} cases passed\n`
	);
	if (failures > 0) process.exitCode = 1;
}

await main();
