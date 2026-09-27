import { test, expect, type Page } from '@playwright/test';
import { waitForGraph, setViewport, tableNode, canvas } from './helpers';

// ---------------------------------------------------------------------------
// R2.4.1 / R2.4.2 — Relationship focus.
//
// Contract: selecting a table (R2.4.1) or an individual FK/ETL edge (R2.4.2)
// emphasises its *existing* relationships without changing the graph, layout,
// viewport, geometry, edge paths, or semantic state. The focus set is derived
// from native Svelte Flow selection + the already-rendered edges (see
// src/lib/edgeFocus.ts); the dev seams drive native selection through the
// library's own store actions. Edge selection takes precedence over table
// selection while present.
// ---------------------------------------------------------------------------

interface Geometry {
  nodes: Record<string, string | null>;
  edges: Record<string, string | null>;
  viewport: { x: number; y: number; zoom: number };
}

/** Node transforms, edge path `d` attributes, and the viewport — the frozen set. */
async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const nodes = Object.fromEntries(
      [...document.querySelectorAll('.svelte-flow__node-tableParent')].map((e) => [
        e.getAttribute('data-id'),
        (e as HTMLElement).style.transform,
      ])
    );
    const edges = Object.fromEntries(
      [...document.querySelectorAll('.svelte-flow__edge')].map((e) => [
        e.getAttribute('data-id'),
        e.querySelector('.svelte-flow__edge-path')?.getAttribute('d') ?? null,
      ])
    );
    const vpEl = document.querySelector('.svelte-flow__viewport') as HTMLElement;
    const m = new DOMMatrixReadOnly(getComputedStyle(vpEl).transform);
    return { nodes, edges, viewport: { x: m.e, y: m.f, zoom: m.a } };
  });
}

async function selectNodes(page: Page, ids: string[]) {
  await page.evaluate((i) => window.__erdSelection.selectNodes(i), ids);
}

async function selectEdges(page: Page, ids: string[]) {
  await page.evaluate((i) => window.__erdSelection.selectEdges(i), ids);
}

async function selectNodesAndEdges(page: Page, nodeIds: string[], edgeIds: string[]) {
  await page.evaluate(
    ([n, e]) => window.__erdSelection.selectNodesAndEdges(n, e),
    [nodeIds, edgeIds] as const
  );
}

/**
 * The first FK and first ETL edge ids present in the DOM, discriminated by the
 * ETL dash pattern. Edge ids contain the layout's `COL_ID_SEP` (NUL), so they
 * are read via `getAttribute` rather than used in a CSS selector.
 */
async function edgeIdsByKind(page: Page): Promise<{ fk: string; etl: string }> {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('.svelte-flow__edge')] as HTMLElement[];
    let fk = '';
    let etl = '';
    for (const el of all) {
      const path = el.querySelector('.svelte-flow__edge-path') as SVGPathElement | null;
      if (!path) continue;
      const id = el.getAttribute('data-id') ?? '';
      if (!id) continue;
      const dash = getComputedStyle(path).strokeDasharray;
      const isEtl = !!dash && dash !== 'none';
      if (isEtl && !etl) etl = id;
      else if (!isEtl && !fk) fk = id;
      if (fk && etl) break;
    }
    return { fk, etl };
  });
}

/** Read the emphasis class + kind styling of one edge element by id. */
async function edgeFacts(page: Page, edgeId: string) {
  return page.evaluate((id) => {
    const all = [...document.querySelectorAll('.svelte-flow__edge')] as HTMLElement[];
    const el = all.find((e) => e.getAttribute('data-id') === id);
    if (!el) return null;
    const path = el.querySelector('.svelte-flow__edge-path') as SVGPathElement | null;
    const cs = path ? getComputedStyle(path) : null;
    return {
      selected: el.classList.contains('erd-edge-selected'),
      focus: el.classList.contains('erd-edge-focus'),
      dim: el.classList.contains('erd-edge-dim'),
      stroke: cs?.stroke ?? null,
      dash: cs?.strokeDasharray ?? null,
      markerEnd: path?.getAttribute('marker-end') ?? null,
    };
  }, edgeId);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

// ---------------------------------------------------------------------------
// Test 1 — geometry-frozen contract: selecting a table must not move anything.
// ---------------------------------------------------------------------------
test('selecting a table focuses its relationships without moving geometry', async ({ page }) => {
  await setViewport(page, { x: 120, y: 80, zoom: 0.6 });

  const before = await geometry(page);
  expect(Object.keys(before.nodes).length).toBeGreaterThan(0);
  expect(Object.keys(before.edges).length).toBeGreaterThan(0);

  await selectNodes(page, ['person']);
  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().active))
    .toBe(true);

  const focus = await page.evaluate(() => window.__erdFocus.get());
  expect(focus.tableIds).toContain('person');
  expect(focus.edgeIds.length).toBeGreaterThan(0);

  // Emphasis is applied (presentation only), and nothing is hidden.
  await expect(page.locator('.svelte-flow__edge.erd-edge-focus').first()).toBeVisible();
  await expect(page.locator('.svelte-flow__edge.erd-edge-dim').first()).toBeVisible();

  const after = await geometry(page);
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Test 2 — selection and collapse are separate affordances (R2.8.7): the header
// selects the table; the collapse control toggles collapse and preserves the
// selection.
// ---------------------------------------------------------------------------
test('header selects the table; the collapse control collapses without selecting', async ({
  page,
}) => {
  const columns = page.locator('.svelte-flow__node-column[data-id^="person"]');
  expect(await columns.count()).toBeGreaterThan(0);

  // Header click selects the table (native selection); it does not collapse.
  await tableNode(page, 'person').locator('.header').click();
  await expect
    .poll(() => page.evaluate(() => window.__erdSelection.getSelectedNodeIds()))
    .toContain('person');
  expect(await columns.count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__erdFocus.get().active)).toBe(true);

  // The collapse control collapses only — the selection is preserved.
  await tableNode(page, 'person').locator('.collapse-toggle').click();
  await expect(columns).toHaveCount(0);
  expect(await page.evaluate(() => window.__erdSelection.getSelectedNodeIds())).toContain('person');
  expect(await page.evaluate(() => window.__erdFocus.get().active)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3 — clicking the node surface (a column row) focuses its table.
// ---------------------------------------------------------------------------
test('clicking a column row focuses its table', async ({ page }) => {
  await page.locator('.svelte-flow__node-column[data-id^="person"]').first().click();

  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().active))
    .toBe(true);
  const focus = await page.evaluate(() => window.__erdFocus.get());
  expect(focus.tableIds).toContain('person');
});

// ---------------------------------------------------------------------------
// Test 4 — clicking empty canvas clears selection and focus.
// ---------------------------------------------------------------------------
test('empty canvas click clears selection and focus', async ({ page }) => {
  await selectNodes(page, ['person']);
  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().active))
    .toBe(true);

  // Move far from the graph so the pane click cannot land on a node.
  await setViewport(page, { x: -20000, y: -20000, zoom: 0.6 });
  await page.locator('.svelte-flow__pane').click({ position: { x: 5, y: 5 } });

  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().active))
    .toBe(false);
  expect(await page.evaluate(() => window.__erdSelection.getSelectedNodeIds())).toEqual([]);
});

// ---------------------------------------------------------------------------
// R2.4.2 — Edge selection. Contract: selecting one existing FK/ETL edge
// strongly emphasises *that* edge, modestly emphasises its two endpoint tables
// (derived from the edge's own source/target ids), dims everything else, and
// changes no geometry, path, viewport, layout, or semantic state.
// ---------------------------------------------------------------------------

/**
 * Shared geometry-frozen assertion for an edge of the given kind.
 * `expectEtl` selects the ETL styling check (dashed indigo) vs FK (solid slate).
 */
async function assertEdgeFocusFrozen(page: Page, edgeId: string, expectEtl: boolean) {
  await setViewport(page, { x: 120, y: 80, zoom: 0.6 });

  const before = await geometry(page);
  expect(before.edges[edgeId]).toBeTruthy(); // the edge path is rendered

  await selectEdges(page, [edgeId]);
  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().active))
    .toBe(true);

  const focus = await page.evaluate(() => window.__erdFocus.get());
  // The selected edge is the only strongly-focused edge; its two (and only
  // two) endpoints are the focused tables — derived from source/target.
  expect(focus.strongEdgeIds).toEqual([edgeId]);
  expect(focus.edgeIds).toEqual([edgeId]);
  expect(focus.tableIds.length).toBe(2);

  // Strong emphasis landed on exactly the selected edge.
  await expect(page.locator('.svelte-flow__edge.erd-edge-selected')).toHaveCount(1);
  const facts = await edgeFacts(page, edgeId);
  expect(facts?.selected).toBe(true);
  expect(facts?.focus).toBe(false);
  expect(facts?.dim).toBe(false);

  // Its two endpoint tables are modestly emphasised; unrelated edges/tables dim.
  await expect(page.locator('.svelte-flow__node-tableParent .table-parent.related')).toHaveCount(2);
  await expect(page.locator('.svelte-flow__node-tableParent .table-parent.dimmed')).not.toHaveCount(0);
  expect(await page.locator('.svelte-flow__edge.erd-edge-dim').count()).toBeGreaterThan(0);

  // Emphasis preserves the FK vs ETL kind styling and the arrowhead marker.
  expect(facts?.markerEnd).toBeTruthy();
  if (expectEtl) {
    expect(facts?.dash).not.toBe('none');
    expect(facts?.stroke).toBe('rgb(99, 102, 241)'); // #6366f1 indigo-500
  } else {
    expect(facts?.dash).toBe('none');
    expect(facts?.stroke).toBe('rgb(71, 85, 105)'); // #475569 slate-600
  }

  // Geometry, edge paths, and viewport are byte-for-byte unchanged.
  const after = await geometry(page);
  expect(after).toEqual(before);
}

test('selecting an FK edge focuses the relationship and its endpoints, geometry frozen', async ({
  page,
}) => {
  const { fk } = await edgeIdsByKind(page);
  expect(fk).not.toBe('');
  await assertEdgeFocusFrozen(page, fk, false);
});

test('selecting an ETL edge focuses the relationship and its endpoints, geometry frozen', async ({
  page,
}) => {
  // OMOP has zero ETL relationships, so load the SEIN bundled schema, whose
  // exact_mappings resolve to ETL edges, through the same bundled-artefact path.
  await page.evaluate(() => window.__erdSchema.loadBundled('sein'));
  await expect
    .poll(async () => (await edgeIdsByKind(page)).etl !== '', { timeout: 30_000 })
    .toBe(true);
  await page.waitForTimeout(1500); // let the initial fitView settle

  const { etl } = await edgeIdsByKind(page);
  expect(etl).not.toBe('');
  await assertEdgeFocusFrozen(page, etl, true);
});

// ---------------------------------------------------------------------------
// Precedence rule — while an edge is selected it wins over any selected table:
// focus is exactly the edge + its two endpoints, not the table's neighbourhood.
// ---------------------------------------------------------------------------
test('edge selection takes precedence over table selection', async ({ page }) => {
  const { fk } = await edgeIdsByKind(page);
  expect(fk).not.toBe('');

  await selectNodesAndEdges(page, ['person'], [fk]);
  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().active))
    .toBe(true);

  const focus = await page.evaluate(() => window.__erdFocus.get());
  expect(focus.strongEdgeIds).toEqual([fk]);
  // Table focus would have pulled in every edge touching `person`; edge focus
  // keeps exactly the one selected relationship.
  expect(focus.edgeIds).toEqual([fk]);
  expect(focus.tableIds.length).toBe(2);
});
