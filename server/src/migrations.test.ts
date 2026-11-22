import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';

it('seed/reset migrations restore six auctions and ten users and preserve legacy records during upgrade', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Isolated transaction-local schema: never reset the user's review database.
    const schema = `migration_test_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    const migration = async (name: string) => client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    await migration('001_auctions.sql');
    await migration('002_seed_catalog.sql');
    expect((await client.query('SELECT count(*)::int AS count FROM auctions')).rows[0].count).toBe(6);
    await client.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,starting_price_minor,ends_at,art)
      VALUES ('legacy-extra','Legacy extra','Keep me','Other','Used','Original seller',123456,'2030-01-01T00:00:00Z','chassis')`);
    const before = (await client.query('SELECT slug, title, starting_price_minor, ends_at, specs FROM auctions ORDER BY slug')).rows;
    await migration('003_marketplace_users_usd.sql');
    await migration('004_bids.sql');
    expect((await client.query('SELECT count(*)::int AS count FROM bids')).rows[0].count).toBe(0);
    expect((await client.query('SELECT count(*)::int AS count FROM demo_users')).rows[0].count).toBe(10);
    expect((await client.query('SELECT slug, title, starting_price_minor, ends_at, specs FROM auctions ORDER BY slug')).rows).toEqual(before);
    expect((await client.query("SELECT seller_id, location, legacy_metadata FROM auctions WHERE slug='legacy-extra'")).rows[0]).toEqual({
      seller_id: 'alex-morgan', location: null,
      legacy_metadata: { currency: 'INR', startingPriceMinor: 123456, seller: 'Original seller' },
    });
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
