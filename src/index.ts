/**
 * Standalone LoongSuite OpenTelemetry instrumentation for DeepSeek Harness.
 *
 * @module @loongsuite/dsh-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  Config as ConfigSchema,
  type Config as PluginConfig,
  resolveCaptureContent,
} from './config.js'
import { DshTraceCoordinator } from './coordinator.js'
import type { DshPluginContext } from './dsh-types.js'
import { createTelemetryPipeline } from './telemetry.js'

export const name = 'loongsuite-observability'
export const inject = ['sessions', 'llm'] as const
export const Config = ConfigSchema
export type Config = PluginConfig

/** Install native DSH lifecycle observation and an isolated OTLP pipeline. */
export function apply(ctx: Context, config: Config): void {
  const dsh = ctx as unknown as DshPluginContext
  const resolvedConfig = {
    ...config,
    captureContent: resolveCaptureContent(config.captureContent),
  }
  if (!resolvedConfig.enabled) {
    dsh.logger.info('[loongsuite-observability] collection is disabled')
    return
  }

  const telemetry = createTelemetryPipeline(resolvedConfig)
  const coordinator = new DshTraceCoordinator(telemetry.handler, resolvedConfig, dsh.logger)

  // Adopt identity only. Replaying existing events would duplicate spans after
  // HMR, so telemetry begins at each session's next native turn/start.
  for (const session of dsh.sessions.list()) coordinator.adoptSession(session)

  const disposers = [
    dsh.on('session/created', (session) => {
      try {
        coordinator.adoptSession(session)
      } catch (error: unknown) {
        dsh.logger.warn(
          `[loongsuite-observability] failed to adopt session ${String(session.id)}: ${String(error)}`,
        )
      }
    }),
    dsh.on('session/event', (session, event) => coordinator.onSessionEvent(session, event)),
    dsh.on('session/disposed', (session) => {
      try {
        coordinator.disposeSession(session)
      } catch (error: unknown) {
        dsh.logger.warn(
          `[loongsuite-observability] failed to dispose session ${String(session.id)}: ${String(error)}`,
        )
      }
    }),
    dsh.on('llm/stream', (options, next) => coordinator.interceptLlm(options, next)),
  ]

  dsh.effect(() => async () => {
    for (const dispose of disposers.reverse()) dispose()
    try {
      coordinator.closeAll()
    } catch (error: unknown) {
      dsh.logger.warn(`[loongsuite-observability] failed to close live spans: ${String(error)}`)
    }
    await telemetry.shutdown()
  }, 'loongsuite-observability: detach listeners and shutdown OTLP')

  const traceDestination = telemetry.traceEndpoint ?? 'the standard OTLP trace endpoint'
  const metricDestination = resolvedConfig.exportMetrics
    ? telemetry.metricEndpoint ?? 'the standard OTLP metric endpoint'
    : 'disabled'
  dsh.logger.info(
    `[loongsuite-observability] loaded; traces=${traceDestination}; metrics=${metricDestination}; content=${resolvedConfig.captureContent ? 'enabled' : 'disabled'}`,
  )
}
