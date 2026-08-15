import { hostname } from 'node:os'
import {
  metrics,
  type MeterProvider as ApiMeterProvider,
  type TracerProvider as ApiTracerProvider,
} from '@opentelemetry/api'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import {
  defaultResource,
  resourceFromAttributes,
  type Resource,
} from '@opentelemetry/resources'
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai'
import type { Config } from './config.js'
import { VERSION } from './version.js'

const INSTRUMENTATION_NAME = '@loongsuite/dsh-plugin-loongsuite'

export interface TelemetryPipeline {
  handler: ExtendedTelemetryHandler
  tracerProvider: BasicTracerProvider
  meterProvider?: MeterProvider
  traceEndpoint?: string
  metricEndpoint?: string
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

/** Test-only exporter substitutions; production callers omit this object. */
export interface TelemetryOverrides {
  traceExporter?: SpanExporter
  metricExporter?: PushMetricExporter
  simpleSpanProcessor?: boolean
  resource?: Resource
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.trim())
  } catch {
    return value.trim()
  }
}

/** Parse the standard comma-separated OTLP key=value header/resource syntax. */
export function parseKeyValueList(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!value) return result
  for (const item of value.split(',')) {
    const separator = item.indexOf('=')
    if (separator <= 0) continue
    const key = decode(item.slice(0, separator))
    if (key === '') continue
    result[key] = decode(item.slice(separator + 1))
  }
  return result
}

function signalUrl(base: string, signal: 'traces' | 'metrics'): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/v1\/(?:traces|metrics)$/i.test(trimmed)) {
    return trimmed.replace(/\/v1\/(?:traces|metrics)$/i, `/v1/${signal}`)
  }
  return `${trimmed}/v1/${signal}`
}

function resolveEndpoint(config: Config, signal: 'traces' | 'metrics'): string | undefined {
  const explicit = signal === 'traces' ? config.traceEndpoint : config.metricEndpoint
  if (explicit) return explicit.replace(/\/+$/, '')
  if (config.endpoint) return signalUrl(config.endpoint, signal)
  const signalEnv = process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]
  if (signalEnv) return signalEnv.replace(/\/+$/, '')
  const commonEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  return commonEnv ? signalUrl(commonEnv, signal) : undefined
}

function resolveHeaders(config: Config, signal: 'traces' | 'metrics'): Record<string, string> {
  const general = parseKeyValueList(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const signalHeaders = parseKeyValueList(
    process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`],
  )
  return { ...general, ...signalHeaders, ...config.headers }
}

function buildResource(config: Config): Resource {
  const environmentAttributes = parseKeyValueList(process.env.OTEL_RESOURCE_ATTRIBUTES)
  const serviceName = config.serviceName
    || process.env.OTEL_SERVICE_NAME
    || environmentAttributes[ATTR_SERVICE_NAME]
    || 'deepseek-harness'
  return defaultResource().merge(resourceFromAttributes({
    ...environmentAttributes,
    ...config.resourceAttributes,
    [ATTR_SERVICE_NAME]: serviceName,
    'service.instance.id': `${serviceName}@${hostname()}:${process.pid}`,
    'host.name': hostname(),
    'telemetry.sdk.language': 'nodejs',
    'gen_ai.agent.system': 'deepseek-harness',
    'acs.arms.service.feature': 'genai_app',
  }))
}

function traceExporterConfig(
  url: string | undefined,
  headers: Record<string, string>,
  timeoutMillis: number,
): ConstructorParameters<typeof OTLPTraceExporter>[0] {
  return {
    ...url === undefined ? {} : { url },
    ...Object.keys(headers).length === 0 ? {} : { headers },
    timeoutMillis,
  }
}

function metricExporterConfig(
  url: string | undefined,
  headers: Record<string, string>,
  timeoutMillis: number,
): ConstructorParameters<typeof OTLPMetricExporter>[0] {
  return {
    ...url === undefined ? {} : { url },
    ...Object.keys(headers).length === 0 ? {} : { headers },
    timeoutMillis,
  }
}

/** Create a private, non-global OTel pipeline owned entirely by one plugin fiber. */
export function createTelemetryPipeline(
  config: Config,
  overrides: TelemetryOverrides = {},
): TelemetryPipeline {
  if (config.maxExportBatchSize > config.maxQueueSize) {
    throw new Error('loongsuite-observability: maxExportBatchSize must not exceed maxQueueSize')
  }

  const resource = overrides.resource ?? buildResource(config)
  const traceEndpoint = resolveEndpoint(config, 'traces')
  const traceExporter = overrides.traceExporter ?? new OTLPTraceExporter(traceExporterConfig(
    traceEndpoint,
    resolveHeaders(config, 'traces'),
    config.exportTimeoutMs,
  ))
  const spanProcessor = overrides.simpleSpanProcessor
    ? new SimpleSpanProcessor(traceExporter)
    : new BatchSpanProcessor(traceExporter, {
        maxExportBatchSize: config.maxExportBatchSize,
        maxQueueSize: config.maxQueueSize,
        scheduledDelayMillis: config.traceExportIntervalMs,
        exportTimeoutMillis: config.exportTimeoutMs,
      })
  const tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [spanProcessor] })

  let meterProvider: MeterProvider | undefined
  let metricEndpoint: string | undefined
  if (config.exportMetrics) {
    metricEndpoint = resolveEndpoint(config, 'metrics')
    const metricExporter = overrides.metricExporter ?? new OTLPMetricExporter(metricExporterConfig(
      metricEndpoint,
      resolveHeaders(config, 'metrics'),
      config.exportTimeoutMs,
    ))
    const reader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: config.metricExportIntervalMs,
      exportTimeoutMillis: Math.min(config.exportTimeoutMs, config.metricExportIntervalMs),
    })
    meterProvider = new MeterProvider({ resource, readers: [reader] })
  }

  const handler = new ExtendedTelemetryHandler({
    tracerProvider: tracerProvider as ApiTracerProvider,
    meterProvider: (meterProvider ?? metrics) as ApiMeterProvider,
    instrumentationName: INSTRUMENTATION_NAME,
    instrumentationVersion: VERSION,
  })

  let stopped = false
  return {
    handler,
    tracerProvider,
    ...meterProvider === undefined ? {} : { meterProvider },
    ...traceEndpoint === undefined ? {} : { traceEndpoint },
    ...metricEndpoint === undefined ? {} : { metricEndpoint },
    async forceFlush(): Promise<void> {
      if (stopped) return
      await Promise.all([
        tracerProvider.forceFlush(),
        meterProvider?.forceFlush(),
      ])
    },
    async shutdown(): Promise<void> {
      if (stopped) return
      stopped = true
      await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider?.shutdown(),
      ])
    },
  }
}
