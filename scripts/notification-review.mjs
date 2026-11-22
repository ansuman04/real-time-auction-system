import { chromium, expect } from '@playwright/test';
import pg from 'pg';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const webUrl = process.env.WEB_URL ?? 'http://localhost:5108';
const apiUrl = process.env.API_URL ?? 'http://localhost:3108';
const holdMs = Number(process.env.PART8_REVIEW_HOLD_MS ?? 600_000);
if (!Number.isInteger(holdMs) || holdMs < 30_000 || holdMs > 1_800_000) {
  throw new RangeError('PART8_REVIEW_HOLD_MS must be from 30000 to 1800000.');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL });
const browsers = [];
let reviewSlug;
let successful = false;

async function cleanReviewAuction(slug) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT slug FROM auctions WHERE slug=$1 FOR UPDATE', [slug]);
    await client.query('DELETE FROM recipient_notifications WHERE auction_slug=$1', [slug]);
    await client.query('DELETE FROM outbox_events WHERE auction_slug=$1', [slug]);
    await client.query('DELETE FROM auction_closes WHERE auction_slug=$1', [slug]);
    await client.query('DELETE FROM bids WHERE auction_slug=$1', [slug]);
    await client.query('DELETE FROM auctions WHERE slug=$1', [slug]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

try {
  const screenshotDir = await mkdtemp(join(tmpdir(), 'part8-notification-review-'));
  const launch = (x) => chromium.launch({
    channel: 'msedge',
    headless: false,
    args: [`--window-position=${x},0`, '--window-size=680,760'],
  });
  const [sellerBrowser, winnerBrowser] = await Promise.all([launch(0), launch(680)]);
  browsers.push(sellerBrowser, winnerBrowser);
  const [sellerContext, winnerContext] = await Promise.all([
    sellerBrowser.newContext({ viewport: null }),
    winnerBrowser.newContext({ viewport: null }),
  ]);
  const [sellerPage, winnerPage] = await Promise.all([sellerContext.newPage(), winnerContext.newPage()]);
  await sellerPage.addInitScript(() => sessionStorage.setItem('auction-part-8-active-user', 'alex-morgan'));
  await winnerPage.addInitScript(() => sessionStorage.setItem('auction-part-8-active-user', 'jordan-lee'));
  await Promise.all([sellerPage.goto(webUrl), winnerPage.goto(webUrl)]);
  await expect(sellerPage.getByLabel('Active demo user')).toHaveValue('alex-morgan');
  await expect(winnerPage.getByLabel('Active demo user')).toHaveValue('jordan-lee');

  const endsAt = new Date(Date.now() + 20_000).toISOString();
  const created = await fetch(`${apiUrl}/api/auctions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `Popup review ${new Date().toISOString()}`,
      description: 'Intentional review auction for seller and winner popup verification.',
      category: 'Other',
      condition: 'Used',
      sellerId: 'alex-morgan',
      location: 'Review fixture',
      startingPrice: '100.00',
      endsAt,
    }),
  });
  if (!created.ok) throw new Error(`Auction creation failed: ${created.status} ${await created.text()}`);
  const auction = await created.json();
  reviewSlug = auction.slug;

  const bid = await fetch(`${apiUrl}/api/auctions/${encodeURIComponent(reviewSlug)}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bidderId: 'jordan-lee', amountMinor: 12_500 }),
  });
  if (bid.status !== 201) throw new Error(`Winning bid failed: ${bid.status} ${await bid.text()}`);

  const sellerDialog = sellerPage.getByRole('dialog');
  const winnerDialog = winnerPage.getByRole('dialog');
  await Promise.all([
    sellerDialog.waitFor({ state: 'visible', timeout: 60_000 }),
    winnerDialog.waitFor({ state: 'visible', timeout: 60_000 }),
  ]);
  await expect(sellerDialog).toContainText('Jordan Lee won');
  await expect(winnerDialog).toContainText('You won');
  await Promise.all([
    sellerPage.screenshot({ path: join(screenshotDir, 'seller-popup.png') }),
    winnerPage.screenshot({ path: join(screenshotDir, 'winner-popup.png') }),
  ]);

  successful = true;
  console.log(JSON.stringify({
    status: 'Seller and winner popups verified in two headed Edge windows.',
    auctionSlug: reviewSlug,
    sellerMessage: await sellerDialog.innerText(),
    winnerMessage: await winnerDialog.innerText(),
    screenshots: screenshotDir,
    holdMs,
  }, null, 2));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
} finally {
  await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
  if (!successful && reviewSlug) await cleanReviewAuction(reviewSlug).catch((error) => console.error('Review fixture cleanup failed.', error));
  await pool.end();
}
