import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from './app.js';

const app = buildApp();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slug = `integration-${randomUUID()}`;
afterAll(async () => {
  await app.close();
  await pool.query('DELETE FROM auctions WHERE slug = $1', [slug]);
  await pool.end();
});

describe('marketplace slice', () => {
  it('reads persisted USD cents, seller identity and location across app instances and search', async () => {
    await pool.query(`INSERT INTO auctions
      (slug,title,description,category,condition,seller,seller_id,location,starting_price_minor,ends_at,art)
      VALUES ($1,'Integration GPU','Persisted record','GPUs','Used','Alex Morgan','alex-morgan','Test location',123456,now() + interval '1 day','gpu')`, [slug]);
    const response = await app.inject(`/api/auctions/${slug}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ startingPriceMinor: 123456, currency: 'USD', seller: 'Alex Morgan', sellerId: 'alex-morgan', location: 'Test location', specs: [] });
    const secondApp = buildApp();
    try { expect((await secondApp.inject(`/api/auctions/${slug}`)).json()).toEqual(response.json()); }
    finally { await secondApp.close(); }
    expect((await app.inject('/api/auctions?q=Test%20location')).json().map((row: { slug: string }) => row.slug)).toContain(slug);
  });

  it('returns ten stable ordered demo users with unique identifiers', async () => {
    const response = await app.inject('/api/users');
    expect(response.statusCode).toBe(200);
    const users = response.json() as { id: string; displayName: string }[];
    expect(users).toHaveLength(10);
    expect(new Set(users.map((user) => user.id)).size).toBe(10);
    expect(users[0]).toEqual({ id: 'north-loop', displayName: 'North Loop Compute' });
  });

  it('enables posting and bidding with boundary validation', async () => {
    expect((await app.inject('/api/capabilities')).json()).toEqual({ postAuctions: true, placeBids: true });
    const before = await pool.query("SELECT count(*) FROM auctions WHERE title = 'Attempted publication'");
    for (const payload of [{}, { title: 'Attempted publication', startingPrice: '1234.56', seller: 'Alex Morgan' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/auctions', payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/auctions/nvidia-h100-sxm-80gb/bids', payload: { amount: 1845100 } })).statusCode).toBe(400);
    expect((await pool.query("SELECT count(*) FROM auctions WHERE title = 'Attempted publication'")).rows).toEqual(before.rows);
  });

  it('returns missing and empty states, validates search and treats input literally', async () => {
    expect((await app.inject('/api/auctions/not-a-real-auction')).statusCode).toBe(404);
    expect((await app.inject('/api/auctions?q=no-match-987654321')).json()).toEqual([]);
    expect((await app.inject('/api/auctions?q=%27%20OR%201%3D1--')).json()).toEqual([]);
    expect((await app.inject(`/api/auctions?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
  });

  it('keeps all six original seeded items with restored locations and original values', async () => {
    const result = await pool.query(`SELECT * FROM auctions WHERE slug = ANY($1::text[])`, [[
      'nvidia-h100-sxm-80gb', 'amd-epyc-9654', 'one-point-five-tb-ddr5-ecc',
      'supermicro-4u-gpu-chassis', 'quantum-2-400g-switch', 'direct-to-chip-cooling-loop',
    ]]);
    expect(result.rowCount).toBe(6);
    for (const row of result.rows) {
      expect(row.currency).toBe('USD');
      expect(row.location).toBeTruthy();
      expect(row.seller_id).toBeTruthy();
      expect(row.legacy_metadata).toMatchObject({ currency: 'INR', startingPriceMinor: row.starting_price_minor });
    }
  });
});
