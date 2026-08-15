import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { DshTraceCoordinator } from '../src/coordinator.js'
import { createTelemetryPipeline } from '../src/telemetry.js'
import {
  collect,
  event,
  llmOptions,
  logger,
  session,
  successfulStream,
  testConfig,
} from './helpers.js'

describe('standard OTLP exporters', () => {
  it('POSTs protobuf traces and metrics to their signal paths', async () => {
    const requests: Array<{ url: string; contentType?: string; bytes: number }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        requests.push({
          url: request.url ?? '',
          ...request.headers['content-type'] === undefined
            ? {}
            : { contentType: request.headers['content-type'] },
          bytes: Buffer.concat(chunks).length,
        })
        response.writeHead(200, { 'content-type': 'application/x-protobuf' })
        response.end()
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as AddressInfo
    const config = testConfig({ endpoint: `http://127.0.0.1:${address.port}` })
    const pipeline = createTelemetryPipeline(config)
    const coordinator = new DshTraceCoordinator(pipeline.handler, config, logger)
    const current = session('otlp-session')
    const started = Date.now() - 100
    coordinator.adoptSession(current)
    coordinator.onSessionEvent(current, event('turn/start', { turn: 1 }, 0, started))
    coordinator.onSessionEvent(current, event('step/start', { turn: 1, step: 1 }, 1, started + 1))
    await collect(coordinator.interceptLlm(llmOptions('otlp-session'), successfulStream))
    coordinator.onSessionEvent(current, event('step/end', { turn: 1, step: 1 }, 2, Date.now()))
    coordinator.onSessionEvent(current, event(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
      3,
      Date.now(),
    ))

    await pipeline.forceFlush()
    await pipeline.shutdown()
    server.close()
    await once(server, 'close')

    const traces = requests.find(request => request.url === '/v1/traces')
    const metric = requests.find(request => request.url === '/v1/metrics')
    expect(traces).toMatchObject({ contentType: 'application/x-protobuf' })
    expect(metric).toMatchObject({ contentType: 'application/x-protobuf' })
    expect(traces?.bytes).toBeGreaterThan(0)
    expect(metric?.bytes).toBeGreaterThan(0)
  })
})
