import { describe, expect, it } from 'vitest'
import {
  applyUsage,
  capturedConversationAttributes,
  mapContent,
  mapFinishReason,
  mapInputMessage,
  parseToolArguments,
  serializeCaptured,
} from '../src/mapping.js'
import { message } from './helpers.js'

describe('DSH → GenAI mapping', () => {
  it('preserves text, reasoning, tool calls, tool results and image metadata', () => {
    const parts = mapContent([
      { type: 'text', text: 'answer' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'contents' }],
      },
      {
        type: 'image',
        attachment: {
          attachmentId: 'sha256:abc',
          mediaType: 'image/png',
          bytes: 10,
          width: 2,
          height: 3,
        },
      },
    ])

    expect(parts).toEqual([
      { type: 'text', content: 'answer' },
      { type: 'reasoning', content: 'thinking' },
      { type: 'tool_call', id: 'call-1', name: 'read_file', arguments: { path: 'a.txt' } },
      {
        type: 'tool_call_response',
        id: 'call-1',
        response: [{ type: 'text', content: 'contents' }],
      },
      {
        type: 'image',
        attachment_id: 'sha256:abc',
        mime_type: 'image/png',
        bytes: 10,
        width: 2,
        height: 3,
      },
    ])
  })

  it('maps tool-result user messages to role=tool', () => {
    const mapped = mapInputMessage(message(
      'tool-1',
      'user',
      [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
      { kind: 'tool', callId: 'call-1' },
    ))
    expect(mapped.role).toBe('tool')
  })

  it('keeps malformed tool arguments as raw strings and normalizes finish reasons', () => {
    expect(parseToolArguments('{bad')).toBe('{bad')
    expect(mapFinishReason('tool-calls')).toBe('tool_calls')
    expect(mapFinishReason('max-tokens')).toBe('length')
    expect(mapFinishReason('aborted')).toBe('cancelled')
  })

  it('does not double-count reasoning tokens in total usage', () => {
    const target: Record<string, unknown> = { attributes: {} }
    applyUsage(target, {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
    })
    // The conventions define the cache counts as subsets of input_tokens, so
    // DSH's uncached bucket is summed with both cache buckets: 10 + 2 + 1.
    expect(target.inputTokens).toBe(13)
    expect(target.usageCacheReadInputTokens).toBe(2)
    expect(target.usageCacheCreationInputTokens).toBe(1)
    expect((target.attributes as Record<string, unknown>)['gen_ai.usage.total_tokens']).toBe(18)
    expect((target.attributes as Record<string, unknown>)['gen_ai.usage.reasoning_tokens']).toBe(3)
  })

  it('keeps the cache buckets within input tokens when the cache serves most of the prompt', () => {
    // The shape of a warm session: cache reads exceed the uncached remainder.
    // Reporting DSH's uncached bucket as input_tokens here is what made
    // consumers compute cache hit rates above 100%.
    const target: Record<string, unknown> = { attributes: {} }
    applyUsage(target, { inputTokens: 2458, outputTokens: 697, cacheReadTokens: 7168 })
    expect(target.inputTokens).toBe(9626)
    expect(target.usageCacheReadInputTokens).toBe(7168)
    expect(target.usageCacheReadInputTokens as number).toBeLessThanOrEqual(target.inputTokens as number)
    expect((target.attributes as Record<string, unknown>)['gen_ai.usage.total_tokens']).toBe(10323)
  })

  it('leaves input tokens alone when the provider reports no cache buckets', () => {
    const target: Record<string, unknown> = { attributes: {} }
    applyUsage(target, { inputTokens: 12, outputTokens: 4 })
    expect(target.inputTokens).toBe(12)
    expect(target.usageCacheReadInputTokens).toBeUndefined()
    expect(target.usageCacheCreationInputTokens).toBeUndefined()
    expect((target.attributes as Record<string, unknown>)['gen_ai.usage.total_tokens']).toBe(16)
  })

  it('replaces oversized content with valid truncation metadata', () => {
    const serialized = serializeCaptured({ prompt: 'x'.repeat(100) }, 20)
    expect(() => JSON.parse(serialized)).not.toThrow()
    expect(JSON.parse(serialized)).toMatchObject({ truncated: true, limit_characters: 20 })
  })

  it('serializes captured output messages with the GenAI finish_reason field', () => {
    const captured = capturedConversationAttributes([], [{
      role: 'assistant',
      parts: [{ type: 'text', content: 'done' }],
      finishReason: 'stop',
    }], 1_000)
    expect(JSON.parse(captured['gen_ai.output.messages']!)).toEqual([{
      role: 'assistant',
      parts: [{ type: 'text', content: 'done' }],
      finish_reason: 'stop',
    }])
  })
})
