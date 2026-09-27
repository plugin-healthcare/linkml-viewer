#!/usr/bin/env node
/**
 * R2.8.4f — locked-environment determinism proof.
 *
 * Proves the repository reproducibility contract from clean project
 * environments: for every bundled schema, the producer is executed twice, each
 * pass using its OWN freshly-synced environment created from the committed
 * `uv.lock`. The two artefacts must be byte-identical with equal
 * `content_digest` (toolchain-independent identity) and equal `output_digest`
 * (content + toolchain provenance).
 *
 * "Clean" means a distinct `UV_PROJECT_ENVIRONMENT` per pass: the second pass
 * cannot reuse the first pass's installed packages, so it exercises
 * lock -> environment -> artefact for real instead of reusing a warm venv.
 *
 * Contract verified:
 *   identical source + identical locked environment -> identical artefact
 *   content_digest is toolchain-independent; output_digest includes provenance.
 *
 * No semantic reconciliation runs here: this only executes the single producer
 * through the locked environment and compares its outputs.
 *
 * Run: bun run test:repro   (or: node deploy/repro-check.mjs)
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProducer, uvProducerArgs } from './producer-runner.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRODUCER_ENTRY = join(REPO_ROOT, 'produce.py');

const BUNDLED = [
	{ name: 'omop', rel: 'static/omop_cdm.yaml' },
	{ name: 'sein', rel: 'static/sein.yaml' },
	{ name: 'synthetic_inheritance', rel: 'static/synthetic_inheritance.yaml' }
];

const PRODUCER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run the bundled producer once for every fixture, into `outDir`, using the
 * given (freshly-created) locked environment.
 * @param {string} venv
 * @param {string} outDir
 */
async function producePass(venv, outDir) {
	for (const fixture of BUNDLED) {
		const outPath = join(outDir, `${fixture.name}.json`);
		const { stdout, stderr, code } = await runProducer({
			command: 'uv',
			args: uvProducerArgs(PRODUCER_ENTRY, [
				'--schema',
				fixture.rel,
				'--name',
				fixture.name,
				'--out',
				outPath
			]),
			cwd: REPO_ROOT,
			// A private environment per pass, synced from the committed lock.
			env: {
				...process.env,
				UV_PROJECT_ENVIRONMENT: venv,
				UV_NO_PROGRESS: '1'
			},
			timeoutMs: PRODUCER_TIMEOUT_MS
		});
		if (code !== 0) {
			throw new Error(
				`producer failed for '${fixture.name}' (exit ${code}): ${
					stderr.trim() || stdout.trim() || 'no output'
				}`
			);
		}
	}
}

async function main() {
	const work = mkdtempSync(join(tmpdir(), 'linkml-repro-'));
	const report = { contract: 'locked-env-determinism', fixtures: {}, ok: true };
	try {
		const envA = join(work, 'env-a');
		const envB = join(work, 'env-b');
		const outA = join(work, 'out-a');
		const outB = join(work, 'out-b');

		// Two independent environments from the same lock; sequential so they
		// cannot share an interpreter or installed packages.
		await producePass(envA, outA);
		await producePass(envB, outB);

		for (const fixture of BUNDLED) {
			const a = readFileSync(join(outA, `${fixture.name}.json`));
			const b = readFileSync(join(outB, `${fixture.name}.json`));
			const ja = JSON.parse(a.toString('utf8'));
			const jb = JSON.parse(b.toString('utf8'));

			const byteEqual = a.equals(b);
			const contentEqual =
				ja.reproducibility?.content_digest === jb.reproducibility?.content_digest;
			const outputEqual =
				ja.reproducibility?.output_digest === jb.reproducibility?.output_digest;
			const ok = byteEqual && contentEqual && outputEqual;
			if (!ok) report.ok = false;

			report.fixtures[fixture.name] = {
				ok,
				byteEqual,
				contentEqual,
				outputEqual,
				content_digest: ja.reproducibility?.content_digest ?? null,
				output_digest: ja.reproducibility?.output_digest ?? null
			};
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	process.stdout.write(JSON.stringify(report, null, 2) + '\n');
	if (!report.ok) process.exitCode = 1;
}

await main();
