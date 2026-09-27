/**
 * Auto-layout for ERD nodes and edges.
 *
 * Visualization model:
 *   - Each table → one "tableParent" node (subflow container)
 *   - Each column → one "column" child node inside its table parent
 *   - FK/ETL edges connect column-to-column (source col → target PK col)
 *
 * Layout strategy:
 *   1. Run dagre/ELK on table-level positions only (37 classes for the default
 *      OMOP CDM schema).
 *   2. Columns are stacked top-to-bottom inside each parent at fixed y offsets.
 *   3. Parent nodes must appear before their children in the nodes array.
 *
 * Supports two engines (dagre, elkjs) and two directions (LR, TB).
 * Always returns a Promise so callers have a uniform async interface.
 */

import { Position, type Node, type Edge, MarkerType } from '@xyflow/svelte';
import dagre from '@dagrejs/dagre';
import type {
  NormalizedSchema,
  ReconciledRelationship,
  ErdTableNodeData,
  ErdColumnNodeData,
  LayoutOptions,
} from './types';

// ---------------------------------------------------------------------------
// Node dimension constants
// ---------------------------------------------------------------------------
const NODE_WIDTH = 260;
const HEADER_HEIGHT = 36;   // table parent header
const ROW_HEIGHT = 24;      // column row height
const PARENT_PADDING_BOTTOM = 4; // extra padding below last column inside parent
const PARENT_BORDER = 2;    // border on each side counted in height

// Edge colors are the app's semantic presentation tokens, defined in the
// --xy-* theme contract block in src/routes/+layout.svelte. They are resolved
// at render time from the .svelte-flow scope (single visual source of truth),
// never re-declared as literals here.
const FK_EDGE = 'var(--erd-edge-fk)';
const ETL_EDGE = 'var(--erd-edge-etl)';
const FK_LABEL = 'var(--erd-edge-label-fk)';
const ETL_LABEL = 'var(--erd-edge-label-etl)';

/**
 * Estimate the total height of a table parent node.
 * Collapsed → header only. Expanded → header + all column rows + padding.
 */
function estimateParentHeight(slotCount: number, collapsed: boolean): number {
  if (collapsed) return HEADER_HEIGHT;
  return HEADER_HEIGHT + slotCount * ROW_HEIGHT + PARENT_PADDING_BOTTOM + PARENT_BORDER * 2;
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/**
 * Separator used between class name and slot name in column node IDs.
 * A null byte (\x00) is chosen because it cannot appear in LinkML identifiers
 * (which follow XML NCName rules: alphanumeric + underscore + hyphen + dot).
 * This avoids ambiguity when class or slot names contain "__".
 */
export const COL_ID_SEP = '\x00';

/** Column node ID: "ClassName\x00slotName" */
function colId(className: string, slotName: string): string {
  return `${className}${COL_ID_SEP}${slotName}`;
}

/**
 * Materialise the reconciled relationship facts into internal edge records.
 * This is pure materialisation: it maps class-level relationship facts
 * (`source`/`target`/`slot`/`target_slot`) onto Svelte Flow column node ids. It
 * never inspects slot ranges, class-name membership, mapping CURIEs, pk/key
 * slots, or self-reference flags — those decisions are already reconciled in
 * the artefact (`static/reconciled/*.json`, or the reconcile service for
 * uploads). The target anchor is the artefact's per-relationship `target_slot`,
 * not a viewer re-selection.
 *
 * The residual geometric fallbacks: a table whose target anchor names no
 * rendered column falls back to its first column; a collapsed table resolves to
 * the bare table id (the collapsed relationship's endpoint is the table, not a
 * column).
 *
 * R2.8.3: to keep such edges renderable, `TableParentNode` exposes its own
 * source/target `<Handle>` when collapsed (the column children own the handles
 * when expanded). Svelte Flow's `getEdgePosition` therefore resolves the bare
 * table id, so a collapsed table keeps every incident edge — anchored to its
 * header — rather than dropping it. Pinned by `e2e/collapsed-edges.spec.ts`.
 */
function targetNodeId(
  rel: ReconciledRelationship,
  schema: NormalizedSchema,
  collapsed: Set<string>
): string {
  const className = rel.target;
  if (collapsed.has(className)) return className;
  const cls = schema.classes[className];
  if (!cls) return className;
  if (rel.target_slot && cls.slots.some((s) => s.name === rel.target_slot)) {
    return colId(className, rel.target_slot);
  }
  return cls.slots.length > 0 ? colId(className, cls.slots[0].name) : className;
}

type MaterialEdge = {
  kind: 'fk' | 'etl';
  source: string;  // column node ID (or table ID when collapsed)
  target: string;  // column node ID (target_slot anchor, or table ID / first-column fallback)
  slotName: string;
  required: boolean;
  /** Table-level source/target for the layout engine */
  layoutSource: string;
  layoutTarget: string;
};

function materialiseEdges(
  schema: NormalizedSchema,
  collapsed: Set<string>
): MaterialEdge[] {
  const result: MaterialEdge[] = [];
  for (const rel of schema.relationships) {
    const source = collapsed.has(rel.source) ? rel.source : colId(rel.source, rel.slot);
    result.push({
      kind: rel.kind,
      source,
      target: targetNodeId(rel, schema, collapsed),
      slotName: rel.slot,
      required: rel.kind === 'fk' ? rel.required : false,
      layoutSource: rel.source,
      layoutTarget: rel.target,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Svelte Flow edge builder
// ---------------------------------------------------------------------------

function buildSvelteEdges(allEdges: MaterialEdge[]): Edge[] {
  const edges: Edge[] = [];
  const edgeIdCounts = new Map<string, number>();

  for (const edge of allEdges) {
    const baseId = `${edge.source}--${edge.slotName}--${edge.target}`;
    const count = (edgeIdCounts.get(baseId) ?? 0) + 1;
    edgeIdCounts.set(baseId, count);
    const edgeId = count > 1 ? `${baseId}-${count}` : baseId;

    const isEtl = edge.kind === 'etl';
    const color = isEtl ? ETL_EDGE : FK_EDGE;
    const strokeWidth = isEtl ? 1.5 : (edge.kind === 'fk' && edge.required ? 2 : 1.5);
    const dashArray = isEtl ? '5,3' : undefined;

    edges.push({
      id: edgeId,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: false,
      zIndex: 1, // render above parent nodes (required for cross-subflow edges)
      style: `stroke: ${color}; stroke-width: ${strokeWidth};${dashArray ? ` stroke-dasharray: ${dashArray};` : ''}`,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
        width: 16,
        height: 16,
      },
      data: {
        slotName: edge.slotName,
        required: isEtl ? false : (edge.kind === 'fk' && edge.required),
        targetClass: edge.target,
        edgeKind: edge.kind,
      } as unknown as Record<string, unknown>,
      label: edge.slotName,
      labelStyle: `font-size: 10px; fill: ${isEtl ? ETL_LABEL : FK_LABEL};`,
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Node builders (shared between dagre and ELK paths)
// ---------------------------------------------------------------------------

/**
 * Build the tableParent node at the given position (top-left corner).
 */
function buildTableParentNode(
  className: string,
  schema: NormalizedSchema,
  collapsed: Set<string>,
  position: { x: number; y: number },
  isLR: boolean
): Node {
  const cls = schema.classes[className];
  const isCollapsed = collapsed.has(className);
  const height = estimateParentHeight(cls.slots.length, isCollapsed);

  return {
    id: className,
    type: 'tableParent',
    position,
    style: `width: ${NODE_WIDTH}px; height: ${height}px;`,
    class: 'parent',
    data: {
      label: className,
      description: cls.description,
      collapsed: isCollapsed,
      group: cls.group,
      fileId: cls.fileId,
      slotCount: cls.slots.length,
    } as unknown as Record<string, unknown>,
    // Handle sides are declared on the node itself (Svelte Flow's native
    // `sourcePosition`/`targetPosition`), not duplicated in `data`. The parent
    // renders no Handle (columns own them), but the direction is still the
    // layout's single declaration of the active rank direction and is asserted
    // by bench-layout.ts.
    sourcePosition: isLR ? Position.Right : Position.Bottom,
    targetPosition: isLR ? Position.Left : Position.Top,
  };
}

/**
 * Build column child nodes for a table.
 * Returns an empty array when the table is collapsed.
 * Column nodes use relative positions inside the parent.
 */
function buildColumnNodes(
  className: string,
  schema: NormalizedSchema,
  collapsed: Set<string>,
  isLR: boolean
): Node[] {
  // Guard: never produce child nodes for collapsed tables — their column IDs
  // would be absent from the nodes array, causing dangling edge references.
  if (collapsed.has(className)) return [];
  const cls = schema.classes[className];
  return cls.slots.map((slot, index) => ({
    id: colId(className, slot.name),
    type: 'column',
    parentId: className,
    extent: 'parent' as const,
    // Rows are schema data stacked deterministically inside their table, not
    // free-form positions: dragging a column has no LinkML meaning and would
    // only desynchronise the card from its layout. Parent tables stay draggable
    // (see buildTableParentNode) because moving a whole table is a coherent
    // canvas affordance; its fixed-offset children follow via extent: 'parent'.
    draggable: false,
    position: {
      x: 0,
      y: HEADER_HEIGHT + index * ROW_HEIGHT,
    },
    style: `width: ${NODE_WIDTH}px; height: ${ROW_HEIGHT}px;`,
    data: {
      slotName: slot.name,
      slot_name: slot.slot_name,
      range: slot.range,
      required: slot.required,
      identifier: slot.identifier,
      is_fk: slot.is_fk,
      description: slot.description,
      exact_mappings: slot.exact_mappings,
      tableId: className,
    } as unknown as Record<string, unknown>,
    // Svelte Flow's native handle orientation: ColumnNode reads these node-level
    // props (not a `data` copy) for its `<Handle position>`. LR/RIGHT →
    // source right, target left; TB/DOWN → source bottom, target top, so the
    // handles stay coherent with the engine's rank direction.
    sourcePosition: isLR ? Position.Right : Position.Bottom,
    targetPosition: isLR ? Position.Left : Position.Top,
  }));
}

// ---------------------------------------------------------------------------
// Dagre layout
// ---------------------------------------------------------------------------

function buildGraphDagre(
  schema: NormalizedSchema,
  collapsed: Set<string>,
  direction: 'LR' | 'TB'
): { nodes: Node[]; edges: Edge[] } {
  const allEdges = materialiseEdges(schema, collapsed);

  // --- Run dagre on tables only (delegated to @dagrejs/dagre) ---
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 60,
    ranksep: 120,
    edgesep: 20,
    marginx: 40,
    marginy: 40,
  });

  for (const [className, cls] of Object.entries(schema.classes)) {
    const height = estimateParentHeight(cls.slots.length, collapsed.has(className));
    g.setNode(className, { width: NODE_WIDTH, height });
  }
  // Feed layout-level edges (table-to-table) so dagre can rank properly
  for (const edge of allEdges) {
    g.setEdge(edge.layoutSource, edge.layoutTarget);
  }
  dagre.layout(g);

  const isLR = direction === 'LR';
  const tableNodes: Node[] = [];
  const columnNodes: Node[] = [];

  for (const [className] of Object.entries(schema.classes)) {
    const dagreNode = g.node(className);
    if (!dagreNode) continue;

    const position = {
      x: dagreNode.x - NODE_WIDTH / 2,
      y: dagreNode.y - dagreNode.height / 2,
    };

    tableNodes.push(buildTableParentNode(className, schema, collapsed, position, isLR));

    if (!collapsed.has(className)) {
      columnNodes.push(...buildColumnNodes(className, schema, collapsed, isLR));
    }
  }

  // Parents must appear before children in the nodes array
  return { nodes: [...tableNodes, ...columnNodes], edges: buildSvelteEdges(allEdges) };
}

// ---------------------------------------------------------------------------
// ELK layout (async, code-split)
// ---------------------------------------------------------------------------

async function buildGraphElk(
  schema: NormalizedSchema,
  collapsed: Set<string>,
  direction: 'LR' | 'TB'
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const allEdges = materialiseEdges(schema, collapsed);
  const isLR = direction === 'LR';

  const elkNodes = Object.entries(schema.classes).map(([className, cls]) => ({
    id: className,
    width: NODE_WIDTH,
    height: estimateParentHeight(cls.slots.length, collapsed.has(className)),
  }));

  const elkEdges = allEdges.map((e, i) => ({
    id: `e${i}`,
    sources: [e.layoutSource],
    targets: [e.layoutTarget],
  }));

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': isLR ? 'RIGHT' : 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '120',
      'elk.spacing.nodeNode': '60',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: elkNodes,
    edges: elkEdges,
  };

  const ELK = (await import('elkjs/lib/elk.bundled.js')).default;
  const laid = (await new ELK().layout(graph as never)) as {
    children?: Array<{ id: string; x?: number; y?: number }>;
  };

  const posMap = new Map<string, { x: number; y: number }>();
  for (const n of laid.children ?? []) {
    posMap.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  }

  const tableNodes: Node[] = [];
  const columnNodes: Node[] = [];

  for (const [className] of Object.entries(schema.classes)) {
    const pos = posMap.get(className);
    if (!pos) continue;

    tableNodes.push(buildTableParentNode(className, schema, collapsed, pos, isLR));

    if (!collapsed.has(className)) {
      columnNodes.push(...buildColumnNodes(className, schema, collapsed, isLR));
    }
  }

  return { nodes: [...tableNodes, ...columnNodes], edges: buildSvelteEdges(allEdges) };
}

// ---------------------------------------------------------------------------
// Public API — always async
// ---------------------------------------------------------------------------
export async function buildGraph(
  schema: NormalizedSchema,
  collapsed: Set<string>,
  options: LayoutOptions = { engine: 'dagre', direction: 'LR' }
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  // Dev-only deterministic test seam: the browser acceptance tests set
  // `globalThis.__erdLayoutDelayMs` to widen the window during which the user
  // can move the viewport mid-layout, so the async race contract is testable
  // without artificial delays in production.
  if (import.meta.env.DEV) {
    const delay = (globalThis as { __erdLayoutDelayMs?: number }).__erdLayoutDelayMs ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (options.engine === 'elk') {
    return buildGraphElk(schema, collapsed, options.direction);
  }
  return Promise.resolve(buildGraphDagre(schema, collapsed, options.direction));
}
