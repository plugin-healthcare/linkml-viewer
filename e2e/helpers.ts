import { expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared browser-test helpers for the ERD viewer.
//
// The OMOP CDM default schema (static/omop_cdm.yaml) loads automatically on
// mount. Its merged form uses lower-case class ids (e.g. "person",
// "visit_occurrence"), which are used verbatim as Svelte Flow node ids.
// ---------------------------------------------------------------------------

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

declare global {
   interface Window {
     __erdFlow: {
       getViewport: () => { x: number; y: number; zoom: number };
       setViewport: (vp: Viewport, opts?: { duration?: number }) => void;
       fitView: (opts?: { padding?: number; duration?: number }) => void;
       getZoom: () => number;
       getNodeCenter: (id: string) => { x: number; y: number } | null;
     };
     __erdNav: {
       getCursor: () => string | null;
       setCursor: (id: string | null) => void;
     };
     __erdLayout: {
       getLayoutOptions: () => { engine: string; direction: string };
       setLayoutOptions: (opts: { engine: string; direction: string }) => void;
     };
     __erdSelection: {
       getSelectedNodeIds: () => string[];
       getSelectedEdgeIds: () => string[];
       selectNodes: (ids: string[]) => void;
       selectEdges: (ids: string[]) => void;
        selectNodesAndEdges: (nodeIds: string[], edgeIds: string[]) => void;
        clear: () => void;
        getSelectable: () => boolean;
        getDraggable: () => boolean;
      };
     __erdFocus: {
       get: () => {
         active: boolean;
         selectedTableIds: string[];
         selectedNodeIds: string[];
         tableIds: string[];
         edgeIds: string[];
         strongEdgeIds: string[];
       };
     };
     __erdSchema: {
       loadBundled: (stem: string) => Promise<void>;
     };
     __erdEdges: {
       get: () => {
         id: string;
         source: string;
         target: string;
         kind: string | null;
         slot: string | null;
       }[];
     };
     __erdCamera: {
       getMode: () => 'overview' | 'entry';
       setMode: (mode: 'overview' | 'entry') => void;
       entryClass: string;
     };
     __erdLayoutDelayMs?: number;
   }
 }

export const OMOP_CLASS_COUNT = 37;

export function tableNode(page: Page, id: string) {
  return page.locator(`.svelte-flow__node-tableParent[data-id="${id}"]`);
}

export function tableCard(page: Page, id: string) {
  return tableNode(page, id).locator('.table-parent');
}

export function canvas(page: Page) {
  return page.getByTestId('graph-canvas');
}

export function cursorNode(page: Page) {
  return page.locator('.svelte-flow__node-tableParent:has(.table-parent.cursor)');
}

export async function waitForGraph(page: Page) {
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('.svelte-flow__node-tableParent').length >= expected,
    OMOP_CLASS_COUNT,
    { timeout: 60_000 }
  );
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.svelte-flow__node-tableParent') as HTMLElement | null;
      return !!el && getComputedStyle(el).visibility === 'visible';
    },
    undefined,
    { timeout: 30_000 }
  );
  // Let the initial fitView / layout settle before tests move the viewport.
  // Condition-based: the initial fit starts 50ms after layout apply and runs
  // 400ms, so a stability window wider than the start delay proves it finished.
  await waitForViewportStable(page, { settleMs: 300 });
}

/**
 * Read the live viewport from the DOM transform on `.svelte-flow__viewport`.
 *
 * The viewport element is momentarily absent while a layout rebuild swaps the
 * flow internals, so read through a short retry rather than assuming it exists
 * (a bare `getComputedStyle(null)` throws).
 */
export async function getViewport(page: Page, attempts = 40): Promise<Viewport> {
  for (let i = 0; i < attempts; i++) {
    const vp = await page.evaluate(() => {
      const el = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
      if (!el) return null;
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: m.e, y: m.f, zoom: m.a };
    });
    if (vp) return vp;
    await page.waitForTimeout(50);
  }
  throw new Error('getViewport: .svelte-flow__viewport not found after retries');
}

/** Deterministically set the viewport via the dev-only seam. */
export async function setViewport(page: Page, vp: Viewport) {
  await page.evaluate((v) => {
    window.__erdFlow.setViewport(v, { duration: 0 });
  }, vp);
  await page.waitForTimeout(150);
}

/**
 * Poll `getViewport()` until two consecutive readings are equal within a tight
 * tolerance across a `settleMs` interval. An animating viewport changes on every
 * sample, so this proves no app-level fit/center animation is still running.
 *
 * `settleMs` is deliberately wider than the app's fit-start delay (50ms in
 * `FlowController.svelte`): a fit intent that is queued but has not yet begun
 * cannot masquerade as "stable" and then clobber a manually set viewport
 * afterwards. Reads the same DOM transform the rest of the suite uses.
 */
export async function waitForViewportStable(
  page: Page,
  options: { settleMs?: number; timeout?: number } = {}
): Promise<Viewport> {
  const { settleMs = 250, timeout = 15_000 } = options;
  const deadline = Date.now() + timeout;
  let last = await getViewport(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(settleMs);
    const next = await getViewport(page);
    if (
      Math.abs(next.x - last.x) < 0.5 &&
      Math.abs(next.y - last.y) < 0.5 &&
      Math.abs(next.zoom - last.zoom) < 0.0005
    ) {
      return next;
    }
    last = next;
  }
  throw new Error(`waitForViewportStable: viewport did not settle within ${timeout}ms`);
}

export async function search(page: Page, query: string) {
  const input = page.getByRole('combobox', { name: 'Search tables and columns' });
  await input.click();
  await input.fill(query);
  await page.keyboard.press('Enter');
}

export async function setCursor(page: Page, id: string | null) {
  await page.evaluate((i) => window.__erdNav.setCursor(i), id);
}

export async function getCursorId(page: Page) {
  return page.evaluate(() => window.__erdNav.getCursor());
}

export async function nodeCenter(page: Page, id: string) {
  return page.evaluate((i) => window.__erdFlow.getNodeCenter(i), id);
}

export async function resetLayoutDelay(page: Page) {
  await page.evaluate(() => {
    window.__erdLayoutDelayMs = 0;
  });
}

/** Absolute (flow-coordinate) transform of every table node — LOD-independent. */
export async function tableGeometry(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.svelte-flow__node-tableParent')].map((e) => [
        e.getAttribute('data-id'),
        (e as HTMLElement).style.transform,
      ])
    )
  );
}

/** Number of rendered edge labels (presentation-only; driven by edge LOD). */
export async function edgeLabelCount(page: Page): Promise<number> {
  return page.locator('.svelte-flow__edge-label').count();
}

// ---------------------------------------------------------------------------
// R2.6.4.2 screen-stable selected-edge label (EdgeLabelOverlay)
// ---------------------------------------------------------------------------

export interface ScreenLabel {
  edgeId: string;
  text: string;
  /** Screen-space centre (client coordinates). */
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

/** All screen-space selected-edge labels currently rendered. */
export async function screenLabels(page: Page): Promise<ScreenLabel[]> {
  return page.evaluate(() =>
    ([...document.querySelectorAll('.erd-edge-label')] as HTMLElement[]).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        edgeId: el.getAttribute('data-edge-id') ?? '',
        text: (el.textContent ?? '').trim(),
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        width: r.width,
        height: r.height,
        color: getComputedStyle(el).color,
      };
    })
  );
}

/** The screen-space label for one edge id, or null when absent. */
export async function screenLabelFor(page: Page, edgeId: string): Promise<ScreenLabel | null> {
  const labels = await screenLabels(page);
  return labels.find((l) => l.edgeId === edgeId) ?? null;
}

/**
 * Flow-space midpoint of an edge's own rendered path, projected to screen
 * coordinates via the path's own screen CTM (the browser's transform, so no
 * second zoom model is introduced).
 */
export async function edgePathMidScreen(
  page: Page,
  edgeId: string
): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const groups = [...document.querySelectorAll('.svelte-flow__edge')] as SVGElement[];
    for (const group of groups) {
      if (group.getAttribute('data-id') !== id) continue;
      const path = group.querySelector('.svelte-flow__edge-path') as SVGPathElement | null;
      if (!path) return null;
      const len = path.getTotalLength();
      if (!len) return null;
      const p = path.getPointAtLength(len / 2);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      const pt = new DOMPoint(p.x, p.y).matrixTransform(ctm);
      return { x: pt.x, y: pt.y };
    }
    return null;
  }, edgeId);
}

/** Text of any ordinary zoom-coupled label centred within `tol` of a point. */
export async function flowLabelAtPoint(
  page: Page,
  x: number,
  y: number,
  tol = 6
): Promise<string | null> {
  return page.evaluate(
    ([px, py, t]) => {
      const labels = [...document.querySelectorAll('.svelte-flow__edge-label')] as HTMLElement[];
      for (const el of labels) {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (Math.abs(cx - px) <= t && Math.abs(cy - py) <= t) {
          return (el.textContent ?? '').trim();
        }
      }
      return null;
    },
    [x, y, tol] as const
  );
}

/** First rendered FK edge id (solid path = not ETL), or ''. */
export async function firstFkEdgeId(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('.svelte-flow__edge')) {
      const path = el.querySelector('.svelte-flow__edge-path') as SVGPathElement | null;
      if (!path) continue;
      if (getComputedStyle(path).strokeDasharray === 'none') {
        return el.getAttribute('data-id') ?? '';
      }
    }
    return '';
  });
}

/** First rendered ETL edge id (dashed path), or ''. */
export async function firstEtlEdgeId(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('.svelte-flow__edge')) {
      const path = el.querySelector('.svelte-flow__edge-path') as SVGPathElement | null;
      if (!path) continue;
      const dash = getComputedStyle(path).strokeDasharray;
      if (dash && dash !== 'none') return el.getAttribute('data-id') ?? '';
    }
    return '';
  });
}

/**
 * Switch the active layout via the dev seam and wait until it has fully
 * settled: (1) +page.svelte has observed the new options, (2) the async layout
 * build has actually applied new node geometry, and (3) the downstream fitView
 * intent (queued 50ms after apply, 400ms duration) has finished animating.
 *
 * Conditions, not a fixed timeout: on a slow run the ELK build can resolve
 * after any fixed wait and its fit would then clobber a manually set viewport.
 */
export async function setLayout(
  page: Page,
  opts: { engine: string; direction: string }
) {
  const before = await tableGeometry(page);
  await page.evaluate((o) => window.__erdLayout.setLayoutOptions(o), opts);
  await expect.poll(() => page.evaluate(() => window.__erdLayout.getLayoutOptions())).toEqual(opts);
  // The async build has applied the new geometry only once it differs.
  await expect
    .poll(() => tableGeometry(page), { timeout: 30_000 })
    .not.toEqual(before);
  // The fit intent starts 50ms after apply and runs 400ms; wait it out.
  await waitForViewportStable(page);
}

// ---------------------------------------------------------------------------
// Materialised relationship facts (dev seam __erdEdges)
// ---------------------------------------------------------------------------

/** Table id owning a node id: a column id maps to its parent, a table maps to itself. */
export function tableIdOf(nodeId: string): string {
  const sep = nodeId.indexOf('\u0000');
  return sep >= 0 ? nodeId.slice(0, sep) : nodeId;
}

/**
 * The reconciled relationship surface the canvas consumes, normalised to a
 * presentation-independent identity: `kind · sourceTable · targetTable · slot`.
 * Collapsing a table changes only which node anchors the edge (column id →
 * table id), so this key set must be invariant across collapse/expand and
 * direction. `nodeId` fields are read from the layout `edges` source via the
 * `__erdEdges` dev seam.
 */
export async function semanticEdgeKeys(page: Page): Promise<string[]> {
  const edges = await page.evaluate(() => window.__erdEdges.get());
  return edges
    .map(
      (e) =>
        `${e.kind ?? '?'}|${tableIdOf(e.source)}|${tableIdOf(e.target)}|${e.slot ?? '?'}`
    )
    .sort();
}

/** Raw materialised edges (for endpoint-anchor assertions). */
export async function materialisedEdges(page: Page) {
  return page.evaluate(() => window.__erdEdges.get());
}
