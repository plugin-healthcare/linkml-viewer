<script lang="ts">
  import { getContext } from 'svelte';
  import { Handle, Position, type NodeProps, type Node } from '@xyflow/svelte';
  import type { ErdColumnNodeData, RelationshipFocus } from '$lib/types';

  // Accept the base unparameterised NodeProps — re-derive our data shape below.
  // Handle sides come from Svelte Flow's native node props (declared once in
  // layout.ts), not from a `data` copy.
  let {
    data,
    sourcePosition = Position.Bottom,
    targetPosition = Position.Top,
  }: NodeProps<Node<Record<string, unknown>>> = $props();

  const rawData = $derived(data as unknown as ErdColumnNodeData);

  // Level of detail, derived from zoom by FlowController. Presentation only —
  // it never changes node geometry.
  const lodCtx = getContext<{ level: number } | null>('lodLevel');
  const lod = $derived(lodCtx?.level ?? 2);

  // Relationship focus — derived from native selection in +page.svelte. A row is
  // highlighted with its table and dimmed (never hidden) when its table is
  // outside the focused neighbourhood.
  const focusCtx = getContext<RelationshipFocus | null>('relationshipFocus');
  const isRelated = $derived(
    focusCtx?.active === true && focusCtx.tableIds.has(rawData.tableId)
  );
  const isDimmed = $derived(focusCtx?.active === true && !isRelated);

  const showBadge = $derived(lod >= 1);   // PK/FK marker
  const showType = $derived(lod >= 2);    // range ("integer", "Concept", …)
  const showMapping = $derived(lod >= 2); // ETL mapping badge

  const slotIcon = $derived.by(() => {
    if (rawData.identifier) return 'PK';
    if (rawData.is_fk) return 'FK';
    return '';
  });

  /** Return the first exact_mapping value, shortened for display.
   *  e.g. "omop_cdm54:Person.person_source_value" → "Person.person_source_value"
   */
  const primaryMapping = $derived.by(() => {
    const m = rawData.exact_mappings?.[0];
    if (!m) return '';
    const colon = m.lastIndexOf(':');
    return colon >= 0 ? m.slice(colon + 1) : m;
  });
</script>

<!-- Handle sides follow the active layout direction: LR/RIGHT → source right,
     target left; TB/DOWN → source bottom, target top. Declared once on the node
     by layout.ts and read here from the native NodeProps so the handles stay
     coherent with the engine's rank direction. Types are fixed (source/target);
     only the side varies. -->
<Handle type="source" position={sourcePosition} />
<Handle type="target" position={targetPosition} />

<div
  class="col-row"
  class:required={rawData.required}
  class:pk={rawData.identifier}
  class:fk={rawData.is_fk && !rawData.identifier}
  class:lod0={lod < 1}
  class:related={isRelated}
  class:dimmed={isDimmed}
  title={rawData.description || rawData.slotName}
>
  {#if showBadge}
    <span
      class="slot-badge"
      class:badge-pk={rawData.identifier}
      class:badge-fk={rawData.is_fk && !rawData.identifier}
    >
      {slotIcon}
    </span>
  {/if}
  <span class="slot-name">{rawData.slotName}</span>
  {#if showType}
    <span class="slot-type">{rawData.range}</span>
  {/if}
  {#if showMapping && primaryMapping}
    <span
      class="slot-mapping"
      title={rawData.exact_mappings?.join('\n')}
    >{primaryMapping}</span>
  {/if}
</div>

<style>
  .col-row {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px;
    height: 24px;
    width: 100%;
    background: #ffffff;
    border-bottom: 1px solid #f1f5f9;
    box-sizing: border-box;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12px;
    /* Prevent Svelte Flow's default node selection ring from obscuring the row */
    pointer-events: all;
  }

  .col-row.required .slot-name {
    font-weight: 600;
  }

  /* Overview level: names only, no badge/type/mapping. */
  .col-row.lod0 .slot-name {
    color: #334155;
  }

  /* Relationship focus (R2.4.1): rows of the focused table stay at full
     prominence; unrelated rows are reduced (not hidden). Presentation only. */
  .col-row.related .slot-name {
    color: #0f172a;
  }

  .col-row.dimmed {
    opacity: 0.4;
  }

  .slot-badge {
    font-size: 9px;
    font-weight: 700;
    width: 22px;
    flex-shrink: 0;
    color: #94a3b8;
    letter-spacing: 0;
  }

  .badge-pk {
    color: #b45309; /* amber-700 */
  }

  .badge-fk {
    color: #475569; /* slate-600 */
  }

  .slot-name {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #1e293b;
    font-size: 11px;
  }

  .slot-type {
    font-size: 10px;
    color: #64748b;
    white-space: nowrap;
    flex-shrink: 0;
    font-style: italic;
  }

  .slot-mapping {
    font-size: 9px;
    color: var(--erd-edge-label-etl);
    white-space: nowrap;
    flex-shrink: 0;
    font-style: italic;
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
  }
</style>
