import { test, expect } from '@playwright/test';
import { waitForGraph, getViewport } from './helpers';

// ---------------------------------------------------------------------------
// R2.8.10 — first-load camera (presentation only).
//
// The camera is an explicit product choice, never a semantic one: the producer
// emits no notion of "important". The default is the whole-graph overview
// (unchanged behaviour); the readable-entry camera opens on the configured
// class at a legible zoom. This spec pins both so the product decision is a
// one-constant change, not a hidden regression.
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

test('default first-load camera is the whole-graph overview', async ({ page }) => {
  expect(await page.evaluate(() => window.__erdCamera.getMode())).toBe('overview');
  // Fitting 37 tables is necessarily zoomed out (well below the STRUCTURAL LOD).
  const vp = await getViewport(page);
  expect(vp.zoom).toBeLessThan(0.4);
});

test('readable-entry camera opens on the configured class at a readable zoom', async ({ page }) => {
  const overview = await getViewport(page);

  await page.evaluate(() => window.__erdCamera.setMode('entry'));
  const entry = await getViewport(page);

  expect(await page.evaluate(() => window.__erdCamera.getMode())).toBe('entry');
  // Readable-entry is zoomed in past the STRUCTURAL LOD floor and closer than
  // the whole-graph fit.
  expect(entry.zoom).toBeGreaterThan(0.4);
  expect(entry.zoom).toBeGreaterThan(overview.zoom);

  // Switching back restores the whole-graph fit.
  await page.evaluate(() => window.__erdCamera.setMode('overview'));
  expect(await page.evaluate(() => window.__erdCamera.getMode())).toBe('overview');
  expect((await getViewport(page)).zoom).toBeLessThan(0.4);
});
