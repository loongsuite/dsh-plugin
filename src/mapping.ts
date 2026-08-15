import type {
  FunctionToolDefinition,
  InputMessage,
  MessagePart,
  OutputMessage,
} from '@loongsuite/otel-util-genai'
import type {
  DshContentBlock,
  DshFinishReason,
  DshGenerateOptions,
  DshMessage,
  DshTokenUsage,
  DshToolSchema,
} from './dsh-types.js'

/** Semantic attribute names whose values contain intentionally captured content. */
export const CONTENT_ATTRIBUTES = {
  inputMessages: 'gen_ai.input.messages',
  outputMessages: 'gen_ai.output.messages',
  systemInstructions: 'gen_ai.system_instructions',
  toolDefinitions: 'gen_ai.tool.definitions',
  toolArguments: 'gen_ai.tool.call.arguments',
  toolResult: 'gen_ai.tool.call.result',
} as const

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Parse model-produced JSON arguments without discarding malformed raw text. */
export function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/** Convert one DSH content block to the OTel GenAI message-parts vocabulary. */
export function mapContentBlock(block: DshContentBlock): MessagePart {
  const value = objectValue(block)
  switch (block.type) {
    case 'text':
      return { type: 'text', content: typeof value.text === 'string' ? value.text : '' }
    case 'reasoning':
      return { type: 'reasoning', content: typeof value.text === 'string' ? value.text : '' }
    case 'tool-call':
      return {
        type: 'tool_call',
        id: typeof value.id === 'string' ? value.id : null,
        name: typeof value.name === 'string' ? value.name : '',
        arguments: parseToolArguments(typeof value.arguments === 'string' ? value.arguments : ''),
      }
    case 'tool-result': {
      const nested = Array.isArray(value.content)
        ? value.content.map(part => mapContentBlock(part as DshContentBlock))
        : []
      return {
        type: 'tool_call_response',
        id: typeof value.toolCallId === 'string' ? value.toolCallId : null,
        response: nested,
      }
    }
    case 'image': {
      const attachment = objectValue(value.attachment)
      return {
        type: 'image',
        attachment_id: attachment.attachmentId,
        mime_type: attachment.mediaType,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
        ...typeof attachment.name === 'string' ? { name: attachment.name } : {},
      }
    }
    default:
      return { ...value }
  }
}

export function mapContent(blocks: readonly DshContentBlock[]): MessagePart[] {
  return blocks.map(mapContentBlock)
}

/** DSH encodes tool results as user messages; GenAI represents them with role=tool. */
export function mapInputMessage(message: DshMessage): InputMessage {
  return {
    role: message.source.kind === 'tool' ? 'tool' : message.role,
    parts: mapContent(message.content),
  }
}

export function mapInputMessages(messages: readonly DshMessage[]): InputMessage[] {
  return messages.map(mapInputMessage)
}

export function mapOutputMessage(
  message: DshMessage,
  finishReason: string,
): OutputMessage {
  return {
    role: message.role,
    parts: mapContent(message.content),
    finishReason,
  }
}

export function mapToolDefinitions(tools: readonly DshToolSchema[] | undefined): FunctionToolDefinition[] {
  return (tools ?? []).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description || null,
    parameters: tool.parameters,
  }))
}

export function mapSystemInstruction(system: string | undefined): MessagePart[] {
  return system === undefined || system === '' ? [] : [{ type: 'text', content: system }]
}

/** Normalize DSH finish kinds to the stable GenAI spellings used on spans. */
export function mapFinishReason(reason: DshFinishReason | string | undefined): string {
  const kind = typeof reason === 'string' ? reason : reason?.kind
  switch (kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'aborted': return 'cancelled'
    case 'stop':
    case 'error':
      return kind
    default:
      return kind ?? 'unknown'
  }
}

/** Apply DSH's disjoint usage buckets without double-counting reasoning output. */
export function applyUsage(
  target: {
    inputTokens?: number | null
    outputTokens?: number | null
    usageCacheReadInputTokens?: number | null
    usageCacheCreationInputTokens?: number | null
    attributes?: Record<string, unknown>
  },
  usage: DshTokenUsage,
): void {
  target.inputTokens = usage.inputTokens
  target.outputTokens = usage.outputTokens
  if (usage.cacheReadTokens !== undefined) {
    target.usageCacheReadInputTokens = usage.cacheReadTokens
  }
  if (usage.cacheWriteTokens !== undefined) {
    target.usageCacheCreationInputTokens = usage.cacheWriteTokens
  }
  target.attributes ??= {}
  target.attributes['gen_ai.usage.total_tokens'] = usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
  if (usage.reasoningTokens !== undefined) {
    target.attributes['gen_ai.usage.reasoning_tokens'] = usage.reasoningTokens
  }
}

/** Copy scalar request controls and DSH correlation fields into one LLM invocation. */
export function llmRequestAttributes(options: DshGenerateOptions): Record<string, unknown> {
  return {
    'gen_ai.agent.system': 'deepseek-harness',
    ...options.reasoningEffort === undefined
      ? {}
      : { 'gen_ai.request.reasoning_effort': options.reasoningEffort },
  }
}

/** JSON-serialize captured content with a valid, explicit truncation marker. */
export function serializeCaptured(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value)
  if (serialized.length <= maxChars) return serialized
  return JSON.stringify({
    truncated: true,
    original_characters: serialized.length,
    limit_characters: maxChars,
  })
}

export function capturedLlmAttributes(
  options: DshGenerateOptions,
  outputMessages: readonly OutputMessage[],
  maxChars: number,
): Record<string, string> {
  return {
    [CONTENT_ATTRIBUTES.inputMessages]: serializeCaptured(mapInputMessages(options.messages), maxChars),
    [CONTENT_ATTRIBUTES.outputMessages]: serializeCaptured(outputMessages.map(message => ({
      role: message.role,
      parts: message.parts,
      finish_reason: message.finishReason,
    })), maxChars),
    [CONTENT_ATTRIBUTES.systemInstructions]: serializeCaptured(mapSystemInstruction(options.system), maxChars),
    [CONTENT_ATTRIBUTES.toolDefinitions]: serializeCaptured(mapToolDefinitions(options.tools), maxChars),
  }
}

export function capturedConversationAttributes(
  inputMessages: readonly InputMessage[],
  outputMessages: readonly OutputMessage[],
  maxChars: number,
): Record<string, string> {
  return {
    [CONTENT_ATTRIBUTES.inputMessages]: serializeCaptured(inputMessages, maxChars),
    [CONTENT_ATTRIBUTES.outputMessages]: serializeCaptured(outputMessages.map(message => ({
      role: message.role,
      parts: message.parts,
      finish_reason: message.finishReason,
    })), maxChars),
  }
}
