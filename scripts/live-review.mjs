import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Slice 1 proof only: two independent profiles/windows, no bidding-war changes.
const base = 'http://localhost:5108';
const executable = process.env.EDGE_EXECUTABLE ?? `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`;
await access(executable).catch(() => { throw new Error('Headed Edge unavailable; no verification or publication was run.'); });
assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
const directory = await mkdtemp(join(tmpdir(), 'part-6-live-review-'));
const activeFile = join(tmpdir(), 'auction-part-8-live-review-active.json');
try {
  const previous = JSON.parse(await readFile(activeFile, 'utf8'));
  for (const endpoint of previous.endpoints) {
    try { const old = await chromium.connectOverCDP(endpoint, { timeout: 2000 }); await (await old.newBrowserCDPSession()).send('Browser.close'); }
    catch { /* Only this runner's previous isolated profiles are considered. */ }
  }
} catch { /* No prior runner manifest. */ }
const endpoints = [];
const pages = [], browsers = [], windows = [];
let reviewUrl;
try {
  for (let index = 0; index < 2; index++) {
    const profile = join(directory, `profile-${index}`);
    const edge = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2', 'about:blank'], { detached: true, stdio: 'ignore', windowsHide: false });
    edge.unref();
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert(port, 'Edge debugging unavailable; no auction published.');
    const endpoint = `http://127.0.0.1:${port}`;
    endpoints.push(endpoint);
    await writeFile(activeFile, JSON.stringify({ endpoints, directory }));
    const browser = await chromium.connectOverCDP(endpoint);
    browsers.push(browser);
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    await context.addInitScript(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => original(callback, delay === 5000 ? 2147483647 : delay, ...args);
    });
    const root = await browser.newBrowserCDPSession();
    const screen = await page.evaluate(() => ({ width: window.screen.availWidth, height: window.screen.availHeight, left: window.screen.availLeft ?? 0, top: window.screen.availTop ?? 0 }));
    const width = Math.floor(screen.width / 2);
    assert(width >= 500 && screen.height >= 600, 'Display cannot fit two usable windows; no auction published.');
    const { targetInfo } = await (await context.newCDPSession(page)).send('Target.getTargetInfo');
    const { windowId } = await root.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    const bounds = { left: screen.left + index * width, top: screen.top, width, height: screen.height, windowState: 'normal' };
    await root.send('Browser.setWindowBounds', { windowId, bounds });
    const actual = (await root.send('Browser.getWindowBounds', { windowId })).bounds;
    assert(Math.abs(actual.left - bounds.left) <= 10 && Math.abs(actual.width - width) <= 20 && actual.windowState === 'normal', 'Window tiling unavailable; no auction published.');
    windows.push(actual);
    pages.push(page);
  }
  console.log('Two independent headed Edge sessions are visibly tiled side by side.');
  const [bidder, watcher] = pages;
  await Promise.all(pages.map((page) => page.goto(base)));
  await bidder.getByLabel('Active demo user').selectOption('alex-morgan');
  await watcher.getByLabel('Active demo user').selectOption('sam-rivera');
  await bidder.goto(`${base}/auctions/new`);
  await bidder.getByLabel('Title', { exact: true }).fill(`Live detail review ${new Date().toISOString()}`);
  await bidder.getByLabel('Description', { exact: true }).fill('Two-session Socket.IO updates through Redis, with authoritative HTTP snapshots and protected bidding.');
  await bidder.locator('select[name="category"]').selectOption('GPUs');
  await bidder.getByLabel('Condition', { exact: true }).fill('Used · Fully tested');
  await bidder.getByLabel('Location', { exact: true }).fill('Austin, TX');
  await bidder.getByLabel('Starting price (USD)').fill('100.00');
  const close = new Date(Date.now() + 86400000);
  await bidder.getByLabel('Closing date and time').fill(new Date(close.getTime() - close.getTimezoneOffset() * 60000).toISOString().slice(0, 19));
  await bidder.getByRole('button', { name: 'Publish auction', exact: true }).click();
  await bidder.waitForURL('**/items/**');
  reviewUrl = bidder.url();
  await bidder.getByLabel('Active demo user').selectOption('jordan-lee');
  await watcher.goto(reviewUrl);
  for (const page of pages) await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
  await watcher.getByLabel('Your bid (USD)').fill('105.00');
  const received = [], reads = [];
  // Attach to the established page's live transport before bidding.
  const cdp = await watcher.context().newCDPSession(watcher);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    if (response.payloadData.includes('auction:changed')) received.push({ at: Date.now(), frame: response.payloadData });
  });
  watcher.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/auctions/${reviewUrl.split('/').at(-1)}`) reads.push({ at: Date.now(), url: request.url() });
  });
  await bidder.getByLabel('Your bid (USD)').fill('101.00');
  await bidder.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(watcher.getByTestId('current-price')).toHaveText('$101.00');
  await expect(watcher.getByTestId('bid-history-entry')).toHaveCount(1);
  await expect(watcher.getByTestId('bid-history-entry').first()).toContainText('Jordan Lee');
  await expect(watcher.getByLabel('Your bid (USD)')).toHaveValue('105.00');
  assert(received.length >= 1 && reads.some((read) => read.at >= received[0].at), 'Expected notification before authoritative watcher HTTP refresh');
  await expect(bidder.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await expect(bidder.getByText('You are the highest bidder. You can bid again after someone outbids you.', { exact: true })).toBeVisible();
  const repeated = await bidder.request.post(`${base}/api/auctions/${reviewUrl.split('/').at(-1)}/bids`, { data: { bidderId: 'jordan-lee', amountMinor: 10200 } });
  assert.equal(repeated.status(), 409, 'The API must reject a leader raising their own bid');
  assert.equal((await repeated.json()).auction.bidCount, 1);
  await watcher.context().setOffline(true);
  await expect(watcher.getByTestId('live-status')).toContainText('reconnecting');
  await bidder.getByLabel('Active demo user').selectOption('taylor-reed');
  await bidder.getByLabel('Your bid (USD)').fill('102.00');
  await bidder.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(bidder.getByTestId('current-price')).toHaveText('$102.00');
  await watcher.context().setOffline(false);
  await expect(watcher.getByTestId('current-price')).toHaveText('$102.00');
  await expect(watcher.getByTestId('live-status')).toHaveText('Live updates connected');
  await expect(watcher.getByTestId('bid-history-entry')).toHaveCount(2);
  await bidder.getByLabel('Active demo user').selectOption('jordan-lee');
  await expect(bidder.getByRole('button', { name: 'Place bid', exact: true })).toBeEnabled();
  await watcher.getByLabel('Your bid (USD)').fill('103.00');
  await watcher.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(bidder.getByTestId('current-price')).toHaveText('$103.00');
  await expect(bidder.getByTestId('bid-history-entry')).toHaveCount(3);
  await expect(watcher.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await expect(watcher.getByText('You are the highest bidder. You can bid again after someone outbids you.', { exact: true })).toBeVisible();
  for (let index = 0; index < pages.length; index++) {
    await pages[index].getByTestId('current-price').scrollIntoViewIfNeeded();
    await pages[index].screenshot({ path: join(directory, `session-${index + 1}.png`) });
  }
  const result = { passed: true, reviewUrl, windows, notifications: received, authoritativeReads: reads, pollingDisabled: true, reloadsOrManualSync: false, highestBidder: { repeatStatus: repeated.status(), leaderDisabled: true, reenabledAfterOutbid: true }, finalPrice: '$103.00', bidCount: 3 };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`PASS: cross-session updates, typed input preserved, offline/reconnect catch-up and reverse-direction bid. ${reviewUrl}\nEvidence: ${directory}`);
  // Disconnect automation by exiting; leave both independent browsers open.
  process.exit(0);
} catch (error) {
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ reviewUrl, error: String(error) }, null, 2));
  console.error(error);
  process.exit(1);
}
