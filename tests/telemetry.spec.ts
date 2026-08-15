import { afterEach, describe, expect, it } from 'vitest'
import { parseKeyValueList } from '../src/telemetry.js'
import { testConfig, testPipeline } from './helpers.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  Object.assign(process.env, ORIGINAL_ENV)
})

describe('OTLP pipeline configuration', () => {
  it('normalizes one shared endpoint for both signals', async () => {
    const { pipeline } = testPipeline(testConfig({ endpoint: 'http://collector:4318/' }))
    expect(pipeline.traceEndpoint).toBe('http://collector:4318/v1/traces')
    expect(pipeline.metricEndpoint).toBe('http://collector:4318/v1/metrics')
    await pipeline.shutdown()
  })

  it('honors signal-specific standard environment endpoints', async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://trace.example/custom'
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://metric.example/custom'
    const { pipeline } = testPipeline(testConfig())
    expect(pipeline.traceEndpoint).toBe('http://trace.example/custom')
    expect(pipeline.metricEndpoint).toBe('http://metric.example/custom')
    await pipeline.shutdown()
  })

  it('parses percent-encoded OTLP headers', () => {
    expect(parseKeyValueList('authorization=Bearer%20token,x-tenant=demo')).toEqual({
      authorization: 'Bearer token',
      'x-tenant': 'demo',
    })
  })

  it('rejects a trace batch larger than the queue', () => {
    expect(() => testPipeline(testConfig({ maxExportBatchSize: 3, maxQueueSize: 2 })))
      .toThrow(/maxExportBatchSize/)
  })
})
