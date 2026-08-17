import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshGenerateOptions, DshSession, DshSessionEvent, DshStreamChunk } from '../src/dsh-types.js'
import { apply } from '../src/index.js'
import { llmOptions, session, successfulStream, testConfig } from './helpers.js'

const mocks = vi.hoisted(() => {
  const coordinator = {
    adoptSession: vi.fn(),
    disposeSession: vi.fn(),
    onSessionEvent: vi.fn(),
    interceptLlm: vi.fn(),
    closeAll: vi.fn(),
  }
  const telemetry = {
    handler: { id: 'handler' },
    traceEndpoint: 'http://collector.example/v1/traces',
    metricEndpoint: 'http://collector.example/v1/metrics',
    shutdown: vi.fn(async () => undefined),
  }
  return {
    coordinator,
    telemetry,
    createTelemetryPipeline: vi.fn(() => telemetry),
    DshTraceCoordinator: vi.fn(function MockDshTraceCoordinator() {
      return coordinator
    }),
  }
})

vi.mock('../src/telemetry.js', () => ({
  createTelemetryPipeline: mocks.createTelemetryPipeline,
}))

vi.mock('../src/coordinator.js', () => ({
  DshTraceCoordinator: mocks.DshTraceCoordinator,
}))

type Listener = (...args: never[]) => unknown

function testContext(existing: DshSession[] = []) {
  const listeners = new Map<string, Listener>()
  const disposeOrder: string[] = []
  let cleanup: (() => void | Promise<void>) | undefined
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  const context = {
    sessions: { list: vi.fn(() => existing) },
    logger,
    on: vi.fn((eventName: string, listener: Listener) => {
      listeners.set(eventName, listener)
      return vi.fn(() => disposeOrder.push(eventName))
    }),
    effect: vi.fn((factory: () => () => void | Promise<void>) => {
      cleanup = factory()
    }),
  }
  return {
    context: context as unknown as Context,
    disposeOrder,
    listeners,
    logger,
    runCleanup: async () => cleanup?.(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const mock of Object.values(mocks.coordinator)) mock.mockReset()
  mocks.createTelemetryPipeline.mockReset().mockReturnValue(mocks.telemetry)
  mocks.telemetry.shutdown.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('plugin lifecycle', () => {
  it('does not create telemetry or listeners when collection is disabled', () => {
    const { context, logger } = testContext([session('existing')])

    apply(context, testConfig({ enabled: false }))

    expect(mocks.createTelemetryPipeline).not.toHaveBeenCalled()
    expect(mocks.DshTraceCoordinator).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('[loongsuite-observability] collection is disabled')
  })

  it('wires DSH events, resolves environment switches, and shuts down in order', async () => {
    vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'SPAN_ONLY')
    vi.stubEnv('OTEL_METRICS_EXPORTER', 'none')
    const existing = session('existing')
    const created = session('created')
    const { context, disposeOrder, listeners, logger, runCleanup } = testContext([existing])
    const config = testConfig()
    delete config.captureContent
    delete config.exportMetrics

    apply(context, config)

    expect(mocks.createTelemetryPipeline).toHaveBeenCalledWith(expect.objectContaining({
      captureContent: true,
      exportMetrics: false,
    }))
    expect(mocks.DshTraceCoordinator).toHaveBeenCalledWith(
      mocks.telemetry.handler,
      expect.objectContaining({ captureContent: true, exportMetrics: false }),
      logger,
    )
    expect(mocks.coordinator.adoptSession).toHaveBeenCalledWith(existing)

    const createdListener = listeners.get('session/created') as (value: DshSession) => void
    const eventListener = listeners.get('session/event') as (
      value: DshSession,
      event: DshSessionEvent,
    ) => void
    const disposedListener = listeners.get('session/disposed') as (value: DshSession) => void
    const streamListener = listeners.get('llm/stream') as (
      options: DshGenerateOptions,
      next: () => AsyncIterable<DshStreamChunk>,
    ) => AsyncIterable<DshStreamChunk>
    const observedEvent = { type: 'turn/start', data: { turn: 1 }, seq: 0, time: Date.now() }
    const options = llmOptions('created')
    const downstream = successfulStream()
    const observed = successfulStream()
    mocks.coordinator.interceptLlm.mockReturnValue(observed)

    createdListener(created)
    eventListener(created, observedEvent)
    disposedListener(created)
    const stream = streamListener(options, () => downstream)

    expect(mocks.coordinator.adoptSession).toHaveBeenCalledWith(created)
    expect(mocks.coordinator.onSessionEvent).toHaveBeenCalledWith(created, observedEvent)
    expect(mocks.coordinator.disposeSession).toHaveBeenCalledWith(created)
    expect(mocks.coordinator.interceptLlm).toHaveBeenCalledWith(options, expect.any(Function))
    expect(stream).toBe(observed)
    expect(logger.info).toHaveBeenCalledWith(
      '[loongsuite-observability] loaded; traces=http://collector.example/v1/traces; metrics=disabled; content=enabled',
    )

    await runCleanup()

    expect(disposeOrder).toEqual([
      'llm/stream',
      'session/disposed',
      'session/event',
      'session/created',
    ])
    expect(mocks.coordinator.closeAll).toHaveBeenCalledOnce()
    expect(mocks.telemetry.shutdown).toHaveBeenCalledOnce()
    expect(mocks.coordinator.closeAll.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.telemetry.shutdown.mock.invocationCallOrder[0]!)
  })

  it('isolates session and close failures while still shutting down telemetry', async () => {
    const { context, listeners, logger, runCleanup } = testContext()
    apply(context, testConfig())
    const current = session('failure')
    mocks.coordinator.adoptSession.mockImplementationOnce(() => {
      throw new Error('adopt failed')
    })
    mocks.coordinator.disposeSession.mockImplementationOnce(() => {
      throw new Error('dispose failed')
    })
    mocks.coordinator.closeAll.mockImplementationOnce(() => {
      throw new Error('close failed')
    })

    const createdListener = listeners.get('session/created') as (value: DshSession) => void
    const disposedListener = listeners.get('session/disposed') as (value: DshSession) => void
    createdListener(current)
    disposedListener(current)
    await runCleanup()

    expect(logger.warn).toHaveBeenCalledWith(
      '[loongsuite-observability] failed to adopt session failure: Error: adopt failed',
    )
    expect(logger.warn).toHaveBeenCalledWith(
      '[loongsuite-observability] failed to dispose session failure: Error: dispose failed',
    )
    expect(logger.warn).toHaveBeenCalledWith(
      '[loongsuite-observability] failed to close live spans: Error: close failed',
    )
    expect(mocks.telemetry.shutdown).toHaveBeenCalledOnce()
  })
})
