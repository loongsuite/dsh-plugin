import { describe, expect, it } from 'vitest'
import { Config, resolveCaptureContent } from '../src/config.js'

describe('resolveCaptureContent', () => {
  it('can distinguish an omitted setting from an explicit false after schema normalization', () => {
    expect(Config({} as never)).not.toHaveProperty('captureContent')
    expect(Config({ captureContent: false } as never)).toHaveProperty('captureContent', false)
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
