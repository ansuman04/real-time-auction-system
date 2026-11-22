import { annotate, currentCarrier, traceHeaders, link, span } from '@auction/telemetry';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

const paramsSchema = z.object({ slug: z.string().min(1).max(160) }).strict();
const buyerSchema = z.object({ buyerId: z.string().min(1).max(80) }).strict();
const sessionSchema = z.object({ id: z.string().regex(/^cs_test_[a-f0-9]+$/), url: z.string().url(), client_reference_id: z.string().uuid() });
const eventSchema = z.object({
  eventId: z.string().uuid(), eventType: z.literal('checkout.session.completed'), occurredAt: z.string().datetime(),
  data: z.object({ object: z.object({ id: z.string(), object: z.literal('checkout.session'),
    status: z.literal('complete'), payment_status: z.literal('paid'), client_reference_id: z.string().uuid(),
    amount_total: z.number().int().positive().safe(), currency: z.literal('usd') }) }),
});
interface Purchase { id: string; buyer_id: string; amount_minor: number; currency: string; title: string;
  success_url: string; cancel_url: string; session_id: string | null; checkout_url: string | null; paid_at: Date | null; trace_context: unknown; auction_slug: string }

export function registerCheckout(app: FastifyInstance, pool: pg.Pool) {
  const stripeUrl = process.env.STRIPE_URL ?? 'http://127.0.0.1:7108';
  const webUrl = process.env.CHECKOUT_WEB_URL ?? 'http://localhost:5108';
  app.get('/api/auctions/:slug/checkout', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const actor = z.union([buyerSchema, z.object({ userId: z.string().min(1).max(80) }).strict()]).safeParse(request.query);
    if (!params.success || !actor.success) return reply.code(400).send({ message: 'Invalid payment status request.' });
    const userId = 'userId' in actor.data ? actor.data.userId : actor.data.buyerId;
    const outcome = (await pool.query(
      'SELECT c.winner_id,c.winning_amount_minor,a.seller_id FROM auction_closes c JOIN auctions a ON a.slug=c.auction_slug WHERE c.auction_slug=$1', [params.data.slug])).rows[0];
    if (!outcome?.winner_id || ![outcome.winner_id, outcome.seller_id].includes(userId)) return reply.code(403).send({ message: 'Payment status is available only to the seller and winner.' });
    const purchase = (await pool.query<Purchase>('SELECT * FROM purchases WHERE auction_slug=$1', [params.data.slug])).rows[0];
    const role = outcome.winner_id === userId ? 'winner' : 'seller';
    return { role, status: purchase?.paid_at ? 'paid' : role === 'winner' && purchase?.session_id ? 'pending' : 'unpaid',
      amountMinor: outcome.winning_amount_minor };
  });

  app.post('/api/auctions/:slug/checkout', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params), buyer = buyerSchema.safeParse(request.body);
    if (!params.success || !buyer.success) return reply.code(400).send({ message: 'Invalid checkout request.' });
    const outcome = (await pool.query<{ winner_id: string | null; winning_amount_minor: number; title: string; trace_context: unknown }>(
      'SELECT c.winner_id,c.winning_amount_minor,c.trace_context,a.title FROM auction_closes c JOIN auctions a ON a.slug=c.auction_slug WHERE c.auction_slug=$1', [params.data.slug])).rows[0];
    if (!outcome?.winner_id || outcome.winner_id !== buyer.data.buyerId) return reply.code(403).send({ message: 'Only the recorded winner may check out.' });
    link(outcome.trace_context);
    annotate({ 'auction.id': params.data.slug, role: 'winner', 'amount.minor': outcome.winning_amount_minor, currency: 'usd' });
    const returnUrl = `${webUrl}/items/${encodeURIComponent(params.data.slug)}`;
    // Commit stable identity before the external call: ambiguous provider responses retry the same purchase.
    await pool.query(`INSERT INTO purchases (id,auction_slug,buyer_id,amount_minor,title,success_url,cancel_url,trace_context)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (auction_slug) DO NOTHING`,
    [randomUUID(), params.data.slug, outcome.winner_id, outcome.winning_amount_minor, outcome.title,
      returnUrl + '?checkout=success&session_id={CHECKOUT_SESSION_ID}', returnUrl + '?checkout=canceled', JSON.stringify(currentCarrier() ?? null)]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const purchase = (await client.query<Purchase>('SELECT * FROM purchases WHERE auction_slug=$1 FOR UPDATE', [params.data.slug])).rows[0];
      link(purchase.trace_context);
      annotate({ 'purchase.id': purchase.id, 'amount.minor': purchase.amount_minor, currency: purchase.currency });
      if (purchase.paid_at) { await client.query('COMMIT'); return { status: 'paid' }; }
      let missing = false;
      if (purchase.session_id) {
        const response = await span('checkout.session.retrieve', { 'purchase.id': purchase.id, 'payment.session.id': purchase.session_id }, async () => fetch(`${stripeUrl}/v1/checkout/sessions/${purchase.session_id}`, { signal: AbortSignal.timeout(5000), headers: traceHeaders() }));
        if (response.status === 404) missing = true;
        else {
          if (!response.ok) throw new Error('Could not verify existing checkout');
          const session = sessionSchema.extend({ status: z.enum(['open', 'complete']), payment_status: z.enum(['unpaid', 'paid']) }).parse(await response.json());
          if (session.id !== purchase.session_id || session.client_reference_id !== purchase.id) throw new Error('Mismatched checkout');
          if (session.payment_status === 'paid' || session.status === 'complete') {
            await client.query('COMMIT'); return { status: 'pending', confirmationPending: true };
          }
        }
      }
      if (!purchase.session_id || missing) {
        const response = await span('checkout.session', { 'purchase.id': purchase.id }, async () => fetch(`${stripeUrl}/v1/checkout/sessions`, { method: 'POST', signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json', ...traceHeaders() }, body: JSON.stringify({ mode: 'payment', client_reference_id: purchase.id,
            ...(missing ? { previous_session_id: purchase.session_id } : {}),
            line_items: [{ price_data: { currency: purchase.currency, product_data: { name: purchase.title }, unit_amount: purchase.amount_minor }, quantity: 1 }],
            success_url: purchase.success_url, cancel_url: purchase.cancel_url }) }));
        if (!response.ok) throw new Error('Payment service rejected checkout creation');
        const session = sessionSchema.extend({ payment_status: z.enum(['paid', 'unpaid']) }).parse(await response.json());
        if (session.client_reference_id !== purchase.id || new URL(session.url).origin !== new URL(stripeUrl).origin) throw new Error('Invalid payment service session');
        await client.query('UPDATE purchases SET session_id=$1,checkout_url=$2 WHERE id=$3', [session.id, session.url, purchase.id]);
        purchase.checkout_url = session.url;
        if (session.payment_status === 'paid') { await client.query('COMMIT'); return { status: 'pending', confirmationPending: true }; }
      }
      await client.query('COMMIT');
      return { status: 'pending', url: purchase.checkout_url };
    } catch (error) {
      await client.query('ROLLBACK');
      request.log.error({ err: error }, 'checkout creation failed; stable purchase retained');
      return reply.code(503).send({ message: 'Checkout is temporarily unavailable. Retry safely.' });
    } finally { client.release(); }
  });

  // Encapsulate the raw-body parser so existing JSON API behavior is preserved.
  app.register(async (webhooks) => {
    webhooks.removeContentTypeParser('application/json');
    webhooks.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 65536 }, (_request, body, done) => done(null, body));
    webhooks.post('/api/webhooks/stripe', async (request, reply) => {
      const raw = request.body;
      const signature = request.headers['x-stripe-signature'];
      if (!Buffer.isBuffer(raw) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return reply.code(400).send({ message: 'Invalid signature.' });
      const expected = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET!).update(raw).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return reply.code(400).send({ message: 'Invalid signature.' });
      let json: unknown;
      try { json = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ message: 'Invalid event JSON.' }); }
      const parsed = eventSchema.safeParse(json);
      if (!parsed.success) return reply.code(400).send({ message: 'Invalid completion event.' });
      const event = parsed.data, paid = event.data.object;
      annotate({ 'event.id': event.eventId, 'purchase.id': paid.client_reference_id, 'payment.session.id': paid.id, 'amount.minor': paid.amount_total, currency: paid.currency });
      const hash = createHash('sha256').update(raw).digest('hex');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const purchase = (await client.query<Purchase>('SELECT * FROM purchases WHERE id=$1 FOR UPDATE', [paid.client_reference_id])).rows[0];
        if (!purchase || purchase.session_id !== paid.id || purchase.amount_minor !== paid.amount_total || purchase.currency !== paid.currency) {
          await client.query('ROLLBACK'); return reply.code(409).send({ message: 'Payment does not match purchase.' });
        }
        link(purchase.trace_context);
        annotate({ 'auction.id': purchase.auction_slug });
        const receipt = await client.query('INSERT INTO payment_webhook_receipts (event_id,purchase_id,payload_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id', [event.eventId, purchase.id, hash]);
        if (!receipt.rowCount) {
          const previous = (await client.query('SELECT payload_hash FROM payment_webhook_receipts WHERE event_id=$1', [event.eventId])).rows[0];
          if (previous.payload_hash !== hash) { await client.query('ROLLBACK'); return reply.code(409).send({ message: 'Conflicting event replay.' }); }
        }
        const transitioned = await client.query('UPDATE purchases SET paid_at=clock_timestamp() WHERE id=$1 AND paid_at IS NULL RETURNING auction_slug', [purchase.id]);
        if (transitioned.rows[0]) await client.query(`INSERT INTO outbox_events (auction_slug,event_type,payload,trace_context)
          VALUES ($1,'payment.paid',$2::jsonb,$3::jsonb) ON CONFLICT (auction_slug,event_type) DO NOTHING`,
        [transitioned.rows[0].auction_slug, JSON.stringify({ auctionSlug: transitioned.rows[0].auction_slug }), JSON.stringify(currentCarrier() ?? null)]);
        await client.query('COMMIT');
        annotate({ outcome: transitioned.rows[0] ? 'paid' : 'duplicate' });
        if (transitioned.rows[0]) await span('purchase.paid', { 'purchase.id': purchase.id, 'auction.id': purchase.auction_slug, 'amount.minor': purchase.amount_minor, currency: purchase.currency, outcome: 'committed' }, async () => {});
        return { received: true };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  });
}
