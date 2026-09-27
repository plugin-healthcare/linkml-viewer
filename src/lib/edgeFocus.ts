/**
 * R2.4.1 / R2.4.2 relationship-focus presentation transform.
 *
 * Pure, reversible presentation over the *already-rendered* Svelte Flow edges.
 * It never creates a second graph and never resolves LinkML meaning: given the
 * selected node/edge ids (native Svelte Flow selection) it selects from the
 * existing edges:
 *
 *   table selected (R2.4.1) — every edge connected to the selected table, and
 *   the selected table plus its connected tables.
 *
 *   edge selected (R2.4.2) — the selected edge itself (strong), and its two
 *   endpoint tables (modest). Endpoints are derived from the existing edge's
 *   `source`/`target` node ids via the same `tableIdOf`/`COL_ID_SEP` mapping
 *   that owns column→table identity; no LinkML semantics are re-read and no new
 *   graph is built.
 *
 * It changes no edge geometry, direction, routing, markers, or the underlying
 * layout `edges` source — only a presentation `class`. Delete this file and
 * pass `edges` straight to <SvelteFlow> to revert.
 */
import type { Edge } from '@xyflow/svelte';
import { COL_ID_SEP } from './layout';
import type { RelationshipFocus } from './types';

export const NO_FOCUS: RelationshipFocus = {
  active: false,
  selectedTableIds: new Set(),
  selectedNodeIds: new Set(),
  tableIds: new Set(),
  edgeIds: new Set(),
  strongEdgeIds: new Set(),
};

/** Table id owning a node id: a column id maps to its parent, a table maps to itself. */
export function tableIdOf(nodeId: string): string {
  const sep = nodeId.indexOf(COL_ID_SEP);
  return sep >= 0 ? nodeId.slice(0, sep) : nodeId;
}

/**
 * Derive the focus set from native selection and the already-materialised edges.
 *
 * No new graph: the focused-edge set is a filter over `renderedEdges`; the
 * focused-table set is read back from those edges' endpoints. A selected
 * column maps to its parent table, so selecting any row focuses its table.
 *
 * Precedence: edge selection wins over table selection while any edge is
 * selected. A selected relationship is the most specific inspectable unit, and
 * its two endpoints are still surfaced as focused tables, so the table-level
 * information is not lost.
 *
 * Multi-selection rule (deterministic union, no new semantics):
 *
 *   no selection           -> no focus
 *   nodes [A, B] only      -> focus the union of A's and B's incident edges,
 *                             and A ∪ B ∪ their connected tables
 *   edges [e1, e2] present -> edge precedence: both edges strong, focused
 *                             tables = union of both edges' endpoints
 *
 * Edge precedence applies whenever any edge is selected, so it is consistent
 * with the R2.4.2 single-edge contract.
 *
 * Three presentation states are distinguished (R2.8.7):
 *
 *   SELECTED  the object the user explicitly chose — `selectedTableIds` /
 *             `selectedNodeIds` (exact native selection).
 *   RELATED   connected to a selected object — `tableIds` minus the selected.
 *   DIMMED    everything else while focus is active.
 */
export function deriveRelationshipFocus(
  renderedEdges: Edge[],
  selectedNodeIds: string[],
  selectedEdgeIds: string[]
): RelationshipFocus {
  if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return NO_FOCUS;

  // Edge-selected focus (R2.4.2) — takes precedence while an edge is selected.
  if (selectedEdgeIds.length > 0) {
    const strongEdgeIds = new Set(selectedEdgeIds);
    const edgeIds = new Set<string>();
    const tableIds = new Set<string>();
    for (const edge of renderedEdges) {
      if (!strongEdgeIds.has(edge.id)) continue;
      edgeIds.add(edge.id);
      // Endpoints come straight from the existing edge — no re-derivation.
      tableIds.add(tableIdOf(edge.source));
      tableIds.add(tableIdOf(edge.target));
    }
    // Edge-selected focus chooses a *relationship*: its endpoints are related,
    // not selected — no table carries the `selected` treatment here.
    return {
      active: true,
      selectedTableIds: new Set(),
      selectedNodeIds: new Set(),
      tableIds,
      edgeIds,
      strongEdgeIds,
    };
  }

  // Table-selected focus (R2.4.1). `selectedNodes` is the exact native
  // selection; `selectedTables` maps each to its owning table, so a selected
  // column row marks its parent table selected.
  const selectedNodes = new Set(selectedNodeIds);
  const selectedTables = new Set(selectedNodeIds.map(tableIdOf));
  const edgeIds = new Set<string>();

  for (const edge of renderedEdges) {
    if (selectedTables.has(tableIdOf(edge.source)) || selectedTables.has(tableIdOf(edge.target))) {
      edgeIds.add(edge.id);
    }
  }

  const tableIds = new Set(selectedTables);
  for (const edge of renderedEdges) {
    if (!edgeIds.has(edge.id)) continue;
    tableIds.add(tableIdOf(edge.source));
    tableIds.add(tableIdOf(edge.target));
  }

  return {
    active: true,
    selectedTableIds: selectedTables,
    selectedNodeIds: selectedNodes,
    tableIds,
    edgeIds,
    strongEdgeIds: new Set(),
  };
}

function withFocusClass(edge: Edge, focusClass: string, selected: boolean): Edge {
  const existing = typeof edge.class === 'string' ? edge.class.trim() : '';
  return { ...edge, selected, class: existing ? `${existing} ${focusClass}` : focusClass };
}

/**
 * Tag focused edges for emphasis and all other edges for reduced prominence.
 * A natively selected edge is tagged `erd-edge-selected` (strong); an edge
 * merely connected to a selected table is tagged `erd-edge-focus` (modest).
 * Returns the input array unchanged when no focus is active, so the default
 * (unselected) appearance is byte-for-byte the layout output.
 *
 * The native `selected` flag is round-tripped here because Svelte Flow derives
 * `selectedEdges` from `edge.selected` on the array it is given. `displayEdges`
 * is rebuilt from the layout `edges` source (which never carries selection), so
 * without re-asserting the flag the selected edge would be dropped on the very
 * re-render its own selection triggered — a selection-reset loop. Only the
 * `strongEdgeIds` (natively selected) carry `selected: true`.
 */
export function applyEdgeFocus(edges: Edge[], focus: RelationshipFocus): Edge[] {
  if (!focus.active) return edges;
  return edges.map((edge) => {
    if (focus.strongEdgeIds.has(edge.id)) {
      return withFocusClass(edge, 'erd-edge-selected', true);
    }
    if (focus.edgeIds.has(edge.id)) return withFocusClass(edge, 'erd-edge-focus', false);
    return withFocusClass(edge, 'erd-edge-dim', false);
  });
}
