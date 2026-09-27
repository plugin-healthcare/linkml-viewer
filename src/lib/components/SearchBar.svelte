<script lang="ts">
  import type { NormalizedSchema } from '$lib/types';
  import { COL_ID_SEP } from '$lib/layout';

  interface SearchResult {
    /** The Svelte Flow node ID to pan to.
     *  - Table match  → classId (e.g. "Person")
     *  - Column match → "ClassName\x00slotName" (e.g. "Person\x00gender_concept_id")
     */
    nodeId: string;
    /** Display label — always the class name */
    label: string;
    /** Sub-label shown for column matches — the column name */
    sublabel?: string;
    /** Badge shown next to the result */
    kind: 'table' | 'column';
  }

  interface Props {
    schema: NormalizedSchema | null;
    onselect: (nodeId: string) => void;
  }

  let { schema, onselect }: Props = $props();

  const LISTBOX_ID = 'search-listbox';
  const optionId = (i: number) => `search-option-${i}`;

  // Platform-aware shortcut hint; the global handler accepts meta or ctrl.
  const shortcutHint =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
      ? '⌘K'
      : 'Ctrl K';

  let query = $state('');
  let activeIndex = $state(-1);
  // Explicit open state. The popup is only closed on selection or explicit
  // dismiss — never by a blur timer racing a pointer click.
  let open = $state(false);
  let inputEl: HTMLInputElement | undefined = $state();
  let wrapperEl: HTMLDivElement | undefined = $state();

  const MAX_RESULTS = 12;

  const results = $derived.by<SearchResult[]>(() => {
    if (!schema || query.trim() === '') return [];
    const q = query.trim().toLowerCase();
    const tables: SearchResult[] = [];
    const columns: SearchResult[] = [];

    for (const [classId, cls] of Object.entries(schema.classes)) {
      // Class name match (table) — highest priority. Ranked globally, not just
      // within a class, so a class-name hit always precedes column hits (e.g.
      // "person" returns the `person` table before any `person_id` column).
      if (cls.name.toLowerCase().includes(q)) {
        tables.push({ nodeId: classId, label: cls.name, kind: 'table' });
        continue;
      }

      // Column name matches — find all matching slots, up to 3 per table
      const matchingSlots = cls.slots.filter((s) => s.name.toLowerCase().includes(q));
      for (const slot of matchingSlots.slice(0, 3)) {
        columns.push({
          nodeId: `${classId}${COL_ID_SEP}${slot.name}`,
          label: cls.name,
          sublabel: slot.name,
          kind: 'column',
        });
      }
    }

    return [...tables, ...columns].slice(0, MAX_RESULTS);
  });

  const hasQuery = $derived(query.trim().length > 0);
  const listboxVisible = $derived(open && hasQuery && results.length > 0);
  const noResultsVisible = $derived(open && hasQuery && results.length === 0);

  // Reset the active option whenever the query changes.
  $effect(() => {
    void query;
    activeIndex = -1;
  });

  function select(nodeId: string) {
    onselect(nodeId);
    query = '';
    activeIndex = -1;
    open = false;
    inputEl?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        open = false;
        activeIndex = -1;
      } else if (query) {
        e.preventDefault();
        query = '';
      }
      return;
    }

    if (!listboxVisible) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = activeIndex + 1 >= results.length ? 0 : activeIndex + 1;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = activeIndex - 1 < 0 ? results.length - 1 : activeIndex - 1;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = results[activeIndex] ?? results[0];
      if (choice) select(choice.nodeId);
    } else if (e.key === 'Tab') {
      open = false;
      activeIndex = -1;
    }
  }

  function onFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && wrapperEl?.contains(next)) return;
    open = false;
    activeIndex = -1;
  }

  // Exposed so the parent can focus the input (e.g. via Cmd-K shortcut)
  export function focus() {
    open = true;
    inputEl?.focus();
    inputEl?.select();
  }
</script>

<div class="search-wrap" bind:this={wrapperEl} onfocusout={onFocusOut}>
  <div class="search-input-row">
    <span class="search-icon">⌕</span>
    <input
      bind:this={inputEl}
      bind:value={query}
      onkeydown={onKeydown}
      onfocus={() => { open = true; }}
      oninput={() => { open = true; }}
      type="search"
      placeholder="Search tables or columns…"
      autocomplete="off"
      spellcheck="false"
      disabled={!schema}
      role="combobox"
      aria-label="Search tables and columns"
      aria-expanded={listboxVisible}
      aria-controls={listboxVisible ? LISTBOX_ID : undefined}
      aria-autocomplete="list"
      aria-activedescendant={activeIndex >= 0 && listboxVisible ? optionId(activeIndex) : undefined}
    />
    <kbd class="kbd-hint">{shortcutHint}</kbd>
  </div>

  {#if listboxVisible}
    <ul class="results" id={LISTBOX_ID} role="listbox" aria-label="Search results">
      {#each results as result, i (result.nodeId)}
        <li
          id={optionId(i)}
          role="option"
          aria-selected={i === activeIndex}
          class:active={i === activeIndex}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => select(result.nodeId)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              select(result.nodeId);
            }
          }}
        >
          <span class="kind-badge" class:kind-column={result.kind === 'column'}>
            {result.kind === 'table' ? 'T' : 'C'}
          </span>
          <span class="result-label">{result.label}</span>
          {#if result.sublabel}
            <span class="result-sublabel">› {result.sublabel}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if noResultsVisible}
    <div class="no-results">No matches</div>
  {/if}
</div>

<style>
  .search-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .search-input-row {
    display: flex;
    align-items: center;
    background: #f8fafc;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 0 8px 0 10px;
    gap: 6px;
    height: 34px;
    transition: border-color 0.15s;
  }

  .search-input-row:focus-within {
    border-color: #475569;
    background: #fff;
  }

  .search-input-row:focus-within .kbd-hint {
    display: none;
  }

  .search-icon {
    color: #94a3b8;
    font-size: 16px;
    line-height: 1;
    user-select: none;
  }

  input {
    border: none;
    background: transparent;
    outline: none;
    font-size: 13px;
    color: #1e293b;
    width: 220px;
    min-width: 0;
  }

  /* Keyboard focus must stay visible (D6). */
  input:focus-visible {
    outline: 2px solid #475569;
    outline-offset: 1px;
    border-radius: 3px;
  }

  input::placeholder {
    color: #64748b;
  }

  input:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Remove browser default search cancel button */
  input[type='search']::-webkit-search-cancel-button {
    -webkit-appearance: none;
  }

  .kbd-hint {
    display: inline-flex;
    align-items: center;
    padding: 1px 5px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
    color: #475569;
    background: #f1f5f9;
    white-space: nowrap;
    flex-shrink: 0;
    user-select: none;
    pointer-events: none;
  }

  .results {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    list-style: none;
    margin: 0;
    padding: 4px 0;
    z-index: 100;
    max-height: 320px;
    overflow-y: auto;
  }

  .results li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 7px 12px;
    cursor: pointer;
    font-size: 13px;
    color: #1e293b;
    user-select: none;
  }

  .results li:hover,
  .results li.active {
    background: #f1f5f9;
  }

  .results li.active {
    outline: 2px solid #475569;
    outline-offset: -2px;
  }

  /* T / C kind badge */
  .kind-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
    background: #e2e8f0;
    color: #475569;
    letter-spacing: 0;
  }

  .kind-badge.kind-column {
    background: #ede9fe;
    color: #6366f1;
  }

  .result-label {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .result-sublabel {
    color: #64748b;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 1;
  }

  .no-results {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    padding: 10px 12px;
    font-size: 13px;
    color: #94a3b8;
    z-index: 100;
  }
</style>
