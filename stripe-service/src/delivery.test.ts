import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildStripeApp } from './app.js';

it('bounds a stalled callback and returns confirmation pending without losing paid state', async () => {
  const original = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
    });
  };
  const app = buildStripeApp({ logger: false, retryMs: 60000 });
  try {
    const created = await app.inject({ method: 'POST', url: '/v1/checkout/sessions', payload: {
      mode: 'payment', client_reference_id: randomUUID(),
      line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Timeout checkout' }, unit_amount: 12500 }, quantity: 1 }],
      success_url: 'http://localhost:5108/items/test', cancel_url: 'http://localhost:5108/items/test?checkout=canceled',
    } });
    const id = created.json().id;
    const attempt = await app.inject({ method: 'POST', url: `/v1/checkout/sessions/${id}/attempt`, payload: { cardNumber: '4242424242424242', expiry: '12 / 30', cvc: '123' } });
    expect(signal?.aborted).toBe(true);
    expect(attempt.json()).toMatchObject({ confirmation_pending: true, redirect_url: 'http://localhost:5108/items/test' });
    expect((await app.inject(`/v1/checkout/sessions/${id}`)).json()).toMatchObject({ status: 'complete', payment_status: 'paid' });
  } finally { globalThis.fetch = original; await app.close(); }
}, 8000);
