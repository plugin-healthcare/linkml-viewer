#!/usr/bin/env python3
"""Authoritative LinkML producer for the linkml-viewer (native-pipeline entry).

This is a thin *execution boundary*, not another LinkML implementation. It is
invoked directly by ``vite.config.ts`` (the native Vite/SvelteKit pipeline), so
there is no standalone producer directory or HTTP service beside the app.

It loads a schema with the installed ``linkml`` / ``linkml_runtime`` (pinned to
1.11.1) and serialises the facts the viewer consumes — classes, effective
(induced) slots, and relationships — into a deterministic JSON artefact.

Invocation is driven by the Vite plugin:

    # bundled schemas -> static/reconciled/<name>.json (dev server start + build)
    uv run --with linkml==1.11.1 --python 3.12 produce.py --all

    # upload / hand-edited workspace (Vite dev middleware POST /reconcile)
    printf '%s' '<payload-json>' | \
        uv run --with linkml==1.11.1 --python 3.12 produce.py --reconcile

Nothing here re-implements LinkML semantics. Every value is read from an
installed implementation:

  * ``linkml_runtime.utils.schemaview.SchemaView`` — ``all_classes``,
    ``all_enums``, ``all_types``, ``get_class`` / ``get_enum`` / ``get_type``,
    ``get_identifier_slot``, ``get_key_slot``, ``class_induced_slots``,
    ``slot_applicable_range_elements``, ``slot_range_as_union``,
    ``imports_closure``.
  * The induced ``SlotDefinition`` supplied by SchemaView (``name``, ``alias``,
    ``range``, ``identifier``, ``key``, ``required``, ``multivalued``,
    ``description``, ``exact_mappings``, ``domain_of``, ``from_schema``).

The only projections performed here are mechanical relabellings of that
authority output, each recorded in ``reproducibility.producer_projections``:

  * ``range_kind`` / ``range_target`` — the metamodel kind of the resolved
    range, decided by ``get_class`` / ``get_enum`` / ``get_type`` membership.
  * ``name`` — ``alias`` when set, else the canonical ``slot_name`` (LinkML's
    own alias mechanic; no prefix stripping is invented here).
  * ``declared_by`` / ``inherited_from`` — from the induced slot's ``domain_of``
    (see ``producer_projections`` for the exact rule).
  * ETL targets — the class segment of an ``exact_mappings`` CURIE
    (``prefix:Class.slot``), emitted only when it names a local class.
  * ``target_slot`` / ``target_slot_name`` — the per-relationship target anchor
    column. For an FK it is the target class's identifier slot
    (``get_identifier_slot``); for an ETL relationship it is the slot segment of
    the ``exact_mappings`` CURIE, resolved against the target class's induced
    slots. This keeps the anchor a reconciled fact instead of a viewer
    re-derivation.

Generator fidelity is reconciled through LinkML's **native generator
lifecycle** (``linkml.generators.common``), not an ad-hoc harness: the
lifecycle-capable ``JsonSchemaGenerator`` is driven through ``LifecycleMixin``
and its ``BuildResult`` records (``ClassResult`` / ``SlotResult`` /
``EnumResult``) are reconciled against the SchemaView facts, while
``ERDiagramGenerator`` / ``SQLTableGenerator`` are run natively and their
surfaces reconciled. Generator limitations (self-referential-range
``RecursionError``) and convention deltas (identifying self-loops) are recorded
under ``generator_reconciliation`` — never replaced by a bespoke algorithm.

The LinkML metamodel is itself self-describing: ``SlotDefinition.range`` points
back at a ``ClassDefinition`` | ``TypeDefinition`` | ``EnumDefinition``, and a
self-referential class-range identifier closes the
``ClassDefinition -> get_identifier_slot() -> SlotDefinition.range`` edge into a
cycle. The generators traverse that edge without a visited identity and recurse
until ``RecursionError``. The producer reconciles that range/identity surface
with **SchemaView's own native resolvers** — the virtual schema that already
resolves the metamodel's circular relationships without recursion —
``slot_applicable_range_elements`` (the metamodel kinds
``class_definition``/``enum_definition``/``type_definition``),
``slot_range_as_union``, ``get_identifier_slot`` and ``class_induced_slots`` —
under ``generator_reconciliation.range_reconciliation``. The cycle is read from
SchemaView's outputs (the class-range identifier whose induced range is the
class itself is the generator's fixed point), never from a hand-rolled visited
``id()`` set. The upstream generator failures are recorded precisely (recursion
site + metamodel cycles), not papered over.

The producer never outputs an ``ErdSlot`` / viewer shape and never defines an
``is_fk`` / ``collectEdges`` / ``effectiveRawSlots`` algorithm.

The ``--reconcile`` mode is an execution boundary only: it materialises the
uploaded workspace into a temporary directory and calls the *same*
``build_artefact``. It does not parse LinkML, classify ranges, or detect
relationships itself. SchemaView's native import resolution handles
``imports:`` between uploaded files because they are written side by side.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata as metadata
import json
import platform
import re
import sys
import tempfile
import traceback
import types
from pathlib import Path

from linkml.generators.common.build import ClassResult, EnumResult, SlotResult
from linkml.generators.common.lifecycle import LifecycleMixin
from linkml.generators.common.type_designators import get_type_designator_value
from linkml.generators.erdiagramgen import ERDiagramGenerator
from linkml.generators.jsonschemagen import JsonSchemaGenerator
from linkml.generators.sqltablegen import SQLTableGenerator
from linkml_runtime.linkml_model.meta import ClassDefinition, EnumDefinition
from linkml_runtime.utils.schemaview import SchemaView

REPO_ROOT = Path(__file__).resolve().parent

GENERATOR_NAME = "produce.py"
GENERATOR_VERSION = "1"
ARTIFACT_FORMAT = "linkml-viewer-reconciled"
ARTIFACT_VERSION = 1

# One entry point, three bundled schemas. Paths are repo-relative.
BUNDLED = {
    "omop": Path("static/omop_cdm.yaml"),
    "sein": Path("static/sein.yaml"),
    "synthetic_inheritance": Path("static/synthetic_inheritance.yaml"),
}

# The native generator lifecycle adopted by this producer (linkml 1.11.1).
# ``LifecycleMixin`` build hooks + ``BuildResult`` records are used to reconcile
# a generator's independent build of the class/enum/slot surface against the
# SchemaView facts. ``type_designators`` is the native range/designator resolver.
# The range/identity surface is reconciled through SchemaView's own resolvers
# over the metamodel's circular relationships (``range_reconciliation``);
# ``common.build.RangeResult`` is abstract (no ``source`` field, emitted by no
# hook), so it is not usable.
GENERATOR_RECONCILIATION_API = {
    "lifecycle": "linkml.generators.common.lifecycle.LifecycleMixin",
    "build": "linkml.generators.common.build.{ClassResult,SlotResult,EnumResult,RangeResult}",
    "type_designators": "linkml.generators.common.type_designators.get_type_designator_value",
    "range_identity": "linkml_runtime.utils.schemaview.SchemaView.{class_induced_slots, slot_applicable_range_elements, slot_range_as_union, get_identifier_slot} (virtual-schema resolution of SlotDefinition.range -> class_definition|enum_definition|type_definition)",
}

PRODUCER_PROJECTIONS = {
    "range_kind": "class|type|enum from SchemaView get_class/get_enum/get_type membership",
    "range_target": "the resolved range name when range_kind == class, else null",
    "name": "induced SlotDefinition.alias when set, else SlotDefinition.name",
    "declared_by": (
        "class_name if class_name in domain_of; else the sole domain_of entry when "
        "len(domain_of) == 1 (an ancestor or mixin); else null for shared multi-domain slots"
    ),
    "inherited_from": "declared_by when declared_by != class_name, else null",
    "etl_target": "class segment of an exact_mappings CURIE 'prefix:Class.slot', emitted only when it names a local class",
    "pk_slot": "display name (alias or name) of the authority's get_identifier_slot; pk_slot_name is its canonical slot name",
    "key_slot": "display name (alias or name) of the authority's get_key_slot; key_slot_name is its canonical slot name",
    "target_slot": "FK: display name of the target class's get_identifier_slot; ETL: the slot segment of the exact_mappings CURIE resolved to the target class's display name",
    "target_slot_name": "canonical slot name of the target anchor (FK: the identifier slot name; ETL: the mapping's slot segment)",
}


# ---------------------------------------------------------------------------
# helpers over the authority
# ---------------------------------------------------------------------------


def _annotation_value(annotations, key: str):
    """Read an annotation value from a SchemaView annotation map (authority data)."""
    annotation = (annotations or {}).get(key)
    if annotation is None:
        return None
    value = getattr(annotation, "value", annotation)
    return None if value is None else str(value)


def _range_facts(sv: SchemaView, range_name: str) -> tuple[str, str | None]:
    """Classify a resolved range using the authority's element resolvers."""
    if not range_name:
        return "type", None
    if sv.get_class(range_name):
        return "class", range_name
    if sv.get_enum(range_name):
        return "enum", None
    return "type", None


def _parse_mapping(mapping: str) -> tuple[str | None, str | None]:
    """Split 'prefix:Class.slot' into (Class, slot) without inventing grammar."""
    colon = mapping.find(":")
    if colon < 0:
        return None, None
    remainder = mapping[colon + 1 :]
    dot = remainder.find(".")
    if dot < 0:
        return None, None
    return remainder[:dot], remainder[dot + 1 :]


# ---------------------------------------------------------------------------
# fact extraction (execution + mechanical relabelling only)
# ---------------------------------------------------------------------------


def _slot_facts(sv: SchemaView, class_name: str, islot, class_surface: set[str]):
    slot_name = str(islot.name)
    range_name = str(islot.range) if islot.range else ""
    range_kind, range_target = _range_facts(sv, range_name)

    domain_of = [str(d) for d in (islot.domain_of or [])]
    if class_name in domain_of:
        declared_by = class_name
    elif len(domain_of) == 1:
        declared_by = domain_of[0]
    else:
        declared_by = None
    inherited_from = declared_by if declared_by and declared_by != class_name else None

    exact_mappings = [str(m) for m in (islot.exact_mappings or [])]
    etl_targets = []
    for mapping in exact_mappings:
        target, target_slot = _parse_mapping(mapping)
        if target and target in class_surface and target != class_name:
            etl_targets.append(
                {"target_class": target, "target_slot": target_slot, "mapping": mapping}
            )

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
        "exact_mappings": exact_mappings,
        "declared_by": declared_by,
        "inherited_from": inherited_from,
        "from_schema": str(islot.from_schema) if islot.from_schema else None,
    }
    return slot, range_kind, range_target, etl_targets


def _display_name(slot) -> str | None:
    """Display name (alias or canonical name) of an authority SlotDefinition."""
    if slot is None:
        return None
    return str(slot.alias) if slot.alias else str(slot.name)


def _target_anchor_maps(sv: SchemaView, class_surface: set[str]) -> dict:
    """Per-class lookup tables for the per-relationship target anchor.

    ``slot_display`` maps each class's canonical slot name to its display name;
    ``identifier_display`` / ``identifier_name`` hold the authority's
    ``get_identifier_slot`` for each class. All values are read from SchemaView.
    """
    slot_display: dict[str, dict[str, str]] = {}
    identifier_display: dict[str, str | None] = {}
    identifier_name: dict[str, str | None] = {}
    for class_name in class_surface:
        display: dict[str, str] = {}
        for islot in sv.class_induced_slots(class_name):
            display[str(islot.name)] = _display_name(islot) or str(islot.name)
        slot_display[class_name] = display
        identifier = sv.get_identifier_slot(class_name)
        identifier_display[class_name] = _display_name(identifier)
        identifier_name[class_name] = str(identifier.name) if identifier else None
    return {
        "slot_display": slot_display,
        "identifier_display": identifier_display,
        "identifier_name": identifier_name,
    }


def extract_facts(sv: SchemaView) -> dict:
    class_surface = set(sv.all_classes().keys())
    anchors = _target_anchor_maps(sv, class_surface)

    classes = []
    relationships = []
    counts = {
        "classes_total": 0,
        "classes_non_abstract": 0,
        "identifiers": 0,
        "keys": 0,
        "fk_slots_total": 0,
        "fk_slots_cross": 0,
        "fk_slots_self": 0,
        "etl_relationships": 0,
    }

    for class_name in sorted(class_surface):
        cd = sv.get_class(class_name)
        islot_list = sv.class_induced_slots(class_name)

        identifier_slot = sv.get_identifier_slot(class_name)
        key_slot = sv.get_key_slot(class_name)
        identifier_name = (
            str(identifier_slot.alias)
            if identifier_slot and identifier_slot.alias
            else (str(identifier_slot.name) if identifier_slot else None)
        )
        key_name = (
            str(key_slot.alias)
            if key_slot and key_slot.alias
            else (str(key_slot.name) if key_slot else None)
        )

        slots = []
        for islot in islot_list:
            slot, range_kind, range_target, etl_targets = _slot_facts(
                sv, class_name, islot, class_surface
            )
            slots.append(slot)

            if slot["identifier"]:
                counts["identifiers"] += 1
            if slot["key"]:
                counts["keys"] += 1

            if range_kind == "class" and not slot["identifier"]:
                counts["fk_slots_total"] += 1
                self_reference = range_target == class_name
                if self_reference:
                    counts["fk_slots_self"] += 1
                else:
                    counts["fk_slots_cross"] += 1
                relationships.append(
                    {
                        "kind": "fk",
                        "source_class": class_name,
                        "target_class": range_target,
                        "slot": slot["name"],
                        "slot_name": slot["slot_name"],
                        "target_slot": anchors["identifier_display"].get(range_target),
                        "target_slot_name": anchors["identifier_name"].get(
                            range_target
                        ),
                        "required": slot["required"],
                        "self_reference": self_reference,
                    }
                )

            for etl in etl_targets:
                counts["etl_relationships"] += 1
                etl_target = etl["target_class"]
                etl_slot_name = etl["target_slot"]
                etl_target_slot = (
                    anchors["slot_display"]
                    .get(etl_target, {})
                    .get(etl_slot_name, etl_slot_name)
                )
                relationships.append(
                    {
                        "kind": "etl",
                        "source_class": class_name,
                        "target_class": etl_target,
                        "slot": slot["name"],
                        "slot_name": slot["slot_name"],
                        "target_slot": etl_target_slot,
                        "target_slot_name": etl_slot_name,
                        "required": False,
                        "self_reference": False,
                        "mapping": etl["mapping"],
                    }
                )

        counts["classes_total"] += 1
        if not cd.abstract:
            counts["classes_non_abstract"] += 1

        classes.append(
            {
                "name": class_name,
                "description": str(cd.description or ""),
                "abstract": bool(cd.abstract),
                "group": _annotation_value(cd.annotations, "group"),
                "from_schema": str(cd.from_schema) if cd.from_schema else None,
                "pk_slot": identifier_name,
                "pk_slot_name": str(identifier_slot.name) if identifier_slot else None,
                "key_slot": key_name,
                "key_slot_name": str(key_slot.name) if key_slot else None,
                "slots": slots,
            }
        )

    relationships.sort(
        key=lambda r: (r["kind"], r["source_class"], r["target_class"], r["slot_name"])
    )

    return {
        "schema": {
            "name": str(sv.schema.name or ""),
            "id": str(sv.schema.id or ""),
            "description": str(sv.schema.description or ""),
            "imports_closure": list(sv.imports_closure()),
        },
        "classes": classes,
        "relationships": relationships,
        "counts": counts,
    }


# ---------------------------------------------------------------------------
# native generator lifecycle reconciliation
#
# LinkML 1.11.1 ships a native generator lifecycle under
# ``linkml.generators.common``: ``LifecycleMixin`` build hooks, ``BuildResult``
# records (``ClassResult`` / ``SlotResult`` / ``EnumResult`` / ``RangeResult``)
# and ``type_designators``. Only the generators that opt into that mixin
# (jsonschemagen, pydanticgen, rustgen) can be driven through it; the
# ERDiagramGenerator and SQLTableGenerator do **not** implement it.
#
# This producer therefore reconciles generator output through the native
# lifecycle and records, rather than papers over, what a generator cannot do:
#
#   * JsonSchemaGenerator is run through its native build path with a
#     LifecycleMixin recorder; the emitted ClassResult / SlotResult / EnumResult
#     records are reconciled against the SchemaView facts.
#   * ERDiagramGenerator / SQLTableGenerator are run through their native
#     ``serialize()`` path; their entity/table and FK surfaces are reconciled
#     against the same facts.
#   * A generator failure (e.g. the self-referential-range ``RecursionError``)
#     is recorded as a ``native_limitation`` — never as a replacement semantic
#     algorithm. The limitation carries the deepest repeating frame (the
#     recursion site) and the metamodel cycles SchemaView's own resolvers found.
#     ERDiagram's identifying self-loop for a class-range identifier is recorded
#     as a ``convention_delta`` (the producer excludes it from FK).
#   * The range/identity surface is reconciled through SchemaView's own
#     resolvers over the metamodel's circular relationships (see
#     ``_range_reconciliation``) into ``range_reconciliation``;
#     ``common.build.RangeResult`` is abstract and emitted by no installed hook,
#     so this is its equivalent.
# ---------------------------------------------------------------------------

_ERD_ENTITY_RE = re.compile(r"^([A-Za-z0-9_]+)\s*\{$")
_ERD_REL_RE = re.compile(
    r'^([A-Za-z0-9_]+)\s+[|o{}<>-]*--[|o{}<>-]*\s+([A-Za-z0-9_]+)\s*:\s*"([^"]+)"$'
)
_SQL_TABLE_RE = re.compile(r'CREATE TABLE\s+"([^"]+)"\s*\((.*?)\);', re.S)
_SQL_FK_RE = re.compile(
    r'FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+"([^"]+)"\s*\(([^)]*)\)', re.I
)


GENERATOR_RECURSION_EDGE = (
    "SlotDefinition.range -> get_identifier_slot() -> SlotDefinition.range "
    "(the descent jsonschemagen.get_type_info_for_slot_subschema and "
    "sqltablegen.get_sql_range follow for a non-inlined class range)"
)
RANGE_ELEMENT_KINDS = (
    "SchemaView.slot_applicable_range_elements(slot) -> "
    "class_definition | enum_definition | type_definition"
)
CYCLE_AUTHORITY = (
    "a class-range identifier whose SchemaView-resolved induced range is the "
    "range class itself is the generators' fixed point; recorded from "
    "SchemaView.slot_range_as_union(get_identifier_slot(range)), never from a "
    "visited id() set"
)


def _applicable_range_elements(sv: SchemaView, slot) -> list[str]:
    """Metamodel element kinds for a slot, via SchemaView's native resolver.

    ``slot_applicable_range_elements`` returns the metamodel class names
    (``class_definition`` / ``enum_definition`` / ``type_definition``) that a
    slot's range can be; it resolves the range through the virtual schema, so
    it is the native authority for the ``range -> Class|Type|Enum`` mapping.
    An unresolvable range yields an empty list rather than an exception.
    """
    try:
        return list(sv.slot_applicable_range_elements(slot))
    except Exception:  # noqa: BLE001 - unresolvable range is a type fallback
        return []


def _range_reconciliation(sv: SchemaView, facts: dict) -> dict:
    """RangeResult-equivalent range/identity facts from SchemaView's resolvers.

    ``linkml.generators.common.build.RangeResult`` is abstract (it declares no
    ``source`` field and no lifecycle hook emits it), so the installed generators
    never produce a usable RangeResult. The range/identity surface is instead
    produced entirely from SchemaView's own native operations over the
    metamodel's circular relationships — ``class_induced_slots`` (the induced
    slot surface), ``slot_applicable_range_elements`` (the metamodel kind),
    ``slot_range_as_union`` (the resolved range) and ``get_identifier_slot``
    (identity) — and reconciled against the viewer slot facts. There is no
    hand-rolled metamodel walk: the cycle is read from SchemaView's outputs.
    """
    records: list[dict] = []
    cycles: set[str] = set()
    gaps: list[dict] = []
    fact_target = {
        (cls["name"], slot["slot_name"]): (slot["range_kind"], slot["range_target"])
        for cls in facts["classes"]
        for slot in cls["slots"]
    }
    for class_name in sorted(cls["name"] for cls in facts["classes"]):
        for islot in sv.class_induced_slots(class_name):
            elements = _applicable_range_elements(sv, islot)
            if ClassDefinition.class_name not in elements:
                continue
            range_name = str(islot.range) if islot.range else ""
            slot_name = str(islot.name)
            identifier = sv.get_identifier_slot(range_name)
            if identifier is None:
                terminal_kind, cycle, path = "class", False, [range_name]
            else:
                identifier_elements = _applicable_range_elements(sv, identifier)
                identifier_ranges = sv.slot_range_as_union(identifier)
                if (
                    ClassDefinition.class_name in identifier_elements
                    and range_name in identifier_ranges
                ):
                    terminal_kind, cycle, path = "class", True, [range_name, range_name]
                elif ClassDefinition.class_name in identifier_elements:
                    terminal_kind, cycle, path = (
                        "class",
                        False,
                        [range_name, str(identifier.range)],
                    )
                elif EnumDefinition.class_name in identifier_elements:
                    terminal_kind, cycle, path = "enum", False, [range_name]
                else:
                    terminal_kind, cycle, path = "type", False, [range_name]
            records.append(
                {
                    "class": class_name,
                    "slot_name": slot_name,
                    "range": range_name,
                    "range_kind": "class",
                    "range_target": range_name,
                    "terminal_kind": terminal_kind,
                    "cycle": cycle,
                    "path": path,
                }
            )
            if cycle:
                cycles.add(range_name)
            observed = ("class", range_name)
            expected = fact_target.get((class_name, slot_name))
            if expected != observed:
                gaps.append(
                    {
                        "kind": "range_fact_mismatch",
                        "class": class_name,
                        "slot_name": slot_name,
                        "expected": list(expected) if expected else None,
                        "observed": list(observed),
                    }
                )
    records.sort(key=lambda r: (r["class"], r["slot_name"]))
    return {
        "api": {
            "range_element_kinds": RANGE_ELEMENT_KINDS,
            "generator_recursion_edge": GENERATOR_RECURSION_EDGE,
            "cycle_authority": CYCLE_AUTHORITY,
            "range_result": (
                "linkml.generators.common.build.RangeResult declares no source "
                "field and is emitted by no installed lifecycle hook; the "
                "equivalent range facts are produced from SchemaView's own "
                "range/identity resolvers (this reconciliation)"
            ),
        },
        "count": len(records),
        "cycles": sorted(cycles),
        "range_results": records,
        "gaps": gaps,
    }


def _limitation(exc: BaseException) -> dict:
    """Record a generator failure as a native limitation, not a gap.

    For an upstream ``RecursionError`` the deepest frame (the recursion site the
    generator could not terminate) is recorded, so the failure is precise rather
    than opaque.
    """
    entry: dict = {"error": type(exc).__name__, "detail": str(exc)[:200]}
    if isinstance(exc, RecursionError) and exc.__traceback__ is not None:
        frames = traceback.extract_tb(exc.__traceback__)
        if frames:
            # The recursion site is the frame that repeats; the deepest frame is
            # arbitrary (wherever the recursion limit happened to trip).
            counts: dict[tuple[str, int, str], int] = {}
            for frame in frames:
                key = (frame.filename, frame.lineno, frame.name)
                counts[key] = counts.get(key, 0) + 1
            filename, lineno, name = max(counts, key=lambda k: counts[k])
            entry["kind"] = "upstream_recursion"
            entry["site"] = f"{Path(filename).name}:{lineno}:{name}"
    return entry


def _set_gaps(scope: str, expected, observed) -> list[dict]:
    gaps: list[dict] = []
    missing = sorted(set(expected) - set(observed))
    extra = sorted(set(observed) - set(expected))
    if missing:
        gaps.append({"kind": "missing", "scope": scope, "names": missing})
    if extra:
        gaps.append({"kind": "unexpected", "scope": scope, "names": extra})
    return gaps


def _lifecycle_reconciliation(
    schema_path: Path, sv: SchemaView, class_names: list[str]
) -> dict:
    """Drive JsonSchemaGenerator through the native LifecycleMixin build path.

    A LifecycleMixin recorder captures the native ``BuildResult`` records the
    generator emits per class / class-slot / enum; those records are reconciled
    against the SchemaView-derived class and induced-slot surface.
    """
    result = {
        "generator": "JsonSchemaGenerator",
        "implements_lifecycle": issubclass(JsonSchemaGenerator, LifecycleMixin),
        "ok": False,
        "classes": 0,
        "slots": 0,
        "enums": [],
        "gaps": [],
        "native_limitation": None,
    }
    observed_classes: set[str] = set()
    observed_slots: set[tuple[str, str]] = set()
    observed_enums: set[str] = set()

    try:
        gen = JsonSchemaGenerator(str(schema_path))
    except Exception as exc:  # noqa: BLE001 - recorded, never substituted
        result["native_limitation"] = _limitation(exc)
        return result

    def after_class(self, cls: ClassResult, _sv: SchemaView) -> ClassResult:
        observed_classes.add(cls.source.name)
        return cls

    def after_class_slot(self, slot: SlotResult, cls, _sv: SchemaView) -> SlotResult:
        observed_slots.add((cls.name, slot.source.name))
        return slot

    def after_enum(self, enum: EnumResult, _sv: SchemaView) -> EnumResult:
        observed_enums.add(enum.source.name)
        return enum

    gen.after_generate_class = types.MethodType(after_class, gen)
    gen.after_generate_class_slot = types.MethodType(after_class_slot, gen)
    gen.after_generate_enum = types.MethodType(after_enum, gen)

    try:
        gen.serialize()
    except Exception as exc:  # noqa: BLE001 - recorded, never substituted
        result["native_limitation"] = _limitation(exc)
        return result

    expected_slots = {
        (c, str(s.name)) for c in class_names for s in sv.class_induced_slots(c)
    }
    result["ok"] = True
    result["classes"] = len(observed_classes)
    result["slots"] = len(observed_slots)
    result["enums"] = sorted(observed_enums)
    result["gaps"].extend(_set_gaps("lifecycle.classes", class_names, observed_classes))
    result["gaps"].extend(_set_gaps("lifecycle.slots", expected_slots, observed_slots))
    result["gaps"].extend(_set_gaps("lifecycle.enums", sv.all_enums(), observed_enums))
    return result


def _formatted_name_map(gen, sv: SchemaView, class_names: list[str]) -> dict[str, str]:
    fmt: dict[str, str] = {}
    for c in class_names:
        formatted = gen.formatted_element_name(sv.get_class(c)) or c
        fmt[str(formatted)] = c
    return fmt


def _erd_surface(gen, sv: SchemaView, class_names: list[str]):
    fmt = _formatted_name_map(gen, sv, class_names)
    entities: set[str] = set()
    relationships: set[tuple[str, str, str]] = set()
    for line in gen.serialize().splitlines():
        line = line.strip()
        entity = _ERD_ENTITY_RE.match(line)
        if entity:
            entities.add(fmt.get(entity.group(1), entity.group(1)))
            continue
        rel = _ERD_REL_RE.match(line)
        if rel:
            src = fmt.get(rel.group(1), rel.group(1))
            tgt = fmt.get(rel.group(2), rel.group(2))
            for slot in rel.group(3).split(","):
                relationships.add((src, tgt, slot.strip()))
    return entities, relationships


def _sql_surface(gen, sv: SchemaView, class_names: list[str]):
    fmt = _formatted_name_map(gen, sv, class_names)
    tables: set[str] = set()
    fks: set[tuple[str, str, str]] = set()
    for table_match in _SQL_TABLE_RE.finditer(gen.serialize()):
        table = table_match.group(1)
        tables.add(fmt.get(table, table))
        for fk_match in _SQL_FK_RE.finditer(table_match.group(2)):
            cols = [c.strip().strip('"') for c in fk_match.group(1).split(",")]
            refs = [c.strip().strip('"') for c in fk_match.group(3).split(",")]
            if len(cols) != len(refs):
                cols = [" ".join(cols)] if len(cols) > 1 else cols
                refs = [" ".join(refs)] if len(refs) > 1 else refs
            for col, _ref in zip(cols, refs):
                fks.add(
                    (
                        fmt.get(table, table),
                        fmt.get(fk_match.group(2), fk_match.group(2)),
                        col,
                    )
                )
    return tables, fks


def _generator_reconciliation(schema_path: Path, sv: SchemaView, facts: dict) -> dict:
    """Reconcile generator output against the SchemaView facts (native lifecycle)."""
    class_names = sorted(c["name"] for c in facts["classes"])
    fk_triples = {
        (r["source_class"], r["target_class"], r["slot_name"])
        for r in facts["relationships"]
        if r["kind"] == "fk"
    }
    fk_edges = {(s, t) for (s, t, _) in fk_triples}
    ident_classes = {
        cls["name"]
        for cls in facts["classes"]
        if any(s["identifier"] and s["range_kind"] == "class" for s in cls["slots"])
    }

    lifecycle = _lifecycle_reconciliation(schema_path, sv, class_names)
    range_reconciliation = _range_reconciliation(sv, facts)
    if lifecycle.get("native_limitation"):
        # Tie the generator's upstream termination failure to the metamodel
        # cycle SchemaView's own range/identity resolvers identified.
        lifecycle["native_limitation"]["metamodel_cycles"] = range_reconciliation[
            "cycles"
        ]

    declared: list[str] = sorted(
        str(s.name)
        for s in sv.all_slots().values()
        if getattr(s, "designates_type", False)
    )
    resolved: dict[str, str | None] = {}
    if declared:
        td_slot = sv.get_slot(declared[0])
        for cname in class_names:
            resolved[cname] = get_type_designator_value(
                sv, td_slot, sv.get_class(cname)
            )
    type_designators = {"declared": declared, "resolved": resolved}

    erd = {
        "generator": "ERDiagramGenerator",
        "ok": False,
        "entities": 0,
        "relationships": 0,
        "gaps": [],
        "convention_deltas": [],
        "native_limitation": None,
    }
    try:
        erd_gen = ERDiagramGenerator(str(schema_path))
    except Exception as exc:  # noqa: BLE001 - recorded, never substituted
        erd["native_limitation"] = _limitation(exc)
        erd_gen = None
    if erd_gen is not None:
        try:
            entities, rels = _erd_surface(erd_gen, sv, class_names)
            erd["ok"] = True
            erd["entities"] = len(entities)
            erd["relationships"] = len(rels)
            erd["gaps"].extend(_set_gaps("erd.entities", class_names, entities))
            erd_edges = {(s, t) for (s, t, _) in rels}
            for src, tgt in sorted(fk_edges):
                if (src, tgt) not in erd_edges:
                    erd["gaps"].append(
                        {
                            "kind": "producer_fk_missing_in_erd",
                            "source_class": src,
                            "target_class": tgt,
                        }
                    )
            for src, tgt in sorted(erd_edges):
                if (src, tgt) in fk_edges:
                    continue
                if src == tgt and src in ident_classes:
                    erd["convention_deltas"].append(
                        {"kind": "identifier_range_self_edge", "class": src}
                    )
                else:
                    erd["gaps"].append(
                        {
                            "kind": "erd_only_edge",
                            "source_class": src,
                            "target_class": tgt,
                        }
                    )
        except Exception as exc:  # noqa: BLE001 - recorded, never substituted
            erd["native_limitation"] = _limitation(exc)

    sql = {
        "generator": "SQLTableGenerator",
        "ok": False,
        "tables": 0,
        "fks": 0,
        "gaps": [],
        "native_limitation": None,
    }
    try:
        sql_gen = SQLTableGenerator(str(schema_path))
    except Exception as exc:  # noqa: BLE001 - recorded, never substituted
        sql["native_limitation"] = _limitation(exc)
        sql_gen = None
    if sql_gen is not None:
        try:
            tables, sql_fks = _sql_surface(sql_gen, sv, class_names)
            sql["ok"] = True
            sql["tables"] = len(tables)
            sql["fks"] = len(sql_fks)
            sql["gaps"].extend(_set_gaps("sql.tables", class_names, tables))
            sql["gaps"].extend(_set_gaps("sql.fks", fk_triples, sql_fks))
        except Exception as exc:  # noqa: BLE001 - recorded, never substituted
            sql["native_limitation"] = _limitation(exc)

    gaps: list[dict] = []
    gaps.extend({"generator": "lifecycle", **g} for g in lifecycle["gaps"])
    gaps.extend({"generator": "range", **g} for g in range_reconciliation["gaps"])
    gaps.extend({"generator": "erd", **g} for g in erd["gaps"])
    gaps.extend({"generator": "sql", **g} for g in sql["gaps"])

    return {
        "apis": GENERATOR_RECONCILIATION_API,
        "lifecycle": lifecycle,
        "range_reconciliation": range_reconciliation,
        "type_designators": type_designators,
        "generators": {"erd": erd, "sql": sql},
        "gaps": gaps,
    }


# ---------------------------------------------------------------------------
# artefact assembly
# ---------------------------------------------------------------------------


def _sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


# Environment-dependent provenance. These keys identify WHICH locked toolchain
# produced an artefact. They are recorded (so the digest stays auditable) but are
# deliberately excluded from ``content_digest``: the reproducibility claim is
# "identical repository source state + identical locked environment -> identical
# content", and the toolchain metadata is provenance, not content identity.
ENV_PROVENANCE_KEYS = ("python_version", "linkml_version", "linkml_runtime_version")


def _content_digest(body: dict) -> str:
    """Digest of the reconciled content, independent of the producer toolchain."""
    reproducibility = {
        k: v for k, v in body["reproducibility"].items() if k not in ENV_PROVENANCE_KEYS
    }
    return _sha256_bytes(
        _canonical({**body, "reproducibility": reproducibility}).encode("utf-8")
    )


def build_artefact(schema_path: Path, schema_label: str | None = None) -> dict:
    """Build the reconciled artefact for one schema.

    ``schema_label`` overrides the provenance label recorded under
    ``reproducibility.schema_path``. The reconcile (upload) path passes the
    uploaded root filename so its output is deterministic and location
    independent (a temp path would otherwise leak into the digest). The bundled
    ``--all`` path leaves it unset and keeps repo-relative labels.
    """
    raw = schema_path.read_bytes()
    sv = SchemaView(str(schema_path))
    facts = extract_facts(sv)
    generator_reconciliation = _generator_reconciliation(schema_path, sv, facts)

    if schema_label is None:
        try:
            schema_label = str(schema_path.resolve().relative_to(REPO_ROOT))
        except ValueError:
            schema_label = str(schema_path)

    body = {
        "artifact": {"format": ARTIFACT_FORMAT, "version": ARTIFACT_VERSION},
        "reproducibility": {
            "schema_path": schema_label,
            "schema_fingerprint": _sha256_bytes(raw),
            "linkml_version": metadata.version("linkml"),
            "linkml_runtime_version": metadata.version("linkml_runtime"),
            "python_version": platform.python_version(),
            "generator": {"name": GENERATOR_NAME, "version": GENERATOR_VERSION},
            "config": {
                "include_abstract": True,
                "etl_mapping_grammar": "prefix:Class.slot",
            },
            "producer_projections": PRODUCER_PROJECTIONS,
        },
        **facts,
        "generator_reconciliation": generator_reconciliation,
    }
    digest = _sha256_bytes(_canonical(body).encode("utf-8"))
    return {
        **body,
        "reproducibility": {
            **body["reproducibility"],
            # content identity (source + projection rules, toolchain-independent)
            "content_digest": _content_digest(body),
            # content identity + toolchain provenance (full environment identity)
            "output_digest": digest,
        },
    }


def write_artefact(artefact: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(artefact, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    out_path.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# upload reconciliation (--reconcile): the same build_artefact, off-client
# ---------------------------------------------------------------------------

MAX_BODY_BYTES = 64 * 1024 * 1024
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_name(name: str) -> str:
    """Reduce a client-supplied filename to a single safe basename."""
    basename = str(name).replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = SAFE_NAME.sub("_", basename).lstrip(".")
    if not cleaned:
        raise ValueError("invalid (empty) filename")
    return cleaned


def _normalise_files(files: object) -> list[tuple[str, str]]:
    if isinstance(files, dict):
        items = files.items()
    elif isinstance(files, list):
        items = (
            (entry.get("name"), entry.get("text"))
            for entry in files
            if isinstance(entry, dict)
        )
    else:
        raise ValueError("'files' must be an object or a list of {name,text}")
    normalised: list[tuple[str, str]] = []
    for name, text in items:
        if name is None or text is None:
            raise ValueError("each file needs a 'name' and a 'text'")
        normalised.append((_safe_name(name), str(text)))
    if not normalised:
        raise ValueError("no files supplied")
    return normalised


def reconcile_payload(payload: dict) -> dict:
    """Write the uploaded workspace and execute the shared producer on its root."""
    files = _normalise_files(payload.get("files"))
    by_name = {name: text for name, text in files}

    root_name = payload.get("name")
    if root_name is None:
        root_name = files[0][0]
    root_name = _safe_name(root_name)
    if root_name not in by_name:
        raise ValueError(f"root file '{root_name}' not present in 'files'")

    with tempfile.TemporaryDirectory(prefix="linkml-reconcile-") as tmp:
        for name, text in files:
            (Path(tmp) / name).write_text(text, encoding="utf-8")
        # Label provenance with the uploaded root name, not the temp path, so the
        # output digest is deterministic and location independent.
        return build_artefact(Path(tmp) / root_name, schema_label=root_name)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Authoritative LinkML producer")
    parser.add_argument(
        "--all", action="store_true", help="produce all bundled artefacts"
    )
    parser.add_argument(
        "--reconcile",
        action="store_true",
        help="read a {name, files} payload from stdin and write the artefact to stdout",
    )
    parser.add_argument("--schema", help="path to a single schema file")
    parser.add_argument("--name", help="artefact name (output stem)")
    parser.add_argument("--out", help="explicit output path")
    args = parser.parse_args(argv)

    if args.reconcile:
        try:
            payload = json.load(sys.stdin)
            artefact = reconcile_payload(payload)
        except ValueError as exc:
            sys.stderr.write(json.dumps({"error": str(exc)}) + "\n")
            return 2
        except Exception as exc:  # noqa: BLE001 - the failure is the response
            sys.stderr.write(
                json.dumps({"error": f"{type(exc).__name__}: {exc}"}) + "\n"
            )
            return 1
        json.dump(artefact, sys.stdout, sort_keys=True, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    jobs: list[tuple[str, Path, Path]] = []
    if args.all or not args.schema:
        for name, rel in BUNDLED.items():
            jobs.append(
                (
                    name,
                    REPO_ROOT / rel,
                    REPO_ROOT / "static" / "reconciled" / f"{name}.json",
                )
            )
    else:
        if not args.name:
            parser.error("--name is required when --schema is used")
        schema_path = Path(args.schema)
        out = (
            Path(args.out)
            if args.out
            else REPO_ROOT / "static" / "reconciled" / f"{args.name}.json"
        )
        jobs.append((args.name, schema_path, out))

    for name, schema_path, out_path in jobs:
        artefact = build_artefact(schema_path)
        write_artefact(artefact, out_path)
        counts = artefact["counts"]
        gaps = artefact["generator_reconciliation"]["gaps"]
        try:
            display_path = str(out_path.resolve().relative_to(REPO_ROOT))
        except ValueError:
            display_path = str(out_path)
        print(
            f"{name}: wrote {display_path} "
            f"[classes={counts['classes_total']} fk={counts['fk_slots_total']} "
            f"(cross={counts['fk_slots_cross']} self={counts['fk_slots_self']}) "
            f"identifiers={counts['identifiers']} etl={counts['etl_relationships']} "
            f"reconciliation_gaps={len(gaps)} "
            f"content_digest={artefact['reproducibility']['content_digest']} "
            f"output_digest={artefact['reproducibility']['output_digest']}]"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
