import { telemetry } from './otel.js';

const { buildApp } = await import('./app.js');
const app = buildApp();
const port = Number(process.env.API_PORT ?? 3108);

try {
  await app.listen({ port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await app.close(); await telemetry.shutdown(); process.exit(0); });
