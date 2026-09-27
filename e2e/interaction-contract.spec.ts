import { test, expect, type Page } from '@playwright/test';
import {
  waitForGraph,
  setViewport,
  getViewport,
  tableNode,
  canvas,
  search,
  tableCard,
} from './helpers';

// ---------------------------------------------------------------------------
// R2.4.3 — Interaction authority boundary (non-interference contract).
//
// Three interaction authorities coexist and must not compete:
//
//   native Svelte Flow selection  -> relationshipFocus (edgeFocus.ts)
//   app keyboard authority        -> cursor / Enter / Space (.canvas-area)
//   app search authority          -> searchTarget / pane recentre
//
// The authority mapping is encoded on <SvelteFlow> (+page.svelte): pointer
// selection is native (elementsSelectable), node/edge keyboard focus is
// disabled (nodesFocusable/edgesFocusable={false}), Delete is disabled
// (deleteKey={null}), and dragging is governed by the viewer lock state.
// Relationship emphasis is derived from native selection + the already
// rendered edges — no new graph and no `useNodeConnections()`.
//
// These tests prove non-interference, not a redesign: selection changes no
// zoom/layout, keyboard/search/lock/delete retain their existing semantics,
// and multi-selection has one defined presentation rule.
// ---------------------------------------------------------------------------

interface Snapshot {
  nodes: Record<string, string | null>;
  edges: Record<string, string | null>;
  viewport: { x: number; y: number; zoom: number };
}

/** Node transforms, edge path `d` attributes, and the viewport — the frozen set. */
async function snapshot(page: Page): Promise<Snapshot> {
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

async function selectedNodeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__erdSelection.getSelectedNodeIds());
}

async function focusState(page: Page) {
  return page.evaluate(() => window.__erdFocus.get());
}

async function renderedEdgeIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.svelte-flow__edge')]
      .map((e) => e.getAttribute('data-id') ?? '')
      .filter(Boolean)
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

// ---------------------------------------------------------------------------
// Encoded authority boundary — the disabled native keyboard paths.
// ---------------------------------------------------------------------------
test('Svelte Flow node/edge focus is disabled; the canvas owns keyboard', async ({ page }) => {
  // nodesFocusable={false} / edgesFocusable={false} -> no tab stops on the
  // library's node/edge wrappers. The app's spatial handler lives on
  // `.canvas-area`, which is the single operable keyboard region.
  const nodeTabStops = await page
    .locator('.svelte-flow__node')
    .evaluateAll((els) => els.filter((e) => e.hasAttribute('tabindex')).length);
  const edgeTabStops = await page
    .locator('.svelte-flow__edge')
    .evaluateAll((els) => els.filter((e) => e.hasAttribute('tabindex')).length);
  expect(nodeTabStops).toBe(0);
  expect(edgeTabStops).toBe(0);

  await expect(canvas(page)).toHaveAttribute('tabindex', '0');
  await expect(canvas(page)).toHaveAttribute('role', 'application');
});

// ---------------------------------------------------------------------------
// Selection non-interference
// ---------------------------------------------------------------------------
test('selection focuses relationships without changing zoom or geometry', async ({ page }) => {
  await setViewport(page, { x: 120, y: 80, zoom: 0.6 });
  const before = await snapshot(page);
  expect(Object.keys(before.nodes).length).toBeGreaterThan(0);

  await page.evaluate(() => window.__erdSelection.selectNodes(['person']));
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  const focus = await focusState(page);
  expect(focus.tableIds).toContain('person');

  const after = await snapshot(page);
  expect(after).toEqual(before);
});

test('empty-canvas click clears selection and focus without a zoom change', async ({ page }) => {
  await page.evaluate(() => window.__erdSelection.selectNodes(['person']));
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  await setViewport(page, { x: -20000, y: -20000, zoom: 0.6 });
  const before = await getViewport(page);
  await page.locator('.svelte-flow__pane').click({ position: { x: 5, y: 5 } });

  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(false);
  expect(await selectedNodeIds(page)).toEqual([]);

  const after = await getViewport(page);
  expect(Math.abs(after.zoom - before.zoom)).toBeLessThan(0.001);
});

test('edge selection focuses the edge without changing zoom or geometry', async ({ page }) => {
  const edgeId = (await renderedEdgeIds(page))[0];
  expect(edgeId).toBeTruthy();

  await setViewport(page, { x: 120, y: 80, zoom: 0.6 });
  const before = await snapshot(page);

  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), edgeId);
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  const focus = await focusState(page);
  expect(focus.strongEdgeIds).toEqual([edgeId]);
  expect(focus.edgeIds).toEqual([edgeId]);

  const after = await snapshot(page);
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Keyboard non-interference
// ---------------------------------------------------------------------------
test('selection does not hijack the spatial cursor', async ({ page }) => {
  await page.evaluate(() => window.__erdNav.setCursor('person'));
  await page.evaluate(() => window.__erdSelection.selectNodes(['visit_occurrence']));
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  expect(await page.evaluate(() => window.__erdNav.getCursor())).toBe('person');
});

test('arrow navigation still moves the cursor while a node is selected', async ({ page }) => {
  await page.evaluate(() => window.__erdNav.setCursor('person'));
  await page.evaluate(() => window.__erdSelection.selectNodes(['person']));
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  await canvas(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.__erdNav.getCursor())).not.toBe('person');

  // Selection is native state and is not cleared by the keyboard handler.
  expect(await selectedNodeIds(page)).toContain('person');
});

test('Enter toggles the cursor table exactly once while an edge is selected', async ({ page }) => {
  const edgeId = (await renderedEdgeIds(page))[0];
  expect(edgeId).toBeTruthy();

  await page.evaluate(() => window.__erdNav.setCursor('person'));
  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), edgeId);
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  await canvas(page).focus();
  const columns = page.locator('.svelte-flow__node-column[data-id^="person"]');
  const initial = await columns.count();
  expect(initial).toBeGreaterThan(0);

  await page.keyboard.press('Enter');
  await expect(columns).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect.poll(() => columns.count()).toBe(initial);
});

// ---------------------------------------------------------------------------
// Search non-interference
// ---------------------------------------------------------------------------
test('search recentres at the current zoom and relationship focus stays independent', async ({
  page,
}) => {
  await setViewport(page, { x: 100, y: 80, zoom: 0.63 });
  await search(page, 'person');
  await expect(tableCard(page, 'person')).toHaveClass(/highlighted/);
  await page.waitForTimeout(900); // setCenter animation is 500ms

  const zoomAfterSearch = await getViewport(page);
  expect(Math.abs(zoomAfterSearch.zoom - 0.63)).toBeLessThan(0.01);

  await page.evaluate(() => window.__erdSelection.selectNodes(['visit_occurrence']));
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  // Focus is driven by selection, not by the search target; search emphasis
  // remains on the searched table until its own timer clears it.
  const focus = await focusState(page);
  expect(focus.tableIds).toContain('visit_occurrence');
  await expect(tableCard(page, 'person')).toHaveClass(/highlighted/);

  const zoomAfterSelect = await getViewport(page);
  expect(Math.abs(zoomAfterSelect.zoom - zoomAfterSearch.zoom)).toBeLessThan(0.001);
});

test('selection after search does not corrupt the search highlight lifecycle', async ({ page }) => {
  await search(page, 'person');
  await expect(tableCard(page, 'person')).toHaveClass(/highlighted/);

  await page.evaluate(() => window.__erdSelection.selectNodes(['visit_occurrence']));
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  // The search highlight is still owned by search and has not been cleared by
  // the selection.
  await expect(tableCard(page, 'person')).toHaveClass(/highlighted/);

  // It clears on its own schedule (1500ms), independent of the selection.
  await page.waitForTimeout(2200);
  await expect(tableCard(page, 'person')).not.toHaveClass(/highlighted/);
  await expect(tableCard(page, 'visit_occurrence')).not.toHaveClass(/highlighted/);
  expect((await focusState(page)).active).toBe(true);
});

// ---------------------------------------------------------------------------
// Lock non-interference
// ---------------------------------------------------------------------------
test('locking disables pointer selection and dragging; no bypass; unlocking restores', async ({
  page,
}) => {
  expect(await page.evaluate(() => window.__erdSelection.getSelectable())).toBe(true);
  expect(await page.evaluate(() => window.__erdSelection.getDraggable())).toBe(true);

  await page.getByRole('button', { name: 'Lock dragging and selection' }).click();
  expect(await page.evaluate(() => window.__erdSelection.getSelectable())).toBe(false);
  expect(await page.evaluate(() => window.__erdSelection.getDraggable())).toBe(false);

  // No selection pathway bypasses the lock: a pointer click on a column row
  // selects nothing and derives no focus.
  await page.locator('.svelte-flow__node-column[data-id^="person"]').first().click();
  await page.waitForTimeout(200);
  expect(await selectedNodeIds(page)).toEqual([]);
  expect((await focusState(page)).active).toBe(false);

  await page.getByRole('button', { name: 'Unlock dragging and selection' }).click();
  expect(await page.evaluate(() => window.__erdSelection.getSelectable())).toBe(true);

  await page.locator('.svelte-flow__node-column[data-id^="person"]').first().click();
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);
  expect((await focusState(page)).tableIds).toContain('person');
});

test('lock governs pointer affordances only; keyboard navigation is unchanged', async ({ page }) => {
  await page.getByRole('button', { name: 'Lock dragging and selection' }).click();
  expect(await page.evaluate(() => window.__erdSelection.getSelectable())).toBe(false);

  await page.evaluate(() => window.__erdNav.setCursor('person'));
  await canvas(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.__erdNav.getCursor())).not.toBe('person');
});

// ---------------------------------------------------------------------------
// Deletion non-interference (deleteKey={null})
// ---------------------------------------------------------------------------
test('Delete with a selected node is non-mutating', async ({ page }) => {
  await page.evaluate(() => window.__erdSelection.selectNodes(['person']));
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  const before = await snapshot(page);
  expect(tableNode(page, 'person')).toHaveCount(1);

  await canvas(page).focus();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);

  // The graph is read-only: deleteKey={null} means the keypress never reaches
  // any deletion handler.
  expect(tableNode(page, 'person')).toHaveCount(1);
  const after = await snapshot(page);
  expect(after).toEqual(before);
  expect((await focusState(page)).active).toBe(true);
});

test('Delete with a selected edge is non-mutating', async ({ page }) => {
  const edgeId = (await renderedEdgeIds(page))[0];
  expect(edgeId).toBeTruthy();

  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), edgeId);
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);

  const before = await snapshot(page);
  await canvas(page).focus();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);

  expect((await renderedEdgeIds(page))).toContain(edgeId);
  const after = await snapshot(page);
  expect(after).toEqual(before);
  expect((await focusState(page)).strongEdgeIds).toEqual([edgeId]);
});

// ---------------------------------------------------------------------------
// Multi-selection rule (deterministic union; edge precedence)
//
//   nodes [A, B] only      -> union of A's and B's relationships
//   edges [e1, e2] present -> edge precedence; union of both edges' endpoints
// ---------------------------------------------------------------------------
test('multi-node selection focuses the union of their relationships', async ({ page }) => {
  const a = 'person';
  const b = 'visit_occurrence';

  await page.evaluate((id) => window.__erdSelection.selectNodes([id]), a);
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);
  const fa = await focusState(page);

  await page.evaluate((id) => window.__erdSelection.selectNodes([id]), b);
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);
  const fb = await focusState(page);

  await page.evaluate((ids) => window.__erdSelection.selectNodes(ids), [a, b]);
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);
  const both = await focusState(page);

  const expectedTables = new Set([...fa.tableIds, ...fb.tableIds]);
  const expectedEdges = new Set([...fa.edgeIds, ...fb.edgeIds]);
  expect(new Set(both.tableIds)).toEqual(expectedTables);
  expect(new Set(both.edgeIds)).toEqual(expectedEdges);
  expect(both.strongEdgeIds).toEqual([]);
});

test('multi-edge selection takes precedence and focuses the union of endpoints', async ({ page }) => {
  const ids = await renderedEdgeIds(page);
  const e1 = ids[0];
  const e2 = ids[1];
  expect(e1).toBeTruthy();
  expect(e2).toBeTruthy();

  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), e1);
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);
  const f1 = await focusState(page);

  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), e2);
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);
  const f2 = await focusState(page);

  // Select both edges plus an unrelated table: edges take precedence, so the
  // table's neighbourhood must not leak into the focus set.
  const nodeIds: string[] = ['person'];
  const edgeIds: string[] = [e1, e2];
  await page.evaluate(
    ([n, e]) => window.__erdSelection.selectNodesAndEdges(n, e),
    [nodeIds, edgeIds] as const
  );
  await expect.poll(() => focusState(page).then((f) => f.active)).toBe(true);
  const both = await focusState(page);

  expect(new Set(both.strongEdgeIds)).toEqual(new Set([e1, e2]));
  expect(new Set(both.edgeIds)).toEqual(new Set([e1, e2]));
  expect(new Set(both.tableIds)).toEqual(new Set([...f1.tableIds, ...f2.tableIds]));
});
