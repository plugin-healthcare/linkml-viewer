<script lang="ts">
  /**
   * R2.6.4.2 counter-scaled selected-edge label.
   *
   * Presentation-only child of <SvelteFlow>. Below LOD2 the ordinary
   * zoom-coupled `edge.label` is suppressed for the natively selected edge(s)
   * by `edgeLod.ts`; this component renders that same label text at a fixed
   * on-screen size, anchored to the edge's own flow-space midpoint and
   * inverse-scaled against the viewport zoom (`1 / zoom`) so it stays legible
   * at overview. It consumes only the existing `edge.label`, the derived
   * `strongEdgeIds`, the layout `edges` array, and the Svelte Flow viewport —
   * it reconstructs no relationship semantics and changes no geometry.
   *
   * The label lives inside the transformed viewport (via `ViewportPortal`), so
   * pan moves it with the relationship automatically; only the inverse scale
   * tracks zoom. The viewport is `pointer-events: none`, so the overlay never
   * intercepts canvas pan or selection.
   */
  import { untrack } from 'svelte';
  import { ViewportPortal, useStore, type Edge } from '@xyflow/svelte';

  interface Props {
    /** Layout source edges (labels intact; never mutated). */
    edges: Edge[];
    /** Natively selected edge ids (`relationshipFocus.strongEdgeIds`). */
    strongEdgeIds: ReadonlySet<string>;
    /** Current shared LOD level. */
    level: number;
  }

  let { edges, strongEdgeIds, level }: Props = $props();

  const store = useStore();

  // Below LOD2 the ordinary zoom-coupled label is suppressed for the selected
  // edges, so the overlay supplies the readable replacement. At LOD2 the
  // ordinary label is already legible and the overlay stands down (no duplicate).
  const activeIds = $derived(level < 2 ? [...strongEdgeIds] : []);

  const zoom = $derived(store.viewport.zoom);
  const inverseZoom = $derived(zoom > 0 ? 1 / zoom : 1);

  const labelsById = $derived.by(() => {
    const active = new Set(activeIds);
    const map = new Map<string, { label: string; kind: string }>();
    for (const edge of edges) {
      if (!active.has(edge.id) || !edge.label) continue;
      const kind =
        (edge.data as unknown as { edgeKind?: string } | undefined)?.edgeKind ?? 'fk';
      map.set(edge.id, { label: String(edge.label), kind });
    }
    return map;
  });

  /** Flow-space anchor of each active edge, in document order. */
  let anchors = $state<{ id: string; x: number; y: number }[]>([]);

  function edgePath(id: string): SVGPathElement | null {
    const groups = document.querySelectorAll('.svelte-flow__edge');
    for (const group of groups) {
      if (group.getAttribute('data-id') !== id) continue;
      return group.querySelector<SVGPathElement>('.svelte-flow__edge-path');
    }
    return null;
  }

  // Read the edge's own rendered path midpoint (flow coordinates) — the same
  // geometry Svelte Flow centres the ordinary label on. Consumed, never
  // reconstructed. Re-measured when the active set or the edge array changes,
  // and on viewport changes: a layout switch replaces the edge DOM and then
  // fits, so subscribing to the viewport lets the fit animation re-measure the
  // new paths once they exist.
  $effect(() => {
    const ids = activeIds;
    void edges;
    const viewport = store.viewport;
    void viewport.x;
    void viewport.y;
    void viewport.zoom;
    if (ids.length === 0) {
      if (untrack(() => anchors).length > 0) anchors = [];
      return;
    }
    const next: { id: string; x: number; y: number }[] = [];
    for (const id of ids) {
      const path = edgePath(id);
      if (!path) continue;
      const length = path.getTotalLength();
      if (!length) continue;
      const point = path.getPointAtLength(length / 2);
      next.push({ id, x: point.x, y: point.y });
    }
    const prev = untrack(() => anchors);
    const same =
      prev.length === next.length &&
      prev.every((a, i) => a.id === next[i].id && a.x === next[i].x && a.y === next[i].y);
    if (!same) anchors = next;
  });
</script>

{#if anchors.length > 0 && zoom > 0}
  <ViewportPortal target="front">
    {#each anchors as anchor (anchor.id)}
      {@const info = labelsById.get(anchor.id)}
      {#if info}
        <div
          class="erd-edge-label"
          class:erd-edge-label--etl={info.kind === 'etl'}
          data-edge-id={anchor.id}
          style:transform="translate(-50%, -50%) translate({anchor.x}px, {anchor.y}px) scale({inverseZoom})"
        >
          {info.label}
        </div>
      {/if}
    {/each}
  </ViewportPortal>
{/if}

<style>
  .erd-edge-label {
    position: absolute;
    top: 0;
    left: 0;
    padding: 2px 4px;
    font-size: 12px;
    line-height: 1.4;
    white-space: nowrap;
    color: var(--erd-edge-label-fk);
    background: var(--xy-edge-label-background-color);
    border-radius: 3px;
    pointer-events: none;
    transform-origin: 50% 50%;
  }

  .erd-edge-label--etl {
    color: var(--erd-edge-label-etl);
  }
</style>
