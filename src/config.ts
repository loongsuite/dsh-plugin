import z from '@deepseek-ai/schemastery'

/** Runtime configuration accepted by the bundle's Cordis row. */
export interface Config {
  /** Disable all collection without removing the bundle. */
  enabled: boolean
  /** Shared OTLP/HTTP base endpoint. Signal-specific endpoints take precedence. */
  endpoint?: string
  /** Complete OTLP trace endpoint, usually ending in `/v1/traces`. */
  traceEndpoint?: string
  /** Complete OTLP metric endpoint, usually ending in `/v1/metrics`. */
  metricEndpoint?: string
  /** Headers sent to both OTLP exporters. */
  headers: Record<string, string>
  /** OpenTelemetry service.name. */
  serviceName?: string
  /** Additional string-valued Resource attributes. */
  resourceAttributes: Record<string, string>
  /** Capture prompts, responses, tool arguments and results. Off by default. */
  captureContent?: boolean
  /** Maximum serialized characters retained for any captured content attribute. */
  contentMaxChars: number
  /** Export GenAI client duration and token metrics in addition to traces. */
  exportMetrics?: boolean
  /** Maximum number of spans in one exported batch. */
  maxExportBatchSize: number
  /** Maximum queued spans before the SDK starts dropping new spans. */
  maxQueueSize: number
  /** Delay between trace export batches. */
  traceExportIntervalMs: number
  /** Delay between metric exports. */
  metricExportIntervalMs: number
  /** OTLP export timeout for traces and metrics. */
  exportTimeoutMs: number
  /** Emit plugin lifecycle diagnostics through the DSH logger. */
  debug: boolean
}

/** Cordis/Schemastery schema with privacy-safe and backend-neutral defaults. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  endpoint: z.string(),
  traceEndpoint: z.string(),
  metricEndpoint: z.string(),
  headers: z.dict(z.string()).default({}),
  serviceName: z.string(),
  resourceAttributes: z.dict(z.string()).default({}),
  captureContent: z.boolean(),
  contentMaxChars: z.number().step(1).min(1).default(128_000),
  exportMetrics: z.boolean(),
  maxExportBatchSize: z.number().step(1).min(1).default(512),
  maxQueueSize: z.number().step(1).min(1).default(2_048),
  traceExportIntervalMs: z.number().step(1).min(1).default(5_000),
  metricExportIntervalMs: z.number().step(1).min(1).default(60_000),
  exportTimeoutMs: z.number().step(1).min(1).default(30_000),
  debug: z.boolean().default(false),
})

const METRICS_EXPORTER_ENV = 'OTEL_METRICS_EXPORTER'
const CONTENT_CAPTURE_ENV = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'
const SPAN_CONTENT_MODES = new Set(['SPAN_ONLY', 'SPAN_AND_EVENT'])

/**
 * Resolve the privacy-sensitive content switch.
 *
 * An explicit plugin setting always wins. When it is omitted, reuse the
 * content-capture modes understood by @loongsuite/otel-util-genai. Modes that
 * do not place content on spans remain disabled because this plugin exports
 * trace spans rather than GenAI log events.
 */
export function resolveCaptureContent(
  configured: boolean | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (configured !== undefined) return configured
  const mode = environment[CONTENT_CAPTURE_ENV]?.trim().toUpperCase()
  return mode !== undefined && SPAN_CONTENT_MODES.has(mode)
}

/**
 * Resolve the metrics switch.
 *
 * An explicit plugin setting always wins. When it is omitted, the standard
 * `OTEL_METRICS_EXPORTER=none` spelling disables metrics; every other value
 * keeps the current behaviour because the plugin only ever exports OTLP.
 */
export function resolveExportMetrics(
  configured: boolean | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (configured !== undefined) return configured
  return environment[METRICS_EXPORTER_ENV]?.trim().toLowerCase() !== 'none'
}
