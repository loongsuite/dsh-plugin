import { describe, expect, it } from 'vitest'
import { Config, resolveCaptureContent, resolveExportMetrics } from '../src/config.js'

describe('resolveCaptureContent', () => {
  it('can distinguish an omitted setting from an explicit false after schema normalization', () => {
    expect(Config({} as never)).not.toHaveProperty('captureContent')
    expect(Config({ captureContent: false } as never)).toHaveProperty('captureContent', false)
  })

  it('can distinguish an omitted exportMetrics from an explicit value after schema normalization', () => {
    expect(Config({} as never)).not.toHaveProperty('exportMetrics')
    expect(Config({ exportMetrics: false } as never)).toHaveProperty('exportMetrics', false)
  })

  it('keeps content disabled when neither config nor environment enables it', () => {
    expect(resolveCaptureContent(undefined, {})).toBe(false)
  })

  it.each(['SPAN_ONLY', 'span_and_event', '  SpAn_OnLy  '])(
    'enables span content for environment mode %s',
    (mode) => {
      expect(resolveCaptureContent(undefined, {
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: mode,
      })).toBe(true)
    },
  )

  it.each(['NO_CONTENT', 'EVENT_ONLY', 'true', 'invalid'])(
    'keeps span content disabled for environment mode %s',
    (mode) => {
      expect(resolveCaptureContent(undefined, {
        OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: mode,
      })).toBe(false)
    },
  )

  it('gives an explicit plugin setting precedence over the environment', () => {
    expect(resolveCaptureContent(false, {
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'SPAN_ONLY',
    })).toBe(false)
    expect(resolveCaptureContent(true, {
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'NO_CONTENT',
    })).toBe(true)
  })
})

describe('resolveExportMetrics', () => {
  it('exports metrics when neither config nor environment says otherwise', () => {
    expect(resolveExportMetrics(undefined, {})).toBe(true)
  })

  it.each(['none', ' NONE ', 'None'])(
    'disables metrics for environment value %s',
    (value) => {
      expect(resolveExportMetrics(undefined, { OTEL_METRICS_EXPORTER: value })).toBe(false)
    },
  )

  it.each(['otlp', 'OTLP', 'prometheus', 'invalid'])(
    'keeps metrics enabled for environment value %s',
    (value) => {
      expect(resolveExportMetrics(undefined, { OTEL_METRICS_EXPORTER: value })).toBe(true)
    },
  )

  it('gives an explicit plugin setting precedence over the environment', () => {
    expect(resolveExportMetrics(false, {})).toBe(false)
    expect(resolveExportMetrics(true, { OTEL_METRICS_EXPORTER: 'none' })).toBe(true)
  })
})
