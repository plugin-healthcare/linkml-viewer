<script lang="ts">
  import type { GroupInfo } from '$lib/types';

  interface Props {
    groups: GroupInfo[];
    onchange: (groups: GroupInfo[]) => void;
    onclose: () => void;
  }

  let { groups, onchange, onclose }: Props = $props();

  // Work on a local mutable copy; fire onchange on every edit.
  // Use $state without initializer; $effect keeps it in sync with parent prop.
  let rows = $state<GroupInfo[]>([]);

  // Keep rows in sync if parent pushes a new list (e.g. new schema loaded)
  $effect(() => {
    rows = groups.map((d) => ({ ...d }));
  });

  function update(index: number, field: keyof GroupInfo, value: string) {
    rows = rows.map((r, i) => (i === index ? { ...r, [field]: value } : r));
    onchange(rows);
  }

  function addRow() {
    const newRow: GroupInfo = { name: 'new_group', label: 'New Group', color: '#6b7280', text_color: '#ffffff' };
    rows = [...rows, newRow];
    onchange(rows);
  }

  function removeRow(index: number) {
    rows = rows.filter((_, i) => i !== index);
    onchange(rows);
  }

  // The 'default' entry should always exist and not be removable
  const isDefault = (row: GroupInfo) => row.name === 'default';
</script>

<aside class="group-editor-panel">
  <div class="panel-header">
    <span class="panel-title">Group Colors</span>
    <button class="close-btn" onclick={onclose} aria-label="Close group editor">×</button>
  </div>

  <div class="panel-body">
    <div class="col-labels">
      <span class="col-label" style="grid-column: 2">Name</span>
      <span class="col-label" style="grid-column: 3">Label</span>
      <span class="col-label" style="grid-column: 4">BG</span>
      <span class="col-label" style="grid-column: 5">Text</span>
    </div>

    {#each rows as row, i (i)}
      <div class="group-row" class:is-default={isDefault(row)}>
        <!-- Delete button -->
        <button
          class="delete-btn"
          onclick={() => removeRow(i)}
          disabled={isDefault(row)}
          aria-label="Remove group"
          title={isDefault(row) ? 'The default entry cannot be removed' : 'Remove'}
        >×</button>

        <!-- Name -->
        <input
          class="field field-name"
          type="text"
          value={row.name}
          oninput={(e) => update(i, 'name', (e.target as HTMLInputElement).value)}
          placeholder="name"
          title="Group key (must match annotation value in YAML)"
        />

        <!-- Label -->
        <input
          class="field field-label"
          type="text"
          value={row.label}
          oninput={(e) => update(i, 'label', (e.target as HTMLInputElement).value)}
          placeholder="Label"
        />

        <!-- Background color -->
        <label class="color-wrap" title="Background color">
          <input
            type="color"
            value={row.color}
            oninput={(e) => update(i, 'color', (e.target as HTMLInputElement).value)}
          />
          <span class="color-preview" style:background={row.color}></span>
        </label>

        <!-- Text color -->
        <label class="color-wrap" title="Text color">
          <input
            type="color"
            value={row.text_color}
            oninput={(e) => update(i, 'text_color', (e.target as HTMLInputElement).value)}
          />
          <span class="color-preview" style:background={row.text_color}></span>
        </label>
      </div>
    {/each}

    <button class="add-btn" onclick={addRow}>+ Add group</button>

    <p class="hint">
      The <strong>name</strong> field must match the <code>group:</code> annotation value in your
      LinkML YAML. The <strong>default</strong> entry is the fallback for unrecognised group values.
    </p>
  </div>
</aside>

<style>
  .group-editor-panel {
    /* Viewport-aware width (R2.7.2): pixel-identical to 360px at >=1125px
       (32vw >= 360) but shrinks below so the panel never drives the canvas to
       0. At 1280/1600 this resolves to exactly 360px — unchanged. */
    width: min(360px, 32vw);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: #fff;
    border-left: 1px solid #e5e7eb;
    overflow: hidden;
    z-index: 15;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
  }

  .panel-title {
    font-size: 12px;
    font-weight: 700;
    color: #111827;
    flex: 1;
  }

  .close-btn {
    background: none;
    border: none;
    color: #9ca3af;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
    flex-shrink: 0;
  }

  .close-btn:hover {
    color: #374151;
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* Column header row */
  .col-labels {
    display: grid;
    grid-template-columns: 20px 1fr 1fr 28px 28px;
    gap: 4px;
    padding: 0 2px 2px;
  }

  .col-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
  }

  /* Each group row */
  .group-row {
    display: grid;
    grid-template-columns: 20px 1fr 1fr 28px 28px;
    gap: 4px;
    align-items: center;
    padding: 3px 2px;
    border-radius: 4px;
  }

  .group-row.is-default {
    border-top: 1px solid #e5e7eb;
    margin-top: 4px;
    padding-top: 7px;
  }

  .delete-btn {
    background: none;
    border: none;
    color: #d1d5db;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    text-align: center;
    flex-shrink: 0;
  }

  .delete-btn:hover:not(:disabled) {
    color: #dc2626;
  }

  .delete-btn:disabled {
    opacity: 0.2;
    cursor: not-allowed;
  }

  .field {
    font-size: 11px;
    padding: 3px 5px;
    border: 1px solid #e5e7eb;
    border-radius: 3px;
    color: #111827;
    background: #fff;
    width: 100%;
    min-width: 0;
    font-family: inherit;
  }

  .field:focus {
    outline: none;
    border-color: #6366f1;
  }

  .field-name {
    font-family: ui-monospace, monospace;
    font-size: 10px;
  }

  /* Color picker wrapper — hide native input, show preview swatch */
  .color-wrap {
    position: relative;
    width: 28px;
    height: 24px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .color-wrap input[type='color'] {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
    padding: 0;
    border: none;
  }

  .color-preview {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 3px;
    border: 1px solid #d1d5db;
    pointer-events: none;
  }

  .add-btn {
    margin-top: 6px;
    align-self: flex-start;
    background: none;
    border: 1px dashed #d1d5db;
    border-radius: 4px;
    color: #6b7280;
    font-size: 11px;
    padding: 4px 10px;
    cursor: pointer;
  }

  .add-btn:hover {
    border-color: #6366f1;
    color: #6366f1;
  }

  .hint {
    margin-top: 12px;
    font-size: 10px;
    color: #9ca3af;
    line-height: 1.5;
    border-top: 1px solid #f3f4f6;
    padding-top: 10px;
  }

  .hint strong {
    color: #6b7280;
  }

  .hint code {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    background: #f3f4f6;
    padding: 1px 3px;
    border-radius: 2px;
  }
</style>
