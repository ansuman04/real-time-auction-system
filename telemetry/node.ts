import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, AlwaysOnSampler } from '@opentelemetry/sdk-trace';

export function startTelemetry(serviceName: string) {
  const exporter = new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
      'http://127.0.0.1:4338/v1/traces',
    timeoutMillis: 1500,
  });

  const processor = new BatchSpanProcessor({
    exporter,
    maxQueueSize: 2048,
    maxExportBatchSize: 256,
    scheduledDelayMillis: 500,
    exportTimeoutMillis: 2000,
  });

  const sdk = new NodeSDK({
    serviceName,
    autoDetectResources: false,
    sampler: new AlwaysOnSampler(),
    spanProcessors: [processor],
    instrumentations: [],
  });

  if (process.env.OTEL_SDK_DISABLED !== 'true') {
    sdk.start();
  }

  return {
    flush: () => processor.forceFlush(),
    shutdown: () => sdk.shutdown(),
  };
}
