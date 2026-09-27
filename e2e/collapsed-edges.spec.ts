import { test, expect, type Page } from '@playwright/test';
import { waitForGraph, tableNode, getViewport, setLayout } from './helpers';

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

  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
  await expect(page.locator('.svelte-flow__node-column[data-id^="person"]')).toHaveCount(0);
  await page.waitForTimeout(1000);
  sides = await handleSides(page);
  // The collapsed person table now contributes its own source/target handle.
  expect(sides.source).toEqual(['right']);
  expect(sides.target).toEqual(['left']);
  expect(sides.parent).toBeGreaterThan(0);
  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
  await page.waitForTimeout(1000);

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
  expect(before.length).toBeGreaterThan(0);

  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
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

  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
  await page.waitForTimeout(1000);
  expect(await edgeIds(page)).toEqual(before);
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

  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
  await page.waitForTimeout(1000);
  const afterCollapse = await getViewport(page);
  expect(Math.abs(afterCollapse.x - before.x)).toBeLessThan(2);
  expect(Math.abs(afterCollapse.y - before.y)).toBeLessThan(2);
  expect(Math.abs(afterCollapse.zoom - before.zoom)).toBeLessThan(0.01);

  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
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

  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
  await expect(page.locator('.svelte-flow__node-column[data-id^="person"]')).toHaveCount(0);
  await page.waitForTimeout(1200);

  const after = await edgeIds(page);
  const removed = before.filter((id) => !after.includes(id));
  const added = after.filter((id) => !before.includes(id));
  expect(after.length).toBe(before.length);
  expect(removed.length).toBe(added.length);
  expect(removed.every((id) => id.includes('person'))).toBe(true);
  expect(added.every((id) => id.includes('person'))).toBe(true);

  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
  await page.waitForTimeout(1200);
  expect(await edgeIds(page)).toEqual(before);
});
