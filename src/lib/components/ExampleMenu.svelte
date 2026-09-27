<script lang="ts">
  // ---------------------------------------------------------------------------
  // R2.8.9 — example discovery + LinkML/ERD vocabulary.
  //
  // Presentation-only. It loads a *bundled* example through the same
  // `loadBundledSchema` path the default uses (no new semantic path), and it
  // explains the LinkML → ERD mapping so the database vocabulary on the canvas
  // is legible. The examples are descriptive fixtures, not a new model: the
  // counts below mirror the reconciled artefacts (`OMOP` 42 FK / 0 ETL;
  // `SEIN` 50 FK / 60 ETL). The default schema is unchanged.
  // ---------------------------------------------------------------------------
  interface Example {
    stem: string;
    label: string;
    detail: string;
  }

  const EXAMPLES: Example[] = [
    { stem: 'omop_cdm', label: 'OMOP CDM v5.4', detail: '37 tables · 42 FK · 0 ETL' },
    { stem: 'sein', label: 'SEIN (HiX → OMOP)', detail: '29 tables · 50 FK · 60 ETL' },
  ];

  interface Props {
    /** Stem of the active bundled example, or null when an uploaded file is active. */
    activeStem?: string | null;
    loading?: boolean;
    onload: (stem: string) => void;
  }

  let { activeStem = null, loading = false, onload }: Props = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  // Capture the menu root via an attachment (rather than bind:this) so the
  // click-outside test can be scoped to this menu.
  function rootAttachment(node: HTMLDivElement) {
    root = node;
    return () => {
      root = undefined;
    };
  }

  function choose(stem: string) {
    open = false;
    onload(stem);
  }

  function onWindowPointerDown(e: PointerEvent) {
    if (!open) return;
    if (root && !root.contains(e.target as Node)) open = false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onKeydown} />

<div class="example-menu" {@attach rootAttachment}>
  <button
    class="example-btn"
    class:active={open}
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    disabled={loading}
    onclick={() => (open = !open)}
    title="Load a bundled example schema"
  >
    <span class="example-btn-icon">◫</span>
    Examples
  </button>

  {#if open}
    <div class="example-popover" role="menu" aria-label="Example schemas">
      <div class="example-caption">
        Class → Table · Slot → Column · Range → related table
      </div>
      {#each EXAMPLES as example (example.stem)}
        <button
          class="example-item"
          class:current={example.stem === activeStem}
          type="button"
          role="menuitem"
          onclick={() => choose(example.stem)}
        >
          <span class="example-label">{example.label}</span>
          <span class="example-detail">{example.detail}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .example-menu {
    position: relative;
  }

  .example-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    background: #fff;
    border: 1.5px solid #d1d5db;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    color: #374151;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.12s ease;
  }

  .example-btn:hover:not(:disabled) {
    border-color: #6b7280;
    background: #f9fafb;
  }

  .example-btn.active {
    background: #1e293b;
    border-color: #1e293b;
    color: #fff;
  }

  .example-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .example-btn-icon {
    font-size: 11px;
    opacity: 0.8;
  }

  .example-popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 230px;
    padding: 6px;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(15, 23, 42, 0.14);
    z-index: 40;
  }

  .example-caption {
    padding: 4px 8px 6px;
    font-size: 10px;
    line-height: 1.4;
    color: #6b7280;
    border-bottom: 1px solid #f1f5f9;
    margin-bottom: 4px;
  }

  .example-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    text-align: left;
    cursor: pointer;
  }

  .example-item:hover {
    background: #f1f5f9;
  }

  .example-item.current {
    background: #eff6ff;
  }

  .example-label {
    font-size: 12px;
    font-weight: 600;
    color: #1e293b;
  }

  .example-detail {
    font-size: 10px;
    color: #6b7280;
  }
</style>
