// ---------------------------------------------------------------------------
// LinkML schema types — matches the raw YAML structure for uploaded files
// and the normalized internal representation consumed by the ERD layout.
// ---------------------------------------------------------------------------

import type { Position } from '@xyflow/svelte';

/**
 * Canonical kind of a slot's resolved range, in metamodel terms.
 *
 * Consumed directly from the reconciled artefact's `range_kind` (the producer's
 * mechanical relabelling of SchemaView `get_class`/`get_enum`/`get_type`). The
 * viewer never re-derives it.
 */
export type ErdRangeKind = 'class' | 'type' | 'enum';

/** A single slot/column */
export interface ErdSlot {
  name: string;         // display name (authority's alias-or-name)
  slot_name: string;    // internal LinkML slot name
  range: string;        // e.g. "integer", "string", "person", "concept"
  required: boolean;
  identifier: boolean;  // true = primary key
  multivalued: boolean;
  /**
   * True when this slot is the source of an authoritative FK relationship.
   * Consumed as membership in the reconciled `relationships` set — NOT
   * recomputed from `range_kind`/`identifier`.
   */
  is_fk: boolean;
  description: string;
  exact_mappings: string[]; // e.g. ["omop_cdm54:Person.person_source_value"]
  // -------------------------------------------------------------------------
  // Canonical semantic facts — transported from the reconciled artefact.
  // -------------------------------------------------------------------------
  /** Metamodel kind of the resolved range (artefact `range_kind`). */
  range_kind: ErdRangeKind;
  /**
   * Canonical class id when `range_kind === 'class'`; `null` for type/enum
   * ranges. Transported from the reconciled artefact; the FK edge target anchor
   * is the relationship's reconciled `target_slot` (R1.9), not this.
   */
  range_target: string | null;
  // -------------------------------------------------------------------------
  // Composition provenance — transported from the artefact (producer reads the
  // induced slot's `domain_of`). No in-browser derivation.
  // -------------------------------------------------------------------------
  /** Class that declares this slot (own, ancestor, or mixin). */
  declared_by: string | null;
  /** Ancestor on this class's path through which the slot is induced, else null. */
  inherited_from: string | null;
  /** Schema id this slot's definition came from. */
  from_schema?: string;
}

/** A single class/table in the ERD */
export interface ErdClass {
  name: string;
  description: string;
  slots: ErdSlot[];
  group?: string;   // e.g. "clinical", "vocabulary", "hix" — from annotations.group
  fileId?: string;  // WorkspaceFile.id of the file this class came from (viewer projection)
  /** Schema id the class definition came from (artefact provenance). */
  from_schema?: string;
  /**
   * Canonical identifier slot display name (artefact `pk_slot`), or `null` when
   * the class declares no identifier. Transported as a class fact; the FK edge
   * target anchor is the relationship's reconciled `target_slot` (R1.9).
   */
  pk_slot: string | null;
}

/**
 * A relationship fact resolved by the producer (`produce.py`) and transported
 * by `src/lib/linkml.ts` (transport/materialisation only — not a parser).
 *
 * `layout.ts` materialises these into Svelte Flow edges; it does not decide
 * them. `source`/`target` are class names (not node ids); the producer has
 * already filtered to the induced, non-identifier, non-self, cross-class
 * surface. `slot` is the display name; `slot_name` is the canonical identity.
 * `target_slot`/`target_slot_name` are the reconciled target anchor column
 * (FK: the target class's identifier slot; ETL: the mapping's slot segment),
 * so layout never re-selects the endpoint.
 */
export interface ReconciledRelationship {
  kind: 'fk' | 'etl';
  source: string;   // source class name
  target: string;   // target class name
  slot: string;     // display name (ErdSlot.name)
  slot_name: string;
  /** Display name of the target anchor column, or null when the target has none. */
  target_slot: string | null;
  /** Canonical slot name of the target anchor column. */
  target_slot_name: string | null;
  required: boolean;
}

/** The top-level normalized schema structure */
export interface NormalizedSchema {
  name: string;
  description: string;
  id: string;
  classes: Record<string, ErdClass>;
  /**
   * FK/ETL relationship facts resolved by the producer and transported by
   * `src/lib/linkml.ts`. Layout materialises these; it never re-derives them
   * from slot fields.
   */
  relationships: ReconciledRelationship[];
  /** Import names left unresolved by the workspace resolver. */
  unresolved?: string[];
}

// ---------------------------------------------------------------------------
// Workspace — multi-file upload and import resolution
// ---------------------------------------------------------------------------

/**
 * A single file loaded into the workspace.
 * Pre-parsed so import resolution is synchronous.
 */
export interface WorkspaceFile {
  /** Stable unique identifier (crypto.randomUUID) */
  id: string;
  /** Original filename, e.g. "hix.yaml" */
  name: string;
  /** Filename without extension, used for import matching, e.g. "hix" */
  stem: string;
  /** Raw YAML/JSON text */
  text: string;
  /**
   * Schema display name read from the raw YAML `name:` scalar (workspace file
   * metadata, not LinkML semantics), falling back to the file stem.
   */
  displayName: string;
  /**
   * Schema id read from the raw YAML `id:` scalar (parse-only workspace
   * metadata). Used to map an artefact class's `from_schema` provenance back to
   * the workspace file it came from.
   */
  schemaId?: string;
  /**
   * User-defined import names from the raw YAML `imports:` list,
   * with built-in linkml:* entries stripped.
   * e.g. ["hix", "sein-omop"]
   */
  imports: string[];
}

// ---------------------------------------------------------------------------
// Layout options — controls which engine and direction to use
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  engine: 'dagre' | 'elk';
  direction: 'LR' | 'TB';
}

// ---------------------------------------------------------------------------
// Group configuration — loaded from static/group-config.yaml
// ---------------------------------------------------------------------------

/** One entry from group-config.yaml */
export interface GroupInfo {
  name: string;       // e.g. "clinical"
  label: string;      // e.g. "Clinical"
  color: string;      // hex header background, e.g. "#2563eb"
  text_color: string; // hex header text, e.g. "#ffffff"
}

/** Top-level shape of group-config.yaml */
export interface GroupConfig {
  groups: GroupInfo[];
}

// ---------------------------------------------------------------------------
// File configuration — auto-assigned per-file colors for multi-file workspaces
// ---------------------------------------------------------------------------

/** Per-file color entry, keyed by WorkspaceFile.id */
export interface FileInfo {
  id: string;     // WorkspaceFile.id
  label: string;  // display name: schema.name or filename stem
  color: string;  // hex stripe color, auto-assigned from FILE_PALETTE
}

// ---------------------------------------------------------------------------
// Interaction-state contract
// ---------------------------------------------------------------------------
//
// Distinct interaction concepts, kept separate on purpose. Conflating them was
// the source of the old bugs: search emphasis mutated the node array, collapse
// triggered viewport resets, and selection had no home. Each concept below has
// exactly one owner and one meaning:
//
//   hover        — transient pointer emphasis. Owned by CSS (`:hover`); never
//                  stored in application state.
//   focus        — keyboard focus. Owned by the DOM; surfaced via `:focus-visible`.
//                  Never stored in application state.
//   selected     — persistent user selection of nodes/edges. Owned by Svelte Flow.
//   searchTarget — transient navigation emphasis produced by a search. Holds the
//                  *table* node id (a column hit maps to its parent) or null.
//                  Auto-clears after a short timeout. This is NOT selection and
//                  NOT collapse; it must never rewrite `nodes`.
//   collapsed    — Set<string> of table ids whose columns are hidden. Owned by
//                  +page.svelte; changes trigger a layout rebuild only.
//   locked       — canvas interactivity lock (draggable/connectable/selectable).
//   activeFileId — the workspace file currently rendered on the canvas.
//   groupConfig  — Map<string, GroupInfo> colour/label configuration.
//
// Invariant: a change to any one of these must not imply a change to another
// or to the viewport. Viewport motion is reserved for explicit fit requests and
// search navigation.

/** Canonical names of the interaction concepts and their meaning. */
export const INTERACTION_CONCEPTS = {
  hover: 'transient pointer emphasis — CSS-owned, not app state',
  focus: 'keyboard focus — DOM-owned, surfaced via :focus-visible',
  selected: 'persistent node/edge selection — owned by Svelte Flow',
  searchTarget: 'transient search emphasis (table id | null) — auto-clears',
  collapsed: 'Set<string> of tables rendered without their column children',
  locked: 'canvas interactivity lock — draggable/connectable/selectable',
  activeFileId: 'workspace file currently rendered',
  groupConfig: 'Map<string, GroupInfo> colour/label configuration',
} as const;

export type InteractionConcept = keyof typeof INTERACTION_CONCEPTS;

// ---------------------------------------------------------------------------
// Level of detail
// ---------------------------------------------------------------------------
//
// Information resolution derived from the flow viewport zoom. This is a
// presentation concern only: it changes what a node renders, never its geometry.
// Keeping geometry constant means zooming can never trigger a layout rebuild,
// so Fit and the LOD thresholds cannot fight each other.
//
//   0 OVERVIEW    zoom < 0.5    column name only
//   1 STRUCTURAL  0.5–0.85      PK/FK badge + column name
//   2 SEMANTIC    >= 0.85       badge + name + range + ETL mapping
export const LOD = {
  OVERVIEW: 0,
  STRUCTURAL: 1,
  SEMANTIC: 2,
} as const;

export type LodLevel = (typeof LOD)[keyof typeof LOD];

/** Direction for spatial graph navigation (keyboard cursor movement). */
export type NavDirection = 'left' | 'right' | 'up' | 'down';

// ---------------------------------------------------------------------------
// Relationship focus (R2.4.1 table selection, R2.4.2 edge selection)
// ---------------------------------------------------------------------------
//
// A fourth transient interaction state, derived *only* from native Svelte Flow
// selection (never a second selection model). It holds the table ids and edge
// ids that should be visually emphasised, plus an `active` flag that is false
// when nothing is selected. It is presentation state: it never changes the
// reconciled graph, layout, geometry, viewport, LOD, `searchTarget`, or
// `cursor`.
//
// Two focus modes share this one state:
//
//   table-selected (R2.4.1) — every edge connected to the selected table is
//   emphasised, and the selected table plus every connected table is modestly
//   emphasised.
//
//   edge-selected (R2.4.2) — the natively selected relationship is emphasised
//   *strongly* (`strongEdgeIds`), and its two endpoint tables are emphasised
//   modestly (`tableIds`). Edge selection takes precedence while present: an
//   individual relationship is the most specific inspectable unit, and its two
//   endpoints subsume the informative part of a table selection.
export interface RelationshipFocus {
  /** True when a native node/edge selection exists. */
  active: boolean;
  /** Selected tables plus tables directly connected by a focused edge. */
  tableIds: Set<string>;
  /** Focused edges (connected to a selected table, or natively selected). */
  edgeIds: Set<string>;
  /**
   * Natively selected edges — emphasised strongly as the individually
   * inspected relationship. Always a subset of `edgeIds`; empty for
   * table-selected focus.
   */
  strongEdgeIds: Set<string>;
}

/**
 * Shape of the interaction state owned by +page.svelte.
 *
 * `selected` and `locked` are deliberately absent: `selected` is owned by
 * Svelte Flow's store, and `locked` is a projection of the flow store's
 * `nodesDraggable`/`elementsSelectable` toggled from CustomControls. Neither
 * lives in +page.svelte state, so neither belongs in this contract.
 */
export interface InteractionState {
  cursor: string | null;
  searchTarget: string | null;
  collapsed: Set<string>;
  activeFileId: string | null;
  groupConfig: Map<string, GroupInfo>;
}

// ---------------------------------------------------------------------------
// ERD graph model — projected from the reconciled artefact, input to Svelte Flow
// ---------------------------------------------------------------------------

/**
 * Data on a table parent node (type: 'tableParent').
 * The parent node acts as a subflow container; its children are column nodes.
 */
export interface ErdTableNodeData {
  label: string;
  description: string;
  collapsed: boolean;
  group?: string;    // propagated from ErdClass.group — drives header color
  fileId?: string;   // propagated from ErdClass.fileId — drives left stripe color
  slotCount: number; // total number of slots (used for sizing the parent node)
}

/**
 * Data on a column child node (type: 'column').
 * Positioned inside a tableParent node.
 */
export interface ErdColumnNodeData {
  slotName: string;       // display name
  slot_name: string;      // internal LinkML slot name
  range: string;          // e.g. "integer", "string", "Concept"
  required: boolean;
  identifier: boolean;    // true = primary key
  is_fk: boolean;         // true when range resolves to another class
  description: string;
  exact_mappings: string[]; // ETL mapping CURIEs
  tableId: string;        // parent className — used for edge IDs
  /**
   * Resolved handle sides for the active layout direction (viewer/layout
   * presentation, not semantics). `LR`/`RIGHT` → source right, target left;
   * `TB`/`DOWN` → source bottom, target top. Resolved once in `layout.ts`.
   */
  sourcePosition: Position;
  targetPosition: Position;
}

export interface ErdEdgeData {
  slotName: string;
  required: boolean;
  targetClass: string;
  edgeKind: 'fk' | 'etl'; // 'fk' = structural FK via range:; 'etl' = exact_mappings ETL
}
