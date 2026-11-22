import { context, type Context, type Span, type Attributes } from '@opentelemetry/api';
import { parent, currentCarrier, span } from '@auction/telemetry';
export function contextFromTraceparent(traceparent?: string): Context { return parent({ traceparent }); }
export function activeTraceparent(): string | null { return currentCarrier()?.traceparent ?? null; }
export async function withStripeSpan<T>(name: string, attributes: Attributes, origin: Context, work: (s: Span) => Promise<T>): Promise<T> {
  return context.with(origin, () => span(name, attributes, work));
}
