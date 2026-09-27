/**
 * Phase B / B2 experiment — edge annotation density (edge LOD).
 *
 * Presentation-only transform over Svelte Flow edges. It changes which labels
 * are rendered in response to the shared LOD level; it never changes edge
 * geometry, direction, markers, or the underlying `edges` source array.
 *
 *   LOD 0  no labels (overview), except a natively selected edge
 *   LOD 1  labels only on required FK edges (structural minimum), plus selected
 *   LOD 2  all `slotName` labels (current behaviour)
 *
 * Selected-edge replacement (R2.6.4.2): an edge whose id is in
 * `overlayLabelIds` (the derived `relationshipFocus.strongEdgeIds`, i.e.
 * natively selected) has its already-materialised `label` suppressed through
 * the transform below LOD2. The readable replacement is rendered in screen
 * space by `EdgeLabelOverlay.svelte`, so keeping the tiny zoom-coupled label
 * here would double-render it. This is not new relationship semantics — the
 * label already exists on the reconciled edge; only presentation-state
 * selection swaps the *rendering surface*. It never reconstructs a target slot
 * or an ETL mapping, and it adds no field. The underlying `edges` source array
 * is never mutated.
 *
 * Reversible: delete this file and pass `edges` straight to <SvelteFlow>.
 *
 * Invariant (R2.4.4): a presentation transform may add presentation state but
 * must preserve the native Svelte Flow interaction fields on every object it
 * receives — at minimum `selected`, and any other native field (`draggable`,
 * `selectable`, `focusable`, `connectable`, `zIndex`/`elevated`, `class`). Here
 * only `label` is removed, via rest-destructuring, so every other field
 * (including native `selected`) is carried through untouched. A retained edge is
 * returned as the original object reference.
 */
import type { Edge } from '@xyflow/svelte';

export function applyEdgeLod(
  edges: Edge[],
  level: number,
  overlayLabelIds?: ReadonlySet<string>
): Edge[] {
  // Semantic level: full annotation, same array reference (no re-render).
  if (level >= 2) return edges;

  return edges.map((edge) => {
    const data = edge.data as unknown as
      | { edgeKind?: string; required?: boolean }
      | undefined;
    const isRequiredFk = data?.edgeKind !== 'etl' && data?.required === true;

    // The screen-space overlay owns the selected edge's label below LOD2.
    if (overlayLabelIds?.has(edge.id)) {
      const { label: _label, ...rest } = edge;
      return rest as Edge;
    }

    // Structural level keeps only the required-FK labels.
    if (level >= 1 && isRequiredFk) return edge;

    // Drop the label without touching geometry/style/data.
    const { label: _label, ...rest } = edge;
    return rest as Edge;
  });
}
