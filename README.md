# linkml-viewer

A generic [LinkML](https://linkml.io/) ERD viewer built with [SvelteKit](https://svelte.dev/docs/kit) and [Svelte Flow](https://svelteflow.dev/).

Upload any LinkML schema YAML file and explore it as an interactive entity-relationship diagram. Nodes are collapsible table cards; edges are foreign-key relationships inferred from `range:` fields that resolve to other classes in the schema.

Defaults to the fully merged [OMOP CDM](https://ohdsi.github.io/CommonDataModel/) v5.4 schema. Also includes the **SEIN** schema — a merged HiX staging + OMOP CDM subset with slot-level ETL mappings.

The app ships as both a **web SPA** (hosted on GitHub Pages) and a **native desktop app** built with [Tauri v2](https://tauri.app).

## Web usage

```sh
npm install
npm run dev        # or: just
```

Open http://localhost:5173

To build for production:

```sh
npm run build
npm run preview
```

## Desktop (Tauri v2)

The same SvelteKit frontend is wrapped in a native window via Tauri v2. Supports macOS, Windows, and Linux.

### Development

```sh
just dev-tauri     # or: npm run tauri:dev
```

Starts the Vite dev server and opens the app in a native window.

### Building

```sh
just build-tauri              # build for the current platform
just build-macos-silicon      # macOS Apple Silicon .app + .dmg
                              # prerequisite: brew install create-dmg
```

Output artifacts are placed in `src-tauri/target/<target-triple>/release/bundle/`.

> The `beforeBuildCommand` in `src-tauri/tauri.conf.json` runs `npm run build` automatically, so the SvelteKit build is always in sync with the Tauri bundle.

### Tauri shell

`src-tauri/` contains the minimal Rust harness — no custom Rust logic beyond the standard Tauri app setup:

```
src-tauri/
├── tauri.conf.json   # app metadata, window size (1400×900), bundle targets
├── Cargo.toml        # tauri v2 + tauri-plugin-opener
├── src/
│   ├── main.rs       # binary entry point
│   └── lib.rs        # tauri::Builder::default().run(...)
├── icons/            # platform icons (.png, .icns, .ico)
└── capabilities/     # Tauri v2 capability definitions
```

## Features

- Drag-and-drop upload of any `.yaml` / `.yml` LinkML schema
- **In-browser Schema YAML editor** — live CodeMirror 6 editor with syntax highlighting; edits are applied to the canvas with a 500ms debounce
- **In-browser Domain color editor** — edit domain labels and colors live without touching any files
- Auto-layout via [Dagre](https://github.com/dagrejs/dagre) or [ELK](https://eclipse.dev/elk/) (layered algorithm), switchable at runtime
- Left-side **domain legend** sidebar — shown automatically when the schema has domain-annotated classes; lists color swatches, slot row icon key, and edge type legend
- **Domain-colored node headers** — each class's header is colored by its domain annotation (configured in `static/domain-config.yaml`)
- **ETL mapping badges** — slots with `exact_mappings` show the target column as an indigo italic badge, with the full mapping list on hover
- **ETL edges** — dashed indigo arrows drawn between classes connected via `exact_mappings` (e.g. HiX → OMOP)
- Collapsible table nodes (click the header)
- Top-bar search with keyboard navigation and canvas pan-to-node
- MiniMap with domain-aware node coloring
- Supports both LinkML slot styles:
  - `attributes:` (inline per class)
  - `slots:` list + top-level `slots:` dict + `slot_usage:` overrides

## Domains

Classes in a LinkML schema can carry a `domain` annotation. When present, the node header is colored according to the domain's entry in `static/domain-config.yaml`, and the **domain legend** sidebar appears automatically.

### Annotating a class

Use the **compact annotation form** (a plain scalar value):

```yaml
classes:
  Person:
    annotations:
      domain: clinical
    attributes:
      person_id:
        identifier: true
```

The LinkML metamodel also allows an expanded `{tag, value}` form, but the compact form is preferred and is what the included schemas (`sein.yaml`, `hix.yaml`) use:

```yaml
# expanded form — verbose, avoid
annotations:
  domain:
    tag: domain
    value: clinical
```

The parser accepts both forms.

### Configuring domain colors

Edit `static/domain-config.yaml` to add or change domains — no TypeScript changes required:

```yaml
domains:
  - name: clinical
    label: Clinical
    color: "#2563eb"
    text_color: "#ffffff"
  - name: hix
    label: HiX Source
    color: "#f59e0b"
    text_color: "#ffffff"
  - name: default
    label: Other
    color: "#475569"
    text_color: "#ffffff"
```

The `default` entry is the fallback color for classes whose domain value does not match any named entry. It is not shown in the legend swatch list.

### Built-in domains (SEIN / OMOP)

| Domain | Color | Classes |
|---|---|---|
| `clinical` | blue `#2563eb` | Person, VisitOccurrence, ConditionOccurrence, DrugExposure, Note, … |
| `vocabulary` | violet `#7c3aed` | Concept, Vocabulary, Relationship, … |
| `infrastructure` | emerald `#059669` | Location, CdmSource |
| `era` | amber `#d97706` | DrugEra, ConditionEra, … |
| `episode` | red `#dc2626` | Episode, EpisodeEvent |
| `hix` | yellow `#f59e0b` | HiX staging tables (Patients, Admissions, …) |

## ETL mappings

Slots can declare `exact_mappings` to record cross-schema column mappings (e.g. from a HiX staging column to an OMOP CDM column):

```yaml
attributes:
  patient_number:
    exact_mappings:
      - omop_cdm54:Person.person_source_value
```

The first mapping is shown as an indigo italic badge in the slot row (prefix stripped). Hover over it to see all mappings.

When both source and target classes are present in the schema, a **dashed indigo ETL edge** is drawn between them on the canvas.

## In-browser editors

Two slide-in panels are accessible from the top bar:

- **`</> Schema`** — opens a CodeMirror 6 YAML editor pre-loaded with the current schema. Edits are parsed live (500ms debounce) and applied to the canvas. Parse errors are shown in a red bar; the canvas is not updated until the YAML is valid.
- **`◎ Domains`** — opens a domain color-picker form. Each row has a name, label, background color, and text color. Changes are applied to all node headers and the legend immediately.

## Included schemas

| File | Description |
|---|---|
| `static/omop_cdm.yaml` | OMOP CDM v5.4 — fully merged, 13 879 lines, default schema |
| `static/sein.yaml` | SEIN — 13 HiX staging + 17 OMOP classes, with `exact_mappings` and domain annotations |
| `static/hix.yaml` | HiX staging classes only (13 classes) |
| `static/sein-omop.yaml` | OMOP CDM subset used by SEIN (17 classes) |

## Project structure

```
src-tauri/                    # Tauri v2 desktop shell
src/
  lib/
    types.ts              # ErdSlot, ErdClass, NormalizedSchema, ErdNodeData, DomainInfo
    linkml.ts             # YAML parser, loadDefaultSchema(), loadDomainConfig()
    layout.ts             # buildGraph(schema, collapsed, layoutOptions) → nodes/edges
    components/
      CustomControls.svelte  # zoom/fit/lock + layout buttons (replaces built-in Controls)
      DomainEditor.svelte    # right panel: domain color-picker form
      DomainLegend.svelte    # left sidebar: domain swatches + slot icon key + edge legend
      SchemaEditor.svelte    # right panel: CodeMirror 6 YAML editor
      TableNode.svelte       # custom node: domain-colored header, exact_mappings badge
      SchemaUploader.svelte
      SearchBar.svelte
      FlowController.svelte
  routes/
    +layout.ts            # prerender=true, ssr=false
    +layout.svelte
    +page.svelte
static/
  omop_cdm.yaml
  sein.yaml
  hix.yaml
  sein-omop.yaml
  domain-config.yaml      # domain → color/label mapping (edit to add domains)
```

See [AGENTS.md](./AGENTS.md) for architecture notes and design decisions.
