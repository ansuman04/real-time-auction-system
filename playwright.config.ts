import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './web/browser-tests',
  testMatch: '**/*.pw.ts',
  workers: 1,
  reporter: 'line',
  outputDir: mkdtempSync(join(tmpdir(), 'part8-recovery-tests-')),
  use: {
    baseURL: 'http://localhost:5108',
    channel: 'msedge',
    headless: true,
    screenshot: 'only-on-failure',
  },
});
