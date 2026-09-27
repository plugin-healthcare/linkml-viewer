import { test, expect, type Page } from '@playwright/test';
import { waitForGraph, tableNode, getViewport, setLayout, semanticEdgeKeys } from './helpers';

// ---------------------------------------------------------------------------
// R2.8.3 — collapsed-edge anchoring contract.
//
// Expanded: the directional Handles live on the COLUMN child nodes; the
// `tableParent` renders none. Collapsed: the columns are gone, so the
// `tableParent` exposes its own Handles (sides from layout.ts's native
// `sourcePosition`/`targetPosition`). Svelte Flow's `getEdgePosition` therefore
// resolves an edge endpoint that is a bare table id, and a collapsed table
// keeps its incident edges — anchored to its header — instead of dropping them.
// ---------------------------------------------------------------------------

/** Rendered edge ids (from the DOM), sorted for stable comparison. */
async function edgeIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll('.svelte-flow__edge'),
    ]
      .map((el) => el.getAttribute('data-id') ?? '')
      .sort()
  );
}

/** Rendered edges split by kind, discriminated by the ETL dash pattern. */
async function edgeKindSplit(page: Page) {
  return page.evaluate(() => {
    let fk = 0;
    let etl = 0;
    document.querySelectorAll('.svelte-flow__edge-path').forEach((el) => {
      const dash = getComputedStyle(el).strokeDasharray;
      if (dash && dash !== 'none') etl += 1;
      else fk += 1;
    });
    return { total: fk + etl, fk, etl };
  });
}

/** Styling identity of the first rendered ETL edge (dash/indigo/arrowhead). */
async function firstEtlEdgeFacts(page: Page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('.svelte-flow__edge')) {
      const path = el.querySelector('.svelte-flow__edge-path') as SVGPathElement | null;
      if (!path) continue;
      const cs = getComputedStyle(path);
      if (cs.strokeDasharray && cs.strokeDasharray !== 'none') {
        return {
          id: el.getAttribute('data-id') ?? '',
          stroke: cs.stroke,
          dash: cs.strokeDasharray,
          markerEnd: path.getAttribute('marker-end'),
        };
      }
    }
    return null;
  });
}

/** Handle sides per type, plus the count of handles on tableParent nodes. */
async function handleSides(page: Page) {
  return page.evaluate(() => {
    const source = new Set<string>();
    const target = new Set<string>();
    let parent = 0;
    document.querySelectorAll('.svelte-flow__handle').forEach((h) => {
      const el = h as HTMLElement;
      if (el.closest('.svelte-flow__node-tableParent')) parent += 1;
      const set = el.classList.contains('source') ? source : target;
      set.add(el.dataset.handlepos ?? '');
    });
    return { source: [...source].sort(), target: [...target].sort(), parent };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

// 1. Handles follow the layout direction and move from the column nodes to the
//    parent exactly when the table is collapsed.
test('directional handles: columns when expanded, parent when collapsed (LR + TB)', async ({ page }) => {
  let sides = await handleSides(page);
  expect(sides.source).toEqual(['right']);
  expect(sides.target).toEqual(['left']);
  expect(sides.parent).toBe(0);

  await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
  await expect(page.locator('.svelte-flow__node-column[data-id^="person"]')).toHaveCount(0);
  await page.waitForTimeout(1000);
  sides = await handleSides(page);
  // The collapsed person table now contributes its own source/target handle.
  expect(sides.source).toEqual(['right']);
  expect(sides.target).toEqual(['left']);
  expect(sides.parent).toBeGreaterThan(0);
  await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
  await page.waitForTimeout(1000);
  // Expanding restores column-level anchors: the parent exposes none again.
  sides = await handleSides(page);
  expect(sides.parent).toBe(0);

  await setLayout(page, { engine: 'dagre', direction: 'TB' });
  sides = await handleSides(page);
  expect(sides.source).toEqual(['bottom']);
  expect(sides.target).toEqual(['top']);
  expect(sides.parent).toBe(0);
});

// 2. Edge existence is preserved: collapsing a table keeps every edge (its
//    incident edges re-anchor to the header, so their ids change from
//    column-id to table-id form); unaffected edges keep their ids; expanding
//    restores the original id set exactly (the inverse, no reconstruction).
test('collapse preserves every edge; expand is the exact inverse (LR)', async ({ page }) => {
  const before = await edgeIds(page);
  const semBefore = await semanticEdgeKeys(page);
  expect(before.length).toBeGreaterThan(0);

  await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
  await expect(page.locator('.svelte-flow__node-column[data-id^="person"]')).toHaveCount(0);
  await page.waitForTimeout(1000);

  const after = await edgeIds(page);
  const removed = before.filter((id) => !after.includes(id));
  const added = after.filter((id) => !before.includes(id));

  // No edge is dropped or duplicated: the total is invariant.
  expect(after.length).toBe(before.length);
  // Only person's incident edges are re-materialised, 1:1 — nothing else moves.
  expect(removed.length).toBe(added.length);
  expect(removed.every((id) => id.includes('person'))).toBe(true);
  expect(added.every((id) => id.includes('person'))).toBe(true);
  // The reconciled relationship data is untouched: kind (FK/ETL), source/target
  // table identity and slot are all invariant across the collapse.
  expect(await semanticEdgeKeys(page)).toEqual(semBefore);

  await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
  await page.waitForTimeout(1000);
  expect(await edgeIds(page)).toEqual(before);
  expect(await semanticEdgeKeys(page)).toEqual(semBefore);
});

// 3. Collapse-all preserves the full edge count (every edge anchors to a
//    collapsed header); expand-all restores the original id set exactly.
test('collapse-all preserves every edge; expand-all restores the id set', async ({ page }) => {
  const before = await edgeIds(page);

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await page.waitForTimeout(1400);
  expect((await edgeIds(page)).length).toBe(before.length);

  await page.getByRole('button', { name: 'Expand all' }).click();
  await page.waitForTimeout(1400);
  expect(await edgeIds(page)).toEqual(before);
});

// 4. Both directions of the toggle are content mutations: the viewport is
//    preserved (no fit, no pan).
test('collapse and expand preserve the viewport', async ({ page }) => {
  const before = await getViewport(page);

  await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
  await page.waitForTimeout(1000);
  const afterCollapse = await getViewport(page);
  expect(Math.abs(afterCollapse.x - before.x)).toBeLessThan(2);
  expect(Math.abs(afterCollapse.y - before.y)).toBeLessThan(2);
  expect(Math.abs(afterCollapse.zoom - before.zoom)).toBeLessThan(0.01);

  await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
  await page.waitForTimeout(1000);
  const afterExpand = await getViewport(page);
  expect(Math.abs(afterExpand.x - before.x)).toBeLessThan(2);
  expect(Math.abs(afterExpand.y - before.y)).toBeLessThan(2);
  expect(Math.abs(afterExpand.zoom - before.zoom)).toBeLessThan(0.01);
});

// 5. The collapse contract is direction-independent.
test('collapse preserves every edge under TB', async ({ page }) => {
  await setLayout(page, { engine: 'dagre', direction: 'TB' });
  const before = await edgeIds(page);

  await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
  await expect(page.locator('.svelte-flow__node-column[data-id^="person"]')).toHaveCount(0);
  await page.waitForTimeout(1200);

  const after = await edgeIds(page);
  const removed = before.filter((id) => !after.includes(id));
  const added = after.filter((id) => !before.includes(id));
  expect(after.length).toBe(before.length);
  expect(removed.length).toBe(added.length);
  expect(removed.every((id) => id.includes('person'))).toBe(true);
  expect(added.every((id) => id.includes('person'))).toBe(true);

  await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
  await page.waitForTimeout(1200);
  expect(await edgeIds(page)).toEqual(before);
});

// 6. R2.8.6 — FK/ETL identity is preserved by collapse. The default OMOP schema
//    has zero ETL relationships, so the kind-invariance clause is pinned here on
//    the SEIN bundled schema (50 FK + 60 ETL): collapsing every table must keep
//    both kinds, their counts, and the dashed-indigo ETL styling intact — the
//    endpoint re-anchors to the header without changing what the edge *is*.
test('collapse preserves FK/ETL identity on an ETL-bearing schema', async ({ page }) => {
  // OMOP has zero ETL; load SEIN through the same bundled-artefact path.
  await page.evaluate(() => window.__erdSchema.loadBundled('sein'));
  await expect
    .poll(async () => (await edgeKindSplit(page)).total, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(1200); // let the initial fitView settle

  const before = await edgeKindSplit(page);
  expect(before.fk).toBeGreaterThan(0);
  expect(before.etl).toBeGreaterThan(0);
  const etlStyleBefore = await firstEtlEdgeFacts(page);
  expect(etlStyleBefore?.dash).not.toBe('none');
  expect(etlStyleBefore?.markerEnd).toBeTruthy();

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await page.waitForTimeout(1600);

  // Identity is invariant: both kinds survive collapse with unchanged counts...
  expect(await edgeKindSplit(page)).toEqual(before);
  // ...and the ETL edge keeps its dash, indigo stroke, and arrowhead.
  const etlStyleAfter = await firstEtlEdgeFacts(page);
  expect(etlStyleAfter?.dash).toBe(etlStyleBefore?.dash);
  expect(etlStyleAfter?.stroke).toBe(etlStyleBefore?.stroke);
  expect(etlStyleAfter?.markerEnd).toBeTruthy();

  await page.getByRole('button', { name: 'Expand all' }).click();
  await page.waitForTimeout(1600);
  expect(await edgeKindSplit(page)).toEqual(before);
});

// 6. Fit collapsed is a genuinely connected overview: collapsing everything
//    keeps every relationship (anchored to the collapsed headers) and fits it.
test('fit collapsed yields a connected overview', async ({ page }) => {
  const before = await edgeIds(page);
  const semBefore = await semanticEdgeKeys(page);

  await page.getByRole('button', { name: 'Fit collapsed' }).click();
  await page.waitForTimeout(1600);

  // Every table is collapsed → anchors come from the parents only.
  const sides = await handleSides(page);
  expect(sides.parent).toBeGreaterThan(0);
  // No relationship is lost, so the fitted overview is genuinely connected.
  expect(await edgeIds(page)).toHaveLength(before.length);
  expect(await semanticEdgeKeys(page)).toEqual(semBefore);
});

// 7. FK *and* ETL identity are preserved: collapse never changes a relationship's
//    kind, endpoint tables or slot. Uses SEIN (which has 60 ETL relationships).
test('FK and ETL relationship identity survives collapse (SEIN)', async ({ page }) => {
  await page.evaluate(() => window.__erdSchema.loadBundled('sein'));
  await expect
    .poll(() => page.locator('.svelte-flow__node-tableParent').count(), { timeout: 30_000 })
    .toBe(29);
  await page.waitForTimeout(600);

  const before = await semanticEdgeKeys(page);
  expect(before.filter((k) => k.startsWith('etl|')).length).toBeGreaterThan(0);
  expect(before.filter((k) => k.startsWith('fk|')).length).toBeGreaterThan(0);

  const firstId = await page
    .locator('.svelte-flow__node-tableParent')
    .first()
    .getAttribute('data-id');
  await tableNode(page, firstId!).locator('.collapse-toggle').dispatchEvent('click');
  await page.waitForTimeout(1200);

  expect(await semanticEdgeKeys(page)).toEqual(before);
});
