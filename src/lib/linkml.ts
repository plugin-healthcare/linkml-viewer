/**
 * LinkML schema ingestion — transport/materialisation boundary only.
 *
 * ONE PRODUCER, TWO INPUT MODES:
 *
 *   bundled  static/reconciled/<name>.json  --fetch-->  projectReconciledArtifact
 *   upload   POST /reconcile  -->  projectReconciledArtifact
 *
 * `static/reconciled/<name>.json` is a pipeline output: the Vite plugin in
 * `vite.config.ts` runs the producer on dev-server start and on build. Uploads
 * POST to `/reconcile`, served by that same plugin via Vite's native dev-server
 * middleware — there is no separate service process.
 *
 * Both modes yield the *same* artefact shape produced by the *same*
 * `produce.py` (pinned linkml 1.11.1 + SchemaView). This module never
 * computes LinkML semantics: it maps already-established class / effective-slot
 * / relationship facts into the viewer's `NormalizedSchema`. Python/SchemaView
 * stays off the client bundle; the former in-browser JS SchemaView residual is
 * deleted.
 *
 * `js-yaml` is used for PARSE-ONLY concerns: workspace display metadata, the
 * group config asset, and `imports:` extraction. Parsing YAML is not LinkML
 * semantics.
 */

import { load as yamlLoad } from 'js-yaml';
import { base } from '$app/paths';
import type {
  NormalizedSchema,
  ErdClass,
  ErdSlot,
  ErdRangeKind,
  GroupConfig,
  GroupInfo,
  WorkspaceFile,
  FileInfo,
  ReconciledRelationship,
} from './types';

type AnyRec = Record<string, any>;

// ---------------------------------------------------------------------------
// Input coercion
// ---------------------------------------------------------------------------

function toRaw(input: unknown): AnyRec {
  if (typeof input === 'string') {
    const trimmed = input.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return (JSON.parse(input) ?? {}) as AnyRec;
    }
    return (yamlLoad(input) ?? {}) as AnyRec;
  }
  return (input ?? {}) as AnyRec;
}

/** User-defined import names from a raw YAML `imports:` list (linkml:* stripped). */
export function extractImports(input: unknown): string[] {
  const raw = toRaw(input);
  const imports = raw.imports;
  if (!Array.isArray(imports)) return [];
  return imports
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0 && !v.startsWith('linkml:'));
}

// ---------------------------------------------------------------------------
// AUTHORITATIVE: reconciled artefact loader
//
// The artefact already contains: classes with pk/key slots, effective
// (induced) slots with range_kind/range_target/identifier/required/multivalued/
// exact_mappings/declared_by/inherited_from/from_schema, and the full FK+ETL
// relationship set. This loader maps those facts 1:1 into the viewer shape.
// ---------------------------------------------------------------------------

interface ReconciledArtifactSlot {
  name: string;
  slot_name: string;
  range: string;
  range_kind: ErdRangeKind;
  range_target: string | null;
  identifier: boolean;
  key: boolean;
  required: boolean;
  multivalued: boolean;
  description: string;
  exact_mappings: string[];
  declared_by: string | null;
  inherited_from: string | null;
  from_schema: string | null;
}

interface ReconciledArtifactClass {
  name: string;
  description: string;
  abstract: boolean;
  group: string | null;
  from_schema: string | null;
  pk_slot: string | null;
  pk_slot_name: string | null;
  key_slot: string | null;
  key_slot_name: string | null;
  slots: ReconciledArtifactSlot[];
}

interface ReconciledArtifactRelationship {
  kind: 'fk' | 'etl';
  source_class: string;
  target_class: string;
  slot: string;
  slot_name: string;
  /** Reconciled target anchor column: display name (FK identifier / ETL mapping slot). */
  target_slot: string | null;
  /** Canonical slot name of the target anchor column. */
  target_slot_name: string | null;
  required: boolean;
  self_reference: boolean;
  /** Present on `etl` relationships only. */
  mapping?: string;
}

/** Shape of `static/reconciled/<name>.json` (and the `/reconcile` response). */
export interface ReconciledArtifact {
  artifact: { format: string; version: number };
  reproducibility: Record<string, unknown>;
  schema: { name: string; id: string; description: string; imports_closure?: string[] };
  classes: ReconciledArtifactClass[];
  relationships: ReconciledArtifactRelationship[];
  counts: Record<string, number>;
}

const RECONCILED_ARTIFACT_FORMAT = 'linkml-viewer-reconciled';

/** Key separator for the (source_class, slot_name) FK-membership lookup. */
const SLOT_KEY_SEP = '\x00';

/**
 * Project an authoritative reconciled artefact into the viewer's
 * `NormalizedSchema`.
 *
 * Every field is consumed directly from the artefact. The only viewer-owned
 * value is `is_fk`, which is read as membership in the authoritative FK
 * relationship set (it is NOT recomputed from `range_kind`/`identifier`).
 * Self-referential FK relationships remain authoritative facts in the artefact
 * but are not materialised as canvas self-loops (a presentation choice).
 */
export function projectReconciledArtifact(artifact: ReconciledArtifact): NormalizedSchema {
  const fkSlots = new Set<string>();
  const relationships: ReconciledRelationship[] = [];

  for (const rel of artifact.relationships ?? []) {
    if (rel.kind === 'fk') {
      fkSlots.add(`${rel.source_class}${SLOT_KEY_SEP}${rel.slot_name}`);
      // No self-loop edges: a self-reference is a valid fact but not a canvas edge.
      if (rel.self_reference) continue;
    }
    relationships.push({
      kind: rel.kind,
      source: rel.source_class,
      target: rel.target_class,
      slot: rel.slot,
      slot_name: rel.slot_name,
      target_slot: rel.target_slot ?? null,
      target_slot_name: rel.target_slot_name ?? null,
      required: rel.required,
    });
  }

  const classes: Record<string, ErdClass> = {};
  for (const cls of artifact.classes ?? []) {
    if (cls.abstract) continue;
    const slots: ErdSlot[] = (cls.slots ?? []).map((slot) => ({
      name: slot.name,
      slot_name: slot.slot_name,
      range: slot.range,
      required: slot.required,
      identifier: slot.identifier,
      multivalued: slot.multivalued,
      is_fk: fkSlots.has(`${cls.name}${SLOT_KEY_SEP}${slot.slot_name}`),
      description: slot.description,
      exact_mappings: [...(slot.exact_mappings ?? [])],
      range_kind: slot.range_kind,
      range_target: slot.range_target ?? null,
      declared_by: slot.declared_by ?? null,
      inherited_from: slot.inherited_from ?? null,
      from_schema: slot.from_schema ?? cls.from_schema ?? artifact.schema.id,
    }));
    classes[cls.name] = {
      name: cls.name,
      description: cls.description,
      slots,
      group: cls.group ?? undefined,
      from_schema: cls.from_schema ?? undefined,
      pk_slot: cls.pk_slot ?? null,
    };
  }

  return {
    name: artifact.schema?.name ?? 'Unknown schema',
    description: artifact.schema?.description ?? '',
    id: artifact.schema?.id ?? '',
    classes,
    relationships,
    unresolved: [],
  };
}

/**
 * In dev the Vite plugin generates `static/reconciled/<name>.json` off the
 * critical path (so the dev server is available before a cold `uv` toolchain
 * provision finishes). The fetch therefore tolerates a not-yet-generated
 * artefact by retrying briefly. Production static export has no generation
 * step, so it fetches once and surfaces any error immediately.
 */
const ARTIFACT_LOAD_RETRIES = 60;
const ARTIFACT_LOAD_RETRY_MS = 500;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Load a bundled reconciled artefact and project it into a `NormalizedSchema`.
 * This is the viewer's authoritative load path for the bundled schemas.
 */
export async function loadReconciledArtifact(name: string): Promise<NormalizedSchema> {
  const maxRetries = import.meta.env.DEV ? ARTIFACT_LOAD_RETRIES : 0;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base}/reconciled/${name}.json`);
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await delay(ARTIFACT_LOAD_RETRY_MS);
      continue;
    }
    if (res.ok) {
      const artifact = (await res.json()) as ReconciledArtifact;
      if (artifact?.artifact?.format !== RECONCILED_ARTIFACT_FORMAT) {
        throw new Error(`Unexpected reconciled artifact format for '${name}'`);
      }
      return projectReconciledArtifact(artifact);
    }
    // 404 = the artefact is not generated yet (dev); every other status is a
    // real error and is surfaced without retrying.
    if (res.status !== 404 || attempt >= maxRetries) {
      throw new Error(`Failed to load reconciled artifact '${name}': ${res.statusText}`);
    }
    await delay(ARTIFACT_LOAD_RETRY_MS);
  }
}

// ---------------------------------------------------------------------------
// UPLOAD BOUNDARY — the same producer, executed off-client.
//
// The client POSTs the uploaded workspace to `${RECONCILE_URL}/reconcile`. In
// dev that is the Vite middleware in `vite.config.ts`; in production it is the
// `deploy/serve.mjs` origin behind the Cloudflare tunnel. Both run the same
// `produce.py` through the shared `deploy/producer-runner.mjs` and return the
// same artefact shape. There is no in-browser LinkML path and no fallback: if
// the endpoint is unreachable the caller surfaces an error. Set
// VITE_RECONCILE_URL only for an off-origin boundary.
// ---------------------------------------------------------------------------

/**
 * Base URL of the reconciliation endpoint. Override with VITE_RECONCILE_URL.
 *
 * Defaults to the app's own `base` so the same-origin boundary is correct under
 * the production sub-path: the static SPA is served at `/linkml-viewer/` and the
 * production origin (`deploy/serve.mjs`) exposes `POST /linkml-viewer/reconcile`
 * there, which the Cloudflare tunnel already routes to that process. In dev
 * `base` is empty, so this is `/reconcile` — the Vite dev middleware, unchanged.
 */
export const RECONCILE_URL: string =
  (import.meta.env.VITE_RECONCILE_URL as string | undefined) ?? base;

export interface WorkspaceReconciliation {
  merged: NormalizedSchema;
  unresolved: string[];
}

function emptySchema(): NormalizedSchema {
  return { name: 'Unknown schema', description: '', id: '', classes: {}, relationships: [] };
}

/**
 * Import names (parse-only) that no workspace file resolves. This is workspace
 * metadata, not LinkML semantics; the producer performs the actual closure.
 */
function unresolvedImportNames(files: WorkspaceFile[], active: WorkspaceFile): string[] {
  const byStem = new Map(files.map((f) => [f.stem.toLowerCase(), f] as const));
  const rawByFileId = new Map<string, AnyRec>();
  const rawOf = (f: WorkspaceFile): AnyRec => {
    let raw = rawByFileId.get(f.id);
    if (!raw) {
      raw = toRaw(f.text);
      rawByFileId.set(f.id, raw);
    }
    return raw;
  };

  const unresolved: string[] = [];
  const visited = new Set<string>([active.stem.toLowerCase()]);
  const walk = (file: WorkspaceFile) => {
    for (const name of extractImports(rawOf(file))) {
      const key = name.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      const dep = byStem.get(key);
      if (!dep) {
        unresolved.push(name);
        continue;
      }
      walk(dep);
    }
  };
  walk(active);
  return unresolved;
}

/**
 * Reconcile an uploaded / hand-edited workspace through the Vite plugin's
 * `/reconcile` endpoint and project the returned artefact exactly like the bundled one.
 */
export async function reconcileWorkspace(
  files: WorkspaceFile[],
  activeFileId: string
): Promise<WorkspaceReconciliation> {
  const active = files.find((f) => f.id === activeFileId) ?? files[0];
  if (!active) return { merged: emptySchema(), unresolved: [] };

  const unresolved = unresolvedImportNames(files, active);
  const res = await fetch(`${RECONCILE_URL}/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: active.name,
      files: Object.fromEntries(files.map((f) => [f.name, f.text])),
    }),
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`reconcile endpoint ${res.status}: ${detail}`);
  }

  const artifact = (await res.json()) as ReconciledArtifact;
  if (artifact?.artifact?.format !== RECONCILED_ARTIFACT_FORMAT) {
    throw new Error('Unexpected artifact format from /reconcile');
  }
  return { merged: projectReconciledArtifact(artifact), unresolved };
}

// ---------------------------------------------------------------------------
// Workspace metadata (js-yaml parse-only)
// ---------------------------------------------------------------------------

/** Describe an uploaded YAML file as workspace metadata (js-yaml only). */
export function describeWorkspaceFile(name: string, text: string): WorkspaceFile {
  const basename = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  const dotIdx = basename.lastIndexOf('.');
  const stem = dotIdx > 0 ? basename.slice(0, dotIdx) : basename;
  let displayName = stem;
  let schemaId: string | undefined;
  try {
    const raw = yamlLoad(text) as AnyRec | undefined;
    if (raw && typeof raw === 'object') {
      if (raw.name != null && String(raw.name) !== '') displayName = String(raw.name);
      if (raw.id != null && String(raw.id) !== '') schemaId = String(raw.id);
    }
  } catch {
    /* fall back to the stem */
  }
  return {
    id: crypto.randomUUID(),
    name: basename,
    stem,
    text,
    displayName,
    schemaId,
    imports: extractImports(text),
  };
}

/**
 * Stamp every class in a NormalizedSchema with the given fileId.
 */
export function assignFileIds(schema: NormalizedSchema, fileId: string): NormalizedSchema {
  const classes: Record<string, ErdClass> = {};
  for (const [key, cls] of Object.entries(schema.classes)) {
    classes[key] = { ...cls, fileId };
  }
  return { ...schema, classes };
}

/**
 * Stamp each class with the workspace file it came from, using the artefact's
 * authoritative `from_schema` provenance. Falls back to the active file. This
 * is a workspace-identity projection, not LinkML meaning.
 */
export function assignWorkspaceFileIds(
  schema: NormalizedSchema,
  files: WorkspaceFile[],
  fallbackFileId: string
): NormalizedSchema {
  const byKey = new Map<string, string>();
  for (const f of files) {
    for (const key of [f.name, f.stem, f.displayName, f.schemaId]) {
      if (key) byKey.set(key.toLowerCase(), f.id);
    }
  }
  const classes: Record<string, ErdClass> = {};
  for (const [key, cls] of Object.entries(schema.classes)) {
    const from = cls.from_schema?.toLowerCase();
    classes[key] = { ...cls, fileId: (from && byKey.get(from)) || fallbackFileId };
  }
  return { ...schema, classes };
}

/**
 * Load the default OMOP CDM schema from its authoritative reconciled artefact.
 */
export async function loadDefaultSchema(): Promise<NormalizedSchema> {
  return loadReconciledArtifact('omop');
}

/**
 * Load group color/label configuration from the static YAML asset.
 */
export async function loadGroupConfig(): Promise<Map<string, GroupInfo>> {
  const res = await fetch(`${base}/group-config.yaml`);
  if (!res.ok) throw new Error(`Failed to load group config: ${res.statusText}`);
  const raw = yamlLoad(await res.text()) as GroupConfig;
  const map = new Map<string, GroupInfo>();
  for (const entry of raw.groups ?? []) {
    map.set(entry.name, entry);
  }
  return map;
}

// Re-export FileInfo so callers can import it from '$lib/linkml' if needed
export type { FileInfo };
