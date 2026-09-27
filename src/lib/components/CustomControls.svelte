<script lang="ts">
  import { useSvelteFlow } from '@xyflow/svelte';
  import { useStore } from '@xyflow/svelte';
  import type { LayoutOptions } from '$lib/types';

  interface Props {
    layoutOptions: LayoutOptions;
    layoutLoading: boolean;
    onlayoutselect: (opts: LayoutOptions) => void;
    // Phase B / B1 geometry-density controls. Kept as plain callbacks so the
    // viewport/layout ownership stays in +page.svelte (controls never fitView
    // except through the explicit `onfitcollapsed` intent).
    collapseCount: number;
    tableTotal: number;
    oncollapseall: () => void;
    onexpandall: () => void;
    onfitcollapsed: () => void;
  }

  let {
    layoutOptions,
    layoutLoading,
    onlayoutselect,
    collapseCount,
    tableTotal,
    oncollapseall,
    onexpandall,
    onfitcollapsed,
  }: Props = $props();

  const { zoomIn, zoomOut, fitView } = useSvelteFlow();
  const store = $derived(useStore());

  // Connectability is permanently disabled at the <SvelteFlow> level (the graph
  // is schema-derived, so handles must never be draggable). The lock therefore
  // governs only the two remaining interactive affordances: node dragging and
  // element selection. It must never re-enable connection creation.
  const isInteractive = $derived(
    store.nodesDraggable || store.elementsSelectable
  );
  const minZoomReached = $derived(store.viewport.zoom <= store.minZoom);
  const maxZoomReached = $derived(store.viewport.zoom >= store.maxZoom);

  function toggleInteractivity() {
    const next = !isInteractive;
    store.nodesDraggable = next;
    store.elementsSelectable = next;
    // store.nodesConnectable stays false — never assigned here.
  }

  // R2.8.11 — the layout is exposed as two orthogonal, intent-labelled axes
  // instead of the engine-initials glyphs (`D→ D↓ E→ E↓`). Direction is the
  // primary control ("Left → Right" / "Top → Bottom"); the engine (Dagre / ELK)
  // is secondary. Selecting either axis preserves the other, and a click is a
  // plain `onlayoutselect` on the resulting combination — no new semantics.
  const DIRECTIONS: Array<{
    direction: LayoutOptions['direction'];
    label: string;
    title: string;
  }> = [
    { direction: 'LR', label: 'Left → Right', title: 'Lay the graph out left to right' },
    { direction: 'TB', label: 'Top → Bottom', title: 'Lay the graph out top to bottom' },
  ];

  const ENGINES: Array<{
    engine: LayoutOptions['engine'];
    label: string;
    title: string;
  }> = [
    { engine: 'elk', label: 'ELK', title: 'ELK layered layout engine' },
    { engine: 'dagre', label: 'Dagre', title: 'Dagre layout engine' },
  ];

  function selectDirection(direction: LayoutOptions['direction']) {
    if (layoutLoading || layoutOptions.direction === direction) return;
    onlayoutselect({ engine: layoutOptions.engine, direction });
  }

  function selectEngine(engine: LayoutOptions['engine']) {
    if (layoutLoading || layoutOptions.engine === engine) return;
    onlayoutselect({ engine, direction: layoutOptions.direction });
  }
</script>

<div class="controls-panel" role="toolbar" aria-label="Canvas controls">
  <!-- View -->
  <button
    class="ctrl-btn"
    title="Zoom in"
    aria-label="Zoom in"
    disabled={maxZoomReached}
    onclick={() => zoomIn()}
  >
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" class="icon">
      <path d="M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z" />
    </svg>
  </button>
  <button
    class="ctrl-btn"
    title="Zoom out"
    aria-label="Zoom out"
    disabled={minZoomReached}
    onclick={() => zoomOut()}
  >
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 5" class="icon">
      <path d="M0 0h32v4.2H0z" />
    </svg>
  </button>
  <button
    class="ctrl-btn"
    title="Fit view"
    aria-label="Fit view"
    onclick={() => fitView({ padding: 0.15, duration: 400 })}
  >
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30" class="icon">
      <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
    </svg>
  </button>
  <button
    class="ctrl-btn"
    title={isInteractive ? 'Lock dragging and selection' : 'Unlock dragging and selection'}
    aria-label={isInteractive ? 'Lock dragging and selection' : 'Unlock dragging and selection'}
    aria-pressed={!isInteractive}
    onclick={toggleInteractivity}
  >
    {#if isInteractive}
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 32" class="icon">
        <path d="M21.333 10.667H19.81V7.619C19.81 3.429 16.38 0 12.19 0c-4.114 1.828-1.37 2.133.305 2.438 1.676.305 4.42 2.59 4.42 5.181v3.048H3.047A3.056 3.056 0 000 13.714v15.238A3.056 3.056 0 003.048 32h18.285a3.056 3.056 0 003.048-3.048V13.714a3.056 3.056 0 00-3.048-3.047zM12.19 24.533a3.056 3.056 0 01-3.047-3.047 3.056 3.056 0 013.047-3.048 3.056 3.056 0 013.048 3.048 3.056 3.056 0 01-3.048 3.047z" />
      </svg>
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 32" class="icon">
        <path d="M21.333 10.667H19.81V7.619C19.81 3.429 16.38 0 12.19 0 8 0 4.571 3.429 4.571 7.619v3.048H3.048A3.056 3.056 0 000 13.714v15.238A3.056 3.056 0 003.048 32h18.285a3.056 3.056 0 003.048-3.048V13.714a3.056 3.056 0 00-3.048-3.047zM12.19 24.533a3.056 3.056 0 01-3.047-3.047 3.056 3.056 0 013.047-3.048 3.056 3.056 0 013.048 3.048 3.056 3.056 0 01-3.048 3.047zm4.724-13.866H7.467V7.619c0-2.59 2.133-4.724 4.723-4.724 2.591 0 4.724 2.133 4.724 4.724v3.048z" />
      </svg>
    {/if}
  </button>

  <!-- Geometry density. Collapse All / Expand All are content mutations
       (viewport-preserving); Fit Collapsed is the one explicit fit among them. -->
  <button
    class="ctrl-btn ctrl-btn-glyph"
    title="Collapse all tables"
    aria-label="Collapse all"
    disabled={tableTotal > 0 && collapseCount >= tableTotal}
    onclick={oncollapseall}
  >
    ⊟
  </button>
  <button
    class="ctrl-btn ctrl-btn-glyph"
    title="Expand all tables"
    aria-label="Expand all"
    onclick={onexpandall}
  >
    ⊞
  </button>
  <button
    class="ctrl-btn ctrl-btn-glyph span-2"
    title="Collapse all and fit the resulting overview"
    aria-label="Fit collapsed"
    onclick={onfitcollapsed}
  >
    ⤢ Fit collapsed
  </button>

  <!-- Layout: direction (primary) and engine (secondary) as labelled axes. -->
  <div class="ctrl-caption">Layout direction</div>
  {#each DIRECTIONS as d (d.direction)}
    <button
      class="ctrl-btn ctrl-btn-label"
      class:active={layoutOptions.direction === d.direction}
      title={d.title}
      aria-label={`Layout direction: ${d.label}`}
      aria-pressed={layoutOptions.direction === d.direction}
      disabled={layoutLoading}
      onclick={() => selectDirection(d.direction)}
    >
      {#if layoutLoading && layoutOptions.direction === d.direction}
        <span class="ctrl-spin">⟳</span>
      {:else}
        {d.label}
      {/if}
    </button>
  {/each}

  <div class="ctrl-caption">Engine</div>
  {#each ENGINES as e (e.engine)}
    <button
      class="ctrl-btn ctrl-btn-label"
      class:active={layoutOptions.engine === e.engine}
      title={e.title}
      aria-label={`Layout engine: ${e.label}`}
      aria-pressed={layoutOptions.engine === e.engine}
      disabled={layoutLoading}
      onclick={() => selectEngine(e.engine)}
    >
      {e.label}
    </button>
  {/each}
</div>

<style>
  .controls-panel {
    position: absolute;
    bottom: 24px;
    left: 12px;
    z-index: 5;
    display: grid;
    grid-template-columns: 1fr 1fr;
    width: 188px;
    gap: 1px;
    background: var(--xy-controls-button-border-color, #eee);
    border: 1px solid var(--xy-controls-button-border-color, #eee);
    border-radius: 4px;
    overflow: hidden;
    box-shadow: var(--xy-controls-box-shadow, 0 1px 4px rgba(0, 0, 0, 0.12));
  }

  .ctrl-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 28px;
    background: var(--xy-controls-button-background-color, #fefefe);
    color: var(--xy-controls-button-color, #222);
    border: none;
    cursor: pointer;
    font-size: 10px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    padding: 0;
    transition: background 0.1s;
  }

  .ctrl-btn:hover:not(:disabled) {
    background: var(--xy-controls-button-background-color-hover, #f4f4f4);
  }

  .ctrl-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ctrl-btn.active {
    background: var(--erd-controls-active-bg, #475569);
    color: var(--erd-controls-active-fg, #fff);
  }

  /* Wider glyph / labelled rows */
  .ctrl-btn-glyph {
    font-size: 14px;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }

  .ctrl-btn-label {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 11px;
    font-weight: 600;
    padding: 0 6px;
    white-space: nowrap;
  }

  .ctrl-btn.span-2 {
    grid-column: span 2;
    width: auto;
  }

  /* Small section caption, spanning both columns. */
  .ctrl-caption {
    grid-column: span 2;
    padding: 5px 7px 3px;
    background: var(--xy-controls-button-background-color, #fefefe);
    color: #6b7280;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-align: left;
  }

  .icon {
    width: 12px;
    height: 12px;
    fill: currentColor;
  }

  .ctrl-spin {
    display: inline-block;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
</style>
