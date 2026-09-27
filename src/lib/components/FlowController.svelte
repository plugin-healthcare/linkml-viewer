<script lang="ts">
  import { getContext } from 'svelte';
  import {
    useSvelteFlow,
    useStore,
    useOnSelectionChange,
    type Viewport,
  } from '@xyflow/svelte';
  import type { NavDirection } from '$lib/types';

  interface Props {
    panTarget: string | null;  // nodeId to centre on (table or column), or null
    panNonce: number;          // incremented on every search so repeat hits re-fire
    fitRequest: number;        // incremented only by explicit fit intents
    onpanned: () => void;      // called after centring so parent can clear panTarget
  }

  let { panTarget, panNonce, fitRequest, onpanned }: Props = $props();

  const { setCenter, getNode, fitView, getViewport, setViewport } = useSvelteFlow();
  const store = $derived(useStore());

  // Level-of-detail context, set by +page.svelte. FlowController is the only
  // component that can read the flow viewport, so it derives the level here and
  // writes it to the shared holder; nodes read it reactively.
  const lodCtx = getContext<{ level: number } | null>('lodLevel');

  // Native selection holder, set by +page.svelte. Svelte Flow owns selection;
  // this is the single point at which that native state is surfaced so the rest
  // of the app can derive relationship focus from it. No second selection model
  // exists — this only forwards the library's own `selectedNodes`/`selectedEdges`.
  const selectionCtx = getContext<{
    nodeIds: string[];
    edgeIds: string[];
  } | null>('selection');

  useOnSelectionChange(({ nodes: selectedNodes, edges: selectedEdges }) => {
    if (!selectionCtx) return;
    const nodeIds = selectedNodes.map((n) => n.id);
    const edgeIds = selectedEdges.map((e) => e.id);
    // Guard: only write when the id set actually changed, so a presentation
    // edge transform (which recomputes `store.edges`) cannot feed a loop.
    if (
      nodeIds.join('\u0001') !== selectionCtx.nodeIds.join('\u0001') ||
      edgeIds.join('\u0001') !== selectionCtx.edgeIds.join('\u0001')
    ) {
      selectionCtx.nodeIds = nodeIds;
      selectionCtx.edgeIds = edgeIds;
    }
  });

  // Level of detail derived from zoom. Thresholds are exact (no hysteresis):
  // the level is presentation-only and never changes node geometry, so toggling
  // at a boundary is cheap and chattering is harmless. Deterministic boundaries
  // also make the levels directly testable.
  //   0 OVERVIEW    zoom < 0.5
  //   1 STRUCTURAL  0.5 <= zoom < 0.85
  //   2 SEMANTIC    zoom >= 0.85
  const LOD_LOWER = 0.5;
  const LOD_UPPER = 0.85;

  function lodForZoom(zoom: number): number {
    if (zoom < LOD_LOWER) return 0;
    if (zoom < LOD_UPPER) return 1;
    return 2;
  }

  $effect(() => {
    const level = lodForZoom(store.viewport.zoom);
    if (lodCtx && lodCtx.level !== level) lodCtx.level = level;
  });

  // ---------------------------------------------------------------------------
  // Spatial geometry helpers — shared by search centring and keyboard
  // navigation. Both centre at the current zoom (never fitView).
  // ---------------------------------------------------------------------------
  function centerOf(id: string): { x: number; y: number } | null {
    const n = getNode(id);
    if (!n) return null;
    const abs =
      (n as unknown as { internals?: { positionAbsolute?: { x: number; y: number } } }).internals
        ?.positionAbsolute ?? n.position;
    const w = n.measured?.width ?? 260;
    const h = n.measured?.height ?? 40;
    return { x: (abs.x ?? 0) + w / 2, y: (abs.y ?? 0) + h / 2 };
  }

  export function getNodeCenter(id: string) {
    return centerOf(id);
  }

  export function centerNode(id: string) {
    const c = centerOf(id);
    if (!c) return;
    setCenter(c.x, c.y, { zoom: getViewport().zoom, duration: 300 });
  }

  /**
   * Spatial neighbour selection. Candidates must lie in the requested direction;
   * the score penalises perpendicular offset so the "most aligned" node wins.
   * With no current cursor, the node nearest the viewport centre is chosen.
   */
  export function moveCursor(
    ids: string[],
    fromId: string | null,
    dir: NavDirection
  ): string | null {
    const entries: { id: string; x: number; y: number }[] = [];
    for (const id of ids) {
      const c = centerOf(id);
      if (c) entries.push({ id, x: c.x, y: c.y });
    }
    if (entries.length === 0) return null;

    const from = entries.find((e) => e.id === fromId);
    if (!from) {
      const vp = getViewport();
      const w = store.width ?? 0;
      const h = store.height ?? 0;
      if (w > 0 && h > 0) {
        const cx = (w / 2 - vp.x) / vp.zoom;
        const cy = (h / 2 - vp.y) / vp.zoom;
        let best: string | null = null;
        let bestD = Infinity;
        for (const e of entries) {
          const d = (e.x - cx) ** 2 + (e.y - cy) ** 2;
          if (d < bestD) { bestD = d; best = e.id; }
        }
        return best;
      }
      return entries[0].id;
    }

    let best: string | null = null;
    let bestScore = Infinity;
    for (const e of entries) {
      if (e.id === from.id) continue;
      const dx = e.x - from.x;
      const dy = e.y - from.y;
      let primary: number;
      let perp: number;
      if (dir === 'right') { if (dx <= 1) continue; primary = dx; perp = Math.abs(dy); }
      else if (dir === 'left') { if (dx >= -1) continue; primary = -dx; perp = Math.abs(dy); }
      else if (dir === 'down') { if (dy <= 1) continue; primary = dy; perp = Math.abs(dx); }
      else { if (dy >= -1) continue; primary = -dy; perp = Math.abs(dx); }
      const score = primary + perp * 2;
      if (score < bestScore) { bestScore = score; best = e.id; }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Viewport preservation handle. +page.svelte captures the viewport immediately
  // before a *content* rebuild (collapse/expand) and calls restoreViewport()
  // once the new nodes are applied. Restoration is conditional: if the user
  // panned or zoomed while the async layout was running, their viewport wins.
  // Explicit fit intents (initial load, schema change, layout change, Fit
  // button) skip capture/restore entirely.
  // ---------------------------------------------------------------------------
  let savedViewport: Viewport | null = null;

  export function captureViewport() {
    savedViewport = getViewport();
  }

  export function restoreViewport() {
    const saved = savedViewport;
    savedViewport = null;
    if (!saved) return;

    const current = getViewport();
    const userMoved =
      Math.abs(current.x - saved.x) > 0.5 ||
      Math.abs(current.y - saved.y) > 0.5 ||
      Math.abs(current.zoom - saved.zoom) > 0.001;

    // The user moved during the async rebuild — leave their viewport alone.
    if (userMoved) return;

    const unchanged =
      Math.abs(current.x - saved.x) < 0.001 &&
      Math.abs(current.y - saved.y) < 0.001 &&
      Math.abs(current.zoom - saved.zoom) < 0.0001;

    // Svelte Flow preserves the viewport across node updates, so an unchanged
    // viewport needs no write. Skipping the redundant setViewport also avoids a
    // write/render feedback loop when a rebuild resolves synchronously.
    if (unchanged) return;

    setViewport(saved, { duration: 0 });
  }

  // Dev-only test seam: exposes the flow viewport primitives to the browser
  // test harness. Never registered in production builds.
  $effect(() => {
    if (!import.meta.env.DEV) return;
    (globalThis as Record<string, unknown>).__erdFlow = {
      getViewport,
      setViewport,
      fitView,
      getZoom: () => getViewport().zoom,
      getNodeCenter: (id: string) => centerOf(id),
    };
  });

  // Dev-only selection seam: drives *native* Svelte Flow selection deterministically
  // for the relationship-focus tests, for both nodes (R2.4.1) and edges
  // (R2.4.2). It uses the library's own selection actions, so the app code path
  // under test is exactly the one a real click triggers.
  $effect(() => {
    if (!import.meta.env.DEV) return;
    const s = store;
    (globalThis as Record<string, unknown>).__erdSelection = {
      getSelectedNodeIds: () => s.selectedNodes.map((n) => n.id),
      getSelectedEdgeIds: () => s.selectedEdges.map((e) => e.id),
      selectNodes: (ids: string[]) => {
        s.unselectNodesAndEdges();
        s.addSelectedNodes(ids);
      },
      selectEdges: (ids: string[]) => {
        s.unselectNodesAndEdges();
        s.addSelectedEdges(ids);
      },
      selectNodesAndEdges: (nodeIds: string[], edgeIds: string[]) => {
        s.unselectNodesAndEdges();
        s.addSelectedNodes(nodeIds);
        s.addSelectedEdges(edgeIds);
      },
      clear: () => s.unselectNodesAndEdges(),
      // Read-only projection of the lock state owned by the viewer (toggled in
      // CustomControls). It reports only which interactive affordances are
      // enabled; it can never write, so it adds no selection pathway.
      getSelectable: () => s.elementsSelectable,
      getDraggable: () => s.nodesDraggable,
    };
  });

  // Centre on the search-selected node. Zoom is read from the current viewport
  // so search never forces a zoom level — it only recentres.
  $effect(() => {
    const nonce = panNonce;
    if (nonce === 0 || !panTarget) return;

    const c = centerOf(panTarget);
    if (!c) { onpanned(); return; }

    setCenter(c.x, c.y, { zoom: getViewport().zoom, duration: 500 });
    onpanned();
  });

  // Explicit fit intents only (initial load, schema/layout change). Small delay
  // lets Svelte Flow settle the new node positions before measuring.
  $effect(() => {
    if (fitRequest === 0) return;
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
  });
</script>
