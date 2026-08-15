import { SpanStatusCode } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshTraceCoordinator } from '../src/coordinator.js'
import { CONTENT_ATTRIBUTES } from '../src/mapping.js'
import {
  collect,
  event,
  llmOptions,
  logger,
  message,
  session,
  successfulStream,
  testConfig,
  testPipeline,
} from './helpers.js'

afterEach(() => vi.unstubAllEnvs())

describe('DshTraceCoordinator', () => {
  it('exports ENTRY → AGENT → STEP → LLM/TOOL and LLM metrics', async () => {
    const config = testConfig({ captureContent: true })
    const { pipeline, spans, metrics } = testPipeline(config)
    const coordinator = new DshTraceCoordinator(pipeline.handler, config, logger)
    const current = session()
    const started = Date.now() - 1_000
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 10))
    coordinator.onSessionEvent(current, event(
      'user/message',
      message('user-1', 'user', [{ type: 'text', text: 'Hello from DSH' }], { kind: 'user' }),
      2,
      started + 20,
    ))

    await collect(coordinator.interceptLlm(llmOptions(), successfulStream))
    coordinator.onSessionEvent(current, event(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: message(
          'assistant-1',
          'assistant',
          [{ type: 'text', text: 'Hi!' }],
          { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' },
        ),
      },
      3,
      Date.now(),
    ))
    coordinator.onSessionEvent(current, event(
      'tool/call',
      { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      4,
      Date.now(),
    ))
    coordinator.onSessionEvent(current, event(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: message(
          'tool-1',
          'user',
          [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file' }] }],
          { kind: 'tool', callId: 'call-1' },
        ),
      },
      5,
      Date.now(),
    ))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 6, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      7,
      Date.now(),
    ))
    await pipeline.forceFlush()

    const finished = spans.getFinishedSpans()
    expect(finished).toHaveLength(5)
    const byKind = new Map(finished.map(span => [span.attributes['gen_ai.span.kind'], span]))
    const entry = byKind.get('ENTRY')!
    const agent = byKind.get('AGENT')!
    const step = byKind.get('STEP')!
    const llm = byKind.get('LLM')!
    const tool = byKind.get('TOOL')!
    expect(agent.parentSpanContext?.spanId).toBe(entry.spanContext().spanId)
    expect(step.parentSpanContext?.spanId).toBe(agent.spanContext().spanId)
    expect(llm.parentSpanContext?.spanId).toBe(step.spanContext().spanId)
    expect(tool.parentSpanContext?.spanId).toBe(step.spanContext().spanId)
    expect(new Set(finished.map(span => span.spanContext().traceId))).toHaveLength(1)
    expect(llm.status.code).toBe(SpanStatusCode.OK)
    expect(llm.attributes['gen_ai.usage.input_tokens']).toBe(8)
    expect(llm.attributes['gen_ai.usage.output_tokens']).toBe(3)
    expect(llm.attributes['gen_ai.usage.total_tokens']).toBe(13)
    expect(llm.attributes['gen_ai.response.time_to_first_token']).toEqual(expect.any(Number))
    expect(llm.attributes[CONTENT_ATTRIBUTES.inputMessages]).toContain('Hello from DSH')
    expect(tool.attributes[CONTENT_ATTRIBUTES.toolArguments]).toContain('a.txt')
    expect(tool.attributes[CONTENT_ATTRIBUTES.toolResult]).toContain('file')

    const metricNames = metrics.getMetrics().flatMap(resource =>
      resource.scopeMetrics.flatMap(scope => scope.metrics.map(metric => metric.descriptor.name)),
    )
    expect(metricNames).toContain('gen_ai.client.operation.duration')
    expect(metricNames).toContain('gen_ai.client.token.usage')
    await pipeline.shutdown()
  })

  it('keeps content absent by default', async () => {
    vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental')
    vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'SPAN_ONLY')
    const config = testConfig()
    const { pipeline, spans } = testPipeline(config)
    const coordinator = new DshTraceCoordinator(pipeline.handler, config, logger)
    const current = session('privacy-session')
    const started = Date.now() - 100
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 1))
    await collect(coordinator.interceptLlm(llmOptions('privacy-session'), successfulStream))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 2, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      3,
      Date.now(),
    ))

    const llm = spans.getFinishedSpans().find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!
    expect(llm.attributes).not.toHaveProperty(CONTENT_ATTRIBUTES.inputMessages)
    expect(llm.attributes).not.toHaveProperty(CONTENT_ATTRIBUTES.outputMessages)
    await pipeline.shutdown()
  })

  it('creates a failed LLM span followed by a successful retry in one STEP', async () => {
    const config = testConfig({ exportMetrics: false })
    const { pipeline, spans } = testPipeline(config)
    const coordinator = new DshTraceCoordinator(pipeline.handler, config, logger)
    const current = session('retry-session')
    const started = Date.now() - 100
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 1))

    await collect(coordinator.interceptLlm(llmOptions('retry-session'), () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } }
    })()))
    await collect(coordinator.interceptLlm(llmOptions('retry-session'), successfulStream))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 2, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      3,
      Date.now(),
    ))

    const llms = spans.getFinishedSpans()
      .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
      .sort((left, right) => Number(left.attributes['dsh.llm.attempt']) - Number(right.attributes['dsh.llm.attempt']))
    expect(llms).toHaveLength(2)
    expect(llms[0]?.status.code).toBe(SpanStatusCode.ERROR)
    expect(llms[0]?.attributes['error.type']).toBe('RATE_LIMIT')
    expect(llms[1]?.status.code).toBe(SpanStatusCode.OK)
    expect(llms.map(span => span.attributes['dsh.llm.attempt'])).toEqual([1, 2])
    expect(llms[0]?.parentSpanContext?.spanId).toBe(llms[1]?.parentSpanContext?.spanId)
    const step = spans.getFinishedSpans()
      .find(span => span.attributes['gen_ai.span.kind'] === 'STEP')
    expect(step?.status.code).toBe(SpanStatusCode.OK)
    await pipeline.shutdown()
  })

  it('marks STEP as failed when its terminal LLM attempt ends with an error', async () => {
    const config = testConfig({ exportMetrics: false })
    const { pipeline, spans } = testPipeline(config)
    const coordinator = new DshTraceCoordinator(pipeline.handler, config, logger)
    const current = session('failed-step-session')
    const started = Date.now() - 100
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 1))

    await collect(coordinator.interceptLlm(llmOptions('failed-step-session'), () => (
      async function* () {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'rate limited', code: 'RATE_LIMIT' },
          },
        }
      }
    )()))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 2, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      {
        turn: 1,
        reason: {
          kind: 'error',
          error: { message: 'rate limited', code: 'RATE_LIMIT' },
        },
      },
      3,
      Date.now(),
    ))

    const finished = spans.getFinishedSpans()
    const step = finished.find(span => span.attributes['gen_ai.span.kind'] === 'STEP')
    const llm = finished.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')
    expect(llm?.status.code).toBe(SpanStatusCode.ERROR)
    expect(step?.status.code).toBe(SpanStatusCode.ERROR)
    expect(step?.status.message).toBe('DSH step error')
    expect(step?.attributes['gen_ai.react.finish_reason']).toBe('error')
    expect(step?.attributes['error.type']).toBe('ERROR')
    await pipeline.shutdown()
  })

  it('does not replay historical events when adopting an existing session', async () => {
    const config = testConfig({ exportMetrics: false })
    const { pipeline, spans } = testPipeline(config)
    const coordinator = new DshTraceCoordinator(pipeline.handler, config, logger)
    const current = {
      ...session('adopt-session'),
      events: [
        event('turn/start', { turn: 1 }, 0, Date.now() - 1_000),
        event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1, Date.now() - 900),
      ],
    }
    coordinator.adoptSession(current)
    expect(spans.getFinishedSpans()).toHaveLength(0)
    coordinator.closeAll()
    await pipeline.shutdown()
  })
})
