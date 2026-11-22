import { span } from '@auction/telemetry';
import { startTelemetry } from '@auction/telemetry/node';
const telemetry = startTelemetry('auction-notifications-part-8');
import { tracedPool } from '@auction/telemetry/postgres';
import amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import { createClient } from 'redis';
import { z } from 'zod';
import { persistRecipientNotifications } from './notificationDelivery.js';
import { closeEventsExchange, closeEventsRoutingKey, notificationQueue } from './rabbitOutboxPublisher.js';

const config = z.object({
  DATABASE_URL: z.string().url().default(process.env.DATABASE_URL!),
  RABBITMQ_URL: z.string().url().default(process.env.RABBITMQ_URL!),
  REDIS_URL: z.string().url().default('redis://localhost:56388'),
}).parse(process.env);

const queueName = notificationQueue;
const pool = tracedPool({ connectionString: config.DATABASE_URL });
const redis = createClient({ url: config.REDIS_URL, disableOfflineQueue: true });
redis.on('error', (error) => console.error('Notification worker Redis error.', error));

let stopping = false;
let connection: ChannelModel | undefined;
let channel: Channel | undefined;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

try {
  await redis.connect();
  while (!stopping) {
    try {
      connection = await amqp.connect(config.RABBITMQ_URL);
      channel = await connection.createChannel();
      await channel.assertExchange(closeEventsExchange, 'topic', { durable: true });
      await channel.assertQueue(queueName, { durable: true });
      await channel.bindQueue(queueName, closeEventsExchange, closeEventsRoutingKey);
      await channel.bindQueue(queueName, closeEventsExchange, 'payment.paid');
      await channel.prefetch(20);
      console.info('Notification worker is consuming auction.closed events.');
      await new Promise<void>((resolve, reject) => {
        connection?.once('close', resolve);
        connection?.once('error', reject);
        void channel?.consume(queueName, (message) => {
          if (!message || !channel) return;
          void (async () => {
            try {
              const event: unknown = JSON.parse(message.content.toString('utf8'));
              await span('messaging.process', { 'event.id': message.properties.messageId ?? 'unknown', redelivered: message.fields.redelivered, 'queue.age_ms': Math.max(0, Date.now() - Number(message.properties.timestamp ?? Date.now())) }, async () => {
                await persistRecipientNotifications(pool, redis, event);
              }, message.properties.headers ?? {});
              channel?.ack(message);
            } catch (error) {
              console.error('Notification delivery failed; event will be requeued.', error);
              try { channel?.nack(message, false, true); } catch { /* Connection recovery will redeliver unacked messages. */ }
            }
          })();
        }, { noAck: false }).catch(reject);
      });
    } catch (error) {
      if (!stopping) console.error('Notification worker connection failed; retrying.', error);
    } finally {
      channel = undefined;
      const oldConnection = connection;
      connection = undefined;
      if (oldConnection) await oldConnection.close().catch(() => {});
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await redis.quit().catch(() => {});
  await pool.end();
  await telemetry.shutdown();
}
