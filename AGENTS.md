# AGENTS.md — linkml-viewer

Summary of the project architecture and key design decisions for AI coding agents working on this codebase.

---

## What this is

An interactive **Entity Relationship Diagram (ERD) viewer** built with SvelteKit and Svelte Flow. It parses any [LinkML](https://linkml.io) schema (YAML or JSON) and renders the classes as a pannable, zoomable canvas of table nodes connected by foreign-key edges. Each table is rendered as a **subflow container** (`tableParent` node) with individual columns as child `column` nodes inside it. The default schema is the OMOP CDM v5.4 (fully merged LinkML YAML).

There is no backend. Everything runs in the browser as a static SPA.

The project ships two deployment targets from the same SvelteKit frontend:

- **Web / GitHub Pages** — static SPA built with `@sveltejs/adapter-static`, deployed via `.github/workflows/deploy.yml`.
- **Desktop (Tauri v2)** — the same static build is wrapped in a native window using [Tauri v2](https://tauri.app). The Tauri shell lives in `src-tauri/` and adds no extra Rust logic beyond the standard app harness. Supports macOS (`.app` / `.dmg`), Windows (`.exe` / `.msi`), and Linux (`.deb` / `.AppImage`).

---

## Running the project

```bash
just                    # start web dev server (npm run dev) at http://localhost:5173
just dev-tauri          # start Tauri desktop dev (wraps Vite dev in a native window)
pnpm run build           # production web build → build/
pnpm run check           # svelte-check type checking
```

### Desktop builds

```bash
just build-tauri                # build for the current platform
just build-macos-silicon        # macOS Apple Silicon .app + .dmg (requires: brew install create-dmg)
# Output: src-tauri/target/<target-triple>/release/bundle/
```

Tauri v2 CLI is invoked via `npm run tauri:dev` / `npm run tauri:build` (see `package.json`). The `beforeBuildCommand` in `tauri.conf.json` runs `npm run build` automatically before bundling.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | SvelteKit 2 + Svelte 5 (runes syntax) |
| Canvas | `@xyflow/svelte` v1.5.x (Svelte Flow) |
| Layout engines | `@dagrejs/dagre` v2 (sync) + `elkjs` (async, ELK layered) |
| YAML parsing | `js-yaml` v4 |
| Code editor | CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/lang-yaml`, `@codemirror/theme-one-dark`, `@codemirror/commands`) |
| Language | TypeScript 5, strict mode |
| Build tool | Vite 7 |
| Adapter | `@sveltejs/adapter-static` (static SPA, GitHub Pages) |
| Desktop shell | Tauri v2 (`src-tauri/`) — wraps the static build in a native window |

---

## Directory layout

```
linkml-viewer/
├── .github/workflows/deploy.yml  # deploy to GitHub Pages on push to main
├── justfile                      # default recipe: npm run dev; also Tauri build recipes
├── svelte.config.js              # adapter-static, base: /linkml-viewer in prod
├── vite.config.ts                # sveltekit() plugin + chunk size warning limit
├── src-tauri/                    # Tauri v2 desktop shell
│   ├── tauri.conf.json           # app metadata, window config, bundle targets
│   ├── Cargo.toml                # Rust crate (tauri + tauri-plugin-opener)
│   ├── src/
│   │   ├── main.rs               # binary entry point
│   │   └── lib.rs                # tauri::Builder::default().run(...)
│   ├── icons/                    # platform icons (.png, .icns, .ico)
│   └── capabilities/             # Tauri v2 capability definitions
├── static/
│   ├── omop_cdm.yaml             # default schema (OMOP CDM v5.4, fully merged, 13 879 lines)
│   ├── sein.yaml                 # SEIN merged schema (13 HiX staging + 17 OMOP classes, 30 total)
│   ├── hix.yaml                  # HiX staging classes only (13 classes, raw LinkML)
│   ├── sein-omop.yaml            # OMOP CDM subset used by SEIN (17 classes, raw LinkML)
│   ├── group-config.yaml         # group name → color/label config (loaded at runtime)
│   └── logo.png                  # favicon
└── src/
    ├── routes/
    │   ├── +layout.ts            # prerender=true, ssr=false (pure client-side SPA)
    │   ├── +layout.svelte        # Svelte Flow CSS import, favicon, global box-sizing/overflow
    │   └── +page.svelte          # main app: state, canvas wiring, top bar, layout toolbar
    └── lib/
        ├── types.ts              # all shared TypeScript interfaces (ErdClass, ErdTableNodeData, ErdColumnNodeData, FileInfo, GroupInfo, …)
        ├── linkml.ts             # schema parser (YAML + JSON), loadDefaultSchema(), loadGroupConfig(), assignFileIds()
        ├── layout.ts             # async buildGraph(schema, collapsed, LayoutOptions) — dagre + elk; subflow node builder
        └── components/
            ├── ColumnNode.svelte      # custom node: column row rendered inside a tableParent subflow
            ├── CustomControls.svelte  # bottom-left controls: zoom/fit/lock + layout buttons (2×4 grid)
            ├── FileList.svelte        # left sidebar: workspace file list with import badges + context menu
            ├── FlowController.svelte  # useSvelteFlow() context — pan/highlight/fitView (column-aware)
            ├── GroupEditor.svelte     # right panel: group color-picker form (live updates)
            ├── GroupLegend.svelte     # left sidebar: group color swatches + slot icon key
            ├── SchemaEditor.svelte    # right panel: CodeMirror 6 YAML editor (500ms debounce)
            ├── SchemaUploader.svelte  # top-bar button + drag-and-drop file picker
            ├── SearchBar.svelte       # top-bar search with keyboard nav and canvas pan (table + column results)
            └── TableParentNode.svelte # custom node: collapsible table header (subflow container) with group color
```

---

## Data flow

```
static/omop_cdm.yaml  ──fetch──▶  parseLinkMLSchema()  ──▶  NormalizedSchema
uploaded file         ──upload──▶  parseLinkMLSchema()  ──▶  NormalizedSchema
YAML editor (live)    ──debounce─▶  parseLinkMLSchema()  ──▶  NormalizedSchema
                                                               │
                                                        assignFileIds(schema, fileId)
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

1. On mount, `+page.svelte` fetches `omop_cdm.yaml` raw text, stores it in `schemaYamlText`, and calls `parseLinkMLSchema()`.
2. The result is passed through `assignFileIds()` to stamp each class with its source file ID.
3. The `NormalizedSchema` is stored in `$state`.
4. A `$effect` calls `buildGraph()` whenever `schema` or `collapsed` changes, writing new `Node[]` / `Edge[]` into `$state.raw`.
5. Svelte Flow re-renders reactively.
6. In parallel on mount, `loadGroupConfig()` fetches `group-config.yaml` and populates `groupCtx.map`.
7. `TableParentNode` and `GroupLegend` read `groupCtx` from Svelte context reactively.
8. `fileCtx.map` is populated synchronously when files are uploaded; `TableParentNode` derives a stripe color from it.

---

## Schema parsing (`src/lib/linkml.ts`)

`parseLinkMLSchema(input)` accepts a string (YAML or JSON) or a pre-parsed object and returns a `NormalizedSchema`.

Two raw LinkML input styles are supported:

### Path A — `attributes:` (inline, per class)

Used by schemas like `omop_cdm.yaml` (the non-merged source):

```yaml
classes:
  Person:
    attributes:
      person_id:
        identifier: true
        required: true
      gender_concept_id:
        range: Concept
```

Each key under `attributes:` becomes an `ErdSlot`. Display name is `alias` → `name` → key.

### Path B — `slots:` list + top-level `slots:` dict + `slot_usage:` overrides

Used by the default `omop_cdm.yaml` (the fully merged `_omop_cdm.yaml`):

```yaml
slots:
  person_id:
    range: integer
    identifier: true
classes:
  person:
    slots:
      - person_id
    slot_usage:
      person_id:
        required: true
```

Merge order: `slot_usage` overrides top-level `slots`. Display name strips the `className_` prefix if present (e.g. `person_person_id` → `person_id`).

Both paths are checked per class; a class may only use one style (both cannot coexist on the same class).

### FK detection

A slot is classified as a foreign key (`is_fk: true`) when all three hold:
- `range` names a class that exists in the schema
- `identifier` is not `true`
- `range` is not in the built-in `PRIMITIVE_RANGES` set

Cross-schema FK targets (range names a class not present in the file) are silently skipped — no ghost nodes.

### Group annotations

Classes may carry a `group` annotation:

```yaml
classes:
  person:
    annotations:
      group:
        tag: group
        value: clinical
```

`parseRawLinkML()` reads `classDef.annotations?.group?.value` and stores it as `ErdClass.group`. The value must match a `name` key in `group-config.yaml` to receive a color; unknown group values fall back to the `default` entry.

### exact_mappings (ETL mappings)

Slots may carry `exact_mappings` listing cross-schema column references:

```yaml
attributes:
  gender:
    exact_mappings:
      - omop_cdm54:Person.gender_source_value
```

The parser reads this into `ErdSlot.exact_mappings: string[]` for both Path A and Path B. `TableParentNode` / `ColumnNode` renders the first entry as an indigo italic badge (prefix stripped), with the full list on hover.

### Normalized JSON (legacy)

If the parsed object is already in the normalized `NormalizedSchema` shape (produced by the Python `SchemaView` export script in `omop-link`), it is passed through as-is without re-parsing.

**Important**: raw LinkML YAML also has a top-level `classes` object, so a simple presence check is not sufficient to distinguish the two formats. `isNormalizedJson()` scans all class entries looking for a discriminating signal:

- If any class has a `slot_usage` key → raw LinkML, route to `parseRawLinkML()`
- If any class has `slots` as a non-empty string array → raw LinkML (slot reference names), route to `parseRawLinkML()`
- If any class has `slots` as a non-empty object array → normalized JSON, pass through
- Classes with empty/absent `slots` carry no signal and are skipped
- If no signal is found across all classes (all slot-less) → conservatively treat as raw LinkML

Scanning all classes (not just the first) avoids misidentification when the first class happens to have no slots.

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

---

## Auto-layout (`src/lib/layout.ts`)

`buildGraph(schema, collapsed, layoutOptions)` produces `Node[]` and `Edge[]` for Svelte Flow. It is **async** to support the ELK engine.

### Visualization model

Each class is represented as a **subflow**: a `tableParent` node (container) with individual `column` child nodes stacked inside it. Svelte Flow requires parent nodes to appear before their children in the `nodes` array.

- **`tableParent` nodes** — rendered by `TableParentNode.svelte`. Hold the group-colored header and collapse toggle. No Handles; handles are on the column children.
- **`column` nodes** — rendered by `ColumnNode.svelte`. Positioned at `{ x: 0, y: HEADER_HEIGHT + index * ROW_HEIGHT }` relative to their parent. Each has `parentId` and `extent: 'parent'` set. Carry source and target Handles for edges.
- When a table is **collapsed**, its column nodes are omitted from the array entirely. Edges then connect to the `tableParent` node ID directly (see `resolvePkNodeId`).

### Node ID conventions

Column node IDs use the format `"ClassName\x00slotName"` (null-byte separator, see `COL_ID_SEP`). The null byte cannot appear in LinkML identifiers (XML NCName rules), so it is unambiguous. A helper `colId(className, slotName)` constructs these IDs.

`resolvePkNodeId(className, schema, collapsed)` resolves the correct target node ID for an edge pointing at a class:
- Collapsed table → returns the table ID (parent node)
- Expanded table with a PK slot → returns `colId(className, pkSlot.name)`
- Expanded table with no PK → returns `colId(className, firstSlot.name)` as a fallback

### Layout engines

Two engines are supported, selected via `LayoutOptions`:

- **dagre** (`engine: 'dagre'`): synchronous, uses `@dagrejs/dagre` v2. Direction is `LR` or `TB` via `rankdir`.
- **ELK** (`engine: 'elk'`): async, uses `elkjs` with the `org.eclipse.elk.layered` algorithm. Direction controlled via `elk.direction` (`RIGHT` or `DOWN`).

Both engines run layout at the **table level only** (83 nodes for OMOP CDM). Column positions are computed locally after layout as fixed offsets within each parent.

### Node sizing

Parent node heights are estimated from slot count: `header (36px) + rows × 24px + 4px padding + 4px border`, capped at the actual slot count (no visual cap — all rows are rendered as column nodes). Collapsed nodes use only the header height (36px).

### Edges

Two kinds of edges are produced, discriminated by the `kind` field on `ErdEdgeData`:

- **FK edges** (`kind: 'fk'`): inferred from `range:` fields that resolve to another class in the schema. Connect source column node → target PK column node (or table node if collapsed). Color: `#475569` (slate-600), solid. Required edges get `stroke-width: 2`; optional get `1.5`.
- **ETL edges** (`kind: 'etl'`): inferred from `exact_mappings` CURIEs on slots. Color: `#6366f1` (indigo-500), dashed (`stroke-dasharray: 5,3`), `stroke-width: 1.5`, with an indigo label.

All edges have `zIndex: 1` so they render above the parent subflow nodes (required for cross-subflow edges in Svelte Flow).

ETL edge extraction is done by `collectEtlEdges(schema)` in `layout.ts`:
- Parses CURIEs like `omop_cdm54:VisitOccurrence.visit_occurrence_id`
- Extracts target class: `colonIdx = mapping.lastIndexOf(':')`, `dotIdx = mapping.indexOf('.', colonIdx)`, `targetClass = mapping.slice(colonIdx + 1, dotIdx)`
- Silently skips targets not present in the schema (cross-schema references)

Internal union types `FkEdge`, `EtlEdge`, `AnyEdge` carry a `kind` discriminant. `buildSvelteEdges(allEdges: AnyEdge[])` converts them to Svelte Flow `Edge` objects with the appropriate styles. Both `buildGraphDagre` and `buildGraphElk` merge FK and ETL edges before layout so the layout engine accounts for all connections.

Edge IDs are `source--slotName--target` for FK edges, with a counter suffix for duplicates. Isolated nodes (no layout position) are skipped silently.

The `group` field from `ErdClass` is propagated into `ErdTableNodeData` by both the Dagre and ELK build paths so that `TableParentNode` and `GroupLegend` can access it without querying the schema separately. The `fileId` field is propagated the same way.

---

## Custom nodes

### `TableParentNode` (`src/lib/components/TableParentNode.svelte`)

The subflow container rendered for each class. It holds only the colored header row; column rows live in separate `ColumnNode` children.

- Renders as a 260px-wide card with a **group-colored header** (falls back to slate-600 for unannotated classes).
- Header color and text color are `$derived` from `groupCtx.map` read via `getContext('groupConfig')`. Updates reactively once the group config fetch resolves.
- **File stripe**: in multi-file workspaces (`fileCtx.map.size > 1`), a 6px colored left stripe is rendered inside the header button via `position: absolute; left: 0; top: 0; bottom: 0; width: 6px`. The color comes from `fileCtx.map` (keyed by `ErdTableNodeData.fileId`). When only one file is loaded the stripe is hidden. Header `padding-left` is `16px` when a stripe is shown, `10px` otherwise.
- Displays the table name and a slot count badge (e.g. `42 cols`) in the header.
- Click the header to toggle collapse. The component calls `collapseCtx.toggle(id)` injected via `getContext('collapseToggle')`. This updates the `collapsed` `Set` in `+page.svelte`, which triggers a graph rebuild.
- Highlighted nodes (panned-to from search) show a brief amber glow for 1.5s via the `highlighted` flag on `ErdTableNodeData`.
- Svelte Flow v1 requires `Node<Data>` where `Data extends Record<string, unknown>`. Since `ErdTableNodeData` is not directly assignable to `Record<string, unknown>` under strict mode, `data` is cast via `as unknown as ErdTableNodeData`. In `TableParentNode.svelte`, the prop is re-derived reactively with `$derived(data as unknown as ErdTableNodeData)` to avoid the `state_referenced_locally` Svelte 5 lint warning.

### `ColumnNode` (`src/lib/components/ColumnNode.svelte`)

Each slot in a table is rendered as a separate `column` child node positioned inside its `tableParent` container.

- Carries both a **source** Handle (right) and a **target** Handle (left) — FK and ETL edges connect at the column level when tables are expanded.
- Each row shows:
  - A badge: `PK` (amber) for identifiers, `FK` (slate) for foreign keys, blank for plain slots
  - The display name (bold if required, via CSS class `required`)
  - The range type in italic gray
  - An **indigo italic ETL mapping badge** showing `exact_mappings[0]` with the prefix stripped (e.g. `omop_cdm54:Person.person_source_value` → `Person.person_source_value`). The full list of mappings appears as a tooltip on hover.
- Node data is typed as `ErdColumnNodeData`; cast via `as unknown as ErdColumnNodeData` for Svelte Flow compatibility.
- When the parent table is collapsed, these nodes are absent from the `nodes` array entirely (not hidden). Edges fall back to connecting at the `tableParent` node level.

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
- Uses `useStore()` directly to toggle the lock state (`store.nodesDraggable`, `store.nodesConnectable`, `store.elementsSelectable`).
- 2-column CSS grid layout: Row 1: zoom+/zoom−, Row 2: fit view/lock toggle, Rows 3–4: D→/D↓/E→/E↓ layout buttons.
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
- 500ms debounce on `EditorView.updateListener`; calls `parseLinkMLSchema()` on each debounced keystroke.
- On parse error: shows a red error bar with the message; does **not** call `onchange` (canvas unchanged).
- On valid parse: fires `onchange(text, parsedSchema)`.
- A `$effect` syncs editor content when the `yamlText` prop changes externally (e.g. new schema loaded via file upload).
- Editor is destroyed in `onDestroy`.

Props:
- `yamlText: string` — current YAML content (controlled from parent)
- `onchange: (text: string, schema: NormalizedSchema) => void` — called on each valid parse
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
| `$state` | `schema` | Current `NormalizedSchema` (null while loading) |
| `$state` | `loadError` | Error message string |
| `$state` | `collapsed` | `Set<string>` of collapsed node IDs |
| `$state` | `layoutOptions` | Active `LayoutOptions` (engine + direction) |
| `$state` | `fitViewTrigger` | Counter incremented after layout to trigger `fitView` |
| `$state` | `groupCtx` | `{ map: Map<string, GroupInfo> \| null }` — reactive wrapper set as context |
| `$state` | `fileCtx` | `{ map: Map<string, string> }` — file ID → hex color map, set as `'fileConfig'` context |
| `$state` | `collapseCtx` | `{ toggle: (id: string) => void }` — collapse callback set as `'collapseToggle'` context; `TableParentNode` calls this to update `collapsed` |
| `$state` | `schemaEditorOpen` | Boolean — controls Schema editor panel visibility |
| `$state` | `groupEditorOpen` | Boolean — controls Group editor panel visibility |
| `$state` | `schemaYamlText` | Raw YAML string for the Schema editor (kept in sync with loaded schema) |
| `$state.raw` | `nodes` | `Node[]` — raw avoids deep reactivity overhead |
| `$state.raw` | `edges` | `Edge[]` — raw avoids deep reactivity overhead |
| `$effect` | — | Rebuilds `nodes`/`edges` (async IIFE with cancellation flag) when `schema`, `collapsed`, or `layoutOptions` changes |
| `$derived` | `classCount`, `schemaName` | Computed display values |
| `$derived` | `tableCount` | Count of nodes where `n.type === 'tableParent'` (excludes `column` child nodes) |
| `$derived` | `activeGroupNames` | Unique group strings present in current `tableParent` nodes |
| `$derived` | `hasGroups` | `true` when `activeGroupNames.length > 0` — gates `GroupLegend` visibility |
| `$derived` | `groupList` | `GroupInfo[]` array derived from `groupCtx.map` — passed to `GroupEditor` |
| `$derived` | `activeFileIds` | Unique `fileId` strings present in current `tableParent` nodes |
| `$derived` | `fileInfoList` | `FileInfo[]` array for `GroupLegend` — maps active file IDs to label + color |

`$state.raw` is used for `nodes` and `edges` per the [Svelte Flow performance recommendation](https://github.com/sveltejs/svelte/issues/11851) — deep reactivity on large node arrays causes noticeable lag.

---

## Build configuration

- **`svelte.config.js`**: uses `adapter-static` with `fallback: '404.html'` for client-side routing on GitHub Pages. The `base` path is `/linkml-viewer` in production (`NODE_ENV=production`) and empty in development.
- **`src/routes/+layout.ts`**: sets `prerender = true` and `ssr = false`, making the entire app a client-side SPA with statically prerendered HTML shells.
- **`vite.config.ts`**: `sveltekit()` plugin plus `build.chunkSizeWarningLimit: 1600` to silence the bundle-size warning from the ~1.4 MB `elk.bundled.js` chunk.

---

## Known pitfalls

- **`useSvelteFlow()` must be called inside a child of `<SvelteFlow>`** — calling it at page-level script scope crashes the app to a blank page. It lives in `FlowController.svelte`.
- **`setContext` must be called synchronously at component init** — calling it inside `onMount` or inside a `.then()` callback means child components have already called `getContext` and received `undefined`. Always declare the `$state` holder and call `setContext` at the top level of the `<script>` block.
- **elkjs browser build**: import `elkjs/lib/elk.bundled.js` directly rather than the bare `elkjs` package entry. The default entry conditionally `require('web-worker')` in Node environments; in the browser this bare specifier is never resolved, producing a runtime "Failed to resolve module specifier \"web-worker\"" error. The bundled entry has no such dependency and requires no `vite.config.ts` workarounds.
- **`labelBgStyle`** is not a valid property on the `@xyflow/svelte` `Edge` type — do not use it.
- **`Map` mutations are not reactive in Svelte 5**: `fileCtx.map.set(...)` alone does not trigger reactivity. After any `.set()` or `.delete()` call, reassign: `fileCtx.map = new Map(fileCtx.map)` to notify Svelte of the change.
- **`assignFileIds` must be called per imported file before merging**: `resolveImports()` stamps each imported file's classes with their own `fileId` before `Object.assign`-merging them into the active schema. Stamping after the merge would overwrite all classes with the active file's ID.
- **Parent nodes must precede children in the `nodes` array**: Svelte Flow requires that `tableParent` nodes appear before their `column` children. `buildGraphDagre` and `buildGraphElk` both collect `tableNodes` and `columnNodes` separately and concatenate them as `[...tableNodes, ...columnNodes]`.
- **Collapsed tables must not have column child nodes**: edges targeting a collapsed table fall back to the table node ID. If column nodes were still present but invisible, their dangling handles would cause edge routing errors. `buildColumnNodes` returns `[]` immediately when `collapsed.has(className)`.
- **Cross-subflow edges require `zIndex: 1`**: by default, Svelte Flow renders edges below subflow parent nodes. All FK and ETL edges set `zIndex: 1` to ensure they are visible when connecting nodes in different subflows.
- **Column node absolute positions**: `FlowController` reads `node.internals.positionAbsolute` (an internal Svelte Flow field) for accurate pan-to coordinates on column nodes, since their `position` is relative to the parent. Falls back to manual parent-position addition if the internal field is absent.
- **LSP stale errors**: LSP may show stale type errors in `.svelte` files (e.g. `LayoutOptions` not found, `buildGraph` wrong arg count, `GroupInfo` not exported). These are false positives — `pnpm run build` is the ground truth.

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