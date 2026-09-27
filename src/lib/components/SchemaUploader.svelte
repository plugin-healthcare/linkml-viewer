<script lang="ts">
  import { load as yamlLoad } from 'js-yaml';
  import { describeWorkspaceFile } from '$lib/linkml';
  import type { WorkspaceFile } from '$lib/types';

  interface Props {
    onfiles: (files: WorkspaceFile[]) => void;
    onreset: () => void;
  }

  let { onfiles, onreset }: Props = $props();

  let dragging = $state(false);
  let errors = $state<string[]>([]);
  let loading = $state(false);
  let open = $state(false);
  let fileInput: HTMLInputElement;
  let folderInput: HTMLInputElement;

  // ---------------------------------------------------------------------------
  // Process a flat list of File objects → WorkspaceFile[]
  // ---------------------------------------------------------------------------
  async function processFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    errors = [];
    loading = true;
    const results: WorkspaceFile[] = [];
    const errs: string[] = [];

    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (!['yaml', 'yml', 'json'].includes(ext ?? '')) {
        errs.push(`${file.name}: only .yaml, .yml, .json files are supported`);
        continue;
      }
      try {
        const text = await file.text();
        const wf = describeWorkspaceFile(file.name, text);
        const raw = yamlLoad(text) as { classes?: Record<string, unknown> } | null;
        const hasClasses = !!raw && typeof raw === 'object' && !!raw.classes
          && Object.keys(raw.classes).length > 0;
        const hasImports = wf.imports.length > 0;
        if (!hasClasses && !hasImports) {
          errs.push(`${file.name}: no classes or imports found — is this a valid LinkML schema?`);
          continue;
        }
        results.push(wf);
      } catch (e) {
        errs.push(`${file.name}: ${(e as Error).message}`);
      }
    }

    loading = false;
    errors = errs;

    if (results.length > 0) {
      onfiles(results);
      open = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Recursively walk a DataTransferItem directory entry → File[]
  // ---------------------------------------------------------------------------
  async function readEntry(entry: FileSystemEntry): Promise<File[]> {
    if (entry.isFile) {
      return new Promise((resolve) => {
        (entry as FileSystemFileEntry).file(
          (f) => resolve([f]),
          () => resolve([])
        );
      });
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const entries = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      const nested = await Promise.all(entries.map(readEntry));
      return nested.flat();
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop: handles both plain files and directory drops
  // ---------------------------------------------------------------------------
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const items = e.dataTransfer?.items;
    if (items && items.length > 0) {
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
      if (entries.length > 0) {
        loading = true;
        const nested = await Promise.all(entries.map(readEntry));
        const files = nested.flat();
        await processFiles(files);
        return;
      }
    }
    // Fallback: plain DataTransfer.files
    const files = Array.from(e.dataTransfer?.files ?? []);
    await processFiles(files);
  }

  // ---------------------------------------------------------------------------
  // File input change handlers
  // ---------------------------------------------------------------------------
  async function onFileInputChange(e: Event) {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    (e.target as HTMLInputElement).value = ''; // reset so same files can be re-added
    await processFiles(files);
  }

  async function onFolderInputChange(e: Event) {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    (e.target as HTMLInputElement).value = '';
    await processFiles(files);
  }
</script>

<!-- Upload trigger button (top bar) -->
<button class="trigger-btn" onclick={() => (open = !open)}>
  {open ? '✕ Close' : '⬆ Load schema'}
</button>

{#if open}
  <!-- Drop zone panel -->
  <div class="upload-panel">
    <div
      class="drop-zone"
      class:dragging
      ondragover={(e) => { e.preventDefault(); dragging = true; }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
      role="region"
      aria-label="Schema file drop zone"
    >
      {#if loading}
        <div class="drop-content">
          <span class="spin">⟳</span>
          <span>Parsing schemas…</span>
        </div>
      {:else}
        <div class="drop-content">
          <span class="drop-icon">📂</span>
          <span class="drop-label">Drop files or a folder here</span>
          <span class="drop-sub">.yaml / .yml (preferred), .json · multiple files OK</span>
          <div class="browse-row">
            <button class="browse-btn" onclick={() => fileInput.click()}>
              Browse files
            </button>
            <button class="browse-btn browse-btn-secondary" onclick={() => folderInput.click()}>
              Browse folder
            </button>
          </div>
        </div>
      {/if}
    </div>

    {#if errors.length > 0}
      <div class="error-list">
        {#each errors as err}
          <p class="error-msg">⚠ {err}</p>
        {/each}
      </div>
    {/if}

    <div class="panel-actions">
      <button class="reset-btn" onclick={() => { onreset(); open = false; errors = []; }}>
        ↺ Load OMOP CDM example
      </button>
    </div>
  </div>
{/if}

<!-- Hidden file inputs -->
<input
  bind:this={fileInput}
  type="file"
  accept=".yaml,.yml,.json"
  multiple
  style="display:none"
  onchange={onFileInputChange}
/>
<input
  bind:this={folderInput}
  type="file"
  style="display:none"
  webkitdirectory
  onchange={onFolderInputChange}
/>

<style>
  .trigger-btn {
    padding: 5px 12px;
    background: #fff;
    border: 1.5px solid #d1d5db;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    color: #374151;
    white-space: nowrap;
    transition: all 0.12s ease;
  }

  .trigger-btn:hover {
    border-color: #6b7280;
    background: #f9fafb;
  }

  .upload-panel {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    width: 300px;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    padding: 12px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .drop-zone {
    border: 2px dashed #d1d5db;
    border-radius: 6px;
    padding: 20px 16px;
    transition: all 0.15s ease;
    cursor: default;
  }

  .drop-zone.dragging {
    border-color: #475569;
    background: #f1f5f9;
  }

  .drop-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
  }

  .drop-icon {
    font-size: 28px;
  }

  .drop-label {
    font-size: 13px;
    font-weight: 600;
    color: #374151;
  }

  .drop-sub {
    font-size: 11px;
    color: #9ca3af;
  }

  .browse-row {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  .browse-btn {
    padding: 5px 14px;
    background: #475569;
    color: #fff;
    border: none;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .browse-btn:hover {
    background: #334155;
  }

  .browse-btn-secondary {
    background: #e2e8f0;
    color: #374151;
  }

  .browse-btn-secondary:hover {
    background: #cbd5e1;
  }

  .spin {
    font-size: 24px;
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  .error-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .error-msg {
    margin: 0;
    font-size: 11px;
    color: #dc2626;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 4px;
    padding: 6px 8px;
  }

  .panel-actions {
    display: flex;
    justify-content: flex-end;
  }

  .reset-btn {
    font-size: 11px;
    background: none;
    border: 1px solid #d1d5db;
    border-radius: 5px;
    padding: 4px 10px;
    cursor: pointer;
    color: #6b7280;
  }

  .reset-btn:hover {
    border-color: #9ca3af;
    color: #374151;
  }
</style>
