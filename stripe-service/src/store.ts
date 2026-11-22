import { tracedPool } from '@auction/telemetry/postgres';
import type { CheckoutSession } from './app.js';

export function postgresSessionStore(connectionString = process.env.DATABASE_URL ?? process.env.DATABASE_URL!) {
  const pool = tracedPool({ connectionString, connectionTimeoutMillis: 1000 });
  return {
    async load(): Promise<CheckoutSession[]> {
      return (await pool.query<{ state: CheckoutSession }>('SELECT state FROM mock_stripe_sessions')).rows.map((row) => row.state);
    },
    async save(session: CheckoutSession) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO mock_stripe_sessions (id,purchase_id,state) VALUES ($1,$2,$3::jsonb)
          ON CONFLICT (id) DO UPDATE SET state=excluded.state`, [session.id, session.client_reference_id, JSON.stringify(session)]);
        await client.query(`INSERT INTO mock_stripe_purchase_ledger (purchase_id,state) VALUES ($1,$2::jsonb)
          ON CONFLICT (purchase_id) DO UPDATE SET state=excluded.state`, [session.client_reference_id, JSON.stringify(session)]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async findPurchase(id: string): Promise<CheckoutSession | undefined> {
      return (await pool.query<{ state: CheckoutSession }>('SELECT state FROM mock_stripe_purchase_ledger WHERE purchase_id=$1', [id])).rows[0]?.state;
    },
    async remove(id: string) { await pool.query('DELETE FROM mock_stripe_sessions WHERE id=$1', [id]); },
    async close() { await pool.end(); },
  };
}
