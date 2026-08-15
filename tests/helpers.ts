import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import type { Config } from '../src/config.js'
import type {
  DshContentBlock,
  DshGenerateOptions,
  DshMessage,
  DshSession,
  DshSessionEvent,
  DshStreamChunk,
} from '../src/dsh-types.js'
import { createTelemetryPipeline } from '../src/telemetry.js'

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    headers: {},
    resourceAttributes: {},
    captureContent: false,
    contentMaxChars: 128_000,
    exportMetrics: true,
    maxExportBatchSize: 512,
    maxQueueSize: 2_048,
    traceExportIntervalMs: 5_000,
    metricExportIntervalMs: 60_000,
    exportTimeoutMs: 30_000,
    debug: false,
    ...overrides,
  }
}

export function testPipeline(config: Config) {
  const spans = new InMemorySpanExporter()
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const pipeline = createTelemetryPipeline(config, {
    traceExporter: spans,
    metricExporter: metrics,
    simpleSpanProcessor: true,
  })
  return { pipeline, spans, metrics }
}

export function session(id = 'session-test'): DshSession {
  return {
    id,
    header: {
      id,
      createdAt: Date.now() - 1_000,
      cwd: '/tmp/project',
      agentPreset: 'default',
    },
    firstLiveSeq: 0,
    events: [],
  }
}

export function message(
  id: string,
  role: DshMessage['role'],
  content: DshContentBlock[],
  source: DshMessage['source'],
): DshMessage {
  return { id, role, content, source }
}

export function event(
  type: string,
  data: unknown,
  seq: number,
  time: number,
): DshSessionEvent {
  return { type, data, seq, time } as DshSessionEvent
}

export function llmOptions(sessionId = 'session-test'): DshGenerateOptions {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    messages: [message(
      'user-1',
      'user',
      [{ type: 'text', text: 'Hello from DSH' }],
      { kind: 'user' },
    )],
    system: 'You are a concise assistant.',
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }],
    sessionId,
  }
}

export async function collect(stream: AsyncIterable<DshStreamChunk>): Promise<DshStreamChunk[]> {
  const chunks: DshStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

export function successfulStream(): AsyncIterable<DshStreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Hi' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi!' } }
    yield {
      type: 'usage',
      usage: {
        inputTokens: 8,
        outputTokens: 3,
        cacheReadTokens: 2,
        reasoningTokens: 1,
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

export const logger = {
  messages: [] as string[],
  info(message: string): void { this.messages.push(message) },
  warn(message: string): void { this.messages.push(message) },
  error(message: string): void { this.messages.push(message) },
  debug(message: string): void { this.messages.push(message) },
}
