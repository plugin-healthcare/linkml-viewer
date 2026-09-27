import { defineConfig, devices } from '@playwright/test';

// Browser acceptance layer for the ERD viewer. These tests exercise the
// temporal interaction contracts (viewport vs layout, search vs zoom, highlight
// lifecycle, LOD thresholds) that compiler checks cannot establish.
//
// `bun run test:e2e` runs the fast interaction/navigation specs.
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/playwright',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // The viewer runs an async ELK layout per rebuild, the dev server drives the
  // producer, and each browser worker is heavy; concurrent workers have proven
  // to starve/crash the shared dev server mid-suite. Serial execution trades
  // wall-clock time for a deterministic run of the full contract.
  workers: 1,
  // Retries are for CI only; traces are captured on the first retry rather than
  // on every successful run (Playwright's recommended default).
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1600, height: 900 },
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
