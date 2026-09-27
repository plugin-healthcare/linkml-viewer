/**
 * R1.7 — independent producer <-> LinkML reconciliation (offline).
 *
 * Establishes the invariant
 *
 *     native LinkML execution  ==  producer reconciliation  ==  viewer-consumed state
 *
 * for the bundled schemas (OMOP CDM v5.4 + SEIN), by executing three
 * independent surfaces and diffing them:
 *
 *   1. NATIVE LINKML — a fresh Python process that loads the schema with the
 *      installed `linkml_runtime` SchemaView and runs the relevant generators
 *      (`ERDiagramGenerator`, `SQLTableGenerator`). It does NOT import
 *      `produce.py`, so it is an independent read of the same authority.
 *   2. PRODUCER — a fresh `produce.py --reconcile` run over the same source,
 *      compared against the checked-in `static/reconciled/<name>.json` the
 *      viewer fetches (reproducibility) and against the native read.
 *   3. VIEWER — `projectReconciledArtifact()` from `src/lib/linkml.ts`, loaded
 *      through Vite's native SSR module runner (it imports `$app/paths`),
 *      diffed against the producer artefact.
 *
 * Any difference is a reconciliation GAP (reported, never patched here).
 * Generator-specific conventions (e.g. ERDiagram includes identifier-range
 * self loops that the producer excludes by design) are classified separately
 * as deltas, not gaps.
 *
 * Invoked by `bun run check:reconcile`. Deterministic; exact diffs on stdout.
 * A non-empty gap set exits non-zero.
 */

import { createServer, type Plugin } from 'vite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = import.meta.dir ?? process.cwd();

// The locked producer project (pyproject.toml + uv.lock + .python-version) is
// the single environment authority. `--locked` refuses to run against a stale
// or missing lock, so this observer and the production boundaries all execute
// the identical pinned toolchain.
const UV = ['run', '--locked'] as const;

interface Fixture {
	name: string;
	path: string;
	root: string;
	required: boolean;
}

const FIXTURES: Fixture[] = [
	{ name: 'omop', path: 'static/omop_cdm.yaml', root: 'omop_cdm.yaml', required: true },
	{ name: 'sein', path: 'static/sein.yaml', root: 'sein.yaml', required: true },
	{
		name: 'synthetic_inheritance',
		path: 'static/synthetic_inheritance.yaml',
		root: 'synthetic_inheritance.yaml',
		required: false
	}
];

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function run(
	args: string[],
	stdin: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn('uv', args, { cwd: REPO_ROOT });
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf-8');
		child.stderr.setEncoding('utf-8');
		child.stdout.on('data', (c: string) => (stdout += c));
		child.stderr.on('data', (c: string) => (stderr += c));
		child.on('error', reject);
		child.on('close', (code) => resolve({ stdout, stderr, code }));
		child.stdin.end(stdin);
	});
}

// ---------------------------------------------------------------------------
// 1. native LinkML verifier (embedded Python; never imports produce.py)
// ---------------------------------------------------------------------------

const PY_VERIFIER = String.raw`
import json, re, sys

from linkml_runtime.utils.schemaview import SchemaView
from linkml.generators.erdiagramgen import ERDiagramGenerator

def parse_mapping(mapping):
    colon = mapping.find(":")
    if colon < 0:
        return None, None
    remainder = mapping[colon + 1:]
    dot = remainder.find(".")
    if dot < 0:
        return None, None
    return remainder[:dot], remainder[dot + 1:]

def display_name(slot):
    if slot is None:
        return None
    return str(slot.alias) if slot.alias else str(slot.name)

def verify(schema_path):
    sv = SchemaView(schema_path)
    class_surface = set(sv.all_classes().keys())

    counts = {
        "classes_total": 0, "classes_non_abstract": 0,
        "identifiers": 0, "keys": 0,
        "fk_slots_total": 0, "fk_slots_cross": 0, "fk_slots_self": 0,
        "etl_relationships": 0,
    }

    ident_class_slots = []
    classes = []
    relationships = []

    for class_name in sorted(class_surface):
        cd = sv.get_class(class_name)
        ident = sv.get_identifier_slot(class_name)
        key = sv.get_key_slot(class_name)
        slots = []
        for islot in sv.class_induced_slots(class_name):
            slot_name = str(islot.name)
            range_name = str(islot.range) if islot.range else ""
            if not range_name:
                range_kind, range_target = "type", None
            elif sv.get_class(range_name):
                range_kind, range_target = "class", range_name
            elif sv.get_enum(range_name):
                range_kind, range_target = "enum", None
            else:
                range_kind, range_target = "type", None

            domain_of = [str(d) for d in (islot.domain_of or [])]
            if class_name in domain_of:
                declared_by = class_name
            elif len(domain_of) == 1:
                declared_by = domain_of[0]
            else:
                declared_by = None
            inherited_from = declared_by if declared_by and declared_by != class_name else None

            exact = [str(m) for m in (islot.exact_mappings or [])]
            slot = {
                "name": str(islot.alias) if islot.alias else slot_name,
                "slot_name": slot_name,
                "range": range_name,
                "range_kind": range_kind,
                "range_target": range_target,
                "identifier": bool(islot.identifier),
                "key": bool(islot.key),
                "required": bool(islot.required),
                "multivalued": bool(islot.multivalued),
                "description": str(islot.description or ""),
                "exact_mappings": exact,
                "declared_by": declared_by,
                "inherited_from": inherited_from,
                "from_schema": str(islot.from_schema) if islot.from_schema else None,
            }
            slots.append(slot)

            if slot["identifier"]:
                counts["identifiers"] += 1
                if range_kind == "class":
                    ident_class_slots.append({"class": class_name, "slot_name": slot_name})
            if slot["key"]:
                counts["keys"] += 1

            if range_kind == "class" and not slot["identifier"]:
                counts["fk_slots_total"] += 1
                self_ref = range_target == class_name
                if self_ref:
                    counts["fk_slots_self"] += 1
                else:
                    counts["fk_slots_cross"] += 1
                relationships.append({
                    "kind": "fk",
                    "source_class": class_name,
                    "target_class": range_target,
                    "slot_name": slot_name,
                    "target_slot_name": (str(sv.get_identifier_slot(range_target).name)
                                         if sv.get_identifier_slot(range_target) else None),
                    "required": slot["required"],
                    "self_reference": self_ref,
                })

            for mapping in exact:
                target, target_slot = parse_mapping(mapping)
                if target and target in class_surface and target != class_name:
                    counts["etl_relationships"] += 1
                    relationships.append({
                        "kind": "etl",
                        "source_class": class_name,
                        "target_class": target,
                        "slot_name": slot_name,
                        "target_slot_name": target_slot,
                        "required": False,
                        "self_reference": False,
                    })

        counts["classes_total"] += 1
        if not cd.abstract:
            counts["classes_non_abstract"] += 1

        classes.append({
            "name": class_name,
            "abstract": bool(cd.abstract),
            "group": (lambda a: (None if a is None else str(getattr(a, "value", a))))(
                (cd.annotations or {}).get("group")),
            "from_schema": str(cd.from_schema) if cd.from_schema else None,
            "pk_slot_name": str(ident.name) if ident else None,
            "key_slot_name": str(key.name) if key else None,
            "slots": slots,
        })

    relationships.sort(key=lambda r: (r["kind"], r["source_class"], r["target_class"], r["slot_name"]))

    return {
        "schema": {
            "name": str(sv.schema.name or ""),
            "id": str(sv.schema.id or ""),
            "imports_closure": list(sv.imports_closure()),
        },
        "classes": classes,
        "relationships": relationships,
        "counts": counts,
        "ident_class_slots": ident_class_slots,
    }

# --- generators (corroborating independent consumers of the authority) ---

def generated_views(schema_path, sv):
    class_names = list(sv.all_classes().keys())

    erd = {"ok": False, "entities": [], "relationships": [], "error": None}
    try:
        gen = ERDiagramGenerator(schema_path)
        fmt = {}
        for c in class_names:
            fmt[gen.formatted_element_name(sv.get_class(c)) or c] = c
        out = gen.serialize()
        entities = set()
        rels = set()
        for line in out.splitlines():
            line = line.strip()
            ent = re.match(r"^([A-Za-z0-9_]+)\s*\{$", line)
            if ent:
                entities.add(fmt.get(ent.group(1), ent.group(1)))
                continue
            m = re.match(r'^([A-Za-z0-9_]+)\s+[|o{}<>-]*--[|o{}<>-]*\s+([A-Za-z0-9_]+)\s*:\s*"([^"]+)"$', line)
            if m:
                src = fmt.get(m.group(1), m.group(1))
                tgt = fmt.get(m.group(2), m.group(2))
                for s in m.group(3).split(","):
                    rels.add((src, tgt, s.strip()))
        erd = {
            "ok": True,
            "entities": sorted(entities),
            "relationships": [{"source_class": s, "target_class": t, "slot_name": sl}
                              for (s, t, sl) in sorted(rels)],
            "error": None,
        }
    except Exception as e:  # noqa: BLE001 - the failure is reported
        erd["error"] = "%s: %s" % (type(e).__name__, e)

    sql = {"ok": False, "tables": [], "fks": [], "error": None}
    try:
        from linkml.generators.sqltablegen import SQLTableGenerator
        gen = SQLTableGenerator(schema_path)
        fmt = {}
        for c in class_names:
            fmt[gen.formatted_element_name(sv.get_class(c)) or c] = c
        ddl = gen.serialize()
        tables = set()
        fks = set()
        for tm in re.finditer(r'CREATE TABLE\s+"([^"]+)"\s*\((.*?)\);', ddl, re.S):
            table = tm.group(1)
            tables.add(fmt.get(table, table))
            for fkm in re.finditer(
                r'FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+"([^"]+)"\s*\(([^)]*)\)',
                tm.group(2), re.I
            ):
                cols = [c.strip().strip('"') for c in fkm.group(1).split(",")]
                refs = [c.strip().strip('"') for c in fkm.group(3).split(",")]
                if len(cols) != len(refs):
                    cols = [" ".join(cols)] if len(cols) > 1 else cols
                    refs = [" ".join(refs)] if len(refs) > 1 else refs
                for col, refcol in zip(cols, refs):
                    fks.add((fmt.get(table, table), fmt.get(fkm.group(2), fkm.group(2)), col))
        sql = {
            "ok": True,
            "tables": sorted(tables),
            "fks": [{"source_class": s, "target_class": t, "slot_name": sl}
                    for (s, t, sl) in sorted(fks)],
            "error": None,
        }
    except Exception as e:  # noqa: BLE001 - the failure is reported
        sql["error"] = "%s: %s" % (type(e).__name__, e)

    return {"erd": erd, "sql": sql}

# --- native generator lifecycle (independent of produce.py) ---

def limitation(exc):
    entry = {"error": type(exc).__name__, "detail": str(exc)[:200]}
    import os as _os
    import traceback as _tb
    if isinstance(exc, RecursionError) and exc.__traceback__ is not None:
        frames = _tb.extract_tb(exc.__traceback__)
        if frames:
            counts = {}
            for f in frames:
                k = (f.filename, f.lineno, f.name)
                counts[k] = counts.get(k, 0) + 1
            fname, lineno, name = max(counts, key=lambda k: counts[k])
            entry["kind"] = "upstream_recursion"
            entry["site"] = "%s:%d:%s" % (_os.path.basename(fname), lineno, name)
    return entry

def lifecycle_reconciliation(schema_path, cycles):
    import types as _types
    out = {
        "implements_lifecycle": False, "ok": False,
        "classes": 0, "slots": 0, "enums": [], "native_limitation": None,
    }
    try:
        from linkml.generators.jsonschemagen import JsonSchemaGenerator
        from linkml.generators.common.lifecycle import LifecycleMixin
        gen = JsonSchemaGenerator(schema_path)
        out["implements_lifecycle"] = issubclass(JsonSchemaGenerator, LifecycleMixin)
    except Exception as e:  # noqa: BLE001
        out["native_limitation"] = limitation(e)
        out["native_limitation"]["metamodel_cycles"] = cycles
        return out
    obs_cls, obs_slot, obs_enum = set(), set(), set()
    def ac(self, cls, sv): obs_cls.add(cls.source.name); return cls
    def asl(self, slot, cls, sv): obs_slot.add((cls.name, slot.source.name)); return slot
    def ae(self, enum, sv): obs_enum.add(enum.source.name); return enum
    gen.after_generate_class = _types.MethodType(ac, gen)
    gen.after_generate_class_slot = _types.MethodType(asl, gen)
    gen.after_generate_enum = _types.MethodType(ae, gen)
    try:
        gen.serialize()
    except Exception as e:  # noqa: BLE001
        out["native_limitation"] = limitation(e)
        out["native_limitation"]["metamodel_cycles"] = cycles
        return out
    out["ok"] = True
    out["classes"] = len(obs_cls)
    out["slots"] = len(obs_slot)
    out["enums"] = sorted(obs_enum)
    return out

# --- SchemaView-native range/identity reconciliation (independent of produce.py) ---
#
# The LinkML metamodel is self-describing: SlotDefinition.range points at a
# ClassDefinition | TypeDefinition | EnumDefinition, and for a non-inlined class
# range the generators descend ClassDefinition -> get_identifier_slot() ->
# SlotDefinition.range and recurse. A self-referential class-range identifier
# closes that edge into a cycle. SchemaView's own resolvers already resolve those
# circular metamodel relationships: slot_applicable_range_elements returns the
# metamodel element kinds, slot_range_as_union returns the resolved range, and
# get_identifier_slot returns identity. The fixed point (a class-range identifier
# whose induced range is the range class itself) is the generators' recursion
# cycle, read straight from SchemaView's outputs — no visited id() set.

def applicable_range_elements(sv, slot):
    try:
        return list(sv.slot_applicable_range_elements(slot))
    except Exception:
        return []

def range_reconciliation(sv, result):
    from linkml_runtime.linkml_model.meta import ClassDefinition, EnumDefinition
    records = []
    cycles = set()
    gaps = []
    fact_target = {}
    for cls in result["classes"]:
        for s in cls["slots"]:
            fact_target[(cls["name"], s["slot_name"])] = (s["range_kind"], s["range_target"])
    for cname in sorted(c["name"] for c in result["classes"]):
        for islot in sv.class_induced_slots(cname):
            elements = applicable_range_elements(sv, islot)
            if ClassDefinition.class_name not in elements:
                continue
            range_name = str(islot.range) if islot.range else ""
            sn = str(islot.name)
            identifier = sv.get_identifier_slot(range_name)
            if identifier is None:
                terminal_kind, cycle, path = "class", False, [range_name]
            else:
                identifier_elements = applicable_range_elements(sv, identifier)
                identifier_ranges = sv.slot_range_as_union(identifier)
                if (ClassDefinition.class_name in identifier_elements
                        and range_name in identifier_ranges):
                    terminal_kind, cycle, path = "class", True, [range_name, range_name]
                elif ClassDefinition.class_name in identifier_elements:
                    terminal_kind, cycle, path = "class", False, [range_name, str(identifier.range)]
                elif EnumDefinition.class_name in identifier_elements:
                    terminal_kind, cycle, path = "enum", False, [range_name]
                else:
                    terminal_kind, cycle, path = "type", False, [range_name]
            records.append({
                "class": cname, "slot_name": sn,
                "range": range_name,
                "range_kind": "class", "range_target": range_name,
                "terminal_kind": terminal_kind,
                "cycle": cycle, "path": path,
            })
            if cycle:
                cycles.add(range_name)
            expected = fact_target.get((cname, sn))
            if expected != ("class", range_name):
                gaps.append({"kind": "range_fact_mismatch", "class": cname, "slot_name": sn})
    records.sort(key=lambda r: (r["class"], r["slot_name"]))
    return {
        "api": {
            "range_element_kinds": "SchemaView.slot_applicable_range_elements(slot) -> class_definition | enum_definition | type_definition",
            "generator_recursion_edge": "SlotDefinition.range -> get_identifier_slot() -> SlotDefinition.range (the descent jsonschemagen.get_type_info_for_slot_subschema and sqltablegen.get_sql_range follow for a non-inlined class range)",
            "cycle_authority": "a class-range identifier whose SchemaView-resolved induced range is the range class itself is the generators' fixed point; recorded from SchemaView.slot_range_as_union(get_identifier_slot(range)), never from a visited id() set",
            "range_result": "linkml.generators.common.build.RangeResult declares no source field and is emitted by no installed lifecycle hook; the equivalent range facts are produced from SchemaView's own range/identity resolvers (this reconciliation)",
        },
        "count": len(records),
        "cycles": sorted(cycles),
        "range_results": records,
        "gaps": gaps,
    }

def main():
    schema_path = sys.argv[1]
    sv = SchemaView(schema_path)
    result = verify(schema_path)
    result["generators"] = generated_views(schema_path, sv)
    result["range_reconciliation"] = range_reconciliation(sv, result)
    result["lifecycle"] = lifecycle_reconciliation(
        schema_path, result["range_reconciliation"]["cycles"])
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")

main()
`;

interface NativeResult {
	schema: { name: string; id: string; imports_closure: string[] };
	classes: unknown[];
	relationships: unknown[];
	counts: Record<string, number>;
	ident_class_slots: { class: string; slot_name: string }[];
	generators: {
		erd: { ok: boolean; entities: string[]; relationships: unknown[]; error: string | null };
		sql: { ok: boolean; tables: string[]; fks: unknown[]; error: string | null };
	};
	lifecycle: {
		implements_lifecycle: boolean;
		ok: boolean;
		classes: number;
		slots: number;
		enums: string[];
		native_limitation: { error: string; detail: string } | null;
	};
	range_reconciliation: unknown;
}

// ---------------------------------------------------------------------------
// normalisation + diffing
// ---------------------------------------------------------------------------

function slotView(s: any) {
	return {
		name: s.name,
		slot_name: s.slot_name,
		range: s.range,
		range_kind: s.range_kind,
		range_target: s.range_target ?? null,
		identifier: s.identifier,
		key: s.key,
		required: s.required,
		multivalued: s.multivalued,
		exact_mappings: [...(s.exact_mappings ?? [])],
		declared_by: s.declared_by ?? null,
		inherited_from: s.inherited_from ?? null,
		from_schema: s.from_schema ?? null
	};
}

function classView(c: any) {
	return {
		name: c.name,
		abstract: c.abstract,
		group: c.group ?? null,
		from_schema: c.from_schema ?? null,
		pk_slot_name: c.pk_slot_name ?? null,
		key_slot_name: c.key_slot_name ?? null,
		slots: [...(c.slots ?? [])].map(slotView)
	};
}

function relView(r: any) {
	return {
		kind: r.kind,
		source_class: r.source_class,
		target_class: r.target_class,
		slot_name: r.slot_name,
		target_slot_name: r.target_slot_name ?? null,
		required: r.required,
		self_reference: r.self_reference
	};
}

function sortJson(v: unknown): unknown {
	if (Array.isArray(v)) return [...v].map(sortJson);
	if (v && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v).sort()) out[k] = sortJson((v as any)[k]);
		return out;
	}
	return v;
}

const canon = (v: unknown) => JSON.stringify(sortJson(v));

function collectDiffs(path: string, a: unknown, b: unknown, out: string[]): void {
	if (out.length >= 40) return;
	if (canon(a) === canon(b)) return;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) out.push(`${path}: length ${a.length} != ${b.length}`);
		const n = Math.max(a.length, b.length);
		for (let i = 0; i < n; i++) collectDiffs(`${path}[${i}]`, a[i], b[i], out);
		return;
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const k of [...keys].sort()) {
			collectDiffs(path ? `${path}.${k}` : k, (a as any)[k], (b as any)[k], out);
		}
		return;
	}
	out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

function compare(label: string, producer: unknown, other: unknown) {
	const diffs: string[] = [];
	collectDiffs(label, producer, other, diffs);
	return { equal: diffs.length === 0, diffs };
}

// ---------------------------------------------------------------------------
// expected viewer state from the producer artefact (declared projection)
// ---------------------------------------------------------------------------

const SLOT_KEY_SEP = '\x00';

function expectedViewerClasses(art: any) {
	const fkSlots = new Set<string>(
		(art.relationships ?? [])
			.filter((r: any) => r.kind === 'fk')
			.map((r: any) => `${r.source_class}${SLOT_KEY_SEP}${r.slot_name}`)
	);
	const classes: Record<string, any> = {};
	for (const cls of art.classes ?? []) {
		if (cls.abstract) continue;
		classes[cls.name] = {
			name: cls.name,
			description: cls.description,
			pk_slot: cls.pk_slot ?? null,
			group: cls.group ?? null,
			from_schema: cls.from_schema ?? null,
			slots: (cls.slots ?? []).map((s: any) => ({
				name: s.name,
				slot_name: s.slot_name,
				range: s.range,
				required: s.required,
				identifier: s.identifier,
				multivalued: s.multivalued,
				is_fk: fkSlots.has(`${cls.name}${SLOT_KEY_SEP}${s.slot_name}`),
				exact_mappings: [...(s.exact_mappings ?? [])],
				range_kind: s.range_kind,
				range_target: s.range_target ?? null,
				declared_by: s.declared_by ?? null,
				inherited_from: s.inherited_from ?? null,
				from_schema: s.from_schema ?? cls.from_schema ?? art.schema?.id
			}))
		};
	}
	return classes;
}

function expectedViewerRelationships(art: any) {
	return (art.relationships ?? [])
		.filter((r: any) => !(r.kind === 'fk' && r.self_reference))
		.map((r: any) => ({
			kind: r.kind,
			source: r.source_class,
			target: r.target_class,
			slot: r.slot,
			slot_name: r.slot_name,
			target_slot: r.target_slot ?? null,
			target_slot_name: r.target_slot_name ?? null,
			required: r.required
		}))
		.sort((a: any, b: any) => canon(a).localeCompare(canon(b)));
}

function actualViewer(viewer: any) {
	const classes: Record<string, any> = {};
	for (const [name, cls] of Object.entries<any>(viewer.classes)) {
		classes[name] = {
			name: cls.name,
			description: cls.description,
			pk_slot: cls.pk_slot ?? null,
			group: cls.group ?? null,
			from_schema: cls.from_schema ?? null,
			slots: cls.slots.map((s: any) => ({
				name: s.name,
				slot_name: s.slot_name,
				range: s.range,
				required: s.required,
				identifier: s.identifier,
				multivalued: s.multivalued,
				is_fk: s.is_fk,
				exact_mappings: [...(s.exact_mappings ?? [])],
				range_kind: s.range_kind,
				range_target: s.range_target ?? null,
				declared_by: s.declared_by ?? null,
				inherited_from: s.inherited_from ?? null,
				from_schema: s.from_schema
			}))
		};
	}
	const relationships = viewer.relationships
		.map((r: any) => ({
			kind: r.kind,
			source: r.source,
			target: r.target,
			slot: r.slot,
			slot_name: r.slot_name,
			target_slot: r.target_slot ?? null,
			target_slot_name: r.target_slot_name ?? null,
			required: r.required
		}))
		.sort((a: any, b: any) => canon(a).localeCompare(canon(b)));
	return { classes, relationships };
}

// ---------------------------------------------------------------------------
// generator corroboration
// ---------------------------------------------------------------------------

function generatorCheck(fixture: Fixture, native: NativeResult, producer: any) {
	const notes: string[] = [];
	const diffs: string[] = [];
	const classNames = producer.classes.map((c: any) => c.name).sort();
	const prodFk = new Set(
		producer.relationships
			.filter((r: any) => r.kind === 'fk')
			.map((r: any) => `${r.source_class}\x00${r.target_class}\x00${r.slot_name}`)
	);

	// ERD entities should cover the class surface.
	const erdEntities = native.generators.erd.entities;
	if (!native.generators.erd.ok) {
		notes.push(`erdiagramgen unavailable: ${native.generators.erd.error}`);
	} else {
		const d: string[] = [];
		collectDiffs('erd.entities', classNames, erdEntities, d);
		for (const line of d) diffs.push(line);
	}

	// ERD relationships are compared at the (source, target) edge level: the
	// ERDiagram serialiser labels a relationship with BOTH the slot name and
	// the target identifier name, so its per-slot labels are not a clean slot
	// list. Edge-level: producer FK edges must all appear in the ERD; ERD-only
	// edges are acceptable only as identifier-range SELF edges (ERDiagram draws
	// an identifying self-loop for a class-range identifier, which the producer
	// deliberately excludes from FK).
	const prodEdges = new Set(
		producer.relationships
			.filter((r: any) => r.kind === 'fk')
			.map((r: any) => `${r.source_class}\x00${r.target_class}`)
	);
	const erdEdges = new Set(
		native.generators.erd.relationships.map(
			(r: any) => `${r.source_class}\x00${r.target_class}`
		)
	);
	const identClasses = new Set(
		native.ident_class_slots.map((s) => s.class)
	);
	for (const k of prodEdges) {
		if (!erdEdges.has(k)) diffs.push(`erd.relationships: producer FK edge missing in ERD: ${k.replace(/\x00/g, '.')}`);
	}
	for (const k of erdEdges) {
		if (prodEdges.has(k)) continue;
		const [src, tgt] = k.split('\x00');
		if (src === tgt && identClasses.has(src)) {
			notes.push(`erd convention delta: identifier-range self edge drawn by ERDiagram but excluded from FK by producer: ${src}`);
		} else {
			diffs.push(`erd.relationships: ERD-only edge not an identifier-range self edge: ${k.replace(/\x00/g, '.')}`);
		}
	}

	// SQL DDL tables == class surface; FK constraints == producer FK set.
	if (!native.generators.sql.ok) {
		notes.push(`sqltablegen unavailable: ${native.generators.sql.error}`);
	} else {
		const d: string[] = [];
		collectDiffs('sql.tables', classNames, native.generators.sql.tables, d);
		for (const line of d) diffs.push(line);
		const sqlFk = new Set(
			native.generators.sql.fks.map(
				(r: any) => `${r.source_class}\x00${r.target_class}\x00${r.slot_name}`
			)
		);
		collectDiffs('sql.fks', [...prodFk].sort(), [...sqlFk].sort(), diffs);
	}

	return { diffs, notes };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const appPathsStub: Plugin = {
	name: 'app-paths-stub',
	resolveId(id) {
		if (id === '$app/paths') return '\0app-paths';
	},
	load(id) {
		if (id === '\0app-paths') return 'export const base = "";';
	}
};

async function main() {
	const server = await createServer({
		configFile: false,
		root: REPO_ROOT,
		logLevel: 'silent',
		server: { middlewareMode: true },
		appType: 'custom',
		plugins: [appPathsStub]
	});

	const report: any = { invariant: 'native LinkML == producer == viewer', fixtures: {}, gaps: [] };
	try {
		const linkml = await server.ssrLoadModule('/src/lib/linkml.ts');
		const project = linkml.projectReconciledArtifact as (a: unknown) => any;

		for (const fixture of FIXTURES) {
			const schemaPath = join(REPO_ROOT, fixture.path);
			const source = readFileSync(schemaPath, 'utf8');

			// 1. native LinkML execution (+ generators)
			const nativeRun = await run([...UV, 'python', '-', schemaPath], PY_VERIFIER);
			if (nativeRun.code !== 0) {
				const gap = `${fixture.name}: native LinkML verifier failed: ${nativeRun.stderr.trim() || nativeRun.code}`;
				report.gaps.push(gap);
				report.fixtures[fixture.name] = { pass: false, error: gap, required: fixture.required };
				continue;
			}
			const native = JSON.parse(nativeRun.stdout) as NativeResult;

			// 2. producer — checked-in artefact + fresh, digest-reproducing run.
			//    --schema keeps the repo-relative provenance label used by --all,
			//    so the fresh artefact (and its output_digest) must equal the
			//    checked-in one byte-for-byte.
			const checkedIn = JSON.parse(
				readFileSync(join(REPO_ROOT, 'static', 'reconciled', `${fixture.name}.json`), 'utf8')
			);
			const tmp = mkdtempSync(join(tmpdir(), 'reconcile-check-'));
			const freshOut = join(tmp, `${fixture.name}.json`);
			const freshRun = await run(
				[
					...UV,
					join(REPO_ROOT, 'produce.py'),
					'--schema',
					fixture.path,
					'--name',
					fixture.name,
					'--out',
					freshOut
				],
				''
			);
			if (freshRun.code !== 0) {
				const gap = `${fixture.name}: producer failed: ${freshRun.stderr.trim() || freshRun.code}`;
				report.gaps.push(gap);
				report.fixtures[fixture.name] = { pass: false, error: gap, required: fixture.required };
				continue;
			}
			const fresh = JSON.parse(readFileSync(freshOut, 'utf8'));

			// 3. viewer via the production projection
			const viewer = project(checkedIn);
			const av = actualViewer(viewer);

			const comparisons: Record<string, unknown> = {};

			// 2a. reproducibility: checked-in artefact == fresh producer run
			comparisons.reproducible = compare('artifact', checkedIn, fresh);
			comparisons.reproducibleDigest = {
				equal: checkedIn.reproducibility?.output_digest === fresh.reproducibility?.output_digest,
				diffs:
					checkedIn.reproducibility?.output_digest === fresh.reproducibility?.output_digest
						? []
						: [
								`output_digest: ${checkedIn.reproducibility?.output_digest} != ${fresh.reproducibility?.output_digest}`
							]
			};

			// 2b. native LinkML == producer
			const nativeVsProducer = {
				classes: compare(
					'classes',
					checkedIn.classes.map(classView),
					native.classes.map(classView)
				),
				relationships: compare(
					'relationships',
					[...checkedIn.relationships].map(relView).sort(byCanon),
					[...native.relationships].map(relView).sort(byCanon)
				),
				counts: compare('counts', checkedIn.counts, native.counts),
				imports_closure: compare(
					'imports_closure',
					checkedIn.schema.imports_closure,
					native.schema.imports_closure
				),
				range_reconciliation: compare(
					'range_reconciliation',
					checkedIn.generator_reconciliation?.range_reconciliation,
					native.range_reconciliation
				)
			};

			// 3b. viewer == producer (declared projection)
			const viewerVsProducer = {
				classes: compare(
					'classes',
					expectedViewerClasses(checkedIn),
					av.classes
				),
				relationships: compare(
					'relationships',
					expectedViewerRelationships(checkedIn),
					av.relationships
				)
			};

			// 4. generator corroboration (independent ERD/SQL surface diff)
			const generators = generatorCheck(fixture, native, checkedIn);

			// 4b. native generator lifecycle == producer's recorded lifecycle
			//     reconciliation. The producer drives JsonSchemaGenerator through
			//     its native LifecycleMixin build path; this independently re-runs
			//     that build and diffs the emitted BuildResult surface.
			const lifecycleView = (l: any) => ({
				implements_lifecycle: l?.implements_lifecycle ?? false,
				ok: l?.ok ?? false,
				classes: l?.classes ?? 0,
				slots: l?.slots ?? 0,
				enums: [...(l?.enums ?? [])],
				native_limitation: l?.native_limitation ?? null
			});
			const lifecycle = compare(
				'lifecycle',
				lifecycleView(checkedIn.generator_reconciliation?.lifecycle),
				lifecycleView(native.lifecycle)
			);
			// The producer must have recorded no reconciliation gaps of its own.
			const producerGaps: unknown[] = checkedIn.generator_reconciliation?.gaps ?? [];

			const allDiffs: string[] = [];
			if (!lifecycle.equal) for (const d of lifecycle.diffs) allDiffs.push(`lifecycle.${d}`);
			if (producerGaps.length)
				allDiffs.push(`generatorReconciliation.gaps: ${JSON.stringify(producerGaps)}`);
			for (const [k, v] of Object.entries<any>(nativeVsProducer)) {
				if (!v.equal) for (const d of v.diffs) allDiffs.push(`nativeVsProducer.${k}.${d}`);
			}
			for (const [k, v] of Object.entries<any>(viewerVsProducer)) {
				if (!v.equal) for (const d of v.diffs) allDiffs.push(`viewerVsProducer.${k}.${d}`);
			}
			if (!comparisons.reproducible.equal)
				for (const d of comparisons.reproducible.diffs)
					allDiffs.push(`reproducible.${d}`);
			if (!comparisons.reproducibleDigest.equal)
				for (const d of comparisons.reproducibleDigest.diffs)
					allDiffs.push(`reproducibleDigest.${d}`);
			for (const d of generators.diffs) allDiffs.push(`generators.${d}`);

			const pass = allDiffs.length === 0;
			if (!pass) report.gaps.push(`${fixture.name}: ${allDiffs.length} diff(s)`);

			report.fixtures[fixture.name] = {
				required: fixture.required,
				pass,
				classes: checkedIn.classes.length,
				relationships: checkedIn.relationships.length,
				counts: checkedIn.counts,
				digest: checkedIn.reproducibility?.output_digest,
				comparisons: {
					reproducible: comparisons.reproducible,
					reproducibleDigest: comparisons.reproducibleDigest,
					nativeVsProducer,
					viewerVsProducer,
					lifecycle
				},
				generatorReconciliation: {
					gaps: producerGaps,
					lifecycle: checkedIn.generator_reconciliation?.lifecycle,
					rangeReconciliation: {
						count: checkedIn.generator_reconciliation?.range_reconciliation?.count,
						cycles: checkedIn.generator_reconciliation?.range_reconciliation?.cycles,
						gaps: checkedIn.generator_reconciliation?.range_reconciliation?.gaps
					},
					generators: checkedIn.generator_reconciliation?.generators
				},
				generators: {
					erd: { ok: native.generators.erd.ok, entities: native.generators.erd.entities.length },
					sql: { ok: native.generators.sql.ok, tables: native.generators.sql.tables.length },
					notes: generators.notes,
					diffs: generators.diffs
				},
				diffs: allDiffs
			};
		}
	} finally {
		await server.close();
	}

	report.ok = report.gaps.length === 0;
	process.stdout.write(JSON.stringify(report, null, 2) + '\n');
	if (!report.ok) process.exitCode = 1;
}

function byCanon(a: unknown, b: unknown) {
	return canon(a).localeCompare(canon(b));
}

await main();
