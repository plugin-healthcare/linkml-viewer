/**
 * R2.8.8 — relationship-label readability (edge annotation density).
 *
 * Presentation-only transform over Svelte Flow edges. It changes which labels
 * are rendered in response to the shared LOD level; it never changes edge
 * geometry, direction, markers, or the underlying `edges` source array.
 *
 *   LOD 0 / 1  no static labels
 *   LOD 2      every `slotName` label (the semantic level: zoomed in enough to
 *              read the whole graph's relationship names)
 *
 * Rationale (R2.8.8): the previous LOD1 "required-FK only" band rendered a
 * subset of midpoint labels at exactly the zoom where long orthogonal paths run
 * through empty space, so they floated detached and overlapped. Relationship
 * identity is now a property of the *inspected* relationship: below LOD2 the
 * selected/hovered edge's existing `edge.label` is rendered at a stable screen
 * size by `EdgeLabelOverlay.svelte`; everything else stays unlabelled. LOD2
 * restores the full static set, where the zoom is sufficient to read it.
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

export function applyEdgeLod(edges: Edge[], level: number): Edge[] {
  // Semantic level: full annotation, same array reference (no re-render).
  if (level >= 2) return edges;

  // Below the semantic level there are no static labels; the overlay owns the
  // label of the selected/hovered relationship only. Drop the label without
  // touching geometry/style/data.
  return edges.map((edge) => {
    const { label: _label, ...rest } = edge;
    return rest as Edge;
  });
}
