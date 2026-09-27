# AGENTS.md — plugin-link

Summary of the project architecture and key design decisions for AI coding agents working on this codebase.

---

## What this is

An interactive **Entity Relationship Diagram (ERD) viewer** built with SvelteKit and Svelte Flow. It parses any [LinkML](https://linkml.io) schema (YAML or JSON) and renders the classes as a pannable, zoomable canvas of table nodes connected by foreign-key edges. The default schema is the OMOP CDM v5.4 (fully merged LinkML YAML).

There is no in-browser LinkML runtime. The bundled-schema viewer is a pure client-side SPA, but reconciliation is **not** in the browser: it runs off-client in `produce.py`, either at build time (bundled artefacts) or in a server boundary (`POST /reconcile`) for uploads and hand-edits. The bundled viewer therefore needs no server; the upload/edit feature does.

The project ships three deployment targets from the same SvelteKit frontend:

- **Web / GitHub Pages** — static SPA built with `@sveltejs/adapter-static`, deployed via `.github/workflows/deploy.yml`. Serves the bundled schemas only (no reconcile endpoint). Base path `/plugin-link`.
- **Served origin** — the same static build served by `deploy/serve.mjs` under launchd (`com.semiac.linkml-viewer`, `PORT=4180`) behind Cloudflare, which also exposes `POST /linkml-viewer/reconcile` for uploads. Base path `/linkml-viewer`.
- **Desktop (Tauri v2)** — the same static build is wrapped in a native window using [Tauri v2](https://tauri.app). The Tauri shell lives in `src-tauri/` and adds no extra Rust logic beyond the standard app harness. Supports macOS (`.app` / `.dmg`), Windows (`.exe` / `.msi`), and Linux (`.deb` / `.AppImage`). No in-app reconcile server.

The authoritative mode-by-mode matrix lives in [`README.md`](./README.md#deployment-matrix-authoritative).

---

## Authority boundary (Phase A)

Semantics are established once, off the client runtime, then only materialised.

| Concern | Authority |
|---|---|
| Schema meaning | LinkML / SchemaView |
| Schema structure | SchemaDefinition metamodel |
| Import closure | SchemaView |
| Class semantics | ClassDefinition + inheritance |
| Slot semantics | SlotDefinition + slot_usage + inheritance |
| Effective class slots | `class_induced_slots()` |
| Viewer positioning | Svelte Flow / Dagre / ELK |
| Viewport | Svelte Flow |
| Interaction | viewer |
| Mutation | prohibited |

LinkML meaning is established off-client exactly once by `produce.py` (pinned
Python `linkml` 1.11.1), invoked by the native Vite pipeline in
`vite.config.ts`. The client `src/lib/linkml.ts` only projects the
resulting artefact (`NormalizedSchema` is a transport/materialisation boundary);
`layout.ts` materialises the reconciled relationships into Svelte Flow
nodes/edges and must not decide what a class or slot means. There is no
in-browser LinkML runtime.

---

## Running the project

```bash
uv sync --locked         # materialise the locked producer env (pyproject.toml + uv.lock + .python-version)
just                    # start web dev server (bun run dev) at http://localhost:5173
just dev-tauri          # start Tauri desktop dev (wraps Vite dev in a native window)
bun run build            # production web build → build/ (runs `uv run --locked produce.py --all`)
bun run check            # svelte-check type checking
bun run test:repro       # clean-environment producer determinism proof
```

`uv sync --locked` is optional (any producer boundary runs it implicitly), but it is the explicit way to materialise the locked environment. Every producer invocation goes through `uv run --locked`, so a stale/missing `uv.lock` fails instead of silently re-resolving.

### Desktop builds

```bash
just build-tauri                # build for the current platform
just build-macos-silicon        # macOS Apple Silicon .app + .dmg (requires: brew install create-dmg)
# Output: src-tauri/target/<target-triple>/release/bundle/
```

Tauri v2 CLI is invoked via `bun run tauri:dev` / `bun run tauri:build` (see `package.json`). The `beforeBuildCommand` in `tauri.conf.json` runs the project build automatically before bundling.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | SvelteKit 2 + Svelte 5 (runes syntax) |
| Canvas | `@xyflow/svelte` 1.7.0 (Svelte Flow) |
| Layout engines | `@dagrejs/dagre` 3.1.1 (sync) + `elkjs` 0.12.0 (async, ELK layered) |
| YAML parsing | `js-yaml` 5.4.2 |
| Code editor | CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/lang-yaml`, `@codemirror/theme-one-dark`, `@codemirror/commands`) |
| Language | TypeScript 6.0.3, strict mode |
| Build tool | Vite 8.3.1 |
| Adapter | `@sveltejs/adapter-static` (static SPA, GitHub Pages) |
| Desktop shell | Tauri v2 (`src-tauri/`) — wraps the static build in a native window |

---

## Directory layout

```
plugin-link/
├── .github/workflows/deploy.yml  # deploy to GitHub Pages on push to main
├── justfile                      # default recipe: bun run dev; also Tauri build recipes
├── svelte.config.js              # adapter-static, base: /plugin-link in prod
├── produce.py                    # the single LinkML producer (pinned linkml 1.11.1); invoked by vite.config.ts
├── vite.config.ts                # native pipeline: sveltekit() + bundled artefact generation + POST /reconcile (dev)
├── src-tauri/                    # Tauri v2 desktop shell
│   ├── tauri.conf.json           # app metadata, window config, bundle targets
│   ├── Cargo.toml                # Rust crate (tauri + tauri-plugin-opener)
│   ├── src/
│   │   ├── main.rs               # binary entry point
│   │   └── lib.rs                # tauri::Builder::default().run(...)
│   ├── icons/                    # platform icons (.png, .icns, .ico)
│   └── capabilities/             # Tauri v2 capability definitions
├── e2e/                          # kept fast Playwright suite (interaction + navigation)
│   ├── helpers.ts
│   ├── interaction.spec.ts
│   └── navigation.spec.ts
├── static/
│   ├── reconciled/<name>.json    # pipeline output (generated by vite.config.ts; gitignored)
│   ├── synthetic_inheritance.yaml # bundled fixture schema (inheritance coverage)
│   ├── omop_cdm.yaml             # default schema (OMOP CDM v5.4, fully merged, 13 879 lines)
│   ├── sein.yaml                 # SEIN merged schema (13 HiX staging + 17 OMOP classes, 30 total)
│   ├── hix.yaml                  # HiX staging classes only (13 classes, raw LinkML)
│   ├── sein-omop.yaml            # OMOP CDM subset used by SEIN (17 classes, raw LinkML)
│   ├── group-config.yaml         # group name → color/label config (loaded at runtime)
│   └── logo.png                  # favicon
└── src/
    ├── routes/
    │   ├── +layout.ts            # ssr=false only (prerender is omitted; pure client-side SPA)
    │   ├── +layout.svelte        # Svelte Flow CSS import, favicon, global box-sizing/overflow
    │   └── +page.svelte          # main app: state, canvas wiring, top bar, layout toolbar
    └── lib/
        ├── types.ts              # all shared TypeScript interfaces (ErdClass, ErdTableNodeData, ErdColumnNodeData, FileInfo, GroupInfo, …)
        ├── linkml.ts             # artefact transport: projectReconciledArtifact(), reconcileWorkspace(), loadReconciledArtifact(), loadGroupConfig()
        ├── layout.ts             # async buildGraph(schema, collapsed, LayoutOptions) — dagre + elk
        ├── edgeLod.ts            # presentation-only label transform: no static labels below LOD2 (R2.8.8)
        └── components/
            ├── CustomControls.svelte  # bottom-left controls: zoom/fit/lock + intent-labelled layout axes
            ├── FileList.svelte        # left sidebar: workspace file list with import badges + context menu
            ├── FlowController.svelte  # useSvelteFlow() context — pan/highlight/fitView
            ├── GroupEditor.svelte     # right panel: group color-picker form (live updates)
            ├── GroupLegend.svelte     # left sidebar: group color swatches + slot icon key
            ├── SchemaEditor.svelte    # right panel: CodeMirror 6 YAML editor (500ms debounce)
            ├── SchemaUploader.svelte  # top-bar button + drag-and-drop file picker
            ├── SearchBar.svelte       # top-bar search with keyboard nav and canvas pan
            ├── ColumnNode.svelte      # custom child node: one table column row
            └── TableParentNode.svelte # custom parent node: collapsible table card with group header color
```

---

## Data flow

```
BUNDLED (authoritative):
static/reconciled/<name>.json ──fetch──▶ loadReconciledArtifact()
                                          └─ projectReconciledArtifact() ──▶ NormalizedSchema

UPLOAD / EDIT (same producer, Vite dev middleware):
uploaded file         ──POST /reconcile──▶  vite.config.ts (configureServer)
YAML editor (live)    ──debounce────────▶      └─ produce.py ──▶ artefact
                                                               │
                                          projectReconciledArtifact() ──▶ NormalizedSchema
                                                               │
                                                        buildGraph(schema, collapsed)
                                                               │
                                                        Node[] + Edge[]  ──▶  SvelteFlow

static/group-config.yaml  ──fetch──▶  loadGroupConfig()  ──▶  Map<string, GroupInfo>
                                                                        │
                                              setContext('groupConfig', groupCtx)  ──▶  TableParentNode + GroupLegend
Group editor (live)   ──onchange──▶  groupCtx.map = new Map(...)  ──▶  TableParentNode + GroupLegend

handleUploadedFiles() ──upload──▶  FILE_PALETTE color assigned per file  ──▶  fileCtx.map
                                                                                    │
                                              setContext('fileConfig', fileCtx)  ──▶  TableParentNode + GroupLegend
```

1. On mount, `+page.svelte` fetches the bundled schema YAML (for the workspace/editor) and its authoritative reconciled artefact in parallel via `loadBundledSchema()`; semantics come from `loadReconciledArtifact()`, never from the YAML.
2. Uploaded / edited files POST their workspace to `/reconcile`, served natively by the Vite dev-server middleware in `vite.config.ts`, which runs the same `produce.py` and returns the same artefact shape; the client projects it via `projectReconciledArtifact()`.
3. The `NormalizedSchema` is stored in `$state`.
4. A `$effect` calls `buildGraph()` whenever `schema` or `collapsed` changes, writing new `Node[]` / `Edge[]` into `$state.raw`.
5. Svelte Flow re-renders reactively.
6. In parallel on mount, `loadGroupConfig()` fetches `group-config.yaml` and populates `groupCtx.map`.
7. `TableParentNode` and `GroupLegend` read `groupCtx` from Svelte context reactively.
8. `fileCtx.map` is populated synchronously when files are uploaded; `TableParentNode` derives a stripe color from it.

---

## Artefact transport (`src/lib/linkml.ts`)

`src/lib/linkml.ts` is **transport/materialisation only**. It never computes LinkML
semantics — there is no parser and no in-browser SchemaView. It has two entry
points, both yielding the same artefact shape from the same producer:

- `loadReconciledArtifact(name)` — fetches `static/reconciled/<name>.json`
  (generated by the Vite plugin on dev-server start / build).
- `reconcileWorkspace(files, activeFileId)` — POSTs the uploaded/hand-edited
  workspace to `/reconcile` (via `RECONCILE_URL`, default same-origin), served by
  the Vite dev middleware in `vite.config.ts`, which runs `produce.py` and returns
  the same artefact shape. If the endpoint is unreachable the caller surfaces an
  error; no fallback exists.

Both feed `projectReconciledArtifact(artifact)`, which maps the artefact's class /
effective-slot / relationship facts 1:1 into `NormalizedSchema`:

- classes carry `pk_slot`, `pk_slot_name`, `group`, `from_schema`, and their
  induced `slots` with `range_kind` / `range_target` / `identifier` / `required` /
  `multivalued` / `exact_mappings` / `declared_by` / `inherited_from`.
- `relationships[]` carry `kind` (`fk` | `etl`), `source_class`, `target_class`,
  `slot`, `slot_name`, `required`, and the per-relationship target anchor
  `target_slot` / `target_slot_name`. For an FK the anchor is the target class's
  identifier slot; for an ETL relationship it is the slot segment of the
  `exact_mappings` CURIE. `layout.ts` consumes this anchor directly.

The only viewer-owned value is `is_fk`, read as membership in the artefact's
authoritative FK relationship set (never recomputed from `range_kind` /
`identifier`). Self-referential FK relationships remain authoritative facts but
are not materialised as canvas self-loops (a presentation choice).

`js-yaml` is used for **parse-only** workspace metadata (`describeWorkspaceFile` /
`extractImports` / `unresolvedImportNames`) and for `loadGroupConfig()`. Parsing
YAML is not LinkML semantics.

### Group annotations

Classes may carry a `group` annotation; the producer reads
`annotations.group` and emits it as the artefact class's `group`. The value must
match a `name` key in `group-config.yaml` to receive a color; unknown group values
fall back to the `default` entry. The compact scalar form is canonical, but the
producer reads whatever SchemaView exposes as the annotation's value.

### exact_mappings (ETL mappings)

Slots may carry `exact_mappings` listing cross-schema column references:

```yaml
attributes:
  gender:
    exact_mappings:
      - omop_cdm54:Person.gender_source_value
```

The producer reads these from the induced slot, resolves the CURIE's class segment
against the local class surface (emitting an `etl` relationship when it names a
local, non-self class), and carries the CURIE's slot segment as the relationship's
`target_slot`. `ColumnNode` renders the first `exact_mappings` entry as an indigo
italic badge (prefix stripped), with the full list on hover.

---

## Group configuration (`static/group-config.yaml`)

Group colors and labels are defined in `static/group-config.yaml`, **not hardcoded in TypeScript**. This means new groups can be added by editing YAML only.

```yaml
groups:
  - name: clinical
    label: Clinical
    color: "#2563eb"
    text_color: "#ffffff"
  - name: default
    label: Other
    color: "#475569"
    text_color: "#ffffff"
```

Each entry maps to the `GroupInfo` interface (`name`, `label`, `color`, `text_color`). The `default` entry is used as a fallback for classes whose group value does not match any named entry; it is excluded from the `GroupLegend` swatch list.

`loadGroupConfig()` in `linkml.ts` fetches the file at runtime and returns a `Map<string, GroupInfo>` keyed by `name`.

### Context pattern

`+page.svelte` sets a reactive `$state` wrapper as Svelte context **synchronously at init time** so that child components (`TableParentNode`, `GroupLegend`) can call `getContext` during their own synchronous initialization:

```typescript
// +page.svelte — at module script top level (NOT inside onMount)
const groupCtx = $state<{ map: Map<string, GroupInfo> | null }>({ map: null });
setContext('groupConfig', groupCtx);

// Then in onMount, populate the map after the async fetch:
onMount(() => {
  loadGroupConfig().then((map) => { groupCtx.map = map; });
});
```

Child components read the context and derive colors reactively:

```typescript
// TableParentNode.svelte / GroupLegend.svelte
const groupCtx = getContext<{ map: Map<string, GroupInfo> | null }>('groupConfig');
const headerColor = $derived(groupCtx?.map?.get(rawData.group)?.color ?? '#475569');
```

Because `groupCtx` is a `$state` object (not a plain value), mutations to `groupCtx.map` are visible reactively in all child `$derived` expressions without requiring a new `setContext` call.

---

## Auto-layout (`src/lib/layout.ts`)

`buildGraph(schema, collapsed, layoutOptions)` produces `Node[]` and `Edge[]` for Svelte Flow. It is **async** to support the ELK engine.

### Layout engines

Two engines are supported, selected via `LayoutOptions`:

- **dagre** (`engine: 'dagre'`): synchronous, uses `@dagrejs/dagre` 3.1.1. Direction is `LR` or `TB` via `rankdir`.
- **ELK** (`engine: 'elk'`): async, uses `elkjs` with the `org.eclipse.elk.layered` algorithm. Direction controlled via `elk.direction` (`RIGHT` or `DOWN`).

### Division of labour

`layout.ts` is pure materialisation plus a direct call to the native engine. It
owns only node geometry (dimensions, anchor positions) and the Svelte Flow
node/edge representation. It does **not** re-implement Dagre/ELK semantics and
introduces no intermediate layout model:

```
reconciled facts (NormalizedSchema)
  -> viewer-owned node geometry (NODE_WIDTH / header / row / padding)
  -> materialise relationships to Svelte Flow node ids (source slot, target anchor)
  -> Dagre native graph { nodes: {width,height}, edges, rankdir/spacing }  OR
     ELK native graph   { children: [...] , edges: [...], layoutOptions 'elk.*' }
  -> engine positions
  -> tableParent + column Svelte Flow nodes + edges
```

### Node sizing

Node heights are estimated from slot count: `header (36px) + rows × 24px + padding`
(no row cap — every induced slot renders). Collapsed nodes use only the header
height (36px).

### Edges

`materialiseEdges()` maps the reconciled `relationships[]` to edge records. It
reads only `kind`, `source`, `target`, `slot`, and the reconciled `target_slot`
anchor — it never inspects ranges, class-name membership, mapping CURIEs, pk/key
slots, or self-reference flags. The source column is `(source, slot)`; the target
column is `(target, target_slot)`. A collapsed table resolves to the bare table
id (the relationship remains in the materialised edge set, but the `tableParent`
renders no `<Handle>`), and a target anchor that names no rendered column falls
back to the first column. This is the R1.9 closure of the former viewer-side
`pk_slot` + first-column fallback.

**Collapsed-edge anchoring (R2.8.3).** The directional handles live on the
column nodes (`LR` → right/left, `TB` → bottom/top), asserted by both
`bench-layout.ts` and `e2e/collapsed-edges.spec.ts`. When a table collapses its
columns are gone, so `TableParentNode` exposes its own source/target `<Handle>`
(from the native node props). Svelte Flow's `getEdgePosition` can then resolve
the bare-table-id endpoint, so a collapsed table **keeps every incident edge**,
anchored to its header; expanding restores the original edge-id set exactly.
Collapse-all likewise preserves the full edge count. Handles on the parent are
rendered only while collapsed, so expanded tables stay handle-free (the columns
own them).

Two kinds of edges are produced, discriminated by `kind`:

- **FK edges** (`kind: 'fk'`): from the artefact's authoritative FK relationship
  set. Color: `#475569` (slate-600), solid. Required edges get `stroke-width: 2`;
  optional get `1.5`.
- **ETL edges** (`kind: 'etl'`): from the artefact's ETL relationships (resolved
  from `exact_mappings`). Color: `#6366f1` (indigo-500), dashed
  (`stroke-dasharray: 5,3`), `stroke-width: 1.5`, with an indigo label.

`buildSvelteEdges()` converts the materialised records into Svelte Flow `Edge`
objects, feeding both engines the same table-level edge set before layout. Edge
IDs are `source--slotName--target` with a counter suffix for duplicates. Isolated
nodes (no layout position) are skipped silently.

The `group` field from `ErdClass` is propagated into `ErdTableNodeData` by both the Dagre and ELK build paths so that `TableParentNode` and `GroupLegend` can access it without querying the schema separately. The `fileId` field is propagated the same way; column rows carry `ErdColumnNodeData`.

---

## Custom nodes (`TableParentNode.svelte` + `ColumnNode.svelte`)

The ERD uses a Svelte Flow **subflow**: each class is a `tableParent` node whose children are `column` nodes (`parentId` = class id, `extent: 'parent'`). Parent nodes appear before their children in the `nodes` array.

### `TableParentNode.svelte` (type: `tableParent`)

- Renders the table card header only: a group-colored `.header` element with the class name, slot count, and a distinct **collapse control** (`<button class="collapse-toggle">` chevron). Column child nodes are positioned inside this parent by Svelte Flow.
- **Selection vs collapse are separate affordances (R2.8.7).** The `.header` is the table's selection surface — a click selects the table node natively. The chevron `.collapse-toggle` is the *only* collapse affordance; it stops propagation (and pointerdown) so toggling never selects or drags the table. The header is therefore a plain element, not a button, and `aria-expanded`/`aria-label` live on the toggle button.
- Header color and text color are `$derived` from `groupCtx.map` read via `getContext('groupConfig')`. Updates reactively once the group config fetch resolves.
- **File stripe**: in multi-file workspaces (`fileCtx.map.size > 1`), a 6px colored left stripe is rendered inside the header via `position: absolute; left: 0; top: 0; bottom: 0; width: 6px`. The color comes from `fileCtx.map` (keyed by `ErdTableNodeData.fileId`). When only one file is loaded the stripe is hidden. Header `padding-left` is `16px` when a stripe is shown, `10px` otherwise.
- **Three-state focus** (R2.8.7): `selected` (§ the chosen object — `focusCtx.selectedTableIds`), `related` (connected to it — `focusCtx.tableIds`), `dimmed` (everything else while focus is active). The selected state is distinct from the related state, so the chosen object is no longer indistinguishable from its neighbourhood.
- **Search highlight** and **keyboard cursor** are derived from the `searchTarget`/`cursor` contexts (`highlighted`/`cursor` classes); they are never written back into the node array.
- **Read-only geometry**: parent nodes stay draggable (moving a whole table is a coherent canvas affordance); child column nodes are `draggable: false` because rows are schema data, not free-form positions.

### `ColumnNode.svelte` (type: `column`)

- Renders one slot row inside its parent; the source/target `Handle`s live on the column, not the parent.
- **LOD-gated presentation** (from the `lodLevel` context, derived from zoom by `FlowController`): LOD0 = name only; LOD1 adds the PK/FK badge; LOD2 adds the range type and ETL mapping badge. LOD never changes geometry.
- Badge: `PK` (amber) for identifiers, `FK` (slate) for foreign keys, blank for plain slots; required slot names are bold.
- The **indigo italic ETL mapping badge** shows `exact_mappings[0]` with the prefix stripped (e.g. `omop_cdm54:Person.person_source_value` → `Person.person_source_value`); the full list is the hover title.

Both components cast `data` via `as unknown as ErdTableNodeData` / `ErdColumnNodeData` and re-derive it with `$derived` to avoid the `state_referenced_locally` Svelte 5 lint warning. Svelte Flow v1 requires `Node<Data>` where `Data extends Record<string, unknown>`; our node data is richer than that, hence the cast in `layout.ts`.

---

## Group legend (`src/lib/components/GroupLegend.svelte`)

A left-side sidebar (`170px` wide, `border-right: 1px solid #e5e7eb`) rendered when `hasGroups || fileInfoList.length > 1`.

Props:
- `activeGroupNames: string[]` — the unique group names found in the current `nodes` array, derived in `+page.svelte`.
- `fileInfoList?: FileInfo[]` — list of `{ id, label, color }` for loaded files (default `[]`). Passed from `+page.svelte`.

Sections:
1. **Files** — shown only when `fileInfoList.length > 1`. One row per file with a `6×14px` stripe swatch (matching the `TableParentNode` left stripe) and the file label (`schema.name` or filename stem). `min-width: 0` + `text-overflow: ellipsis` prevents long schema names from overflowing.
2. **Groups** — one row per active group (colored `14×14` swatch + label). The `default` entry is excluded from this list.
3. **Legend** — slot row icon key: PK badge (amber), FK badge (slate), bold name = required, plain name = optional, indigo italic = ETL mapping.
4. **Edges** — ETL edge row: dashed indigo swatch (`border-top: 2px dashed #6366f1`) + "ETL edge" label.

The component reads `groupCtx` from Svelte context (same reactive wrapper set by `+page.svelte`), so it updates reactively once `loadGroupConfig()` resolves.

---

## Custom controls (`src/lib/components/CustomControls.svelte`)

Replaces the built-in `<Controls>` component from `@xyflow/svelte` entirely.

- Uses `useSvelteFlow()` for `zoomIn`, `zoomOut`, `fitView` (must be inside `<SvelteFlow>` subtree).
- Uses `useStore()` directly to toggle the lock state (`store.nodesDraggable`, `store.elementsSelectable`). Connectability is permanently disabled at the `<SvelteFlow>` level (`nodesConnectable={false}`) and is deliberately *not* re-enabled by the lock.
- 2-column CSS grid layout: Row 1: zoom+/zoom−, Row 2: fit view/lock toggle, then collapse-all/expand-all + Fit collapsed, then the layout axes.
- **Layout is two orthogonal, intent-labelled axes (R2.8.11)**, not engine-initials glyphs. Direction is primary (`Left → Right` / `Top → Bottom`); the engine is secondary (`ELK` / `Dagre`). Selecting either axis calls `onlayoutselect` with the resulting `{ engine, direction }` and preserves the other axis. Buttons expose `aria-label` (`Layout direction: …` / `Layout engine: …`) and `aria-pressed`; the spinner/disabled state covers both axes while a layout is running.
- Inline SVG icons mirrored from the `@xyflow/svelte` built-in Controls source.
- Positioned absolutely at `bottom: 24px; left: 12px`, matching the original Controls placement.

Props:
- `layoutOptions: LayoutOptions` — current active layout to highlight the active button
- `layoutLoading: boolean` — shows a spinner on the active layout button while running
- `onlayoutselect: (opts: LayoutOptions) => void` — called when user clicks a layout button

---

## File list (`src/lib/components/FileList.svelte`)

A left-side sidebar section showing the workspace files currently loaded.

Props:
- `files: WorkspaceFile[]` — list of loaded workspace files
- `activeFileId: string | null` — ID of the currently displayed file (highlighted)
- `onfileclick: (id: string) => void` — called when the user clicks a file row to switch to it
- `onfileremove: (id: string) => void` — called when the user removes a file via the context menu

Features:
- Each row shows a file icon, truncated filename, and an optional import badge.
- **Import badge**: shown when a file has `imports`. Green (`⇒N`) when all imports resolve to other files in the workspace; amber (`⚠N`) when one or more imports cannot be resolved. Hovering shows the import names or lists the unresolved stems.
- **Context menu**: right-click a row to get a "Remove file" option. Dismissed by clicking outside.
- The active file row is highlighted with a dark (`#1e293b`) background.
- Import resolution is computed by `unresolvedImports(file)`: compares each import stem (case-insensitive) against the set of `WorkspaceFile.stem` values in the current workspace.

---

## Schema editor (`src/lib/components/SchemaEditor.svelte`)

An in-browser CodeMirror 6 YAML editor rendered as a 420px right slide-in panel.

- Extensions: `yaml()` language, `oneDark` theme, `defaultKeymap`, `historyKeymap`, `history()`, `EditorView.lineWrapping`.
- 500ms debounce on `EditorView.updateListener`; validates YAML **syntax** with `js-yaml` (`load`) on each debounced keystroke. It does not parse LinkML.
- On parse error: shows a red error bar with the message; does **not** call `onchange` (canvas unchanged).
- On valid YAML: fires `onchange(text)`; the parent replaces the workspace file text, which re-enters the same `/reconcile` producer path.
- A `$effect` syncs editor content when the `yamlText` prop changes externally (e.g. new schema loaded via file upload).
- Editor is destroyed in `onDestroy`.

Props:
- `yamlText: string` — current YAML content (controlled from parent)
- `onchange: (text: string) => void` — called with valid YAML text on each debounced edit
- `onclose: () => void` — called when the × button is clicked

---

## Group editor (`src/lib/components/GroupEditor.svelte`)

A 360px right slide-in panel for editing group colors and labels live.

- Grid layout: `grid-template-columns: 20px 1fr 1fr 28px 28px` — delete / name / label / bg color / text color.
- Color pickers: native `<input type="color">` hidden behind a visible swatch `div`; `oninput` for live updates without requiring a confirm step.
- Add row button (dashed border); delete button per row; the `default` entry's delete button is disabled.
- A `$effect` re-syncs local `rows` when the `groups` prop changes (e.g. new schema loaded).
- Fires `onchange(rows)` immediately on every change (no debounce); parent updates `groupCtx.map`.

Props:
- `groups: GroupInfo[]` — current group list (derived from `groupCtx.map` in parent)
- `onchange: (groups: GroupInfo[]) => void` — called on every edit
- `onclose: () => void` — called when the × button is clicked

---

## State management (`src/routes/+page.svelte`)

Uses Svelte 5 runes throughout:

| Rune | Variable | Purpose |
|---|---|---|
| `$derived` | `schema` | Active file's imports-resolved `NormalizedSchema` (null while loading) |
| `$state` | `loadError` | Error message string |
| `$state` | `collapsed` | `Set<string>` of collapsed node IDs |
| `$state` | `layoutOptions` | Active `LayoutOptions` (engine + direction) |
| `$state` | `fitRequest` | Counter incremented only for explicit fit intents (initial load, schema/layout change, Fit button) |
| `$state` | `groupCtx` | `{ map: Map<string, GroupInfo> \| null }` — reactive wrapper set as context |
| `$state` | `fileCtx` | `{ map: Map<string, string> }` — file ID → hex color map, set as `'fileConfig'` context |
| `$state` | `schemaEditorOpen` | Boolean — controls Schema editor panel visibility |
| `$state` | `groupEditorOpen` | Boolean — controls Group editor panel visibility |
| `$derived` | `schemaYamlText` | Raw YAML string of the active workspace file, for the Schema editor |
| `$state` | `searchCtx`, `cursorCtx`, `lodCtx` | Reactive context holders: search emphasis target, keyboard cursor id, LOD level |
| `$state.raw` | `nodes` | `Node[]` — raw avoids deep reactivity overhead |
| `$state.raw` | `edges` | `Edge[]` — raw avoids deep reactivity overhead |
| `$effect` | — | Rebuilds `nodes`/`edges` (async IIFE with cancellation flag) when `schema`, `collapsed`, or `layoutOptions` changes |
| `$derived` | `schemaName`, `tableCount`, `fkEdgeCount`, `etlEdgeCount` | Computed display values |
| `$derived` | `activeGroupNames` | Unique group strings present in current `nodes` |
| `$derived` | `hasGroups` | `true` when `activeGroupNames.length > 0` — gates `GroupLegend` visibility |
| `$derived` | `groupList` | `GroupInfo[]` array derived from `groupCtx.map` — passed to `GroupEditor` |
| `$derived` | `activeFileIds` | Unique `fileId` strings present in current `nodes` |
| `$derived` | `fileInfoList` | `FileInfo[]` array for `GroupLegend` — maps active file IDs to label + color |

`$state.raw` is used for `nodes` and `edges` per the [Svelte Flow performance recommendation](https://github.com/sveltejs/svelte/issues/11851) — deep reactivity on large node arrays causes noticeable lag.

---

## Build configuration

- **`svelte.config.js`**: uses `adapter-static` with `fallback: '404.html'` for client-side routing on GitHub Pages. The `base` path is `/plugin-link` in production (`NODE_ENV=production`) and empty in development.
- **`src/routes/+layout.ts`**: sets `ssr = false` only. `prerender` is intentionally omitted — Tauri requires SPA mode (a single `index.html` entry point), and GitHub Pages works via the `404.html` fallback without a full prerender.
- **`vite.config.ts`**: `sveltekit()` plugin plus `build.chunkSizeWarningLimit: 1600` to silence the bundle-size warning from the ~1.4 MB `elk.bundled.js` chunk.

---

## Layout experimentation freeze (C0.5)

The viewer-consumed semantic graph is **frozen for layout experimentation**. Every layout candidate (dagre TB/LR, ELK layered TB/LR) must consume the *same* classes, the same effective slots, the same FK/ETL edge set, the same node dimensions, and the same anchors. The experiment must never compare "Dagre + parser A" against "ELK + parser B". The shared input is pinned and flows through the production `buildGraph()` materialisation; layout never changes the production default.

> **Product default (R2.3).** The default `layoutOptions` is `{ engine: 'elk', direction: 'LR' }` (set in `+page.svelte`). This is a product decision against the objective "navigable, spatially legible and useful at overview zoom while preserving local relationship readability", not a numeric ranking. ELK-LR Pareto-improves the former Dagre-LR default — OMOP fit zoom 0.124 → 0.161, crossings 53 → 52 (OMOP) and 477 → 276 (SEIN) — with orthogonal edge routing and clear group banding. The accepted trade-off is forgoing Dagre-TB's higher raw fit zoom (0.195 OMOP) to keep dense FK/ETL regions legible. All four candidates remain selectable in `CustomControls.svelte` and measurable in `bench-layout.ts`; changing the default changes no semantics, no geometry contract and no layout engine.

> **Superseded (C1.11):** the workspace split-import ingestion defect — `+page.svelte::resolveImports` merging per-file `NormalizedSchema` class maps — is resolved by the reconciliation boundary (below). The workspace path enters the same reconciled boundary as every other schema source.

---

## Semantic authority (one producer, native pipeline)

> **Rule.** No Svelte Flow consumer may derive LinkML meaning independently when an applicable authoritative value exists. Consumers project/position/render/search/navigate the reconciled result; they do not reinterpret it.

**Bundled schemas (R1.4).** `static/reconciled/<name>.json` is produced off-client by `produce.py` from the pinned Python `linkml` 1.11.1 (`SchemaView`), invoked by the Vite plugin in `vite.config.ts` on dev-server start and on build. The viewer fetches it and `projectReconciledArtifact()` maps its class / effective-slot / relationship facts into `NormalizedSchema`. Every field is consumed directly; the only viewer-owned value is `is_fk`, read as membership in the artefact's authoritative FK relationship set (not recomputed from `range_kind`/`identifier`). Self-referential FK relationships remain authoritative facts but are not materialised as canvas self-loops (a presentation choice). Category-4 invented fields (`is_self_reference`, per-slot `etl_target_classes`) and all in-browser LinkML reasoning are deleted. `declared_by` / `inherited_from` / `from_schema` come from the artefact. `ErdClass.pk_slot` is the artefact's `pk_slot`.

**Locked producer environment (R2.8.4).** The producer's execution environment is a committed uv project at the repo root: `pyproject.toml` (declares `linkml==1.11.1`), `uv.lock` (exact resolved dependency set) and `.python-version` (`3.12`). `deploy/producer-runner.mjs::uvProducerArgs()` emits `uv run --locked produce.py …`; `--locked` refuses a missing/stale lock, so no boundary (build, dev middleware, production origin, verifier) can silently re-resolve a different toolchain. The version pin has exactly one authority — the lock — not a second copy in JavaScript. Reproducibility contract: *identical repository source state + identical locked producer environment → identical reconciled content*. Each artefact records `reproducibility.content_digest` (content identity, toolchain-independent), `reproducibility.output_digest` (content + toolchain provenance), and `python_version` / `linkml_version` / `linkml_runtime_version` as provenance. `bun run test:repro` (`deploy/repro-check.mjs`) proves determinism by running the producer twice, each pass in its own freshly-synced environment from `uv.lock`, and requiring byte-identical output.

**Uploads / hand-edited schemas (R1.8).** These have no artefact and POST to `/reconcile`, served by the Vite plugin's native dev-server middleware (`configureServer`), which executes the **same** `produce.py` and returns the **same** artefact shape. The client projects it identically via `projectReconciledArtifact()`. There is exactly one producer; the browser `linkml-runtime` residual is deleted.

**Production boundary (deployed).** The viewer ships as a static SPA (`@sveltejs/adapter-static` → GitHub Pages; Tauri wraps the same build). In production the upload endpoint is served by `deploy/serve.mjs` under launchd (`com.semiac.linkml-viewer`, `PORT=4180`), which serves the static build plus `POST /linkml-viewer/reconcile`; the Cloudflare ingress routes `/linkml-viewer/*` to it. The service executes the same `produce.py` through the same `deploy/producer-runner.mjs` process-group cleanup as the Vite plugin — one producer, two execution boundaries. Deploy with `BASE_PATH=/linkml-viewer bun run build` then `launchctl kickstart -k gui/$(id -u)/com.semiac.linkml-viewer`.

Under launchd the process PATH is minimal (`/usr/bin:/bin:/usr/sbin:/sbin`), so the runner resolves the `uv` binary itself (`UV_BIN` overrides) rather than relying on an inherited PATH.

`src/lib/layout.ts` is pure materialisation (no semantic re-derivation): it maps the reconciled `relationships[]` onto column node ids — the target column is the artefact's per-relationship `target_slot` anchor (R1.9) — and runs Dagre/ELK for geometry only.

> **Housekeeping.** The former parity/reconciliation harness, witness fixtures, and benchmark tooling were deleted, as were the standalone `producer/` and `reconcile-service/` execution boundaries. The authoritative producer (`produce.py`, invoked by `vite.config.ts`), the reconciled artefacts (`static/reconciled/`, a generated pipeline output), and the Vite dev `/reconcile` middleware are the semantic boundary.

---

## First-load camera (R2.8.10)

The first-load camera is an explicit **presentation/product** choice, never a
semantic one: the producer emits no notion of an "important" class, and the
viewer infers none. `src/lib/camera.ts` owns the single configured authority:

- `ENTRY_CLASS` — the class a readable-entry camera opens on (explicit config).
- `ENTRY_ZOOM` — the readable scale (the `STRUCTURAL` LOD floor).
- `DEFAULT_CAMERA_MODE` — `'overview'` (whole-graph fit; the current default,
  unchanged) or `'entry'` (open on `ENTRY_CLASS` at `ENTRY_ZOOM`).

`FlowController.svelte::applyCamera()` applies the mode on every fit intent;
the dev-only seam `window.__erdCamera.setMode(mode)` switches it at runtime so
the modes can be compared without committing the product default. Pinned by
`e2e/camera.spec.ts`.

---

## Interaction authority boundary (R2.4.3)

Three interaction authorities coexist without competing. Each capability has
exactly one owner; none of them writes into another's state. This mapping is a
deliberate boundary, encoded on `<SvelteFlow>` in `+page.svelte`, at the
`.canvas-area` handler, and by `edgeFocus.ts`; it is asserted by
`e2e/interaction-contract.spec.ts`. No `useNodeConnections()` (or any other
graph/selection abstraction) is introduced: relationship focus is derived only
from the rendered `edges` plus native Svelte Flow selection.

| Capability | Authority | Source of truth |
|---|---|---|
| Pointer selection | Svelte Flow (`elementsSelectable`) | library store |
| Table selection surface | Table header click → native node selection | Svelte Flow (`elementsSelectable`) |
| Collapse | `.collapse-toggle` button (stop-propagation) → `collapseCtx` | app collapse authority |
| Node keyboard focus | **Disabled** (`nodesFocusable={false}`) | app spatial keyboard authority |
| Edge keyboard focus | **Disabled** (`edgesFocusable={false}`) | app spatial keyboard authority |
| Arrow navigation | App keyboard authority | `.canvas-area` handler + `cursorCtx` |
| Enter / Space | App keyboard authority (collapse toggle) | `.canvas-area` handler + `collapseCtx` |
| Delete | **Disabled** (`deleteKey={null}`) | none — graph is read-only |
| Dragging | App lock state | `store.nodesDraggable` |
| Search | App search authority | `searchCtx` / `panTarget` / `panNonce` |
| Relationship emphasis | **Derived** from native selection | `edgeFocus.ts` over rendered `edges` |

Svelte Flow documents that `nodesFocusable`/`edgesFocusable` control Tab/Enter
selection while `elementsSelectable` controls pointer selection, and `deleteKey`
controls deletion. Disabling focus (not a11y) leaves the library's descriptions
and live region active while removing the competing per-node/edge keyboard path.

**Multi-selection rule** (presentation over existing Svelte Flow state, no new
semantics):

```
no selection           → no relationship focus
node selection only    → focus relationships of the selected node(s) (union)
edge selection present → edge focus takes precedence: the selected edge(s)
                         plus the union of their endpoint tables
```

`deriveRelationshipFocus()` implements this deterministically for
`selectedNodes = [A, B]` (union of both tables' incident edges) and
`selectedEdges = [e1, e2]` (both edges strong; union of their endpoints), with
edge precedence whenever any edge is selected — consistent with R2.4.1/R2.4.2.

### Presentation ↔ native state invariant (R2.4.4)

> **Invariant.** A presentation transform may add presentation state but must
> preserve the native Svelte Flow interaction state on the node/edge objects it
> receives — at minimum `selected`, plus any other native interaction field it
> does not own (`draggable`, `selectable`, `focusable`, `connectable`,
> `zIndex`/`elevated`, `class`). The viewer model is read-only, so there is no
> native state to mutate; transforms only decorate.

Svelte Flow derives `selectedNodes`/`selectedEdges` by filtering `node.selected`
/ `edge.selected` on the array it is given (`initial-store.svelte.js`). Any
rebuilt array must therefore round-trip those flags or selection resets.

| Path | Rebuilds objects? | Preserves native `selected`? |
|---|---|---|
| `edgeLod.ts::applyEdgeLod` | yes (below LOD2), rest-destructure drops `label` only | yes — all other fields pass through |
| `edgeFocus.ts::applyEdgeFocus` | yes (while focus active) | yes — `selected` re-asserted from `strongEdgeIds` (R2.4.2) |
| node presentation (`TableParentNode`/`ColumnNode` classes, focus/LOD context) | no — derives CSS from context | yes — the node array is never rewritten for presentation |
| layout rebuild (`+page.svelte` effect ← `layout.ts`) | yes — fresh base nodes/edges | yes — nodes: flag carried across same-schema rebuilds, cleared on schema/file switch; edges: `applyEdgeFocus` |
| selection clear (empty-canvas / schema / file switch) | n/a | intentional clear (new graph has no selection) |

Regression coverage: `e2e/selection-regression.spec.ts`.

---

## Known pitfalls

- **One keyboard authority for the graph**: `handleCanvasKeydown` on `.canvas-area` acts only when `e.target === e.currentTarget`. If focus is on a descendant control (e.g. the table header's collapse-toggle `<button>`), that control owns the keypress and behaves natively; the spatial handler must not also fire. Svelte Flow's own per-node/edge keyboard handlers are turned off (`nodesFocusable={false}`, `edgesFocusable={false}`) so they cannot compete, while its a11y descriptions and live region remain (default `disableKeyboardA11y={false}`).
- **The graph is read-only**: `<SvelteFlow>` sets `nodesConnectable={false}` and `deleteKey={null}`; column nodes are `draggable: false`. There is no `edgesReconnectable` prop in `@xyflow/svelte` 1.7.0 — edge reconnection is opt-in via `<EdgeReconnectAnchor>`, which this app never renders.
- **`useSvelteFlow()` must be called inside a child of `<SvelteFlow>`** — calling it at page-level script scope crashes the app to a blank page. It lives in `FlowController.svelte`.
- **`setContext` must be called synchronously at component init** — calling it inside `onMount` or inside a `.then()` callback means child components have already called `getContext` and received `undefined`. Always declare the `$state` holder and call `setContext` at the top level of the `<script>` block.
- **elkjs browser build**: import `elkjs/lib/elk.bundled.js` directly rather than the bare `elkjs` package entry. The default entry conditionally `require('web-worker')` in Node environments; in the browser this bare specifier is never resolved, producing a runtime "Failed to resolve module specifier \"web-worker\"" error. The bundled entry has no such dependency and requires no `vite.config.ts` workarounds.
- **`labelBgStyle`** is not a valid property on the `@xyflow/svelte` `Edge` type — do not use it.
- **`Map` mutations are not reactive in Svelte 5**: `fileCtx.map.set(...)` alone does not trigger reactivity. After any `.set()` or `.delete()` call, reassign: `fileCtx.map = new Map(fileCtx.map)` to notify Svelte of the change.
- **Workspace file identity**: on the upload path `assignWorkspaceFileIds` maps each class's artefact `from_schema` provenance to the workspace file (falling back to the active file); on the bundled path `+page.svelte` stamps `assignFileIds(artifactSchema, wf.id)`. `fileId` is a workspace-identity projection, not LinkML meaning.
- **The Vite `/reconcile` middleware is an execution boundary, not a second producer**: it only writes the uploaded workspace to a temp dir and calls `produce.py --reconcile`; it must never parse LinkML itself. If the endpoint is unreachable the client surfaces an error and never falls back to in-browser reasoning.
- **LSP stale errors**: LSP may show stale type errors in `.svelte` files (e.g. `LayoutOptions` not found, `buildGraph` wrong arg count, `GroupInfo` not exported). These are false positives — `bun run check` (svelte-check) is the ground truth.

---

## Svelte 5 + SvelteKit coding conventions

> Source: https://cursor.directory/svelte5-sveltekit-development-guide

### Key principles

- Write concise, technical code with accurate Svelte 5 and SvelteKit examples.
- Leverage SvelteKit's SSR and SSG capabilities (this project uses SSG/static).
- Prioritize performance and minimal client-side JavaScript.
- Use descriptive variable names and follow Svelte/SvelteKit conventions.
- Organize files using SvelteKit's file-based routing system.

### Code style

- Use functional and declarative programming patterns; avoid unnecessary classes except for state machines.
- Prefer iteration and modularization over code duplication.
- Structure files: component logic, markup, styles, helpers, types.

### Naming conventions

- Lowercase with hyphens for component files (e.g. `auth-form.svelte`).
- PascalCase for component names in imports and usage.
- camelCase for variables, functions, and props.

### TypeScript

- Use TypeScript for all code; prefer `interface` over `type`.
- Avoid enums; use `const` objects instead.
- Enable strict mode (already configured in `tsconfig.json`).

### Svelte 5 runes

```typescript
// Reactive state
let count = $state(0);

// Derived values
let doubled = $derived(count * 2);

// Side effects
$effect(() => {
  console.log(`Count is now ${count}`);
});

// Component props
let { optionalProp = 42, requiredProp } = $props();

// Two-way bindable props
let { bindableProp = $bindable() } = $props();

// Debug (development only)
$inspect(count);
```

Use `$state.raw` for large arrays (e.g. `nodes`, `edges`) to avoid deep-reactivity overhead.

### State machines (complex state)

Use `.svelte.ts` files and classes for complex state:

```typescript
// counter.svelte.ts
class Counter {
  count = $state(0);
  increment() { this.count += 1; }
}
export const counter = new Counter();
```

### Performance

- Use `$state.raw` for large arrays where deep reactivity isn't needed.
- Use `{#key}` blocks to force re-rendering when required.
- Use dynamic imports for code splitting in large apps.
- Use `$effect.tracking()` to optimise effect dependencies.
- Minimise client-side JS; prefer SSR/SSG where possible.

### Project structure

```
src/
  lib/          # shared utilities, components, types
  routes/       # file-based routing (+page.svelte, +layout.svelte, etc.)
  app.html
static/
svelte.config.js
vite.config.ts
```

### Component guidelines

- Create `.svelte` files for components; `.svelte.ts` for logic/state machines.
- Use Svelte's `$props` rune for data passing.
- Use reactive declarations for local state management.

### Routing and data loading

- Use `[slug]` syntax for dynamic routes.
- Use `load` functions for server-side or prerendered data fetching.
- Handle errors with `+error.svelte` pages.

### Accessibility

- Use proper semantic HTML structure.
- Add ARIA attributes where necessary.
- Ensure keyboard navigation for all interactive elements.
- Use `bind:this` to manage focus programmatically.

### Key conventions

1. Embrace Svelte's simplicity — avoid over-engineering.
2. Prioritize Web Vitals (LCP, FID, CLS).
3. Use environment variables for configuration.
4. Keep Svelte and SvelteKit versions up to date.

### Reference documentation

- Svelte 5 runes: https://svelte.dev/docs/svelte/what-are-runes
- Svelte docs: https://svelte.dev/docs
- SvelteKit docs: https://svelte.dev/docs/kit

---

## Miscellaneous rules

- Use https://linkml.io/linkml/developers/tool-developer-guide.html for LinkML tool development guidelines.