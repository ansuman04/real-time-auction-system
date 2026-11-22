import { telemetry } from './otel.js';
import { postgresSessionStore } from './store.js';

const { buildStripeApp } = await import('./app.js');

const port = Number(process.env.STRIPE_PORT ?? 7108);
const app = buildStripeApp({
  store: postgresSessionStore(),
  baseUrl: process.env.STRIPE_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  webhookUrl: process.env.AUCTION_WEBHOOK_URL ?? 'http://127.0.0.1:3108/api/webhooks/stripe',
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET!,
});

try {
  await app.listen({ port, host: '127.0.0.1' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); await telemetry.shutdown(); process.exit(0); });
