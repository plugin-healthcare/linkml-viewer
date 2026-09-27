<script lang="ts">
  import { onMount, onDestroy, setContext, untrack } from 'svelte';
  import {
    SvelteFlow,
    Background,
    MiniMap,
    type Node,
    type Edge,
  } from '@xyflow/svelte';

  import TableParentNode from '$lib/components/TableParentNode.svelte';
  import ColumnNode from '$lib/components/ColumnNode.svelte';
  import SchemaUploader from '$lib/components/SchemaUploader.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import FlowController from '$lib/components/FlowController.svelte';
  import GroupLegend from '$lib/components/GroupLegend.svelte';
  import CustomControls from '$lib/components/CustomControls.svelte';
  import EdgeLabelOverlay from '$lib/components/EdgeLabelOverlay.svelte';
  import SchemaEditor from '$lib/components/SchemaEditor.svelte';
  import GroupEditor from '$lib/components/GroupEditor.svelte';
  import FileList from '$lib/components/FileList.svelte';
  import ExampleMenu from '$lib/components/ExampleMenu.svelte';
  import RelationshipInspector from '$lib/components/RelationshipInspector.svelte';
  import ProvenanceDialog from '$lib/components/ProvenanceDialog.svelte';

  import {
    assignFileIds,
    assignWorkspaceFileIds,
    reconcileWorkspace,
    describeWorkspaceFile,
    loadGroupConfig,
    loadReconciledArtifact,
  } from '$lib/linkml';
  import { buildGraph, COL_ID_SEP } from '$lib/layout';
  import { applyEdgeLod } from '$lib/edgeLod';
  import { deriveRelationshipFocus, applyEdgeFocus, tableIdOf, NO_FOCUS } from '$lib/edgeFocus';
  import type {
    NormalizedSchema,
    LayoutOptions,
    GroupInfo,
    WorkspaceFile,
    FileInfo,
    NavDirection,
    RelationshipFocus,
  } from '$lib/types';
  import { base } from '$app/paths';

  // ---------------------------------------------------------------------------
  // File color palette — 12 visually distinct, accessible colors for per-file stripes
  // ---------------------------------------------------------------------------
  const FILE_PALETTE = [
    '#0ea5e9', // sky-500
    '#f97316', // orange-500
    '#22c55e', // green-500
    '#a855f7', // purple-500
    '#ef4444', // red-500
    '#14b8a6', // teal-500
    '#f59e0b', // amber-500
    '#ec4899', // pink-500
    '#6366f1', // indigo-500
    '#84cc16', // lime-500
    '#06b6d4', // cyan-500
    '#f43f5e', // rose-500
  ];

  // ---------------------------------------------------------------------------
  // Group config — set context synchronously with a reactive holder so
  // TableParentNode can read it reactively once the fetch resolves.
  // setContext must be called at init time (not inside onMount/async).
  // ---------------------------------------------------------------------------
  const groupCtx = $state<{ map: Map<string, GroupInfo> | null }>({ map: null });
  setContext('groupConfig', groupCtx);

  // ---------------------------------------------------------------------------
  // File config — per-file stripe colors, reactive holder set as context.
  // Map is keyed by WorkspaceFile.id → hex color string.
  // ---------------------------------------------------------------------------
  const fileCtx = $state<{ map: Map<string, string> }>({ map: new Map() });
  setContext('fileConfig', fileCtx);

  // ---------------------------------------------------------------------------
  // Collapse context — TableParentNode calls toggle(id) to collapse/expand.
  // Wrapped in a $state object (consistent with groupCtx/fileCtx pattern) so
  // the object reference is stable across re-renders while the function body
  // always reads the current `collapsed` value from the reactive $state binding.
  // setContext must be called synchronously at init time.
  // ---------------------------------------------------------------------------
  const collapseCtx = $state({ toggle: (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    collapsed = next;
  }});
  setContext('collapseToggle', collapseCtx);

  // ---------------------------------------------------------------------------
  // Search-target context — single authoritative state for the table currently
  // emphasised by a search. This is transient navigation emphasis, distinct
  // from selection, collapse, and hover (see the interaction-state contract in
  // src/lib/types.ts).
  // TableParentNode derives its `highlighted` class from this — the node array
  // is never mutated to carry highlight state.
  // ---------------------------------------------------------------------------
  const searchCtx = $state<{ target: string | null }>({ target: null });
  setContext('searchTarget', searchCtx);

  // ---------------------------------------------------------------------------
  // Graph cursor — the table currently under keyboard navigation. One new
  // semantic state, distinct from searchTarget (transient navigation emphasis)
  // and from Svelte Flow selection. Nodes derive their focus ring from this.
  // ---------------------------------------------------------------------------
  const cursorCtx = $state<{ id: string | null }>({ id: null });
  setContext('cursor', cursorCtx);

  // ---------------------------------------------------------------------------
  // Level-of-detail context — the current information resolution (0 overview,
  // 1 structural, 2 semantic). Derived from the flow viewport zoom by
  // FlowController (the only component with access to the flow store) and read
  // reactively by the node components. Presentation only: it never changes node
  // geometry and never triggers a layout rebuild.
  // ---------------------------------------------------------------------------
  const lodCtx = $state<{ level: number }>({ level: 2 });
  setContext('lodLevel', lodCtx);

  // R2.8.8 — the relationship currently under the pointer. Hover inspection:
  // below LOD2 the overlay renders this edge's label at a stable screen size,
  // so any relationship can be read without zooming in. Transient presentation
  // state; never written into the graph, layout, or selection.
  let hoveredEdgeId = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // Native selection holder — the single place Svelte Flow's own selection is
  // surfaced. FlowController calls useOnSelectionChange and writes the selected
  // node/edge ids here. This is *not* a second selection model: it is a read
  // projection of the library's `selectedNodes`/`selectedEdges`.
  // ---------------------------------------------------------------------------
  const selectionCtx = $state<{ nodeIds: string[]; edgeIds: string[] }>({
    nodeIds: [],
    edgeIds: [],
  });
  setContext('selection', selectionCtx);

  // ---------------------------------------------------------------------------
  // Relationship focus — a distinct transient state derived from native
  // selection, separate from searchTarget (search emphasis) and cursor
  // (keyboard navigation). Holds the focused table/edge ids; read reactively by
  // TableParentNode/ColumnNode. Presentation only.
  // ---------------------------------------------------------------------------
  const focusCtx = $state<RelationshipFocus>({
    active: NO_FOCUS.active,
    selectedTableIds: NO_FOCUS.selectedTableIds,
    selectedNodeIds: NO_FOCUS.selectedNodeIds,
    tableIds: NO_FOCUS.tableIds,
    edgeIds: NO_FOCUS.edgeIds,
    strongEdgeIds: NO_FOCUS.strongEdgeIds,
  });
  setContext('relationshipFocus', focusCtx);

  // ---------------------------------------------------------------------------
  // Node types registration
  // ---------------------------------------------------------------------------
  const nodeTypes = { tableParent: TableParentNode, column: ColumnNode };

  // ---------------------------------------------------------------------------
  // Workspace state — list of loaded files + which is active
  // ---------------------------------------------------------------------------
  let workspaceFiles = $state<WorkspaceFile[]>([]);
  let activeFileId = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // Schema source — one producer, two input modes.
  //
  // Bundled schemas consume the authoritative reconciled artefact
  // (static/reconciled/<name>.json), a pipeline output generated by the Vite
  // plugin (vite.config.ts). Uploaded / hand-edited files POST to /reconcile,
  // served by that same plugin, which runs the same produce.py. No in-browser
  // LinkML reasoning remains.
  // ---------------------------------------------------------------------------

  /**
   * Bundled workspace-file stem → reconciled artefact name. Covers the bundled
   * schemas that also ship a static viewer YAML (used for the workspace / YAML
   * editor). The `synthetic_inheritance` artefact has no registered viewer YAML
   * (its source is static/synthetic_inheritance.yaml); it is still loadable
   * through the same `loadReconciledArtifact` entry point.
   */
  const BUNDLED_ARTIFACT_BY_STEM: Record<string, string> = {
    omop_cdm: 'omop',
    sein: 'sein',
  };

  /**
   * The active file's artefact projection, when the active file is a bundled
   * schema. `fileId` ties it to the workspace file so a switch to an upload
   * falls through to the /reconcile reconciliation below.
   */
  let bundledSchema = $state.raw<{ fileId: string; schema: NormalizedSchema } | null>(null);

  /**
   * Workspace reconciliation — uploads / edited files only. The Vite
   * /reconcile producer supplies the artefact; keyed by workspace identity +
   * active file so a stale reply cannot win.
   */
  let reconciled = $state.raw<{
    files: WorkspaceFile[];
    activeId: string;
    merged: NormalizedSchema;
    unresolved: string[];
  } | null>(null);

  const schema = $derived(
    bundledSchema && bundledSchema.fileId === activeFileId
      ? bundledSchema.schema
      : reconciled && reconciled.files === workspaceFiles && reconciled.activeId === activeFileId
        ? reconciled.merged
        : null
  );
  const unresolvedImports = $derived(
    bundledSchema && bundledSchema.fileId === activeFileId
      ? []
      : reconciled && reconciled.files === workspaceFiles && reconciled.activeId === activeFileId
        ? reconciled.unresolved
        : []
  );

  // Reconcile the workspace through the Vite /reconcile endpoint whenever the
  // active file is not served by an artefact. Async with a cancellation guard so
  // a stale reply cannot win; no in-browser fallback exists.
  $effect(() => {
    const files = workspaceFiles;
    const activeId = activeFileId;
    if (!activeId || files.length === 0) {
      reconciled = null;
      return;
    }
    if (bundledSchema && bundledSchema.fileId === activeId) {
      reconciled = null;
      return;
    }
    // Read the previous result without subscribing to it, so a failed request
    // (which writes null) cannot re-trigger this effect into a retry loop.
    const existing = untrack(() => reconciled);
    if (existing && existing.files === files && existing.activeId === activeId) return;

    let cancelled = false;
    (async () => {
      try {
        const result = await reconcileWorkspace(files, activeId);
        if (cancelled) return;
        const merged = assignWorkspaceFileIds(result.merged, files, activeId);
        reconciled = { files, activeId, merged, unresolved: result.unresolved };
      } catch (e) {
        if (cancelled) return;
        loadError = `Schema reconciliation failed: ${(e as Error).message}`;
        reconciled = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  // All class ids in the active schema — the target set for Collapse All.
  const allClassIds = $derived(schema ? Object.keys(schema.classes) : []);

  // ---------------------------------------------------------------------------
  // Other derived values
  // ---------------------------------------------------------------------------
  let loadError = $state('');
  let collapsed = $state<Set<string>>(new Set());

  // Phase B / B1: set by the "Fit collapsed" handler, consumed by the next
  // layout rebuild. Plain (non-reactive) on purpose — see the layout effect.
  let pendingFit = false;

  // Svelte Flow reactive nodes/edges ($state.raw for performance)
  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);

  // Layout options.
  // R2.3 product default: ELK / LR. Decided against the product objective
  // (overview legibility + local relationship readability), not a numeric
  // ranking. ELK-LR Pareto-improves the previous Dagre-LR default: it raises
  // the OMOP fit zoom (0.124 -> 0.161) and lowers edge crossings on both
  // fixtures (OMOP 53 -> 52; SEIN 477 -> 276) with orthogonal edge routing and
  // clear group banding. The accepted trade-off is forgoing Dagre-TB's higher
  // raw fit zoom (0.195 OMOP) to keep dense FK/ETL regions legible; Dagre-LR,
  // Dagre-TB and ELK-TB remain selectable below and in bench-layout.ts.
  let layoutOptions = $state<LayoutOptions>({ engine: 'elk', direction: 'LR' });
  let layoutLoading = $state(false);

  // Explicit fit intents only — initial load (and, conceptually, the Fit button,
  // which calls fitView directly). Layout/viewport are otherwise decoupled:
  // collapse/expand/search/select/group-colour never increment this.
  let fitRequest = $state(0);

  // Search navigation: node to centre on, plus a nonce so repeat hits re-fire.
  let panTarget = $state<string | null>(null);
  let panNonce = $state(0);

  // Timer that clears the transient search highlight; reset on each new search.
  let searchClearTimer: ReturnType<typeof setTimeout> | undefined;
  // A pending auto-clear must not outlive the component.
  onDestroy(() => {
    if (searchClearTimer !== undefined) clearTimeout(searchClearTimer);
  });

  // Imperative viewport handle supplied by FlowController (inside <SvelteFlow>).
  // $state.raw so bind:this is legal, but reads inside the layout effect are
  // wrapped in untrack() so their timing never re-triggers a rebuild.
  let flowController = $state.raw<{
    captureViewport: () => void;
    restoreViewport: () => void;
    moveCursor: (ids: string[], fromId: string | null, dir: NavDirection) => string | null;
    centerNode: (id: string) => void;
    selectEdges: (ids: string[]) => void;
    clearSelection: () => void;
  }>();

  // Tracks schema identity so only genuine schema changes request a fit.
  let lastBuiltSchema: NormalizedSchema | null = null;

  // Tracks the active layout engine+direction. A topology change (engine or
  // direction) moves virtually every node, so it is treated as a deliberate
  // fit intent rather than being viewport-preserved.
  let lastBuiltLayoutKey = '';

  // Editor panel visibility
  let schemaEditorOpen = $state(false);
  let groupEditorOpen = $state(false);
  let inspectorOpen = $state(false);

  // R2.8.13 — provenance dialog (read-only projection of the artefact metadata).
  let aboutOpen = $state(false);

  // Raw YAML text for SchemaEditor — tracks the active file's text
  const schemaYamlText = $derived(
    workspaceFiles.find((f) => f.id === activeFileId)?.text ?? ''
  );

  // Group list derived from groupCtx.map for GroupEditor
  const groupList = $derived<GroupInfo[]>(
    groupCtx.map ? Array.from(groupCtx.map.values()) : []
  );

  // Stem of the active bundled example (null for an uploaded/edited file), so the
  // Examples menu can mark the current one. R2.8.9.
  const activeStem = $derived(
    workspaceFiles.find((f) => f.id === activeFileId)?.stem ?? null
  );

  // Load a bundled example schema through the same path as the default (R2.8.9).
  async function handleLoadExample(stem: string) {
    loadError = '';
    try {
      await loadBundledSchema(stem);
    } catch (e) {
      loadError = `Failed to load example '${stem}': ${(e as Error).message}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Rebuild graph whenever schema, collapsed, or layoutOptions change (async)
  // ---------------------------------------------------------------------------
  $effect(() => {
    if (!schema) {
      nodes = [];
      edges = [];
      return;
    }

    // Capture reactive dependencies before entering async context
    const s = schema;
    const c = collapsed;
    const opts = layoutOptions;

    // Fit intents: a genuine schema change, or a topology change (layout engine
    // or direction). Content mutations — collapse/expand — preserve the
    // viewport (conditionally: the user's own motion during the async layout
    // always wins). Group-colour edits never reach this effect.
    const layoutKey = `${opts.engine}:${opts.direction}`;
    const schemaChanged = s !== lastBuiltSchema;
    const isFit = schemaChanged || layoutKey !== lastBuiltLayoutKey;
    lastBuiltSchema = s;
    lastBuiltLayoutKey = layoutKey;

    // Native state preservation (R2.4.4). Svelte Flow derives `selectedNodes`
    // from `node.selected` on the array it is handed, and `nodes` is bound, so
    // node selection lives on these objects. A content rebuild (collapse/expand,
    // layout/direction change) replaces them and would silently drop the native
    // `selected` flag — the node analogue of the R2.4.2 edge-reset bug. Carry the
    // flag across a same-schema rebuild; a schema/file switch is a new graph, so
    // its selection clears. Read untracked: selection changes must never
    // re-trigger this effect. (Edges are round-tripped by `applyEdgeFocus`.)
    const selectedNodeIds = schemaChanged
      ? new Set<string>()
      : new Set(untrack(() => nodes).filter((n) => n.selected).map((n) => n.id));

    // Phase B / B1: an explicit "Fit collapsed" action requests a fit for the
    // *next* rebuild of the same schema/layout. It is a plain (non-reactive)
    // flag set synchronously by the handler before `collapsed` changes, so the
    // layout effect never depends on it.
    const doFit = isFit || pendingFit;
    pendingFit = false;

    // Capture the viewport immediately before the rebuild; restore it once the
    // new nodes are applied. Explicit fit requests skip capture/restore.
    const controller = untrack(() => flowController);
    if (!doFit) controller?.captureViewport();

    let cancelled = false;

    (async () => {
      layoutLoading = true;
      try {
        const result = await buildGraph(s, c, opts);
        if (!cancelled) {
          // Re-assert the preserved selection only for nodes that still exist.
          nodes = selectedNodeIds.size
            ? result.nodes.map((n) =>
                selectedNodeIds.has(n.id) ? { ...n, selected: true } : n
              )
            : result.nodes;
          edges = result.edges;
          if (doFit) fitRequest += 1;
          else controller?.restoreViewport();
        }
      } catch (e) {
        if (!cancelled) {
          loadError = `Layout failed: ${(e as Error).message}`;
        }
      } finally {
        if (!cancelled) layoutLoading = false;
      }
    })();

    return () => { cancelled = true; };
  });

  // ---------------------------------------------------------------------------
  // Schema loading
  // ---------------------------------------------------------------------------

  /**
   * Load a bundled schema by its workspace-file stem: the raw YAML (for the
   * workspace / editor) plus its authoritative reconciled artefact (for
   * semantics). Every bundled schema (`omop_cdm`, `sein`,
   * `synthetic_inheritance`) loads through this one path.
   */
  async function loadBundledSchema(stem: string) {
    const artifactName = BUNDLED_ARTIFACT_BY_STEM[stem];
    if (!artifactName) throw new Error(`No reconciled artefact registered for '${stem}'`);
    const [text, artifactSchema] = await Promise.all([
      fetch(`${base}/${stem}.yaml`).then((r) => r.text()),
      loadReconciledArtifact(artifactName),
    ]);
    const wf = describeWorkspaceFile(`${stem}.yaml`, text);
    bundledSchema = { fileId: wf.id, schema: assignFileIds(artifactSchema, wf.id) };
    workspaceFiles = [wf];
    activeFileId = wf.id;
    collapsed = new Set();
    // Assign first palette color to the default file
    fileCtx.map = new Map([[wf.id, FILE_PALETTE[0]]]);
  }

  /** Replace workspace with the default bundled schema (OMOP CDM). */
  async function loadDefault() {
    loadError = '';
    try {
      await loadBundledSchema('omop_cdm');
    } catch (e) {
      loadError = `Failed to load default schema: ${(e as Error).message}`;
    }
  }

  /**
   * Add newly uploaded files to the workspace.
   * Deduplicates by stem (case-insensitive); existing files with the same stem
   * are replaced so that re-uploading a revised file works naturally.
   * Assigns a palette color to each genuinely new file (not a replacement).
   */
  function handleUploadedFiles(incoming: WorkspaceFile[]) {
    const map = new Map(workspaceFiles.map((f) => [f.stem.toLowerCase(), f]));
    for (const f of incoming) {
      const key = f.stem.toLowerCase();
      const isReplacement = map.has(key);
      if (isReplacement) {
        // Keep the existing color for the replaced file
        const existingId = map.get(key)!.id;
        const existingColor = fileCtx.map.get(existingId);
        map.set(key, f);
        if (existingColor) fileCtx.map.set(f.id, existingColor);
      } else {
        // New file — assign next palette color
        const colorIndex = fileCtx.map.size % FILE_PALETTE.length;
        fileCtx.map.set(f.id, FILE_PALETTE[colorIndex]);
        map.set(key, f);
      }
    }
    workspaceFiles = Array.from(map.values());
    // Trigger reactivity on fileCtx.map
    fileCtx.map = new Map(fileCtx.map);
    // A replaced/removed bundled file loses its artefact association.
    if (bundledSchema && !workspaceFiles.some((f) => f.id === bundledSchema!.fileId)) {
      bundledSchema = null;
    }
    // Activate the first incoming file (or keep current if it's still present)
    const currentStillPresent = workspaceFiles.some((f) => f.id === activeFileId);
    if (!currentStillPresent || !activeFileId) {
      activeFileId = incoming[0]?.id ?? workspaceFiles[0]?.id ?? null;
    }
    collapsed = new Set();
  }

  /** Switch the active (rendered) file. */
  function handleFileClick(id: string) {
    if (id === activeFileId) return;
    activeFileId = id;
    collapsed = new Set();
  }

  /** Remove a file from the workspace. */
  function handleFileRemove(id: string) {
    if (bundledSchema && bundledSchema.fileId === id) bundledSchema = null;
    workspaceFiles = workspaceFiles.filter((f) => f.id !== id);
    fileCtx.map.delete(id);
    fileCtx.map = new Map(fileCtx.map);
    if (activeFileId === id) {
      activeFileId = workspaceFiles[0]?.id ?? null;
      collapsed = new Set();
    }
  }

  // Called by SchemaEditor when the user edits the YAML and it parses cleanly.
  // Editing a bundled file detaches its authoritative artefact, so the edited
  // text reconciles through the Vite /reconcile producer instead.
  function handleSchemaEditorChange(text: string) {
    if (!activeFileId) return;
    if (bundledSchema && bundledSchema.fileId === activeFileId) bundledSchema = null;
    workspaceFiles = workspaceFiles.map((f) =>
      f.id === activeFileId
        ? { ...describeWorkspaceFile(f.name, text), id: f.id }
        : f
    );
    collapsed = new Set();
  }

  // Called by GroupEditor when colors/names change
  function handleGroupEditorChange(groups: GroupInfo[]) {
    groupCtx.map = new Map(groups.map((d) => [d.name, d]));
  }

  onMount(() => {
    loadDefault();
    loadGroupConfig()
      .then((map: Map<string, GroupInfo>) => { groupCtx.map = map; })
      .catch((e: unknown) => console.warn('group-config load failed:', e));
  });

  // ---------------------------------------------------------------------------
  // Search: set pan target — FlowController handles the pan
  // ---------------------------------------------------------------------------
  function handleSearchSelect(nodeId: string) {
    // A column hit highlights its parent table; a table hit highlights itself.
    const sep = nodeId.indexOf(COL_ID_SEP);
    const tableId = sep >= 0 ? nodeId.slice(0, sep) : nodeId;
    searchCtx.target = tableId;

    // Search moves the keyboard cursor to its result (navigate ≠ search
    // emphasis, but they share the same target semantically).
    cursorCtx.id = tableId;

    // Recentre at the user's current zoom (FlowController reads getViewport()).
    panTarget = nodeId;
    panNonce += 1;

    // Single auto-clear timer, reset on each new search so the newest target
    // is authoritative and no stale timer clears it.
    if (searchClearTimer !== undefined) clearTimeout(searchClearTimer);
    searchClearTimer = setTimeout(() => {
      searchCtx.target = null;
      searchClearTimer = undefined;
    }, 1500);
  }

  // Reference to SearchBar component for programmatic focus
  let searchBar: { focus: () => void } | undefined = $state();

  // Global Cmd-K / Ctrl-K shortcut to activate the search bar
  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      searchBar?.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Layout button helpers
  // ---------------------------------------------------------------------------
  function selectLayout(opts: LayoutOptions) {
    if (layoutLoading) return;
    layoutOptions = opts;
  }

  // Phase B / B1 geometry-density controls.
  // Collapse All / Expand All are content mutations: the viewport is preserved.
  function collapseAll() {
    collapsed = new Set(allClassIds);
  }

  function expandAll() {
    collapsed = new Set();
  }

  // Fit Collapsed is the one explicit fit intent among the density controls:
  // collapse everything, then request a fit for the resulting build.
  function fitCollapsed() {
    pendingFit = true;
    collapsed = new Set(allClassIds);
  }

  // R2.8.12 relationship inspector. Selecting an inspector row selects that
  // edge natively (identical to a canvas edge click, so relationship focus and
  // the strong-edge emphasis follow for free) and recentres on the target table.
  function handleInspectorSelectEdge(edgeId: string) {
    const edge = edges.find((e) => e.id === edgeId);
    flowController?.selectEdges([edgeId]);
    if (edge) flowController?.centerNode(tableIdOf(edge.target));
  }

  function closeInspector() {
    inspectorOpen = false;
  }

  // ---------------------------------------------------------------------------
  // Keyboard graph navigation. Spatial, not DOM-order: arrow keys move the
  // cursor to the most aligned neighbour in that direction. Centring uses
  // setCenter at the current zoom — navigation is neither search nor fit.
  // ---------------------------------------------------------------------------
  const tableParentIds = $derived(
    nodes.filter((n) => n.type === 'tableParent').map((n) => n.id)
  );

  const ARROW_DIRECTIONS: Record<string, 'left' | 'right' | 'up' | 'down'> = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  };

  function handleCanvasKeydown(e: KeyboardEvent) {
    // Single keyboard authority. The canvas container owns arrow/Enter/Escape
    // spatial navigation only when it is itself the event target. If focus is
    // on a descendant (e.g. a table header <button>), that control owns the
    // keypress and behaves natively — the spatial handler must not also fire.
    if (e.target !== e.currentTarget) return;

    const dir = ARROW_DIRECTIONS[e.key];
    if (dir) {
      e.preventDefault();
      e.stopPropagation();
      const next = flowController?.moveCursor(tableParentIds, cursorCtx.id, dir);
      if (next) {
        cursorCtx.id = next;
        flowController?.centerNode(next);
      }
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      if (!cursorCtx.id) return;
      e.preventDefault();
      e.stopPropagation();
      collapseCtx.toggle(cursorCtx.id);
      return;
    }

    if (e.key === 'Escape') {
      if (cursorCtx.id) {
        e.preventDefault();
        cursorCtx.id = null;
      }
      (e.currentTarget as HTMLElement | null)?.blur();
    }
  }

// Dev-only seam so the browser suite can position the cursor deterministically.
$effect(() => {
  if (!import.meta.env.DEV) return;
  (globalThis as Record<string, unknown>).__erdNav = {
    getCursor: () => cursorCtx.id,
    setCursor: (id: string | null) => { cursorCtx.id = id; },
  };
});

// Dev-only seam for layout switching (viewport contract tests).
// Must be in onMount so it runs on the client, not during SSR.
onMount(() => {
  if (!import.meta.env.DEV) return;
  (globalThis as Record<string, unknown>).__erdLayout = {
    getLayoutOptions: () => ({ engine: layoutOptions.engine, direction: layoutOptions.direction }),
    setLayoutOptions: (opts: { engine: string; direction: string }) => {
      layoutOptions = opts as LayoutOptions;
    },
  };
  (globalThis as Record<string, unknown>).__erdFocus = {
    get: () => ({
      active: focusCtx.active,
      selectedTableIds: [...focusCtx.selectedTableIds],
      selectedNodeIds: [...focusCtx.selectedNodeIds],
      tableIds: [...focusCtx.tableIds],
      edgeIds: [...focusCtx.edgeIds],
      strongEdgeIds: [...focusCtx.strongEdgeIds],
    }),
  };
  // Dev-only seam exposing the materialised relationship facts (kind / endpoint
  // node ids / slot), so tests can assert that collapse/expand changes only the
  // presentation anchor and never the reconciled relationship data. Reads the
  // layout `edges` source, not the presentation `displayEdges`.
  (globalThis as Record<string, unknown>).__erdEdges = {
    get: () =>
      edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: (e.data as unknown as { edgeKind?: string } | undefined)?.edgeKind ?? null,
        slot: (e.data as unknown as { slotName?: string } | undefined)?.slotName ?? null,
      })),
  };
  // Dev-only seam to load a bundled schema by stem, so edge-focus tests can
  // exercise an ETL-bearing graph (OMOP has zero ETL relationships) through the
  // same bundled-artefact path the default uses. Never registered in production.
  (globalThis as Record<string, unknown>).__erdSchema = {
    loadBundled: (stem: string) => loadBundledSchema(stem),
  };
});

// ---------------------------------------------------------------------------
// Helpers
  // ---------------------------------------------------------------------------
  const schemaName = $derived(schema?.name ?? 'Loading…');
  const tableCount = $derived(nodes.filter((n) => n.type === 'tableParent').length);

  // Collect unique group names present in current tableParent nodes (for GroupLegend).
  const activeGroupNames = $derived(
    [...new Set(
      nodes
        .filter((n) => n.type === 'tableParent')
        .map((n) => (n.data as unknown as { group?: string }).group)
        .filter((d): d is string => typeof d === 'string')
    )]
  );

  // Only show the legend when at least one node has a group annotation.
  const hasGroups = $derived(activeGroupNames.length > 0);

  // Build FileInfo list for the "Files" section in GroupLegend.
  // Only include files whose classes actually appear in the current tableParent nodes.
  const activeFileIds = $derived(
    [...new Set(
      nodes
        .filter((n) => n.type === 'tableParent')
        .map((n) => (n.data as unknown as { fileId?: string }).fileId)
        .filter((id): id is string => typeof id === 'string')
    )]
  );
  const fileInfoList = $derived<FileInfo[]>(
    activeFileIds
      .map((id) => {
        const wf = workspaceFiles.find((f) => f.id === id);
        if (!wf) return null;
        const color = fileCtx.map.get(id) ?? '#94a3b8';
        const label = wf.displayName || wf.stem;
        return { id, label, color } satisfies FileInfo;
      })
      .filter((f): f is FileInfo => f !== null)
  );

  // Edge count label: distinguish FK vs ETL
  const fkEdgeCount = $derived(
    edges.filter((e) => (e.data as unknown as { edgeKind?: string })?.edgeKind !== 'etl').length
  );
  const etlEdgeCount = $derived(
    edges.filter((e) => (e.data as unknown as { edgeKind?: string })?.edgeKind === 'etl').length
  );

  // Number of collapsed tables — drives the Collapse All button's disabled state.
  const collapseCount = $derived(collapsed.size);

  // R2.4.1 / R2.4.2 relationship focus — derived *only* from native selection +
  // the existing rendered `edges`. No new graph: focused edges are a filter over
  // `edges`; endpoint tables are read back from those edges' source/target ids.
  // Edge selection takes precedence over table selection (see edgeFocus.ts).
  const relationshipFocus = $derived(
    deriveRelationshipFocus(edges, selectionCtx.nodeIds, selectionCtx.edgeIds)
  );

  // Publish the derived focus to the context holder read by node components.
  $effect(() => {
    focusCtx.active = relationshipFocus.active;
    focusCtx.selectedTableIds = relationshipFocus.selectedTableIds;
    focusCtx.selectedNodeIds = relationshipFocus.selectedNodeIds;
    focusCtx.tableIds = relationshipFocus.tableIds;
    focusCtx.edgeIds = relationshipFocus.edgeIds;
    focusCtx.strongEdgeIds = relationshipFocus.strongEdgeIds;
  });

  // Phase B / B2 + R2.4.1 + R2.6.4.2: LOD and relationship focus are
  // presentation-only. `displayEdges` is what Svelte Flow renders; `edges`
  // remains the layout source of truth and is never mutated. Edge
  // geometry/routing is untouched by either transform. Below LOD2 a natively
  // selected edge (`relationshipFocus.strongEdgeIds`) has its zoom-coupled
  // label suppressed here; `EdgeLabelOverlay` renders that existing `edge.label`
  // at a fixed screen size instead. Selection swaps the label *surface*, it
  // does not reconstruct relationship semantics.
  const displayEdges = $derived(
    applyEdgeFocus(applyEdgeLod(edges, lodCtx.level), relationshipFocus)
  );
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="app">
  <!-- Left sidebar: file list + optional group legend -->
  <div class="sidebar-col">
    {#if workspaceFiles.length > 0}
      <FileList
        files={workspaceFiles}
        {activeFileId}
        onfileclick={handleFileClick}
        onfileremove={handleFileRemove}
      />
    {/if}

    {#if schema && (hasGroups || fileInfoList.length > 1)}
      <GroupLegend {activeGroupNames} {fileInfoList} />
    {/if}
  </div>

  <div class="canvas-wrap">
    <!-- Top bar -->
    <div class="topbar">
      <div class="topbar-left">
        <span class="app-title">LinkML ERD Viewer</span>
        {#if schema}
          <span class="schema-name">{schemaName}</span>
          <span class="node-count">
            {tableCount} tables
            {#if fkEdgeCount > 0} · {fkEdgeCount} FK{/if}
            {#if etlEdgeCount > 0} · {etlEdgeCount} ETL{/if}
          </span>
        {/if}
        {#if unresolvedImports.length > 0}
          <span class="load-error" title="Add the missing files to resolve: {unresolvedImports.join(', ')}">
            ⚠ unresolved: {unresolvedImports.join(', ')}
          </span>
        {:else if loadError}
          <span class="load-error">⚠ {loadError}</span>
        {/if}
      </div>

      <div class="topbar-center">
        <SearchBar bind:this={searchBar} {schema} onselect={handleSearchSelect} />
      </div>

      <div class="topbar-right">
        <!-- Schema editor toggle -->
        <button
          class="editor-btn"
          class:active={schemaEditorOpen}
          title="Edit schema YAML"
          onclick={() => { schemaEditorOpen = !schemaEditorOpen; }}
          aria-pressed={schemaEditorOpen}
        >
          <span class="editor-btn-icon">&lt;/&gt;</span>
          Schema
        </button>

        <!-- Group config editor toggle -->
        <button
          class="editor-btn"
          class:active={groupEditorOpen}
          title="Edit group colors"
          onclick={() => { groupEditorOpen = !groupEditorOpen; }}
          aria-pressed={groupEditorOpen}
        >
          <span class="editor-btn-icon">&#9678;</span>
          Groups
        </button>

        <button
          class="editor-btn"
          class:active={inspectorOpen}
          title="Inspect selected relationships"
          onclick={() => { inspectorOpen = !inspectorOpen; }}
          aria-pressed={inspectorOpen}
        >
          <span class="editor-btn-icon">&#9671;</span>
          Relationships
        </button>

        <div class="uploader-wrap">
          <SchemaUploader
            onfiles={handleUploadedFiles}
            onreset={loadDefault}
          />
        </div>

        <ExampleMenu {activeStem} loading={layoutLoading} onload={handleLoadExample} />

        <!-- Provenance / about (R2.8.13) -->
        <button
          class="editor-btn icon-only"
          title="About this model — producer, reconciliation, reproducibility"
          aria-label="About this model"
          onclick={() => { aboutOpen = true; }}
        >
          <span class="editor-btn-icon">&#9432;</span>
        </button>
      </div>
    </div>

    <!-- Main content row: canvas + optional editor panels -->
    <div class="content-row">
      <!-- Svelte Flow canvas.
           This div is a keyboard-operable application region: it owns spatial
           arrow-key navigation and activation, so a nonnegative tabindex and a
           keydown listener are intentional. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="canvas-area"
        tabindex="0"
        role="application"
        aria-label="Graph navigation. Arrow keys move between tables, Enter collapses or expands, Escape leaves navigation."
        data-testid="graph-canvas"
        onkeydown={handleCanvasKeydown}
      >
        {#if schema && nodes.length > 0}
          <!-- Read-only graph. Svelte Flow's editing affordances have no LinkML
               meaning here, so they are disabled rather than validated:
               nodesConnectable={false} — no handle drag-to-connect.
               deleteKey={null}         — deletion cannot originate from keyboard.
               nodesFocusable/edgesFocusable={false} — Svelte Flow's per-node/edge
                 tab stops and keyboard selection/move handlers would be a second
                 keyboard system competing with the app's spatial navigation (the
                 .canvas-area handler + cursor). Disabling only focus removes that
                 conflict while keeping Svelte Flow's a11y descriptions and live
                 region (disableKeyboardA11y is left at its false default).
               Note: there is no `edgesReconnectable` prop in @xyflow/svelte 1.7.0;
               edge reconnection is opt-in via an <EdgeReconnectAnchor> that this
               app never renders, so it is already disabled.
               elevateEdgesOnSelect — native z-layering for the selected edge so
                 it reads above the dimmed rest; presentation only (default true,
                 set explicitly to make the R2.4.2 edge-inspection contract clear). -->
          <SvelteFlow
            bind:nodes
            edges={displayEdges}
            {nodeTypes}
            minZoom={0.1}
            maxZoom={2}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            deleteKey={null}
            elevateEdgesOnSelect={true}
            proOptions={{ hideAttribution: false }}
            onedgepointerenter={({ edge }) => { hoveredEdgeId = edge.id; }}
            onedgepointerleave={({ edge }) => {
              if (hoveredEdgeId === edge.id) hoveredEdgeId = null;
            }}
          >
            <FlowController
              bind:this={flowController}
              {panTarget}
              {panNonce}
              {fitRequest}
              onpanned={() => { panTarget = null; }}
            />
            <Background />
            <EdgeLabelOverlay
              {edges}
              strongEdgeIds={focusCtx.strongEdgeIds}
              {hoveredEdgeId}
              level={lodCtx.level}
            />
            <CustomControls
              {layoutOptions}
              {layoutLoading}
              onlayoutselect={selectLayout}
              {collapseCount}
              tableTotal={tableCount}
              oncollapseall={collapseAll}
              onexpandall={expandAll}
              onfitcollapsed={fitCollapsed}
            />
            <MiniMap
              nodeColor={(n) => {
                if (n.type !== 'tableParent') return 'transparent';
                const group = (n.data as unknown as { group?: string }).group;
                const map = groupCtx.map;
                if (!group || !map) return '#475569';
                return map.get(group)?.color ?? map.get('default')?.color ?? '#475569';
              }}
              nodeStrokeWidth={3}
              zoomable
              pannable
            />
          </SvelteFlow>
        {:else if schema && nodes.length === 0}
          <div class="empty-state">
            <p>No tables to show.</p>
            <p>Upload a LinkML YAML schema to get started.</p>
          </div>
        {:else}
          <div class="loading-state">
            <span class="loading-spinner">⟳</span>
            Loading schema…
          </div>
        {/if}
      </div>

      <!-- Schema YAML editor panel -->
      {#if schemaEditorOpen}
        <SchemaEditor
          yamlText={schemaYamlText}
          onchange={handleSchemaEditorChange}
          onclose={() => { schemaEditorOpen = false; }}
        />
      {/if}

      <!-- Group color editor panel -->
      {#if groupEditorOpen}
        <GroupEditor
          groups={groupList}
          onchange={handleGroupEditorChange}
          onclose={() => { groupEditorOpen = false; }}
        />
      {/if}

      {#if inspectorOpen}
        <RelationshipInspector
          {edges}
          selectedTableIds={focusCtx.selectedTableIds}
          selectedEdgeIds={focusCtx.strongEdgeIds}
          onselectedge={handleInspectorSelectEdge}
          onclose={closeInspector}
        />
      {/if}
    </div>

    {#if aboutOpen && schema?.provenance}
      <ProvenanceDialog
        provenance={schema.provenance}
        schemaName={schema.name}
        schemaId={schema.id}
        onclose={() => { aboutOpen = false; }}
      />
    {/if}
  </div>
</div>

<style>
  .app {
    display: flex;
    height: 100vh;
    width: 100vw;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: #f3f4f6;
  }

  /* Left sidebar column: stacks FileList above GroupLegend */
  .sidebar-col {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: 180px;
    background: #fff;
    border-right: 1px solid #e5e7eb;
    overflow-y: auto;
    z-index: 10;
  }

  /* Hide the sidebar column entirely when it has no children to show */
  .sidebar-col:empty {
    display: none;
  }

  .canvas-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    min-width: 0;
  }

  /* Top bar */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 14px;
    background: #fff;
    border-bottom: 1px solid #e5e7eb;
    z-index: 20;
    gap: 12px;
    flex-shrink: 0;
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
    /* R2.7.2: clip the title cluster so it can never paint over the search bar. */
    overflow: hidden;
  }

  .topbar-center {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    justify-content: flex-end;
    flex-shrink: 0;
  }

  .app-title {
    font-size: 14px;
    font-weight: 700;
    color: #111827;
    white-space: nowrap;
    /* R2.7.2: truncate with an ellipsis rather than overpainting the search bar. */
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .schema-name {
    font-size: 12px;
    color: #475569;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .node-count {
    font-size: 11px;
    color: #6b7280;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .load-error {
    font-size: 11px;
    color: #dc2626;
    cursor: default;
  }

  /* Editor toggle buttons */
  .editor-btn {
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

  .editor-btn:hover {
    border-color: #6b7280;
    background: #f9fafb;
  }

  .editor-btn.active {
    background: #1e293b;
    border-color: #1e293b;
    color: #fff;
  }

  .editor-btn-icon {
    font-size: 11px;
    opacity: 0.8;
  }

  /* Icon-only variant (e.g. About) — keeps the top bar compact. */
  .editor-btn.icon-only {
    padding: 4px 7px;
  }

  .editor-btn.icon-only .editor-btn-icon {
    font-size: 14px;
  }

  .uploader-wrap {
    position: relative;
  }

  /* Main content row: canvas + panels side by side */
  .content-row {
    flex: 1;
    display: flex;
    overflow: hidden;
    min-height: 0;
  }

  .canvas-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }

  /* Persistent, non-time-limited keyboard focus indicator (WCAG 2.4.7).
     Distinct from the `.table-parent.cursor` ring: this outline means the
     canvas region owns DOM keyboard focus (arrow keys navigate from here),
     while the cursor ring marks *which* table is the spatial target. Same
     colour, different meaning — one is input focus, the other is position. */
  .canvas-area:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: -2px;
  }

  /* Canvas */
  :global(.svelte-flow) {
    flex: 1;
  }

  /* Subflow parent node — transparent background, subtle border, no padding */
  :global(.svelte-flow .svelte-flow__node.parent) {
    background: transparent;
    border: none;
    padding: 0;
    border-radius: 6px;
  }

  /* Column nodes — no default node styling */
  :global(.svelte-flow .svelte-flow__node-column) {
    background: transparent;
    border: none;
    padding: 0;
  }

  .empty-state,
  .loading-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #6b7280;
    font-size: 14px;
    gap: 8px;
  }

  .loading-spinner {
    font-size: 28px;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
</style>
