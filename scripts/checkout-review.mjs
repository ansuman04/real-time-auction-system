import pg from 'pg';
const api = process.env.PART8_API_URL ?? 'http://localhost:3108';
const web = process.env.PART8_WEB_URL ?? 'http://localhost:5108';
async function post(path, body) {
  const response = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
if (process.argv[2] === '--expire-unpaid') {
  const slug = process.argv[3];
  if (!slug || !/^[a-zA-Z0-9-]{1,160}$/.test(slug)) throw new Error('Pass the review auction slug after --expire-unpaid');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL });
  try {
    const purchase = (await pool.query('SELECT session_id FROM purchases WHERE auction_slug=$1 AND paid_at IS NULL', [slug])).rows[0];
    if (!purchase?.session_id) throw new Error('No unpaid checkout session for that auction');
    const response = await fetch(`http://127.0.0.1:7108/v1/checkout/sessions/${purchase.session_id}/expire`, { method: 'POST' });
    if (!response.ok) throw new Error('Mock refused expiration: ' + await response.text());
    console.log('Unpaid hosted session removed. Return to the auction and choose Resume checkout.');
  } finally { await pool.end(); }
  process.exit(0);
}
const auction = await post('/api/auctions', { title: 'Winner checkout review', description: 'Review success, decline, cancel and retry with the local payment service.',
  category: 'Other', condition: 'Used', sellerId: 'alex-morgan', location: 'Austin, TX', startingPrice: '100.00', endsAt: new Date(Date.now() + 6000).toISOString() });
await post(`/api/auctions/${auction.slug}/bids`, { bidderId: 'jordan-lee', amountMinor: 12500 });
const until = Date.now() + 20000;
let closed = false;
while (Date.now() < until) {
  const response = await fetch(`${api}/api/auctions/${auction.slug}`);
  if (!response.ok) throw new Error('Could not read auction outcome');
  if ((await response.json()).finalOutcome) { closed = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!closed) throw new Error('Close worker did not record outcome; check npm run dev');
console.log(`Review URL: ${web}/items/${auction.slug}`);
console.log('Choose Jordan Lee in the footer. Dismiss the winning notification if shown. Total: $125.00.');
console.log('Pay now -> Cancel -> Resume checkout. Decline: 4000000000000002. Success: 4242424242424242. Expiry 12 / 30, CVC 123.');
console.log('After success, refresh: Payment confirmed remains. Alex Morgan and Sam Rivera cannot check out.');

console.log('Open the same auction as Alex Morgan in another window to review seller payment status; Sam Rivera sees no payment panel.');
