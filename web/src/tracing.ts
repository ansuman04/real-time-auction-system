import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { parent, safeAttributes } from '@auction/telemetry';
import type { Attributes } from '@opentelemetry/api';

const processor = typeof window === 'undefined' ? undefined : new BatchSpanProcessor(new OTLPTraceExporter({ url: new URL('/otel/v1/traces', window.location.origin).href, timeoutMillis: 1500 }), { scheduledDelayMillis: 300, exportTimeoutMillis: 2000 });
const provider = new WebTracerProvider({ resource: resourceFromAttributes({ 'service.name': 'auction-web-part-8' }), spanProcessors: processor ? [processor] : [] });
const tracer = provider.getTracer('auction-web');

export async function tracedFetch(url: string, options: RequestInit, name: string, attributes: Attributes): Promise<Response> {
  const s = tracer.startSpan(name, { attributes: safeAttributes(attributes) });
  const sc = s.spanContext();
  const headers = new Headers(options.headers);
  headers.set('traceparent', `00-${sc.traceId}-${sc.spanId}-01`);
  try {
    const response = await fetch(url, { ...options, headers });
    s.setAttributes({ 'http.status_code': response.status, outcome: response.ok ? 'completed' : response.status < 500 ? 'rejected' : 'failed' });
    if (response.status >= 500) s.setStatus({ code: 2 });
    return response;
  } catch (error) { s.setStatus({ code: 2 }); s.setAttribute('error.type', 'transport_failed'); throw error; }
  finally { s.end(); void processor?.forceFlush().catch(() => {}); }
}
export function received(name: string, origin: unknown, attributes: Attributes) {
  const s = tracer.startSpan(name, { attributes: safeAttributes(attributes) }, parent(origin));
  s.end();
}
