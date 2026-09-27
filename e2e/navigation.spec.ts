import { test, expect } from '@playwright/test';
import {
  waitForGraph,
  getViewport,
  setViewport,
  canvas,
  cursorNode,
  setCursor,
  getCursorId,
  nodeCenter,
  tableNode,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

// ---------------------------------------------------------------------------
// Test 1 — the canvas is reachable and focusable by keyboard
// ---------------------------------------------------------------------------
test('canvas receives keyboard focus', async ({ page }) => {
  await canvas(page).focus();
  await expect(canvas(page)).toBeFocused();
});

// ---------------------------------------------------------------------------
// Test 2 / 3 — ArrowRight / ArrowLeft move to a spatially appropriate neighbour
// (asserted in graph coordinates, because navigation also moves the viewport)
// ---------------------------------------------------------------------------
test('arrow keys move the cursor spatially', async ({ page }) => {
  await setCursor(page, 'person');
  const from = await nodeCenter(page, 'person');
  expect(from).not.toBeNull();

  await canvas(page).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);

  const right = await getCursorId(page);
  expect(right).not.toBeNull();
  expect(right).not.toBe('person');
  const rightCenter = await nodeCenter(page, right!);
  expect(rightCenter!.x).toBeGreaterThan(from!.x + 1);

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);

  const back = await getCursorId(page);
  expect(back).not.toBeNull();
  const backCenter = await nodeCenter(page, back!);
  expect(backCenter!.x).toBeLessThan(rightCenter!.x - 1);
});

// ---------------------------------------------------------------------------
// Test 4 — Enter activates (collapses/expands) the focused table
// ---------------------------------------------------------------------------
test('enter activates the focused table', async ({ page }) => {
  await setCursor(page, 'person');
  await canvas(page).focus();

  const columns = page.locator('.svelte-flow__node-column[data-id^="person"]');
  expect(await columns.count()).toBeGreaterThan(0);

  await page.keyboard.press('Enter');
  await expect(columns).toHaveCount(0);

  // Enter again re-expands (activation is a toggle).
  await page.keyboard.press('Enter');
  await expect.poll(async () => columns.count()).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 4b — Enter on a focused collapse control toggles exactly ONCE.
//
// Regression for the keyboard double-toggle: when DOM focus is on the collapse
// control button, pressing Enter fires the native button activation AND used
// to bubble to the canvas spatial handler (handleCanvasKeydown), collapsing and
// immediately re-expanding (net no-op). One keypress must mean one toggle.
// ---------------------------------------------------------------------------
test('Enter on a focused collapse control toggles exactly once', async ({ page }) => {
  await setCursor(page, 'person');

  const columns = page.locator('.svelte-flow__node-column[data-id^="person"]');
  const initial = await columns.count();
  expect(initial).toBeGreaterThan(0);

  const control = tableNode(page, 'person').locator('.collapse-toggle');
  await control.focus();
  await expect(control).toBeFocused();

  // A single Enter must collapse (0 columns) — a double-toggle would leave them.
  await page.keyboard.press('Enter');
  await expect(columns).toHaveCount(0);

  // A second Enter must re-expand to the original count.
  await tableNode(page, 'person').locator('.collapse-toggle').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => columns.count()).toBe(initial);
});

// ---------------------------------------------------------------------------
// Test 4c — Enter with the canvas container focused still toggles exactly once.
// ---------------------------------------------------------------------------
test('Enter on the focused canvas toggles exactly once', async ({ page }) => {
  await setCursor(page, 'person');
  await canvas(page).focus();
  await expect(canvas(page)).toBeFocused();

  const columns = page.locator('.svelte-flow__node-column[data-id^="person"]');
  const initial = await columns.count();
  expect(initial).toBeGreaterThan(0);

  await page.keyboard.press('Enter');
  await expect(columns).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect.poll(() => columns.count()).toBe(initial);
});

// ---------------------------------------------------------------------------
// Test 4d — single authority: Enter acts on the DOM-focused collapse control,
// not on a stale keyboard cursor pointing at a *different* table.
//
// Regression for the two-authority conflict: with the cursor on `person` and
// DOM focus on `visit_occurrence`'s collapse control, the canvas spatial handler
// used to hijack Enter and collapse `person` while the focused button was
// ignored (its native activation suppressed). A keypress owned by a focused
// control must act on that control.
// ---------------------------------------------------------------------------
test('Enter acts on the focused collapse control, not the stale cursor', async ({ page }) => {
  await setCursor(page, 'person');

  const voColumns = page.locator('.svelte-flow__node-column[data-id^="visit_occurrence"]');
  const personColumns = page.locator('.svelte-flow__node-column[data-id^="person"]');
  expect(await voColumns.count()).toBeGreaterThan(0);
  expect(await personColumns.count()).toBeGreaterThan(0);

  await tableNode(page, 'visit_occurrence').locator('.collapse-toggle').focus();
  await page.keyboard.press('Enter');

  await expect(voColumns).toHaveCount(0);
  await expect(personColumns).not.toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Test 5 — navigation preserves the current zoom (navigate ≠ fit)
// ---------------------------------------------------------------------------
test('navigation preserves zoom', async ({ page }) => {
  await setViewport(page, { x: 0, y: 0, zoom: 0.63 });
  await setCursor(page, 'person');
  await canvas(page).focus();

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);

  const vp = await getViewport(page);
  expect(Math.abs(vp.zoom - 0.63)).toBeLessThan(0.01);
});

// ---------------------------------------------------------------------------
// Test 6 — navigation does not trigger a layout rebuild
// ---------------------------------------------------------------------------
test('navigation does not trigger layout', async ({ page }) => {
  const snapshot = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('.svelte-flow__node-tableParent')].map((e) => [
          e.getAttribute('data-id'),
          (e as HTMLElement).style.transform,
        ])
      )
    );

  const before = await snapshot();
  await setCursor(page, 'person');
  await canvas(page).focus();

  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowUp']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(250);
  }

  const after = await snapshot();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Test 7 — a focused node is not hidden underneath an open editor panel
// (WCAG 2.2 Focus Not Obscured)
// ---------------------------------------------------------------------------
test('focused node stays visible when a panel is open', async ({ page }) => {
  await page.getByRole('button', { name: /Groups/ }).click();
  await expect(page.getByText('Group Colors')).toBeVisible();

  await setCursor(page, null);
  await canvas(page).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(600);

  await expect(cursorNode(page)).toHaveCount(1);

  const pane = await page.locator('.svelte-flow').boundingBox();
  const box = await cursorNode(page).boundingBox();
  expect(pane).not.toBeNull();
  expect(box).not.toBeNull();

  if (pane && box) {
    expect(box.x).toBeGreaterThanOrEqual(pane.x - 2);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 2);
    expect(box.y).toBeGreaterThanOrEqual(pane.y - 2);
    expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 2);
  }
});
