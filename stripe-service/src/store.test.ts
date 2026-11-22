import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildStripeApp } from './app.js';
import { postgresSessionStore } from './store.js';

it('recovers disappeared unpaid state after restart but restores paid evidence without a new session', async () => {
  const purchaseId = randomUUID();
  const payload = { mode: 'payment', client_reference_id: purchaseId,
    line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Recovery checkout' }, unit_amount: 12500 }, quantity: 1 }],
    success_url: 'http://localhost:5108/items/test', cancel_url: 'http://localhost:5108/items/test?checkout=canceled' };
  const connectionString = process.env.DATABASE_URL ?? process.env.DATABASE_URL!;
  const pool = new pg.Pool({ connectionString });
  const options = () => {
    const store = postgresSessionStore();
    return { logger: false, retryMs: 60000, deliverWebhook: async () => false,
      store: { ...store, load: async () => (await store.load()).filter((session) => session.client_reference_id === purchaseId) } };
  };
  let app = buildStripeApp(options());
  try {
    const first = (await app.inject({ method: 'POST', url: '/v1/checkout/sessions', payload })).json();
    await app.close();
    await pool.query('DELETE FROM mock_stripe_sessions WHERE purchase_id=$1', [purchaseId]);
    app = buildStripeApp(options());
    expect((await app.inject(`/v1/checkout/sessions/${first.id}`)).statusCode).toBe(404);
    const resumed = await app.inject({ method: 'POST', url: '/v1/checkout/sessions', payload: { ...payload, previous_session_id: first.id } });
    expect(resumed.statusCode).toBe(201);
    const second = resumed.json(); expect(second.id).not.toBe(first.id);
    await app.inject({ method: 'POST', url: `/v1/checkout/sessions/${second.id}/attempt`, payload: { cardNumber: '4242424242424242', expiry: '12 / 30', cvc: '123' } });
    await app.close();
    await pool.query('DELETE FROM mock_stripe_sessions WHERE purchase_id=$1', [purchaseId]);
    app = buildStripeApp(options());
    const paid = await app.inject({ method: 'POST', url: '/v1/checkout/sessions', payload: { ...payload, previous_session_id: second.id } });
    expect(paid.json()).toMatchObject({ id: second.id, status: 'complete', payment_status: 'paid' });
    expect((await app.inject({ method: 'POST', url: `/v1/checkout/sessions/${second.id}/expire` })).statusCode).toBe(409);
    const unknown = await app.inject({ method: 'POST', url: '/v1/checkout/sessions', payload: { ...payload, client_reference_id: randomUUID(), previous_session_id: 'cs_test_unknown' } });
    expect(unknown.statusCode).toBe(409);
  } finally {
    await app.close();
    await pool.query('DELETE FROM mock_stripe_sessions WHERE purchase_id=$1', [purchaseId]);
    await pool.query('DELETE FROM mock_stripe_purchase_ledger WHERE purchase_id=$1', [purchaseId]); await pool.end();
  }
});

it('preserves session identity and pending payment evidence across restart, then retries the same event', async () => {
  const purchaseId = randomUUID();
  const payload = { mode: 'payment', client_reference_id: purchaseId,
    line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Durable checkout' }, unit_amount: 12500 }, quantity: 1 }],
    success_url: 'http://localhost:5108/items/test?session_id={CHECKOUT_SESSION_ID}', cancel_url: 'http://localhost:5108/items/test?checkout=canceled' };
  const bodies: string[] = [];
  let available = false;
  const options = () => { const store = postgresSessionStore(); return ({ logger: false, store: { ...store, load: async () => (await store.load()).filter((session) => session.client_reference_id === purchaseId) }, retryMs: 25,
    deliverWebhook: async (body: string) => { bodies.push(body); return available; } }); };
  let app = buildStripeApp(options());
  try {
    const created = await app.inject({ method: 'POST', url: '/v1/checkout/sessions', payload });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const paid = await app.inject({ method: 'POST', url: `/v1/checkout/sessions/${id}/attempt`, payload: { cardNumber: '4242424242424242', expiry: '12 / 30', cvc: '123' } });
    expect(paid.json().confirmation_pending).toBe(true);
    await app.close();
    available = true;
    app = buildStripeApp(options());
    const resumed = await app.inject({ method: 'POST', url: '/v1/checkout/sessions', payload });
    expect(resumed.json()).toMatchObject({ id, status: 'complete', payment_status: 'paid' });
    await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(bodies).size).toBe(1);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
    try {
      await expect.poll(async () => (await pool.query('SELECT state FROM mock_stripe_sessions WHERE purchase_id=$1', [purchaseId])).rows[0].state.completion.delivered).toBe(true);
    } finally { await pool.end(); }
  } finally {
    await app.close();
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
    try { await pool.query('DELETE FROM mock_stripe_sessions WHERE purchase_id=$1', [purchaseId]); await pool.query('DELETE FROM mock_stripe_purchase_ledger WHERE purchase_id=$1', [purchaseId]); }
    finally { await pool.end(); }
  }
});
