import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// This runner always uses real, headed Edge windows. It never silently falls
// back to headless. The profile and evidence stay outside the source tree.
const base = 'http://localhost:5108';
const hold = Number(process.env.BIDDING_WAR_HOLD_MS ?? 0);
assert(Number.isFinite(hold) && hold >= 0, 'Invalid BIDDING_WAR_HOLD_MS');
const duration = Number(process.env.BIDDING_WAR_CLOSE_MS ?? 45000);
assert(Number.isFinite(duration) && duration >= 30000 && duration <= 600000, 'BIDDING_WAR_CLOSE_MS must be 30000–600000');
const executable = process.env.EDGE_EXECUTABLE ?? `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`;
await access(executable).catch(() => { throw new Error('Headed Edge is unavailable; no test was run.'); });
assert.deepEqual(await (await fetch(`${base}/api/health`)).json().then(({ ok, db }) => ({ ok, db })), { ok: true, db: 'ok' });
const activeFile = join(tmpdir(), 'auction-part-8-bidding-war-active.json');
try {
  const previous = JSON.parse(await readFile(activeFile, 'utf8'));
  const oldBrowser = await chromium.connectOverCDP(previous.endpoint, { timeout: 2000 });
  await (await oldBrowser.newBrowserCDPSession()).send('Browser.close');
} catch { /* A previous test's own browser may already have been closed. */ }
const directory = await mkdtemp(join(tmpdir(), 'part-8-bidding-war-'));
const profile = join(directory, 'edge-profile');
const edge = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2', 'about:blank'], { detached: true, stdio: 'ignore', windowsHide: false });
edge.unref();
let endpoint;
for (let attempt = 0; attempt < 100; attempt++) {
  try { endpoint = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; }
  catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
}
assert(endpoint, 'Headed Edge could not start; no auction was published.');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint[0]}`);
await writeFile(activeFile, JSON.stringify({ endpoint: `http://127.0.0.1:${endpoint[0]}`, profile }));
const context = browser.contexts()[0];
await context.addInitScript(() => {
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => timeout(callback, delay === 5000 ? 2147483647 : delay, ...args);
  // During live proof, foreground reads must not mask a missing notification.
  // Restore the real handlers for the separate foreground/deadline checks.
  window.__auctionLiveProof = false;
  for (const [target, eventType] of [[window, 'focus'], [document, 'visibilitychange']]) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    const wrappers = new WeakMap();
    target.addEventListener = (type, listener, options) => {
      if (type !== eventType || !listener) return add(type, listener, options);
      const wrapper = function (event) {
        if (!window.__auctionLiveProof) {
          if (typeof listener === 'function') listener.call(this, event); else listener.handleEvent(event);
        }
      };
      wrappers.set(listener, wrapper);
      return add(type, wrapper, options);
    };
    target.removeEventListener = (type, listener, options) => remove(type, type === eventType && listener ? wrappers.get(listener) ?? listener : listener, options);
  }
});
const root = await browser.newBrowserCDPSession();
const initialPages = context.pages();
const pages = [];
const windows = [];
const errors = [];
const liveEvidence = [];
const audit = [];
let reviewUrl;
try {
  // Check real window tiling before publishing or sending any bids.
  const screenPage = initialPages[0];
  const screen = await screenPage.evaluate(() => ({ width: window.screen.availWidth, height: window.screen.availHeight, left: window.screen.availLeft ?? 0, top: window.screen.availTop ?? 0 }));
  const width = Math.floor(screen.width / 2), height = Math.floor(screen.height / 2);
  assert(width >= 500 && height >= 300, 'Display cannot fit four usable windows; no auction was published.');
  for (let index = 0; index < 4; index++) {
    const nextPage = context.waitForEvent('page');
    const { targetId } = await root.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const page = await nextPage;
    const { windowId } = await root.send('Browser.getWindowForTarget', { targetId });
    const bounds = { left: screen.left + (index % 2) * width, top: screen.top + Math.floor(index / 2) * height, width, height, windowState: 'normal' };
    await root.send('Browser.setWindowBounds', { windowId, bounds });
    const actual = (await root.send('Browser.getWindowBounds', { windowId })).bounds;
    assert(actual.windowState === 'normal' && Math.abs(actual.left - bounds.left) <= 10 && Math.abs(actual.top - bounds.top) <= 10 && Math.abs(actual.width - width) <= 20 && Math.abs(actual.height - height) <= 20, 'Headed window tiling unavailable; no auction was published.');
    pages.push(page); windows.push({ windowId, bounds });
    const record = { notifications: [], reads: [] };
    audit.push(record);
    page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string' && payload.startsWith('42')) {
        try {
          const [event, data] = JSON.parse(payload.slice(2));
          if (event === 'auction:changed') record.notifications.push({ at: Date.now(), auctionSlug: data.auctionSlug });
        } catch { /* Heartbeats and unrelated frames are not change events. */ }
      }
    }));
    page.on('request', (request) => {
      if (request.method() === 'GET' && reviewUrl && request.url() === `${base}/api/auctions/${reviewUrl.split('/').at(-1)}`) record.reads.push({ at: Date.now() });
    });
    page.on('pageerror', (error) => errors.push(error.message));
  }
  for (const page of initialPages) await page.close();
  console.log('Headed Edge available: four distinct windows tiled 2x2.');
  const users = ['alex-morgan', 'jordan-lee', 'sam-rivera', 'taylor-reed'];
  await Promise.all(pages.map(async (page, index) => {
    await page.goto(base);
    await page.getByLabel('Active demo user').selectOption(users[index]);
    // Pending notices from earlier runs must not block the setup form.
    await page.waitForTimeout(750);
    const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
    while (await dismiss.count()) {
      await dismiss.click();
      await page.waitForTimeout(100);
    }
  }));
  // Theme persistence/overflow checks happen before the live auction exists;
  // no reload can reveal another bidder's state later in the proof.
  const third = pages[3];
  const thirdCdp = await context.newCDPSession(third);
  for (const theme of ['marketplace', 'journal', 'terminal']) {
    await third.locator(`.theme-option.${theme}`).click();
    await expect(third.locator('.app-shell')).toHaveAttribute('data-theme', theme);
    await thirdCdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert(await third.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${theme}: mobile horizontal overflow`);
    await third.screenshot({ path: join(directory, `mobile-${theme}.png`), fullPage: true });
    await thirdCdp.send('Emulation.clearDeviceMetricsOverride');
  }
  await third.locator('.theme-option.marketplace').click();
  await root.send('Browser.setWindowBounds', windows[3]);
  const seller = pages[0];
  await seller.goto(`${base}/auctions/new`);
  await seller.getByLabel('Title', { exact: true }).fill(`Protected bidding review ${new Date().toISOString()}`);
  await seller.getByLabel('Description', { exact: true }).fill('Live competitive bidding: Redis notifications, authoritative HTTP state, protected bids and closing-time enforcement.');
  await seller.locator('select[name="category"]').selectOption('GPUs');
  await seller.getByLabel('Condition', { exact: true }).fill('Used · Fully tested');
  await seller.getByLabel('Location', { exact: true }).fill('Austin, TX');
  await seller.getByLabel('Starting price (USD)').fill('100.00');
  const close = new Date(Date.now() + duration);
  const localClose = new Date(close.getTime() - close.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  await seller.getByLabel('Closing date and time').fill(localClose);
  await seller.getByRole('button', { name: 'Publish auction', exact: true }).click();
  await seller.waitForURL('**/items/**');
  reviewUrl = seller.url();
  console.log(`Review auction: ${reviewUrl}`);
  await expect(seller.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await Promise.all(pages.slice(1).map((page) => page.goto(reviewUrl)));
  for (const page of pages) {
    await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
    await page.evaluate(() => { window.__auctionLiveProof = true; });
  }
  const mark = () => audit.map((record) => ({ notifications: record.notifications.length, reads: record.reads.length }));
  async function proveObservers(label, baseline, observers, price, count) {
    const proof = [];
    for (const index of observers) {
      const page = pages[index], record = audit[index];
      await expect(page.getByTestId('current-price')).toHaveText(price);
      await expect(page.getByTestId('bid-history-entry')).toHaveCount(count);
      const notifications = record.notifications.slice(baseline[index].notifications).filter((event) => event.auctionSlug === reviewUrl.split('/').at(-1));
      const reads = record.reads.slice(baseline[index].reads);
      assert(notifications.length > 0 && reads.some((read) => read.at >= notifications[0].at), `${label}: window ${index + 1} needs a Socket.IO notification followed by an authoritative HTTP read`);
      proof.push({ window: index + 1, notifications, reads, price, count });
    }
    liveEvidence.push({ label, observers: proof });
  }
  const equalMark = mark();
  const bidders = pages.slice(1, 3);
  const held = [];
  let posts = 0;
  for (const page of bidders) {
    await page.route('**/api/auctions/*/bids', async (route) => { posts++; held.push(route); });
    await page.getByLabel('Your bid (USD)').fill('101.00');
  }
  const replies = bidders.map((page) => page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/bids')));
  await Promise.all(bidders.map((page) => page.getByRole('button', { name: 'Place bid', exact: true }).click()));
  await expect.poll(() => held.length).toBe(2);
  await Promise.all(held.map((route) => route.continue()));
  const responses = await Promise.all(replies);
  assert.deepEqual(responses.map((response) => response.status()).sort(), [201, 409], 'Equal concurrent bids must yield one acceptance and one conflict');
  const loserIndex = responses.findIndex((response) => response.status() === 409);
  const loser = bidders[loserIndex];
  await expect(loser.getByRole('region', { name: 'Place a bid' }).getByRole('status')).toContainText('below the updated minimum');
  await expect(loser.getByLabel('Your bid (USD)')).toHaveValue('101.00');
  await expect(loser.getByTestId('current-price')).toHaveText('$101.00');
  await expect(loser.getByText('Minimum bid $102.00', { exact: false })).toBeVisible();
  for (const page of bidders) await page.unroute('**/api/auctions/*/bids');
  await proveObservers('equal competing bids', equalMark, [0, 3], '$101.00', 1);
  await expect(third.getByTestId('current-price')).toHaveText('$101.00');
  const increasingMark = mark();
  await third.getByLabel('Your bid (USD)').fill('102.00');
  await third.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(third.getByRole('region', { name: 'Place a bid' }).getByRole('status')).toHaveText('Bid accepted.');
  await expect(third.getByLabel('Your bid (USD)')).toHaveValue('');
  await proveObservers('next increasing bid', increasingMark, [0, 1, 2], '$102.00', 2);
  let state = await (await fetch(`${base}/api/auctions/${reviewUrl.split('/').at(-1)}`)).json();
  assert.equal(state.bidCount, 2);
  let accepted = [...state.bids].reverse();
  assert.deepEqual(accepted.map((bid) => bid.amountMinor), [10100, 10200]);
  for (let index = 1; index < accepted.length; index++) assert(accepted[index].amountMinor >= accepted[index - 1].amountMinor + 100, 'Accepted amounts must increase in acceptance order');
  assert.equal(posts, 2, 'No automatic resubmission');
  const recoveryBidder = bidders[1 - loserIndex];
  let failedPosts = 0;
  await recoveryBidder.route('**/api/auctions/*/bids', async (route) => { failedPosts++; await route.abort('failed'); });
  await recoveryBidder.getByLabel('Your bid (USD)').fill('103.00');
  await recoveryBidder.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(recoveryBidder.getByRole('region', { name: 'Place a bid' }).getByRole('status')).toContainText('Acceptance is unconfirmed');
  await expect(recoveryBidder.getByLabel('Your bid (USD)')).toHaveValue('103.00');
  await expect(recoveryBidder.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  assert.equal(failedPosts, 1, 'Never retry an uncertain submission automatically');
  await recoveryBidder.unroute('**/api/auctions/*/bids');
  await recoveryBidder.getByRole('button', { name: 'Refresh auction', exact: true }).click();
  await expect(recoveryBidder.getByRole('button', { name: 'Place bid', exact: true })).toBeEnabled();
  await expect(recoveryBidder.getByTestId('current-price')).toHaveText('$102.00');
  await expect(recoveryBidder.getByTestId('bid-history-entry')).toHaveCount(2);
  const deadline = Date.parse(state.endsAt);
  async function waitUntil(instant) {
    while (Date.now() < instant) await new Promise((resolve) => setTimeout(resolve, Math.min(250, instant - Date.now())));
  }
  assert(Date.now() < deadline - 7000, 'Pre-deadline checks exhausted the short auction; rerun with a longer BIDDING_WAR_CLOSE_MS.');
  console.log(`Core bidding checks passed. Closing at ${state.endsAt}; verifying near-deadline, delayed delivery, offline timer and foreground return.`);
  // Quiet refresh must preserve the stale amount until the bidder edits it.
  await expect(loser.getByLabel('Your bid (USD)')).toHaveValue('101.00');
  await loser.screenshot({ path: join(directory, 'stale-bid-feedback.png') });
  const nearBidder = bidders[1 - loserIndex];
  await waitUntil(deadline - 5000);
  const nearMark = mark();
  await nearBidder.getByLabel('Your bid (USD)').fill('103.00');
  await nearBidder.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(nearBidder.getByRole('region', { name: 'Place a bid' }).getByRole('status')).toHaveText('Bid accepted.');
  await proveObservers('near-deadline bid', nearMark, pages.map((_page, index) => index).filter((index) => pages[index] !== nearBidder), '$103.00', 3);
  // Live proof is complete before exercising explicit recovery and foreground
  // checks. Those actions cannot supply the assertions already recorded above.
  for (const page of pages) await page.evaluate(() => { window.__auctionLiveProof = false; });
  // Send another request before closing, but deliver it after closing. It must
  // be rejected even though the user clicked while the auction was still open.
  const lateRoutes = [];
  await third.route('**/api/auctions/*/bids', async (route) => lateRoutes.push(route));
  await third.getByLabel('Your bid (USD)').fill('104.00');
  const lateReply = third.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/bids'));
  await waitUntil(deadline - 2000);
  await third.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect.poll(() => lateRoutes.length).toBe(1);
  const frozen = nearBidder;
  const frozenCdp = await context.newCDPSession(frozen);
  await frozenCdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  // No successful GET may be needed to turn the active loser page to Ended.
  await loser.route('**/api/auctions/*', async (route) => route.abort('failed'));
  await waitUntil(deadline + 100);
  await expect(loser.getByTestId('auction-status')).toHaveText('Ended');
  await expect(loser.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await expect(loser.getByLabel('Your bid (USD)')).toBeDisabled();
  await lateRoutes[0].continue();
  const lateResponse = await lateReply;
  assert.equal(lateResponse.status(), 409);
  assert.equal((await lateResponse.json()).message, 'This auction is closed.');
  await third.unroute('**/api/auctions/*/bids');
  await expect(third.getByRole('region', { name: 'Place a bid' }).getByRole('status')).toHaveText('This auction is closed.');
  await frozenCdp.send('Page.setWebLifecycleState', { state: 'active' });
  await frozen.bringToFront();
  const foregroundRead = frozen.waitForRequest((request) => request.method() === 'GET' && request.url().endsWith(`/api/auctions/${state.slug}`));
  await frozen.evaluate(() => window.dispatchEvent(new Event('focus')));
  await foregroundRead;
  await expect(frozen.getByTestId('auction-status')).toHaveText('Ended');
  await expect(frozen.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await loser.getByRole('button', { name: 'Refresh auction', exact: true }).click();
  await expect(loser.getByRole('alert')).toBeVisible();
  await expect(loser.getByRole('button', { name: 'Retry refresh', exact: true })).toBeVisible();
  await expect(loser.getByTestId('auction-status')).toHaveText('Ended');
  await loser.unroute('**/api/auctions/*');
  const late = await fetch(`${base}/api/auctions/${state.slug}/bids`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bidderId: 'taylor-reed', amountMinor: 10400 }) });
  assert.equal(late.status, 409, 'Direct late requests must be rejected by the server');
  // Deadline enforcement is immediate; the durable outcome is committed by the
  // asynchronous close worker on its next poll. Do not conflate those instants.
  await expect.poll(async () => {
    state = await (await fetch(`${base}/api/auctions/${state.slug}`)).json();
    return state.finalOutcome?.winningBid?.amountMinor;
  }, { timeout: 15000, message: 'The close worker must persist the highest accepted bid' }).toBe(10300);
  state = await (await fetch(`${base}/api/auctions/${state.slug}`)).json();
  accepted = [...state.bids].reverse();
  assert.deepEqual(accepted.map((bid) => bid.amountMinor), [10100, 10200, 10300]);
  assert(accepted.every((bid) => Date.parse(bid.acceptedAt) < deadline), 'No accepted timestamp may reach or exceed closing');
  assert.equal(state.isClosed, true, 'The auction detail must report the persisted close outcome');
  assert.equal(state.finalOutcome?.winningBid?.amountMinor, 10300, 'The persisted outcome must contain the highest accepted bid');
  const winnerId = state.finalOutcome.winningBid.bidderId;
  const winnerName = { 'jordan-lee': 'Jordan Lee', 'sam-rivera': 'Sam Rivera' }[winnerId];
  const winnerIndex = users.indexOf(winnerId);
  assert(winnerName && winnerIndex > 0, 'The close outcome must name the participating winning bidder');
  const sellerDialog = seller.getByRole('dialog');
  const winnerDialog = pages[winnerIndex].getByRole('dialog');
  await expect(sellerDialog).toContainText('Auction closed', { timeout: 30000 });
  await expect(sellerDialog).toContainText(`${winnerName} won`);
  await expect(winnerDialog).toContainText('Congratulations', { timeout: 30000 });
  await expect(winnerDialog).toContainText('You won');
  const popupEvidence = {
    sellerUserId: users[0],
    sellerModal: await sellerDialog.innerText(),
    winnerUserId: winnerId,
    winnerModal: await winnerDialog.innerText(),
    finalOutcome: state.finalOutcome,
  };
  const pageEvidence = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    // Fail if a window left the auction; navigation must not repair live proof.
    await expect(page).toHaveURL(reviewUrl);
    await root.send('Browser.setWindowBounds', { windowId: windows[index].windowId, bounds: { windowState: 'normal' } });
    await root.send('Browser.setWindowBounds', windows[index]);
    await page.bringToFront();
    assert.equal((await root.send('Browser.getWindowBounds', { windowId: windows[index].windowId })).bounds.windowState, 'normal');
    await expect(page.getByTestId('current-price')).toHaveText('$103.00');
    await expect(page.getByTestId('auction-status')).toHaveText('Ended');
    await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
    await page.locator(index === 0 ? '.auction-panel' : '.bidding-section').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(directory, `window-${index + 1}.png`), timeout: 5000 });
    await expect(page.getByLabel('Active demo user')).toHaveValue(users[index]);
    pageEvidence.push({ userId: users[index], url: page.url(), status: await page.getByTestId('auction-status').innerText(), biddingDisabled: await page.getByRole('button', { name: 'Place bid', exact: true }).isDisabled(), screenshot: `window-${index + 1}.png` });
  }
  await expect(loser.getByRole('region', { name: 'Place a bid' }).getByRole('status')).toContainText('below the updated minimum');
  await expect(loser.getByLabel('Your bid (USD)')).toHaveValue('101.00');
  assert.deepEqual(errors, [], 'No browser page errors');
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, reviewUrl,
    duplicateResponses: responses.map((response, index) => ({ bidderId: users[index + 1], amountMinor: 10100, status: response.status() })),
    delayedAfterDeadline: { status: lateResponse.status(), message: 'This auction is closed.' },
    directLateRequest: { status: late.status },
    accepted, finalOutcome: state.finalOutcome, popupEvidence, pages: pageEvidence, evidence: directory, windows: 4, headed: true,
    pollingDisabled: true, foregroundReadsSuppressedDuringLiveProof: true, liveEvidence,
    synchronizationReloads: 0, synchronizationRefreshes: 0,
    explicitRecoveryActions: ['uncertain POST successful refresh', 'failed refresh after offline deadline'],
    closingTimeTests: 'passed', deadline: state.endsAt, holdMs: hold }, null, 2));
  console.log(`PASS: protected equal bids, persisted winning outcome, seller and winner popups, stale state, increasing history, near-deadline acceptance, late rejections, Ended/disabled pages, offline deadline timer, foreground refresh, no automatic retries, four identities, themes/mobile. Evidence: ${directory}`);
  console.log(`Holding for ${hold} ms; Edge windows remain open after runner exit.`);
  const until = Date.now() + hold;
  while (Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
  // Edge was launched detached, independently of Playwright. Disconnect by
  // ending this client process; do not send Browser.close or destroy windows.
  process.exit(0);
} catch (error) {
  await Promise.allSettled(pages.map((page, index) => page.screenshot({ path: join(directory, `failure-window-${index + 1}.png`), fullPage: true, timeout: 5000 })));
  await writeFile(join(directory, 'failure.txt'), String(error));
  console.error(`FAILED: ${error.stack}\nEvidence: ${directory}\nReview auction: ${reviewUrl ?? 'not published'}`);
  process.exit(1);
}
