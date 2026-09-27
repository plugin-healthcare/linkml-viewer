<script lang="ts">
  /**
   * R2.8.12 — relationship inspector.
   *
   * Presentation-only. It reads the *same* reconciled relationship surface the
   * canvas consumes — the layout `edges` array (materialised from the artefact
   * by `layout.ts`) — and lists the selected table's outgoing and incoming
   * relationships. It never re-parses LinkML, never re-derives a relationship,
   * and holds no state of its own beyond what selection hands it:
   *
   *   producer → reconciled artefact → layout `edges` ─┬─ canvas
   *                                                     ├─ relationship focus
   *                                                     └─ this inspector
   *
   * Clicking a row selects that edge natively (via the parent callback), so the
   * canvas highlight and focus are the ordinary ones. No parallel semantic path.
   */
  import type { Edge } from '@xyflow/svelte';
  import { COL_ID_SEP } from '$lib/layout';

  interface Props {
    /** Layout source edges (the reconciled relationship surface). */
    edges: Edge[];
    /** Selected tables (`relationshipFocus.selectedTableIds`). */
    selectedTableIds: ReadonlySet<string>;
    /** Natively selected edges (`relationshipFocus.strongEdgeIds`). */
    selectedEdgeIds: ReadonlySet<string>;
    /** Select an edge natively (canvas highlight + focus). */
    onselectedge: (edgeId: string) => void;
    /** Clear the current selection (close the inspector). */
    onclose: () => void;
  }

  let { edges, selectedTableIds, selectedEdgeIds, onselectedge, onclose }: Props = $props();

  /** Table id owning a node id (mirrors edgeFocus.ts / layout.ts). */
  function tableOf(nodeId: string): string {
    const sep = nodeId.indexOf(COL_ID_SEP);
    return sep >= 0 ? nodeId.slice(0, sep) : nodeId;
  }

  /** Column (slot) segment of a node id, or '' when the endpoint is a collapsed table. */
  function slotOf(nodeId: string): string {
    const sep = nodeId.indexOf(COL_ID_SEP);
    return sep >= 0 ? nodeId.slice(sep + 1) : '';
  }

  function kindOf(edge: Edge): 'fk' | 'etl' {
    return (edge.data as { edgeKind?: string } | undefined)?.edgeKind === 'etl' ? 'etl' : 'fk';
  }

  function slotNameOf(edge: Edge): string {
    const fromData = (edge.data as { slotName?: string } | undefined)?.slotName;
    return String(fromData ?? edge.label ?? '');
  }

  function requiredOf(edge: Edge): boolean {
    return (edge.data as { required?: boolean } | undefined)?.required === true;
  }

  /** "table.slot" (or just "table" when collapsed). */
  function refOf(nodeId: string): string {
    const slot = slotOf(nodeId);
    return slot ? `${tableOf(nodeId)}.${slot}` : tableOf(nodeId);
  }

  const tableCount = $derived(selectedTableIds.size);
  const selectedEdge = $derived(
    selectedEdgeIds.size === 1
      ? edges.find((e) => selectedEdgeIds.has(e.id)) ?? null
      : null
  );

  // Rows are grouped by table. When an edge is selected (edge precedence makes
  // `selectedTableIds` empty), fall back to the edge's source table so the list
  // context is preserved and the selected row is simply marked — selecting a
  // relationship from the list never makes the list disappear.
  const focusTable = $derived(
    [...selectedTableIds][0] ?? (selectedEdge ? tableOf(selectedEdge.source) : null)
  );

  const outgoing = $derived(
    focusTable === null ? [] : edges.filter((e) => tableOf(e.source) === focusTable)
  );
  const incoming = $derived(
    focusTable === null ? [] : edges.filter((e) => tableOf(e.target) === focusTable)
  );

  const title = $derived(
    focusTable === null
      ? 'Inspector'
      : `${focusTable}${tableCount > 1 ? ` +${tableCount - 1}` : ''}`
  );
</script>

<aside class="inspector" aria-label="Relationship inspector" data-testid="relationship-inspector">
  <header class="ri-header">
    <span class="ri-title" title={title}>{title}</span>
    <button class="ri-close" onclick={onclose} aria-label="Close inspector" title="Close inspector">
      ×
    </button>
  </header>

  <div class="ri-body">
    {#if selectedEdge}
      <!-- The selected relationship, in full, above its table's lists. -->
      <div class="ri-detail">
        <div class="ri-detail-row">
          <span class="ri-detail-label">Slot</span>
          <span class="ri-detail-value ri-mono">{slotNameOf(selectedEdge)}</span>
        </div>
        <div class="ri-detail-row">
          <span class="ri-detail-label">From</span>
          <span class="ri-detail-value ri-mono">{refOf(selectedEdge.source)}</span>
        </div>
        <div class="ri-detail-row">
          <span class="ri-detail-label">To</span>
          <span class="ri-detail-value ri-mono">{refOf(selectedEdge.target)}</span>
        </div>
        <div class="ri-detail-row">
          <span class="ri-detail-label">Kind</span>
          <span class="ri-detail-value">
            <span class="ri-kind kind-{kindOf(selectedEdge)}">{kindOf(selectedEdge).toUpperCase()}</span>
            {#if kindOf(selectedEdge) === 'fk' && requiredOf(selectedEdge)}
              <span class="ri-required">required</span>
            {/if}
          </span>
        </div>
      </div>
    {/if}

    {#if focusTable}
      <section class="ri-group">
        <div class="ri-group-title">
          Outgoing <span class="ri-count">{outgoing.length}</span>
        </div>
        {#if outgoing.length === 0}
          <p class="ri-empty">No outgoing relationships.</p>
        {:else}
          {#each outgoing as edge (edge.id)}
            <button
              class="ri-row"
              class:ri-row-selected={selectedEdgeIds.has(edge.id)}
              aria-current={selectedEdgeIds.has(edge.id) ? 'true' : undefined}
              onclick={() => onselectedge(edge.id)}
            >
              <span class="ri-row-main">
                <span class="ri-slot">{slotNameOf(edge)}</span>
                <span class="ri-arrow" aria-hidden="true">→</span>
                <span class="ri-target">{refOf(edge.target)}</span>
              </span>
              <span class="ri-kind kind-{kindOf(edge)}">{kindOf(edge).toUpperCase()}</span>
            </button>
          {/each}
        {/if}
      </section>

      <section class="ri-group">
        <div class="ri-group-title">
          Incoming <span class="ri-count">{incoming.length}</span>
        </div>
        {#if incoming.length === 0}
          <p class="ri-empty">No incoming relationships.</p>
        {:else}
          {#each incoming as edge (edge.id)}
            <button
              class="ri-row"
              class:ri-row-selected={selectedEdgeIds.has(edge.id)}
              aria-current={selectedEdgeIds.has(edge.id) ? 'true' : undefined}
              onclick={() => onselectedge(edge.id)}
            >
              <span class="ri-row-main">
                <span class="ri-slot">{tableOf(edge.source)}.{slotNameOf(edge)}</span>
                <span class="ri-arrow" aria-hidden="true">→</span>
                <span class="ri-target">{slotOf(edge.target) || focusTable}</span>
              </span>
              <span class="ri-kind kind-{kindOf(edge)}">{kindOf(edge).toUpperCase()}</span>
            </button>
          {/each}
        {/if}
      </section>
    {:else if !selectedEdge}
      <p class="ri-hint">Select a table or a relationship on the canvas to inspect it.</p>
    {/if}
  </div>
</aside>

<style>
  .inspector {
    width: 300px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: #ffffff;
    border-left: 1px solid #e5e7eb;
    overflow: hidden;
    font-family: ui-sans-serif, system-ui, sans-serif;
    z-index: 10;
  }

  .ri-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid #e5e7eb;
    background: #f9fafb;
  }

  .ri-title {
    font-size: 12px;
    font-weight: 700;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ri-close {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #6b7280;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }

  .ri-close:hover {
    background: #e5e7eb;
    color: #111827;
  }

  .ri-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .ri-group {
    padding: 4px 0 8px;
  }

  .ri-group + .ri-group {
    border-top: 1px solid #f1f5f9;
  }

  .ri-group-title {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7280;
  }

  .ri-count {
    font-size: 9px;
    font-weight: 700;
    color: #94a3b8;
  }

  .ri-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 5px 10px;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  }

  .ri-row:hover {
    background: #f1f5f9;
  }

  /* The row for the natively selected relationship (R2.8.7 selected colour). */
  .ri-row-selected,
  .ri-row-selected:hover {
    background: #dbeafe;
    box-shadow: inset 3px 0 0 #1d4ed8;
  }

  .ri-row:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: -2px;
  }

  .ri-row-main {
    display: flex;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
    font-size: 11px;
  }

  .ri-slot {
    color: #0f172a;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ri-arrow {
    color: #94a3b8;
    flex-shrink: 0;
  }

  .ri-target {
    color: #475569;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ri-empty,
  .ri-hint {
    margin: 0;
    padding: 5px 10px;
    font-size: 11px;
    color: #94a3b8;
  }

  .ri-hint {
    padding-top: 10px;
  }

  .ri-detail {
    padding: 4px 0;
  }

  .ri-detail-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 5px 10px;
  }

  .ri-detail-label {
    flex-shrink: 0;
    width: 44px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #94a3b8;
  }

  .ri-detail-value {
    font-size: 12px;
    color: #0f172a;
    word-break: break-word;
  }

  .ri-mono {
    font-family: ui-monospace, monospace;
  }

  .ri-kind {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 3px;
  }

  .kind-fk {
    background: #e2e8f0;
    color: #475569;
  }

  .kind-etl {
    background: #e0e7ff;
    color: #4338ca;
  }

  .ri-required {
    margin-left: 6px;
    font-size: 10px;
    color: #6b7280;
  }
</style>
