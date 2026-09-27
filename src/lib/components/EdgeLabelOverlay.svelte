<script lang="ts">
  /**
   * R2.6.4.2 / R2.8.8 counter-scaled inspected-edge label.
   *
   * Presentation-only child of <SvelteFlow>. Below LOD2 `edgeLod.ts` suppresses
   * every static `edge.label`; this component renders the label text of the
   * *inspected* relationship(s) — the natively selected edge(s) plus the edge
   * under the pointer — at a fixed on-screen size, anchored to the edge's own
   * flow-space midpoint and inverse-scaled against the viewport zoom
   * (`1 / zoom`) so it stays legible at overview. It consumes only the existing
   * `edge.label`, the derived `strongEdgeIds` / hovered id, the layout `edges`
   * array, and the Svelte Flow viewport — it reconstructs no relationship
   * semantics and changes no geometry.
   *
   * The label lives inside the transformed viewport (via `ViewportPortal`), so
   * pan moves it with the relationship automatically; only the inverse scale
   * tracks zoom. The viewport is `pointer-events: none`, so the overlay never
   * intercepts canvas pan or selection.
   *
   * The anchors are a pure function of (active ids, layout `edges`, viewport):
   * re-reading the rendered edge path midpoints is exactly what the viewport
   * dependency drives, so a `$derived` is sufficient and no state/effect pair is
   * needed.
   */
  import { ViewportPortal, useStore, type Edge } from '@xyflow/svelte';

  interface Props {
    /** Layout source edges (labels intact; never mutated). */
    edges: Edge[];
    /** Natively selected edge ids (`relationshipFocus.strongEdgeIds`). */
    strongEdgeIds: ReadonlySet<string>;
    /** Edge currently under the pointer, or null (R2.8.8 hover inspection). */
    hoveredEdgeId?: string | null;
    /** Current shared LOD level. */
    level: number;
  }

  let { edges, strongEdgeIds, hoveredEdgeId = null, level }: Props = $props();

  const store = useStore();

  // Below LOD2 no static label renders (see edgeLod.ts), so the overlay supplies
  // the readable label for the *inspected* relationship(s): the natively
  // selected edge(s) plus the edge currently under the pointer. At LOD2 the full
  // static set is legible and the overlay stands down (no duplicate).
  const activeIds = $derived(
    level < 2
      ? [...new Set([...strongEdgeIds, ...(hoveredEdgeId ? [hoveredEdgeId] : [])])]
      : []
  );

  const zoom = $derived(store.viewport.zoom);
  const inverseZoom = $derived(zoom > 0 ? 1 / zoom : 1);

  /** Label text + kind for each active edge, keyed by edge id. */
  const labelsById = $derived.by(() => {
    const active = new Set(activeIds);
    const out: Record<string, { label: string; kind: string }> = {};
    for (const edge of edges) {
      if (!active.has(edge.id) || !edge.label) continue;
      const kind =
        (edge.data as unknown as { edgeKind?: string } | undefined)?.edgeKind ?? 'fk';
      out[edge.id] = { label: String(edge.label), kind };
    }
    return out;
  });

  function edgePath(id: string): SVGPathElement | null {
    const groups = document.querySelectorAll('.svelte-flow__edge');
    for (const group of groups) {
      if (group.getAttribute('data-id') !== id) continue;
      return group.querySelector<SVGPathElement>('.svelte-flow__edge-path');
    }
    return null;
  }

  /**
   * Flow-space midpoint of each active edge's rendered path — the same geometry
   * Svelte Flow centres the ordinary label on. Consumed, never reconstructed.
   * Dependencies (active ids, `edges`, viewport x/y/zoom) mirror the previous
   * measurement subscribe set, so the post-layout fit animation re-measures once
   * the new edge DOM exists.
   */
  const anchors = $derived.by(() => {
    const ids = activeIds;
    void edges;
    const viewport = store.viewport;
    void viewport.x;
    void viewport.y;
    void viewport.zoom;
    if (ids.length === 0) return [] as { id: string; x: number; y: number }[];
    const out: { id: string; x: number; y: number }[] = [];
    for (const id of ids) {
      const path = edgePath(id);
      if (!path) continue;
      const length = path.getTotalLength();
      if (!length) continue;
      const point = path.getPointAtLength(length / 2);
      out.push({ id, x: point.x, y: point.y });
    }
    return out;
  });
</script>

{#if anchors.length > 0 && zoom > 0}
  <ViewportPortal target="front">
    {#each anchors as anchor (anchor.id)}
      {@const info = labelsById[anchor.id]}
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
