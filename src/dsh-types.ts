/** Minimal structural types for the public DeepSeek Harness extension points. */

export interface DshImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export type DshContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: DshImageRef }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: string; content: DshContentBlock[]; isError?: boolean }
  | ({ type: string } & Record<string, unknown>)

export interface DshMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: DshContentBlock[]
  source: {
    kind: string
    provider?: string
    model?: string
    callId?: string
    [key: string]: unknown
  }
}

export interface DshToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface DshTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface DshFailure {
  message: string
  code: string
  status?: number
  requestId?: string
}

export type DshFinishReason =
  | { kind: 'stop' | 'tool-calls' | 'max-tokens' }
  | { kind: 'aborted' | 'error'; failure: DshFailure }
  | ({ kind: string } & Record<string, unknown>)

export type DshStreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: DshContentBlock }
  | { type: 'usage'; usage: DshTokenUsage }
  | { type: 'finish'; reason: DshFinishReason }
  | ({ type: string } & Record<string, unknown>)

export interface DshGenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: DshMessage[]
  system?: string
  tools?: DshToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
}

export interface DshSessionHeader {
  id: string
  createdAt?: number
  cwd?: string
  parentSession?: string
  seedLength?: number
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

export interface DshSession {
  readonly id: string
  readonly header: DshSessionHeader
  readonly firstLiveSeq?: number
  readonly events?: readonly DshSessionEvent[]
}

export type DshTurnReason =
  | { kind: 'completed' | 'blocked' | 'max-tokens' | 'interrupted' }
  | { kind: 'aborted'; reason?: unknown }
  | { kind: 'error'; error?: DshFailure }
  | ({ kind: string } & Record<string, unknown>)

export interface DshEventDataMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: DshTurnReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'user/message': DshMessage
  'assistant/chunk': { turn: number; step: number; chunk: DshStreamChunk }
  'assistant/message': { turn: number; step: number; message: DshMessage; usage?: DshTokenUsage }
  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string }
  'tool/result': {
    turn: number
    step: number
    message: DshMessage
    error?: { name: string; code: string }
    meta?: unknown
  }
  'request/header': {
    header: {
      config: Record<string, unknown>
      system?: string
      tools?: DshToolSchema[]
    }
    reason: string
  }
  'request/context': { provider: string; model: string; contextWindow?: number }
}

export type KnownDshEvent = {
  [K in keyof DshEventDataMap]: {
    type: K
    seq: number
    time: number
    data: DshEventDataMap[K]
  }
}[keyof DshEventDataMap]

export type DshSessionEvent = KnownDshEvent | {
  type: string
  seq: number
  time: number
  data: unknown
}

export interface DshLogger {
  debug?(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface DshPluginContext {
  sessions: {
    list(): DshSession[]
  }
  logger: DshLogger
  on(name: 'session/created', listener: (session: DshSession) => void): () => void
  on(name: 'session/disposed', listener: (session: DshSession) => void): () => void
  on(name: 'session/event', listener: (session: DshSession, event: DshSessionEvent) => void): () => void
  on(
    name: 'llm/stream',
    listener: (
      options: DshGenerateOptions,
      next: () => AsyncIterable<DshStreamChunk>,
    ) => AsyncIterable<DshStreamChunk>,
  ): () => void
  effect(effect: () => (() => void | Promise<void>), label?: string): unknown
}
