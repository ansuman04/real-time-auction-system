import { context, trace, ROOT_CONTEXT, SpanStatusCode, type Attributes, type Context, type Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const propagator = new W3CTraceContextPropagator();
const getter = { keys: (c: Record<string, string>) => Object.keys(c), get: (c: Record<string, string>, k: string) => c[k] };
const setter = { set: (c: Record<string, string>, k: string, v: string) => { c[k] = v; } };
export interface TraceCarrier { version: 1; traceparent: string; tracestate?: string }

// Do not persist baggage or accept arbitrary propagation fields.
export function carrier(input: unknown): TraceCarrier | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  if (value.version !== undefined && value.version !== 1) return;
  if (typeof value.traceparent !== 'string' || !/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/.test(value.traceparent)) return;
  if (/^00-0{32}-/.test(value.traceparent) || /-0{16}-/.test(value.traceparent)) return;
  const tracestate = typeof value.tracestate === 'string' && value.tracestate.length <= 512 ? value.tracestate : undefined;
  return { version: 1, traceparent: value.traceparent, ...(tracestate ? { tracestate } : {}) };
}
export function parent(input: unknown): Context {
  const value = carrier(input);
  return value ? propagator.extract(ROOT_CONTEXT, { traceparent: value.traceparent, ...(value.tracestate ? { tracestate: value.tracestate } : {}) }, getter) : ROOT_CONTEXT;
}
export function currentCarrier(): TraceCarrier | undefined {
  const output: Record<string, string> = {};
  propagator.inject(context.active(), output, setter);
  return carrier(output);
}
export function traceHeaders(): Record<string, string> {
  const value = currentCarrier();
  return value ? { traceparent: value.traceparent, ...(value.tracestate ? { tracestate: value.tracestate } : {}) } : {};
}

// Explicit instrumentation only: no payloads, query text, URLs, names or exception messages.
const allowed = /^(auction\.id|bid\.id|purchase\.id|event\.id|notification\.id|payment\.session\.id|amount\.minor|currency|role|outcome|attempt|redelivered|queue\.age_ms|deadline\.late_ms|http\.route|http\.status_code|db\.operation|db\.system|error\.type|mock_stripe\.(checkout|payment)\.outcome|purchase\.amount_cents)$/;
export function safeAttributes(values: Attributes): Attributes {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.test(key) && (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' && value.length <= 160)));
}
export function annotate(values: Attributes) { trace.getActiveSpan()?.setAttributes(safeAttributes(values)); }
export function link(input: unknown) {
  const linked = trace.getSpanContext(parent(input));
  const active = trace.getActiveSpan();
  const current = active?.spanContext();
  if (linked && (linked.traceId !== current?.traceId || linked.spanId !== current?.spanId)) active?.addLink({ context: linked });
}
export async function span<T>(name: string, attrs: Attributes, work: (s: Span) => Promise<T>, origin?: unknown): Promise<T> {
  const base = origin === undefined ? context.active() : parent(origin);
  const linked = origin === undefined ? undefined : trace.getSpanContext(base);
  const s = trace.getTracer('auction-business').startSpan(name, { attributes: safeAttributes(attrs), links: linked ? [{ context: linked }] : [] }, base);
  return context.with(trace.setSpan(base, s), async () => {
    try { return await work(s); }
    catch (error) {
      s.setAttribute('error.type', 'operation_failed');
      s.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally { s.end(); }
  });
}
export function database<T>(operation: string, work: () => Promise<T>): Promise<T> {
  // Worker discovery/health checks have no active business operation and stay silent.
  return trace.getActiveSpan() ? span('postgresql.' + operation, { 'db.system': 'postgresql', 'db.operation': operation }, work) : work();
}
