<script lang="ts">
  import type { WorkspaceFile } from '$lib/types';

  interface Props {
    files: WorkspaceFile[];
    activeFileId: string | null;
    onfileclick: (id: string) => void;
    onfileremove: (id: string) => void;
  }

  let { files, activeFileId, onfileclick, onfileremove }: Props = $props();

  // Context menu state
  let contextMenu = $state<{ x: number; y: number; fileId: string } | null>(null);

  function openContextMenu(e: MouseEvent, fileId: string) {
    e.preventDefault();
    contextMenu = { x: e.clientX, y: e.clientY, fileId };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  function removeFile(id: string) {
    onfileremove(id);
    contextMenu = null;
  }

  /**
   * Compute which of a file's imports cannot be resolved against the workspace.
   * Returns an array of unresolved import stem names.
   */
  function unresolvedImports(file: WorkspaceFile): string[] {
    const stems = new Set(files.map((f) => f.stem.toLowerCase()));
    return file.imports.filter((imp: string) => !stems.has(imp.toLowerCase()));
  }
</script>

<!-- Dismiss context menu on click-away -->
<svelte:window
  onclick={(e) => {
    if (contextMenu && !(e.target as Element)?.closest('.context-menu')) {
      closeContextMenu();
    }
  }}
/>

<section class="file-list">
  <div class="section-header">
    <span class="section-title">Files</span>
    <span class="file-count">{files.length}</span>
  </div>

  {#each files as file (file.id)}
    {@const unresolved = unresolvedImports(file)}
    {@const isActive = file.id === activeFileId}
    <button
      class="file-row"
      class:active={isActive}
      onclick={() => onfileclick(file.id)}
      oncontextmenu={(e) => openContextMenu(e, file.id)}
      title={file.name}
      aria-pressed={isActive}
    >
      <span class="file-icon">📄</span>
      <span class="file-name">{file.name}</span>
      {#if file.imports.length > 0}
        <span
          class="import-badge"
          class:import-warn={unresolved.length > 0}
          title={unresolved.length > 0
            ? `Unresolved imports: ${unresolved.join(', ')}`
            : `Imports: ${file.imports.join(', ')}`}
        >
          {#if unresolved.length > 0}⚠{:else}⇒{/if}{file.imports.length}
        </span>
      {/if}
    </button>
  {/each}
</section>

<!-- Right-click context menu -->
{#if contextMenu}
  <div
    class="context-menu"
    style:left="{contextMenu.x}px"
    style:top="{contextMenu.y}px"
    role="menu"
  >
    <button
      class="context-item context-item-danger"
      role="menuitem"
      onclick={() => removeFile(contextMenu!.fileId)}
    >
      Remove file
    </button>
  </div>
{/if}

<style>
  .file-list {
    padding: 8px 0 4px;
    border-bottom: 1px solid #e5e7eb;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px 4px;
  }

  .section-title {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7280;
  }

  .file-count {
    font-size: 9px;
    font-weight: 700;
    background: #e5e7eb;
    color: #4b5563;
    border-radius: 8px;
    padding: 1px 5px;
    line-height: 1.4;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 4px 12px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    border-radius: 0;
    transition: background 0.1s ease;
    min-width: 0;
  }

  .file-row:hover {
    background: #f1f5f9;
  }

  .file-row.active {
    background: #1e293b;
  }

  .file-row.active .file-name {
    color: #f8fafc;
  }

  .file-row.active .file-icon {
    filter: brightness(1.5);
  }

  .file-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  .file-name {
    font-size: 11px;
    color: #374151;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .import-badge {
    font-size: 8px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
    background: #dbeafe;
    color: #1d4ed8;
    line-height: 1.4;
  }

  .import-badge.import-warn {
    background: #fef3c7;
    color: #92400e;
  }

  /* Context menu */
  .context-menu {
    position: fixed;
    z-index: 9999;
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    padding: 4px 0;
    min-width: 140px;
  }

  .context-item {
    display: block;
    width: 100%;
    padding: 6px 14px;
    background: none;
    border: none;
    text-align: left;
    font-size: 12px;
    cursor: pointer;
    color: #374151;
  }

  .context-item:hover {
    background: #f3f4f6;
  }

  .context-item-danger {
    color: #dc2626;
  }

  .context-item-danger:hover {
    background: #fef2f2;
  }
</style>
