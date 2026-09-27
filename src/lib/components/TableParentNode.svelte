<script lang="ts">
  import { getContext } from 'svelte';
  import { Handle, Position, type NodeProps, type Node } from '@xyflow/svelte';
  import type { ErdTableNodeData, GroupInfo, RelationshipFocus } from '$lib/types';

  // Accept the base unparameterised NodeProps — re-derive our data shape below.
  // The native handle props come from layout.ts (declared once). A collapsed
  // table exposes its own handles so its incident edges anchor to the header
  // instead of being dropped; an expanded table renders none (the column
  // children own the handles).
  let {
    data,
    id,
    sourcePosition = Position.Bottom,
    targetPosition = Position.Top,
  }: NodeProps<Node<Record<string, unknown>>> = $props();

  // Re-derive data reactively so Svelte can track changes when parent rebuilds the node.
  const rawData = $derived(data as unknown as ErdTableNodeData);

  // Group config injected by +page.svelte via setContext.
  const groupCtx = getContext<{ map: Map<string, GroupInfo> | null }>('groupConfig');

  // File config injected by +page.svelte via setContext.
  const fileCtx = getContext<{ map: Map<string, string> }>('fileConfig');

  // Collapse toggle callback — injected via context by +page.svelte
  // so that the parent can update the collapsed Set and trigger a graph rebuild.
  const collapseCtx = getContext<{ toggle: (id: string) => void } | null>('collapseToggle');

  // Search-target context — transient navigation emphasis. The table is
  // highlighted iff it is the current search target; this is derived, never
  // written back into the node array.
  const searchCtx = getContext<{ target: string | null } | null>('searchTarget');
  const highlighted = $derived(searchCtx?.target === id);

  // Keyboard cursor — the table currently under graph navigation. Derived from
  // context, never written into the node array.
  const cursorCtx = getContext<{ id: string | null } | null>('cursor');
  const isCursor = $derived(cursorCtx?.id === id);

  // Relationship focus — derived from native Svelte Flow selection in
  // +page.svelte, distinct from searchTarget (search emphasis) and cursor
  // (keyboard navigation).
  const focusCtx = getContext<RelationshipFocus | null>('relationshipFocus');
  // Three distinct states (R2.8.7): SELECTED is the object the user chose;
  // RELATED is connected to it; DIMMED is everything else while focus is active.
  const isSelected = $derived(focusCtx?.active === true && focusCtx.selectedTableIds.has(id));
  const isRelated = $derived(
    focusCtx?.active === true && !isSelected && focusCtx.tableIds.has(id)
  );
  const isDimmed = $derived(focusCtx?.active === true && !isSelected && !isRelated);

  const DEFAULT_COLOR = '#475569';
  const DEFAULT_TEXT = '#ffffff';

  const headerColor = $derived((() => {
    const group = rawData.group;
    const map = groupCtx?.map;
    if (!group || !map) return DEFAULT_COLOR;
    return map.get(group)?.color ?? map.get('default')?.color ?? DEFAULT_COLOR;
  })());

  const headerText = $derived((() => {
    const group = rawData.group;
    const map = groupCtx?.map;
    if (!group || !map) return DEFAULT_TEXT;
    return map.get(group)?.text_color ?? map.get('default')?.text_color ?? DEFAULT_TEXT;
  })());

  // Left stripe color — only shown when multiple files are loaded.
  const stripeColor = $derived((() => {
    const fileId = rawData.fileId;
    const map = fileCtx?.map;
    if (!fileId || !map || map.size <= 1) return null;
    return map.get(fileId) ?? null;
  })());

  // ---------------------------------------------------------------------------
  // Collapse state — derived directly from data prop so it stays in sync
  // without the round-trip latency of a $state/$effect pair.
  // ---------------------------------------------------------------------------
  const collapsed = $derived(rawData.collapsed);

  // Collapse and selection are separate affordances (R2.8.7): the chevron
  // button toggles collapse, while the header selects the table. Stopping
  // propagation keeps a chevron click from also being read as a node selection
  // (or a drag) by Svelte Flow, so collapsing never changes the selection.
  function toggleCollapse(e: MouseEvent) {
    e.stopPropagation();
    collapseCtx?.toggle(id);
  }
</script>

<!-- The node itself is the container rendered by Svelte Flow.
     Expanded: the column child nodes own the directional Handles.
     Collapsed: the columns are gone, so this node exposes its own Handles
     (sides from the native node props) — otherwise Svelte Flow cannot resolve
     an edge endpoint that is a bare table id and would drop the edge. -->

{#if collapsed}
  <Handle type="source" position={sourcePosition} />
  <Handle type="target" position={targetPosition} />
{/if}

<div
  class="table-parent"
  class:collapsed
  class:highlighted={highlighted}
  class:cursor={isCursor}
  class:selected={isSelected}
  class:related={isRelated}
  class:dimmed={isDimmed}
>
  <!-- The header is the table's selection surface: a click selects the table
       node natively. Collapsing is a distinct control — the chevron button —
       so "select" and "collapse" never share a target. -->
  <div
    class="header"
    style:background={headerColor}
    style:color={headerText}
    style:padding-left={stripeColor ? '16px' : '10px'}
    title={rawData.description || rawData.label}
  >
    {#if stripeColor}
      <span class="file-stripe" style:background={stripeColor}></span>
    {/if}
    <span class="table-name">{rawData.label}</span>
    <span class="slot-count" style:color={headerText}>
      {rawData.slotCount} col{rawData.slotCount !== 1 ? 's' : ''}
    </span>
    <button
      class="collapse-toggle"
      onclick={toggleCollapse}
      onpointerdown={(e) => e.stopPropagation()}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${rawData.label}` : `Collapse ${rawData.label}`}
      title={collapsed ? 'Expand table' : 'Collapse table'}
    >
      <span class="collapse-icon">{collapsed ? '▶' : '▼'}</span>
    </button>
  </div>
</div>

<style>
  .table-parent {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12px;
    background: #ffffff;
    border: 1.5px solid #cbd5e1;
    border-radius: 6px;
    overflow: visible; /* allow column handle dots to be visible at the edges */
    width: 100%;
    height: 100%;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
    box-sizing: border-box;
  }

  .table-parent.collapsed {
    border-color: #94a3b8;
    overflow: hidden;
  }

  .table-parent.highlighted {
    border-color: #f59e0b;
    box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.35), 0 1px 4px rgba(0, 0, 0, 0.08);
    transition: box-shadow 0.2s ease, border-color 0.2s ease;
  }

  /* Keyboard cursor — persistent, non-time-limited focus ring (WCAG 2.4.7). */
  .table-parent.cursor {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }

  /* Selected (R2.8.7) — the table the user explicitly chose. Strongest state:
     a blue ring, clearly stronger than the slate `related` ring below. */
  .table-parent.selected {
    border-color: #1d4ed8;
    box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.5), 0 2px 8px rgba(29, 78, 216, 0.22);
  }

  /* Relationship focus (R2.4.1) — modest emphasis for the selected table and
     its neighbours; reduced prominence (not hidden) for everything else. No
     movement, no geometry change, no animation. */
  .table-parent.related {
    border-color: #334155;
    box-shadow: 0 0 0 2px rgba(51, 65, 85, 0.28), 0 1px 4px rgba(0, 0, 0, 0.08);
  }

  .table-parent.dimmed {
    opacity: 0.4;
  }

  /* Header — the table's selection surface (a plain element; a click selects
     the node natively). `cursor: pointer` signals "clickable". */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    cursor: pointer;
    width: 100%;
    height: 36px;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.15);
    text-align: left;
    gap: 6px;
    position: relative;
    box-sizing: border-box;
  }

  /* Collapse control — the only collapse affordance, distinct from selection.
     Stops propagation so toggling never selects (or drags) the table. */
  .collapse-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.75;
  }

  .collapse-toggle:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.2);
  }

  .collapse-toggle:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 1px;
    opacity: 1;
  }

  /* File source stripe — 6px left edge, absolutely positioned */
  .file-stripe {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 6px;
    border-radius: 4px 0 0 4px;
    pointer-events: none;
  }

  .table-name {
    font-weight: 700;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .slot-count {
    font-size: 9px;
    opacity: 0.7;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .collapse-icon {
    font-size: 9px;
    opacity: 0.75;
    flex-shrink: 0;
  }
</style>
