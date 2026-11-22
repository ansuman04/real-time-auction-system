import { traceHeaders } from '@auction/telemetry';
import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import type { OutboxEvent, ConfirmedPublisher } from './outbox.js';

export const closeEventsExchange = 'auction-part-8.events';
export const closeEventsRoutingKey = 'auction.closed';
export const notificationQueue = 'auction-part-8.notifications';

export class RabbitOutboxPublisher implements ConfirmedPublisher {
  private connection: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;

  constructor(private readonly url: string) {}

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    const connection = await amqp.connect(this.url);
    this.connection = connection;
    connection.on('error', () => {
      if (this.connection === connection) { this.connection = undefined; this.channel = undefined; }
    });
    connection.on('close', () => {
      if (this.connection === connection) { this.connection = undefined; this.channel = undefined; }
    });

    try {
      const channel = await connection.createConfirmChannel();
      this.channel = channel;
      channel.on('error', () => { if (this.channel === channel) this.channel = undefined; });
      channel.on('close', () => { if (this.channel === channel) this.channel = undefined; });
      await channel.assertExchange(closeEventsExchange, 'topic', { durable: true });
      await channel.assertQueue(notificationQueue, { durable: true });
      await channel.bindQueue(notificationQueue, closeEventsExchange, closeEventsRoutingKey);
      await channel.bindQueue(notificationQueue, closeEventsExchange, 'payment.paid');
      return channel;
    } catch (error) {
      this.channel = undefined;
      this.connection = undefined;
      await connection.close().catch(() => {});
      throw error;
    }
  }

  async publishConfirmed(event: OutboxEvent): Promise<void> {
    const channel = await this.getChannel();
    await new Promise<void>((resolve, reject) => {
      channel.publish(closeEventsExchange, event.eventType, Buffer.from(JSON.stringify(event)), {
        persistent: true,
        headers: traceHeaders(),
        contentType: 'application/json',
        messageId: event.eventId,
        type: event.eventType,
        timestamp: Date.now(),
      }, (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;
    if (connection) await connection.close();
  }
}
