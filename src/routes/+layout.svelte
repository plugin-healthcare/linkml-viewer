<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import { base } from '$app/paths';

  let { children } = $props();
</script>

<svelte:head>
  <title>LinkML ERD Viewer</title>
  <link rel="icon" type="image/png" href="{base}/logo.png" />
</svelte:head>

{@render children()}

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  /*
   * Svelte Flow theme contract — one source of visual truth.
   *
   * These are the library's native CSS variables (the `--xy-*` override names,
   * not the `-default` fallbacks). They are declared once, under the
   * `.svelte-flow` scope where `@xyflow/svelte/dist/style.css` loads, and every
   * Svelte Flow primitive the app renders resolves through this block:
   * Background, MiniMap, Handles, Controls, and the default edge. Components
   * stop carrying their own literals so a value changes in exactly one place.
   *
   * Light theme only: no `.svelte-flow.dark` block and no `colorMode` prop.
   * `--erd-*` are app-level semantic presentation tokens (edge kind, control
   * active state), declared once on `:root` below so both the canvas subtree and
   * the app-shell sidebars resolve them; not a redesign.
   */
  :global(.svelte-flow) {
    /* Canvas surface + dot pattern */
    --xy-background-color: #f3f4f6;
    --xy-background-pattern-color: #91919a;

    /* Default edge + handle primitives */
    --xy-edge-stroke: var(--erd-edge-fk);
    --xy-edge-stroke-width: 1.5;
    --xy-edge-label-background-color: #ffffff;
    --xy-handle-background-color: #1a192b;
    --xy-handle-border-color: #ffffff;

    /* Controls */
    --xy-controls-button-background-color: #fefefe;
    --xy-controls-button-background-color-hover: #f4f4f4;
    --xy-controls-button-color: #222;
    --xy-controls-button-color-hover: #222;
    --xy-controls-button-border-color: #eee;
    --xy-controls-box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);

    /* MiniMap */
    --xy-minimap-background-color: #ffffff;
    --xy-minimap-mask-background-color: rgba(240, 240, 240, 0.6);
    --xy-minimap-node-background-color: #e2e2e2;
    --xy-minimap-node-stroke-color: transparent;
  }

  /* App-level semantic presentation tokens — single source, `:root` scope so
     consumers both inside and outside `.svelte-flow` (e.g. the sidebars) resolve
     the same value. */
  :global(:root) {
    --erd-edge-fk: #475569;
    --erd-edge-etl: #6366f1; /* indigo-500 — ETL edge stroke (non-text) */
    --erd-edge-label-fk: #6b7280;
    --erd-edge-label-etl: #4f46e5; /* indigo-600 — ETL label text, ≥4.5:1 on white */
    --erd-controls-active-bg: #475569;
    --erd-controls-active-fg: #ffffff;
  }

  /*
   * Relationship focus (R2.4.1 table selection, R2.4.2 edge selection) —
   * presentation-only edge emphasis. The classes are applied by
   * src/lib/edgeFocus.ts; these rules change stroke opacity / add a glow, so
   * edge routing/geometry and markers are untouched. Nothing is hidden.
   *
   * `erd-edge-selected` is the *strong* emphasis for the natively selected
   * relationship (R2.4.2). The stroke colour, width, and the ETL dash pattern
   * all come from the edge's own inline style, so the FK (#475569 solid) vs
   * ETL (#6366f1 dashed) distinction and the ArrowClosed marker are preserved;
   * only opacity and an outer glow are added. No animation.
   */
  :global(.svelte-flow .svelte-flow__edge.erd-edge-selected .svelte-flow__edge-path) {
    stroke-opacity: 1;
    filter: drop-shadow(0 0 3px rgba(15, 23, 42, 0.55));
  }

  :global(.svelte-flow .svelte-flow__edge.erd-edge-focus .svelte-flow__edge-path) {
    stroke-opacity: 1;
  }

  :global(.svelte-flow .svelte-flow__edge.erd-edge-dim .svelte-flow__edge-path) {
    stroke-opacity: 0.18;
  }
</style>
