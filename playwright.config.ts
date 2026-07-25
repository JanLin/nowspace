// loopback/playwright.config.ts — config for NowSpace's DnD e2e loop.
// Move to the repo ROOT (or pass with `-c`) so Playwright finds it.
//
// NowSpace specifics:
//  - Vite dev server is pinned to port 1420 (strictPort, Tauri convention).
//  - The app is in frontend/, so the dev command runs there.
//  - DnD persistence goes through the FastAPI backend (port 8000). Start the backend
//    separately against a TEST vault before running (see SETUP.md) — webServer here only
//    boots the UI.
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.PORT ?? '1420';
const BASE = process.env.BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './loopback',
  globalSetup: './loopback/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: process.env.WEB_CMD ?? 'npm --prefix frontend run dev',
    url: BASE,
    reuseExistingServer: true,   // won't fight a dev server you already have running
    timeout: 60_000,
  },
});
