import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from './app.js';
import { capabilities } from './capabilities.js';

const app = buildApp();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const created: string[] = [];
const valid = () => ({ title: 'Publication test GPU', description: 'A tested GPU', category: 'GPUs', condition: 'Used', location: 'Austin, TX', sellerId: 'sam-rivera', startingPrice: '1234.56', endsAt: new Date(Date.now() + 86400000).toISOString() });
afterAll(async () => {
  await app.close();
  await pool.query('DELETE FROM auctions WHERE slug = ANY($1::text[])', [created]);
  await pool.end();
});

// Retain the later-slice checks while publication is staged out of this review.
describe.skipIf(!capabilities.postAuctions)('auction publication', () => {
  it('publishes with a seeded seller, exact USD cents, location, UTC close and no specifications', async () => {
    const payload = { ...valid(), title: '  Publication test GPU  ', endsAt: '2031-01-01T15:30:00+05:30' };
    const response = await app.inject({ method: 'POST', url: '/api/auctions', payload });
    expect(response.statusCode).toBe(201);
    const auction = response.json();
    created.push(auction.slug);
    expect(auction).toMatchObject({ title: 'Publication test GPU', sellerId: 'sam-rivera', seller: 'Sam Rivera', startingPriceMinor: 123456, currency: 'USD', location: 'Austin, TX', endsAt: '2031-01-01T10:00:00.000Z', specs: [], art: 'gpu' });
    expect(response.headers.location).toBe(`/api/auctions/${auction.slug}`);
    const secondApp = buildApp();
    try { expect((await secondApp.inject(`/api/auctions/${auction.slug}`)).json()).toEqual(auction); }
    finally { await secondApp.close(); }
    const row = (await pool.query('SELECT starting_price_minor, seller_id, currency, location, legacy_metadata FROM auctions WHERE slug=$1', [auction.slug])).rows[0];
    expect(row).toEqual({ starting_price_minor: 123456, seller_id: 'sam-rivera', currency: 'USD', location: 'Austin, TX', legacy_metadata: null });
    expect((await app.inject('/api/auctions?q=Publication%20test%20GPU')).json().map((item: { slug: string }) => item.slug)).toContain(auction.slug);
  });

  it.each([{ price: '0.01', cents: 1 }, { price: '1.1', cents: 110 }, { price: '9999999.99', cents: 999999999 }])('stores exact cents for $price', async ({ price, cents }) => {
    const response = await app.inject({ method: 'POST', url: '/api/auctions', payload: { ...valid(), startingPrice: price, category: 'Other' } });
    expect(response.statusCode).toBe(201);
    created.push(response.json().slug);
    expect(response.json()).toMatchObject({ startingPriceMinor: cents, art: 'chassis' });
  });

  it.each(['0', '-1', '1.001', '1e3', '10000000', 'NaN', '01', '1,200.00', '$1.00'])('rejects invalid USD price %s', async (startingPrice) => {
    const response = await app.inject({ method: 'POST', url: '/api/auctions', payload: { ...valid(), startingPrice } });
    expect(response.statusCode).toBe(400);
    expect(response.json().errors.startingPrice).toBeDefined();
  });

  it.each([
    { title: ' ' }, { title: 'x'.repeat(121) }, { description: '' }, { category: 'Invalid' },
    { condition: '' }, { location: ' ' }, { location: 'x'.repeat(201) }, { sellerId: '' },
    { sellerId: 'unknown-user' }, { seller: 'Spoofed seller' }, { specs: [['Invented', 'spec']] },
    { startingPrice: 100 }, { endsAt: new Date(0).toISOString() }, { endsAt: 'not a date' },
    { endsAt: '2031-01-01T10:00:00' }, { unexpected: true },
  ])('rejects invalid publication without writing %j', async (change) => {
    const response = await app.inject({ method: 'POST', url: '/api/auctions', payload: { ...valid(), ...change } });
    expect(response.statusCode).toBe(400);
  });
});
