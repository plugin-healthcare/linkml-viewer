/**
 * C1 layout benchmark — reconciled graph, native engines (R2.2 expanded).
 *
 * Invoked by `bun run bench:layout` (see package.json). This is a native
 * pipeline script: it consumes the SAME reconciled artefacts the viewer uses
 * (`static/reconciled/<fixture>.json`, the produce.py / Vite-plugin output) and
 * routes them through the PRODUCTION materialisation and engines by importing
 * `src/lib/linkml.ts` (projectReconciledArtifact) and `src/lib/layout.ts`
 * (buildGraph) — no re-implementation of Dagre/ELK, no new semantic layer.
 *
 * Architectural boundary (hard rule): the benchmark may measure topology and
 * geometry because it already receives the frozen reconciled graph:
 *
 *   reconciled graph -> layout engine -> positions -> geometric measurements  ALLOWED
 *   reconciled graph -> NEW viewer-specific semantic interpretation -> layout FORBIDDEN
 *
 * Every number below is a function of engine-returned positions, node/edge
 * structure, or a viewer-owned geometric formula. Nothing re-derives LinkML
 * meaning. No composite score / ranking is produced: this is per-candidate
 * evidence that exposes trade-offs (the C1 no-leaderboard methodology).
 *
 * Module loading uses Vite's native SSR module runner. That is required for
 * exactly one reason: `src/lib/linkml.ts` imports SvelteKit's virtual
 * `$app/paths`, which only Vite can resolve. The driver supplies a stub for it
 * (linkml.ts only reads `base`). Everything else — node geometry, edge
 * materialisation, engine invocation — comes from the production modules.
 *
 * The ELK bundle detects a bundled fake worker via `typeof self`. Bun defines a
 * global `self`, which makes the bundle take the "main thread message handler"
 * branch and export no Worker. Removing `self` restores the Node/bundled-worker
 * path used by the production `elkjs/lib/elk.bundled.js` import.
 *
 * Output: a single canonical JSON document on stdout. Running it twice yields
 * byte-identical output; the document also carries an in-process digest proof.
 * The four-direction handle-orientation regression contract is asserted here
 * (exit code 1 on violation) rather than in the browser suite.
 */

// --- must precede the first ELK layout call (bundled fake-worker detection) ---
delete (globalThis as unknown as { self?: unknown }).self;

import { createServer, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Frozen experiment parameters
// ---------------------------------------------------------------------------

const REPO_ROOT = import.meta.dir ?? process.cwd();
const RECONCILED_DIR = join(REPO_ROOT, 'static', 'reconciled');

interface Candidate {
	name: string;
	engine: 'dagre' | 'elk';
	direction: 'LR' | 'TB';
}

const CANDIDATES: Candidate[] = [
	{ name: 'dagre-LR', engine: 'dagre', direction: 'LR' },
	{ name: 'dagre-TB', engine: 'dagre', direction: 'TB' },
	{ name: 'elk-LR', engine: 'elk', direction: 'LR' },
	{ name: 'elk-TB', engine: 'elk', direction: 'TB' }
];

const FIXTURES = [
	{ name: 'omop', role: 'primary' },
	{ name: 'sein', role: 'secondary' },
	{ name: 'synthetic_inheritance', role: 'inheritance' }
] as const;

// Documented nominal viewport assumption (REPORT ITEM). Svelte Flow's real pane
// is fluid; 1280x720 is the nominal desktop canvas used for the fit-zoom and
// LOD-visibility measurements below. Any fit-zoom/visibility figure is stated
// relative to this assumption, not to the 1600x900 Playwright window.
const NOMINAL_VIEWPORT = { width: 1280, height: 720, label: '1280x720' };

// Svelte Flow fitView defaults used by the app (FlowController calls
// fitView({ padding: 0.15 }); Svelte Flow clamps to [0.1, 2]).
const FIT = { minZoom: 0.1, maxZoom: 2, padding: 0.15 };

// Real LOD thresholds (src/lib/components/FlowController.svelte):
//   LOD0  zoom < 0.5
//   LOD1  0.5 <= zoom < 0.85
//   LOD2  zoom >= 0.85
const LOD = { lower: 0.5, upper: 0.85 };

const LAYER_TOLERANCE = 1.0;

// "Long-span edge" definition (REPORT ITEM): a materialised edge whose
// endpoint-to-endpoint euclidean length in engine coordinate space exceeds
// LONG_EDGE_THRESHOLD px. Chosen as 200px because it is ~2.7 table row
// heights and sits at the histogram boundary between medium and long.
const LONG_EDGE_THRESHOLD = 200; // px

// ---------------------------------------------------------------------------
// Metric unit & formula documentation
//
// Units:
//   px         — CSS pixels (engine coordinate space)
//   count      — integer number of items
//   ratio      — dimensionless (width/height)
//
// Formulas:
//   aspectRatio        = graphWidth / graphHeight
//   edgeLength         = hypot(targetAnchor - sourceAnchor)
//   edgeLength.{min,p50,p90,max} = percentile(edgeLengths)
//   longSpanEdges      = count(edgeLength > LONG_EDGE_THRESHOLD)
//   edgeHistogram      = { short: <50, medium: 50-200, long: >200 }
//   rankUtilisation    = distinct rank layers on the engine's rank axis
//   containment        = count(column rects outside their parent rect)
//   endpointValidity   = count(edges with an endpoint absent from rendered nodes)
//   selfLoops          = count(edges where sourceId === targetId)
//   fitZoom            = clamp(min(W/(gw*(1+p)), H/(gh*(1+p))), minZoom, maxZoom)
//   visible(z)         = nodes intersecting the nominal viewport at zoom z
//
// Determinism: all measurements are functions of positions/structure only.
// Repeated runs on the same engine+fixture produce identical digests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Geometry helpers (read-only over buildGraph output)
// ---------------------------------------------------------------------------

interface Rect {
	id: string;
	type: 'tableParent' | 'column';
	parentId?: string;
	x: number;
	y: number;
	w: number;
	h: number;
	sourcePosition?: string;
	targetPosition?: string;
}

interface Point {
	x: number;
	y: number;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

function stylePx(style: unknown, prop: string): number {
	if (typeof style !== 'string') return 0;
	const m = style.match(new RegExp(`${prop}:\\s*([\\d.]+)px`));
	return m ? parseFloat(m[1]) : 0;
}

function anchor(r: Rect, position: string | undefined): Point {
	switch (position) {
		case 'right':
			return { x: r.x + r.w, y: r.y + r.h / 2 };
		case 'left':
			return { x: r.x, y: r.y + r.h / 2 };
		case 'bottom':
			return { x: r.x + r.w / 2, y: r.y + r.h };
		case 'top':
			return { x: r.x + r.w / 2, y: r.y };
		default:
			return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
	}
}

function overlapArea(a: Rect, b: Rect): number {
	const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	return ox > 0 && oy > 0 ? ox * oy : 0;
}

function ccw(a: Point, b: Point, c: Point): boolean {
	return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
}

/** Proper (strict) segment intersection: shared/touching endpoints excluded. */
function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
	return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sha256(s: string): string {
	return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface BuiltNode {
	id: string;
	type?: string;
	parentId?: string;
	position: { x: number; y: number };
	style?: string;
	sourcePosition?: string;
	targetPosition?: string;
}

interface BuiltEdge {
	id: string;
	source: string;
	target: string;
	edgeKind?: 'fk' | 'etl';
	slotName?: string;
	targetClass?: string;
}

interface BuiltGraph {
	nodes: BuiltNode[];
	edges: BuiltEdge[];
}

function buildRects(nodes: BuiltNode[]): Map<string, Rect> {
	const rects = new Map<string, Rect>();
	for (const n of nodes) {
		if (n.type !== 'tableParent') continue;
		rects.set(n.id, {
			id: n.id,
			type: 'tableParent',
			x: n.position.x,
			y: n.position.y,
			w: stylePx(n.style, 'width'),
			h: stylePx(n.style, 'height'),
			sourcePosition: n.sourcePosition,
			targetPosition: n.targetPosition
		});
	}
	for (const n of nodes) {
		if (n.type !== 'column') continue;
		const parent = n.parentId ? rects.get(n.parentId) : undefined;
		if (!parent) continue;
		rects.set(n.id, {
			id: n.id,
			type: 'column',
			parentId: n.parentId,
			x: parent.x + n.position.x,
			y: parent.y + n.position.y,
			w: stylePx(n.style, 'width'),
			h: stylePx(n.style, 'height'),
			sourcePosition: n.sourcePosition,
			targetPosition: n.targetPosition
		});
	}
	return rects;
}

function inputSignature(schema: any, graph: BuiltGraph) {
	const classes = Object.keys(schema.classes ?? {}).length;
	let slots = 0;
	for (const cls of Object.values<any>(schema.classes ?? {})) slots += cls.slots.length;

	const tables = graph.nodes.filter((n) => n.type === 'tableParent');
	const columns = graph.nodes.filter((n) => n.type === 'column');
	const dims = tables
		.map((n) => `${n.id}:${stylePx(n.style, 'width')}x${stylePx(n.style, 'height')}`)
		.sort()
		.join('|');

	return {
		classes,
		slots,
		relationships: schema.relationships.length,
		tableNodes: tables.length,
		columnNodes: columns.length,
		engineEdges: graph.edges.length,
		dimensionDigest: sha256(dims)
	};
}

/**
 * Handle-orientation regression contract, derived from layout-emitted positions.
 *
 * The layout emits `sourcePosition`/`targetPosition` on both tableParent and
 * column nodes (LR -> Right/Left, TB -> Bottom/Top) and R2.1 rebuilds every
 * node on a layout change, so Svelte Flow re-measures the handles itself.
 * `useUpdateNodeInternals` is therefore unnecessary. It would only become
 * required if handle positions were ever mutated on an existing node without a
 * node rebuild (e.g. an in-place direction toggle that reused node objects).
 */
function handleOrientation(graph: BuiltGraph, direction: 'LR' | 'TB') {
	const expected =
		direction === 'LR' ? { source: 'right', target: 'left' } : { source: 'bottom', target: 'top' };

	const collect = (type: 'column' | 'tableParent') => {
		const src = new Set<string>();
		const tgt = new Set<string>();
		for (const n of graph.nodes) {
			if (n.type !== type) continue;
			if (n.sourcePosition !== undefined) src.add(n.sourcePosition);
			if (n.targetPosition !== undefined) tgt.add(n.targetPosition);
		}
		return { source: [...src].sort(), target: [...tgt].sort() };
	};

	const columns = collect('column');
	const tables = collect('tableParent');
	const ok =
		columns.source.length === 1 &&
		columns.source[0] === expected.source &&
		columns.target.length === 1 &&
		columns.target[0] === expected.target &&
		tables.source.length === 1 &&
		tables.source[0] === expected.source &&
		tables.target.length === 1 &&
		tables.target[0] === expected.target;

	return { expected, columns, tables, ok };
}

function computeMetrics(
	schema: any,
	graph: BuiltGraph,
	candidate: Candidate
) {
	const { direction, engine } = candidate;
	const rects = buildRects(graph.nodes);
	const tables = [...rects.values()].filter((r) => r.type === 'tableParent');
	const columns = [...rects.values()].filter((r) => r.type === 'column');

	const minX = Math.min(...tables.map((t) => t.x));
	const maxX = Math.max(...tables.map((t) => t.x + t.w));
	const minY = Math.min(...tables.map((t) => t.y));
	const maxY = Math.max(...tables.map((t) => t.y + t.h));
	const width = maxX - minX;
	const height = maxY - minY;

	// --- rank/layer utilisation (distinct layers along the engine rank axis) ---
	const axisCenter = (t: Rect) => (direction === 'LR' ? t.x + t.w / 2 : t.y + t.h / 2);
	const centers = tables.map(axisCenter).sort((a, b) => a - b);
	const layerDist: number[] = [];
	let current = -Infinity;
	for (const c of centers) {
		if (layerDist.length === 0 || c - current > LAYER_TOLERANCE) {
			layerDist.push(1);
			current = c;
		} else {
			layerDist[layerDist.length - 1] += 1;
		}
	}
	const rankUtilisation = {
		metric: 'distinct layers on engine rank axis (position clustering)',
		engine,
		layerCount: layerDist.length,
		maxLayerSize: layerDist.length ? Math.max(...layerDist) : 0,
		nodesPerLayer: layerDist.length ? r6(tables.length / layerDist.length) : 0,
		distribution: layerDist
	};

	// --- straight-segment edge crossings (proxy; not smoothstep truth) ---
	const segments: { a: Point; b: Point }[] = [];
	const lengths: number[] = [];
	let missingEndpoints = 0;
	for (const e of graph.edges) {
		const s = rects.get(e.source);
		const t = rects.get(e.target);
		if (!s || !t) {
			missingEndpoints += 1;
			continue;
		}
		const a = anchor(s, s.sourcePosition);
		const b = anchor(t, t.targetPosition);
		segments.push({ a, b });
		lengths.push(Math.hypot(b.x - a.x, b.y - a.y));
	}
	let crossings = 0;
	for (let i = 0; i < segments.length; i++) {
		for (let j = i + 1; j < segments.length; j++) {
			if (segmentsCross(segments[i].a, segments[i].b, segments[j].a, segments[j].b)) crossings += 1;
		}
	}

	// --- edge length distribution ---
	const sortedLengths = [...lengths].sort((a, b) => a - b);
	const histShort = lengths.filter((l) => l < 50).length;
	const histMedium = lengths.filter((l) => l >= 50 && l <= 200).length;
	const histLong = lengths.filter((l) => l > 200).length;
	const meanLength = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
	const maxLength = sortedLengths.length ? sortedLengths[sortedLengths.length - 1] : 0;
	const longSpanEdges = lengths.filter((l) => l > LONG_EDGE_THRESHOLD).length;

	// --- rectangle overlaps ---
	let tableOverlaps = 0;
	for (let i = 0; i < tables.length; i++) {
		for (let j = i + 1; j < tables.length; j++) {
			if (overlapArea(tables[i], tables[j]) > 0) tableOverlaps += 1;
		}
	}
	let columnCrossOverlaps = 0;
	for (let i = 0; i < columns.length; i++) {
		for (let j = i + 1; j < columns.length; j++) {
			if (columns[i].parentId === columns[j].parentId) continue;
			if (overlapArea(columns[i], columns[j]) > 0) columnCrossOverlaps += 1;
		}
	}

	// --- parent/child containment validity ---
	let containmentViolations = 0;
	for (const col of columns) {
		const parent = col.parentId ? rects.get(col.parentId) : undefined;
		if (!parent) continue;
		if (
			col.x < parent.x - 0.5 ||
			col.x + col.w > parent.x + parent.w + 0.5 ||
			col.y < parent.y - 0.5 ||
			col.y + col.h > parent.y + parent.h + 0.5
		) {
			containmentViolations += 1;
		}
	}

	// --- endpoint validity: every edge endpoint must resolve to a rendered node ---
	// (No semantic re-derivation: this is structural/geometric, not an FK check.)
	let endpointViolations = 0;
	for (const e of graph.edges) {
		if (!rects.has(e.source) || !rects.has(e.target)) endpointViolations += 1;
	}

	// --- self-reference handling ---
	// Authoritative self-referential FK relationships remain facts in the
	// reconciled graph, but the viewer must not materialise them as self-loops.
	const authoritativeSelfFk = (schema.relationships ?? []).filter(
		(r: any) => r.kind === 'fk' && r.source === r.target
	).length;
	const selfLoopEdges = graph.edges.filter((e) => e.source === e.target).length;

	// --- connectivity (undirected, table-level) for isolated/sparse regions ---
	const names = Object.keys(schema.classes ?? {});
	const parentMap = new Map<string, string>(names.map((n) => [n, n]));
	const find = (x: string): string => {
		while (parentMap.get(x) !== x) {
			parentMap.set(x, parentMap.get(parentMap.get(x)!)!);
			x = parentMap.get(x)!;
		}
		return x;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parentMap.set(ra, rb);
	};
	const incident = new Set<string>();
	for (const rel of schema.relationships ?? []) {
		if (parentMap.has(rel.source) && parentMap.has(rel.target)) {
			union(rel.source, rel.target);
			incident.add(rel.source);
			incident.add(rel.target);
		}
	}
	const roots = new Set(names.map(find));
	const isolatedCount = names.filter((n) => !incident.has(n)).length;

	// --- isolated/sparse regions: distance-from-centroid outliers ---
	const tableRects = tables.map((t) => ({ id: t.id, cx: t.x + t.w / 2, cy: t.y + t.h / 2 }));
	let outsideCluster = 0;
	let medianPairwiseDistance = 0;
	if (tableRects.length > 1) {
		const pairwiseDistances: number[] = [];
		for (let i = 0; i < tableRects.length; i++) {
			for (let j = i + 1; j < tableRects.length; j++) {
				const dx = tableRects[i].cx - tableRects[j].cx;
				const dy = tableRects[i].cy - tableRects[j].cy;
				pairwiseDistances.push(Math.hypot(dx, dy));
			}
		}
		pairwiseDistances.sort((a, b) => a - b);
		medianPairwiseDistance = r6(pairwiseDistances[Math.floor(pairwiseDistances.length / 2)]);
		const threshold = 2 * pairwiseDistances[Math.floor(pairwiseDistances.length / 2)];
		const globalCx = tableRects.reduce((s, t) => s + t.cx, 0) / tableRects.length;
		const globalCy = tableRects.reduce((s, t) => s + t.cy, 0) / tableRects.length;
		for (const t of tableRects) {
			const d = Math.hypot(t.cx - globalCx, t.cy - globalCy);
			if (d > threshold) outsideCluster += 1;
		}
	}

	// --- initial fit zoom against the documented nominal viewport ---
	const rawZoom = Math.min(
		NOMINAL_VIEWPORT.width / (width * (1 + FIT.padding)),
		NOMINAL_VIEWPORT.height / (height * (1 + FIT.padding))
	);
	const fitZoom = Math.min(FIT.maxZoom, Math.max(FIT.minZoom, rawZoom));

	// --- visible classes/columns at the fit zoom and each LOD band ---
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const visibleAt = (zoom: number) => {
		const halfW = NOMINAL_VIEWPORT.width / zoom / 2;
		const halfH = NOMINAL_VIEWPORT.height / zoom / 2;
		const vx0 = cx - halfW;
		const vx1 = cx + halfW;
		const vy0 = cy - halfH;
		const vy1 = cy + halfH;
		const tablesVisible = tables.filter(
			(t) => t.x < vx1 && t.x + t.w > vx0 && t.y < vy1 && t.y + t.h > vy0
		).length;
		const columnsVisible = columns.filter(
			(c) => c.x < vx1 && c.x + c.w > vx0 && c.y < vy1 && c.y + c.h > vy0
		).length;
		return { zoom: r4(zoom), tables: tablesVisible, columns: columnsVisible };
	};

	return {
		frozenInput: inputSignature(schema, graph),
		handleOrientation: handleOrientation(graph, direction),
		bounds: { width: r6(width), height: r6(height) },
		area: r6(width * height),
		aspectRatio: r6(width / height),
		nodeOverlap: {
			metric: 'axis-aligned bounding box overlap',
			count: tableOverlaps + columnCrossOverlaps,
			tables: tableOverlaps,
			columnsCrossTable: columnCrossOverlaps
		},
		edgeCrossings: {
			metric: 'straight-segment proxy (not smoothstep)',
			count: crossings,
			edges: segments.length,
			missingEndpoints
		},
		edgeLengthDistribution: {
			histogram: { short: histShort, medium: histMedium, long: histLong },
			bins: { short: '<50px', medium: '50-200px', long: '>200px' },
			min: r6(percentile(sortedLengths, 0)),
			p50: r6(percentile(sortedLengths, 0.5)),
			p90: r6(percentile(sortedLengths, 0.9)),
			max: r6(maxLength),
			mean: r6(meanLength)
		},
		maxEdgeLength: r6(maxLength),
		longSpanEdges: { count: longSpanEdges, threshold: `${LONG_EDGE_THRESHOLD}px` },
		rankUtilisation,
		isolatedSparseRegions: {
			connectedComponents: roots.size,
			isolatedNodes: isolatedCount,
			nodesOutsideMainCluster: outsideCluster,
			medianPairwiseDistance
		},
		parentChildContainment: { violations: containmentViolations, checked: columns.length },
		fkEndpointValidity: {
			metric: 'edge endpoint resolves to a rendered node (structural)',
			violations: endpointViolations,
			checked: graph.edges.length
		},
		selfReferenceHandling: {
			authoritativeSelfFkFacts: authoritativeSelfFk,
			renderedSelfLoops: selfLoopEdges,
			expected: 0,
			ok: selfLoopEdges === 0
		},
		fitZoom: {
			zoom: r4(fitZoom),
			rawZoom: r4(rawZoom),
			clampedToMin: fitZoom <= FIT.minZoom + 1e-9,
			nominalViewport: NOMINAL_VIEWPORT,
			padding: FIT.padding
		},
		visibleClasses: {
			metric: 'nodes intersecting nominal viewport',
			atFitZoom: visibleAt(fitZoom),
			lod0: visibleAt(0.49),
			lod1: visibleAt(0.6),
			lod2: visibleAt(1.0)
		}
	};
}

// ---------------------------------------------------------------------------
// Native Vite module loading (resolves `$app/paths` for linkml.ts)
// ---------------------------------------------------------------------------

const appPathsStub: Plugin = {
	name: 'app-paths-stub',
	resolveId(id) {
		if (id === '$app/paths') return '\0app-paths';
	},
	load(id) {
		if (id === '\0app-paths') return 'export const base = "";';
	}
};

async function runPass(
	project: (artifact: unknown) => any,
	build: (
		schema: any,
		collapsed: Set<string>,
		options: Candidate
	) => Promise<{ nodes: BuiltNode[]; edges: any[] }>
) {
	const results: Record<string, unknown> = {};
	for (const fixture of FIXTURES) {
		const artifact = JSON.parse(readFileSync(join(RECONCILED_DIR, `${fixture.name}.json`), 'utf8'));
		const schema = project(artifact);
		const candidates: Record<string, unknown> = {};
		for (const candidate of CANDIDATES) {
			const graph = await build(schema, new Set(), candidate);
			const enrichedEdges: BuiltEdge[] = graph.edges.map((e: any) => ({
				id: e.id,
				source: e.source,
				target: e.target,
				edgeKind: e.data?.edgeKind,
				slotName: e.data?.slotName,
				targetClass: e.data?.targetClass
			}));
			const enrichedGraph: BuiltGraph = { nodes: graph.nodes, edges: enrichedEdges };
			candidates[candidate.name] = computeMetrics(schema, enrichedGraph, candidate);
		}
		results[fixture.name] = { role: fixture.role, candidates };
	}
	return results;
}

/** Aggregate the four-direction handle contract across every fixture/candidate. */
function aggregateContracts(results: Record<string, any>) {
	const rows: { fixture: string; candidate: string; direction: string; ok: boolean; expected: unknown; observed: unknown }[] = [];
	for (const [fixture, f] of Object.entries(results)) {
		for (const [candidate, m] of Object.entries<any>(f.candidates)) {
			rows.push({
				fixture,
				candidate,
				direction: candidate.endsWith('LR') ? 'LR' : 'TB',
				ok: m.handleOrientation.ok,
				expected: m.handleOrientation.expected,
				observed: { columns: m.handleOrientation.columns, tables: m.handleOrientation.tables }
			});
		}
	}
	return { rows, pass: rows.every((r) => r.ok) };
}

async function main() {
	const server = await createServer({
		configFile: false,
		root: REPO_ROOT,
		logLevel: 'silent',
		server: { middlewareMode: true },
		appType: 'custom',
		plugins: [appPathsStub]
	});

	try {
		const linkml = await server.ssrLoadModule('/src/lib/linkml.ts');
		const layout = await server.ssrLoadModule('/src/lib/layout.ts');
		const project = linkml.projectReconciledArtifact as (artifact: unknown) => any;
		const build = layout.buildGraph as (
			schema: any,
			collapsed: Set<string>,
			options: { engine: 'dagre' | 'elk'; direction: 'LR' | 'TB' }
		) => Promise<{ nodes: BuiltNode[]; edges: any[] }>;

		const pass1 = await runPass(project, build);
		const pass2 = await runPass(project, build);
		const digest1 = sha256(JSON.stringify(pass1));
		const digest2 = sha256(JSON.stringify(pass2));
		const contracts = aggregateContracts(pass1);

		const output = {
			benchmark: 'C1 layout benchmark (reconciled graph, native engines) — R2.2 expanded metrics',
			source: 'static/reconciled/<fixture>.json (produce.py via Vite pipeline)',
			candidates: CANDIDATES.map((c) => c.name),
			fixtures: FIXTURES.map((f) => ({ name: f.name, role: f.role })),
			frozenParameters: {
				nominalViewport: NOMINAL_VIEWPORT,
				fit: FIT,
				lod: LOD,
				layerTolerance: LAYER_TOLERANCE,
				longEdgeThresholdPx: LONG_EDGE_THRESHOLD
			},
			results: pass1,
			contracts,
			determinism: {
				metric: 'sha256(canonical metrics JSON)',
				pass1Digest: digest1,
				pass2Digest: digest2,
				identical: digest1 === digest2
			}
		};

		process.stdout.write(JSON.stringify(output, null, 2) + '\n');

		if (!contracts.pass) {
			process.stderr.write(
				`HANDLE-ORIENTATION REGRESSION: ${contracts.rows.filter((r) => !r.ok).length} candidate(s) failed ` +
					`the LR->Right/Left, TB->Bottom/Top contract\n`
			);
			process.exitCode = 1;
		}
	} finally {
		await server.close();
	}
}

await main();
