import { context, trace, type Span } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { parent } from '@auction/telemetry';

export function installHttpTracing(app: FastifyInstance) {
  const spans = new WeakMap<object, Span>();
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.method !== 'POST') return done();
    const route = request.routeOptions.url ?? 'unknown';
    const s = trace.getTracer('auction-http').startSpan(route.includes('webhooks') ? 'purchase.webhook' : route.endsWith('/bids') ? 'auction.bid' : route.endsWith('/checkout') ? 'purchase.checkout' : 'auction.create',
      { attributes: { 'http.route': route } }, parent(request.headers));
    spans.set(request, s);
    context.with(trace.setSpan(parent(request.headers), s), done);
  });
  app.addHook('onResponse', async (request, reply) => {
    const s = spans.get(request);
    s?.setAttributes({ 'http.status_code': reply.statusCode });
    if (reply.statusCode >= 400 && reply.statusCode < 500) s?.setAttribute('outcome', 'rejected');
    if (reply.statusCode >= 500) s?.setStatus({ code: 2 });
    s?.end();
  });
}
