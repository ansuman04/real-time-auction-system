import { startTelemetry } from '@auction/telemetry/node';
const telemetry = startTelemetry('auction-close-part-8');
import { tracedPool } from '@auction/telemetry/postgres';
import { z } from 'zod';
import { closeDueAuctions } from './closing.js';
import { publishPendingOutbox } from './outbox.js';
import { RabbitOutboxPublisher } from './rabbitOutboxPublisher.js';

const workerConfig = z.object({
  DATABASE_URL: z.string().url().default(process.env.DATABASE_URL!),
  CLOSE_WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  CLOSE_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  RABBITMQ_URL: z.string().url().default(process.env.RABBITMQ_URL!),
}).parse(process.env);

const pool = tracedPool({ connectionString: workerConfig.DATABASE_URL });
const relay = new RabbitOutboxPublisher(workerConfig.RABBITMQ_URL);
let stopping = false;

function stop() {
  stopping = true;
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  while (!stopping) {
    try {
      const closedCount = await closeDueAuctions(pool, { batchSize: workerConfig.CLOSE_WORKER_BATCH_SIZE });
      if (closedCount > 0) console.info(`Recorded ${closedCount} auction close(s).`);
    } catch (error) {
      console.error('Auction close polling failed; the next poll will retry.', error);
    }
    try {
      const publishedCount = await publishPendingOutbox(pool, relay, workerConfig.CLOSE_WORKER_BATCH_SIZE);
      if (publishedCount > 0) console.info(`Published ${publishedCount} close event(s) to RabbitMQ.`);
    } catch (error) {
      console.error('Outbox publication failed; pending events will retry.', error);
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, workerConfig.CLOSE_WORKER_POLL_MS));
  }
} finally {
  await relay.close().catch((error) => console.error('RabbitMQ shutdown failed.', error));
  await pool.end();
  await telemetry.shutdown();
}
