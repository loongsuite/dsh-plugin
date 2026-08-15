import {
  ROOT_CONTEXT,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api'
import {
  createEntryInvocation,
  createExecuteToolInvocation,
  createInvokeAgentInvocation,
  createLLMInvocation,
  createReactStepInvocation,
  type EntryInvocation,
  type ExecuteToolInvocation,
  type ExtendedTelemetryHandler,
  type InputMessage,
  type InvokeAgentInvocation,
  type LLMInvocation,
  type OutputMessage,
  type ReactStepInvocation,
} from '@loongsuite/otel-util-genai'
import type { Config } from './config.js'
import type {
  DshFailure,
  DshGenerateOptions,
  DshLogger,
  DshMessage,
  DshSession,
  DshSessionEvent,
  DshStreamChunk,
  DshTokenUsage,
  DshTurnReason,
} from './dsh-types.js'
import {
  CONTENT_ATTRIBUTES,
  applyUsage,
  capturedConversationAttributes,
  capturedLlmAttributes,
  llmRequestAttributes,
  mapContent,
  mapFinishReason,
  mapInputMessage,
  mapInputMessages,
  mapOutputMessage,
  mapSystemInstruction,
  mapToolDefinitions,
  parseToolArguments,
  serializeCaptured,
} from './mapping.js'

interface ToolState {
  invocation: ExecuteToolInvocation
  ended: boolean
}

interface LlmState {
  invocation: LLMInvocation
  options: DshGenerateOptions
  blocks: Array<{ type: string } & Record<string, unknown>>
  usage?: DshTokenUsage
  ended: boolean
  firstTokenSeen: boolean
}

interface StepState {
  turn: number
  step: number
  invocation: ReactStepInvocation
  tools: Map<string, ToolState>
  llms: Set<LlmState>
  nextAttempt: number
  lastFinishReason?: string
}

interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface TurnState {
  turn: number
  entry: EntryInvocation
  agent: InvokeAgentInvocation
  step: StepState | undefined
  inputs: InputMessage[]
  outputs: OutputMessage[]
  usage: UsageTotals
}

interface SessionState {
  session: DshSession
  turn: TurnState | undefined
}

interface InvocationWithSpan {
  span?: Span | null
  attributes?: Record<string, unknown>
}

function eventData<T>(event: DshSessionEvent): T {
  return event.data as T
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function genAiError(error: unknown, fallbackType = 'Error'): { message: string; type: string } {
  return {
    message: error instanceof Error ? error.message : String(error),
    type: error instanceof Error ? error.name : fallbackType,
  }
}

function finishFailure(reason: DshTurnReason): DshFailure | undefined {
  if (reason.kind === 'error') {
    const value = (reason as { error?: DshFailure }).error
    return value ?? { message: 'DSH turn ended with an error', code: 'ERROR' }
  }
  if (reason.kind === 'aborted') {
    return { message: 'DSH turn was aborted', code: 'ABORTED' }
  }
  if (reason.kind === 'interrupted') {
    return { message: 'DSH turn was interrupted', code: 'INTERRUPTED' }
  }
  return undefined
}

function succeed(invocation: InvocationWithSpan): void {
  invocation.span?.setStatus({ code: SpanStatusCode.OK })
}

function usageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function addUsage(total: UsageTotals, usage: DshTokenUsage): void {
  total.inputTokens += usage.inputTokens
  total.outputTokens += usage.outputTokens
  total.cacheReadTokens += usage.cacheReadTokens ?? 0
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
}

function applyTotals(invocation: InvokeAgentInvocation, totals: UsageTotals): void {
  invocation.inputTokens = totals.inputTokens
  invocation.outputTokens = totals.outputTokens
  invocation.usageCacheReadInputTokens = totals.cacheReadTokens
  invocation.usageCacheCreationInputTokens = totals.cacheWriteTokens
  ;(invocation.attributes ??= {})['gen_ai.usage.total_tokens'] = totals.inputTokens
    + totals.outputTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens
}

function isVisibleToken(chunk: DshStreamChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return typeof (chunk as { text?: unknown }).text === 'string'
      && (chunk as { text: string }).text !== ''
  }
  if (chunk.type !== 'tool-call-delta') return false
  const value = chunk as { argumentsDelta?: unknown; name?: unknown }
  return value.name !== undefined
    || (typeof value.argumentsDelta === 'string' && value.argumentsDelta !== '')
}

function scalarAttributes(session: DshSession, turn: number): Record<string, unknown> {
  const header = session.header
  return {
    'gen_ai.agent.system': 'deepseek-harness',
    'gen_ai.session.id': String(session.id),
    'gen_ai.turn.id': `${String(session.id)}:${turn}`,
    'dsh.session.id': String(session.id),
    'dsh.turn': turn,
    ...header.cwd === undefined ? {} : { 'dsh.session.cwd': header.cwd },
    ...header.parentSession === undefined
      ? {}
      : { 'dsh.session.parent_id': String(header.parentSession) },
    ...header.origin === undefined ? {} : { 'dsh.session.origin': header.origin },
    ...header.delegationDepth === undefined
      ? {}
      : { 'dsh.session.delegation_depth': header.delegationDepth },
    ...header.agentPreset === undefined
      ? {}
      : { 'dsh.agent.preset': header.agentPreset },
    'gen_ai.agent.name': header.agentPreset || 'deepseek-harness',
  }
}

/**
 * Owns the live GenAI span tree for every DSH session observed by one plugin
 * fiber. All host callbacks enter through contained methods so telemetry
 * failures can never change the model/tool execution path.
 */
export class DshTraceCoordinator {
  private readonly sessions = new Map<string, SessionState>()

  constructor(
    private readonly handler: ExtendedTelemetryHandler,
    private readonly config: Config,
    private readonly logger: DshLogger,
  ) {}

  adoptSession(session: DshSession): void {
    const id = String(session.id)
    const previous = this.sessions.get(id)
    if (previous?.session === session) return
    if (previous?.turn !== undefined) {
      this.closeTurn(previous, { kind: 'interrupted' }, Date.now())
    }
    // Historical events are deliberately not replayed: adoption may be an HMR
    // reload, and replaying them would duplicate already-exported telemetry.
    this.sessions.set(id, { session, turn: undefined })
    this.debug(`adopted session ${id}`)
  }

  disposeSession(session: DshSession): void {
    const state = this.sessions.get(String(session.id))
    if (state === undefined || state.session !== session) return
    if (state.turn !== undefined) this.closeTurn(state, { kind: 'interrupted' }, Date.now())
    this.sessions.delete(String(session.id))
    this.debug(`disposed session ${String(session.id)}`)
  }

  onSessionEvent(session: DshSession, event: DshSessionEvent): void {
    try {
      const state = this.ensureSession(session)
      switch (event.type) {
        case 'turn/start':
          this.startTurn(state, eventData<{ turn: number }>(event).turn, event.time)
          break
        case 'turn/end': {
          const data = eventData<{ turn: number; reason: DshTurnReason }>(event)
          if (state.turn?.turn === data.turn) this.closeTurn(state, data.reason, event.time)
          break
        }
        case 'step/start': {
          const data = eventData<{ turn: number; step: number }>(event)
          this.startStep(state, data.turn, data.step, event.time)
          break
        }
        case 'step/end': {
          const data = eventData<{ turn: number; step: number }>(event)
          const step = state.turn?.step
          if (step?.turn === data.turn && step.step === data.step) {
            this.closeStep(state.turn!, event.time)
          }
          break
        }
        case 'user/message':
          this.captureTurnInput(state, eventData<DshMessage>(event))
          break
        case 'assistant/message': {
          const data = eventData<{ turn: number; step: number; message: DshMessage }>(event)
          this.captureTurnOutput(state, data.turn, data.step, data.message)
          break
        }
        case 'tool/call': {
          const data = eventData<{
            turn: number
            step: number
            callId: string
            name: string
            arguments: string
          }>(event)
          this.startTool(state, data, event.time)
          break
        }
        case 'tool/result': {
          const data = eventData<{
            turn: number
            step: number
            message: DshMessage
            error?: { name: string; code: string }
          }>(event)
          this.endTool(state, data, event.time)
          break
        }
      }
    } catch (error: unknown) {
      this.warn(`failed to observe ${event.type} for session ${String(session.id)}: ${errorMessage(error)}`)
    }
  }

  interceptLlm(
    options: DshGenerateOptions,
    next: () => AsyncIterable<DshStreamChunk>,
  ): AsyncIterable<DshStreamChunk> {
    if (options.sessionId === undefined || options.purpose !== undefined) return next()

    let llm: LlmState | undefined
    try {
      llm = this.startLlm(options)
    } catch (error: unknown) {
      this.warn(`failed to start LLM telemetry for session ${options.sessionId}: ${errorMessage(error)}`)
    }

    let stream: AsyncIterable<DshStreamChunk>
    try {
      stream = next()
    } catch (error: unknown) {
      if (llm !== undefined) this.failLlm(llm, error, Date.now())
      throw error
    }
    return llm === undefined ? stream : this.observeLlmStream(llm, stream)
  }

  closeAll(reason = 'plugin unloaded'): void {
    const now = Date.now()
    for (const state of this.sessions.values()) {
      if (state.turn !== undefined) {
        this.closeTurn(state, {
          kind: 'error',
          error: { message: reason, code: 'PLUGIN_UNLOADED' },
        }, now)
      }
    }
    this.sessions.clear()
  }

  private ensureSession(session: DshSession): SessionState {
    const id = String(session.id)
    const existing = this.sessions.get(id)
    if (existing?.session === session) return existing
    this.adoptSession(session)
    return this.sessions.get(id)!
  }

  private startTurn(state: SessionState, turn: number, startTime: number): void {
    if (state.turn !== undefined) {
      this.closeTurn(state, { kind: 'interrupted' }, startTime)
    }
    const agentName = state.session.header.agentPreset || 'deepseek-harness'
    const attributes = scalarAttributes(state.session, turn)
    const entry = createEntryInvocation({
      sessionId: String(state.session.id),
      attributes: { ...attributes },
    })
    this.handler.startEntry(entry, ROOT_CONTEXT, startTime)
    const agent = createInvokeAgentInvocation('deepseek-harness', {
      conversationId: String(state.session.id),
      agentId: agentName,
      agentName,
      attributes: { ...attributes },
    })
    this.handler.startInvokeAgent(agent, entry.contextToken ?? ROOT_CONTEXT, startTime)
    state.turn = {
      turn,
      entry,
      agent,
      step: undefined,
      inputs: [],
      outputs: [],
      usage: usageTotals(),
    }
    this.debug(`started turn ${String(state.session.id)}:${turn}`)
  }

  private startStep(state: SessionState, turn: number, step: number, startTime: number): void {
    const active = state.turn
    if (active === undefined || active.turn !== turn) return
    if (active.step !== undefined) this.closeStep(active, startTime, 'interrupted')
    const invocation = createReactStepInvocation({
      round: step,
      attributes: {
        ...scalarAttributes(state.session, turn),
        'gen_ai.step.id': `${String(state.session.id)}:${turn}:${step}`,
        'dsh.step': step,
      },
    })
    this.handler.startReactStep(invocation, active.agent.contextToken ?? ROOT_CONTEXT, startTime)
    active.step = {
      turn,
      step,
      invocation,
      tools: new Map(),
      llms: new Set(),
      nextAttempt: 1,
    }
  }

  private startLlm(options: DshGenerateOptions): LlmState | undefined {
    const session = this.sessions.get(String(options.sessionId))
    const turn = session?.turn
    const step = turn?.step
    if (session === undefined || turn === undefined || step === undefined) return undefined
    const attempt = step.nextAttempt++
    const invocation = createLLMInvocation({
      requestModel: options.model,
      provider: options.provider,
      responseModelName: options.model,
      conversationId: String(options.sessionId),
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.stop === undefined ? {} : { stopSequences: options.stop },
      attributes: {
        ...scalarAttributes(session.session, turn.turn),
        'gen_ai.step.id': `${String(options.sessionId)}:${turn.turn}:${step.step}`,
        'dsh.step': step.step,
        'dsh.llm.attempt': attempt,
        ...llmRequestAttributes(options),
      },
      ...this.config.captureContent
        ? {
            inputMessages: mapInputMessages(options.messages),
            systemInstruction: mapSystemInstruction(options.system),
            toolDefinitions: mapToolDefinitions(options.tools),
          }
        : {},
    })
    this.handler.startLlm(invocation, step.invocation.contextToken ?? ROOT_CONTEXT)
    const llm: LlmState = {
      invocation,
      options,
      blocks: [],
      ended: false,
      firstTokenSeen: false,
    }
    step.llms.add(llm)
    turn.agent.provider = options.provider
    turn.agent.requestModel = options.model
    this.debug(
      `started LLM attempt ${attempt} for session ${String(options.sessionId)} using ${options.provider}/${options.model}`,
    )
    return llm
  }

  private async *observeLlmStream(
    state: LlmState,
    stream: AsyncIterable<DshStreamChunk>,
  ): AsyncIterable<DshStreamChunk> {
    try {
      for await (const chunk of stream) {
        try {
          this.observeLlmChunk(state, chunk)
        } catch (error: unknown) {
          this.warn(`failed to process an LLM chunk: ${errorMessage(error)}`)
        }
        yield chunk
      }
      if (!state.ended) {
        this.failLlm(state, new Error('LLM stream ended without a finish chunk'), Date.now())
      }
    } catch (error: unknown) {
      if (!state.ended) this.failLlm(state, error, Date.now())
      throw error
    } finally {
      if (!state.ended) {
        const aborted = state.options.signal?.aborted === true
        this.failLlm(
          state,
          new Error(aborted ? 'LLM stream was aborted' : 'LLM stream consumer stopped early'),
          Date.now(),
        )
      }
    }
  }

  private observeLlmChunk(state: LlmState, chunk: DshStreamChunk): void {
    if (state.ended) return
    if (!state.firstTokenSeen && isVisibleToken(chunk)) {
      state.firstTokenSeen = true
      state.invocation.monotonicFirstTokenS = performance.now() / 1_000
    }
    if (chunk.type === 'block-end') {
      const block = (chunk as { block: { type: string } & Record<string, unknown> }).block
      state.blocks.push(block)
      return
    }
    if (chunk.type === 'usage') {
      state.usage = (chunk as { usage: DshTokenUsage }).usage
      return
    }
    if (chunk.type !== 'finish') return
    const reason = (chunk as { reason: { kind: string; failure?: DshFailure } }).reason
    this.finishLlm(state, reason, Date.now())
  }

  private prepareLlmFinish(state: LlmState, finishReason: string): OutputMessage[] {
    const output: OutputMessage[] = [{
      role: 'assistant',
      parts: mapContent(state.blocks),
      finishReason,
    }]
    state.invocation.finishReasons = [finishReason]
    state.invocation.responseModelName = state.options.model
    state.invocation.monotonicEndS = performance.now() / 1_000
    if (state.usage !== undefined) applyUsage(state.invocation, state.usage)
    if (this.config.captureContent) {
      state.invocation.outputMessages = output
      Object.assign(
        state.invocation.attributes ??= {},
        capturedLlmAttributes(state.options, output, this.config.contentMaxChars),
      )
    }
    return output
  }

  private finishLlm(
    state: LlmState,
    reason: { kind: string; failure?: DshFailure },
    endTime: number,
  ): void {
    if (state.ended) return
    state.ended = true
    const finishReason = mapFinishReason(reason.kind)
    this.prepareLlmFinish(state, finishReason)
    this.completeLlmAccounting(state, finishReason)
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      const failure = reason.failure ?? { message: `LLM ${reason.kind}`, code: reason.kind.toUpperCase() }
      this.handler.failLlm(state.invocation, {
        message: failure.message,
        type: failure.code,
      }, endTime)
      return
    }
    succeed(state.invocation)
    this.handler.stopLlm(state.invocation, endTime)
  }

  private failLlm(state: LlmState, error: unknown, endTime: number): void {
    if (state.ended) return
    state.ended = true
    const aborted = state.options.signal?.aborted === true
    const finishReason = aborted ? 'cancelled' : 'error'
    this.prepareLlmFinish(state, finishReason)
    this.completeLlmAccounting(state, finishReason)
    this.handler.failLlm(state.invocation, genAiError(error, aborted ? 'AbortError' : 'Error'), endTime)
  }

  private completeLlmAccounting(state: LlmState, finishReason: string): void {
    const session = this.sessions.get(String(state.options.sessionId))
    const turn = session?.turn
    const step = turn?.step
    if (turn === undefined || step === undefined || !step.llms.has(state)) return
    if (state.usage !== undefined) addUsage(turn.usage, state.usage)
    step.lastFinishReason = finishReason
  }

  private startTool(
    state: SessionState,
    data: { turn: number; step: number; callId: string; name: string; arguments: string },
    startTime: number,
  ): void {
    const turn = state.turn
    const step = turn?.step
    if (turn?.turn !== data.turn || step?.step !== data.step) return
    const parsedArguments = parseToolArguments(data.arguments)
    const attributes: Record<string, unknown> = {
      ...scalarAttributes(state.session, data.turn),
      'gen_ai.step.id': `${String(state.session.id)}:${data.turn}:${data.step}`,
      'dsh.step': data.step,
    }
    if (this.config.captureContent) {
      attributes[CONTENT_ATTRIBUTES.toolArguments] = serializeCaptured(
        parsedArguments,
        this.config.contentMaxChars,
      )
    }
    const invocation = createExecuteToolInvocation(data.name, {
      toolCallId: data.callId,
      toolType: 'function',
      attributes,
      ...this.config.captureContent ? { toolCallArguments: parsedArguments } : {},
    })
    this.handler.startExecuteTool(invocation, step.invocation.contextToken ?? ROOT_CONTEXT, startTime)
    const previous = step.tools.get(data.callId)
    if (previous !== undefined && !previous.ended) {
      this.failTool(previous, new Error(`duplicate tool call id ${data.callId}`), startTime)
    }
    step.tools.set(data.callId, { invocation, ended: false })
  }

  private endTool(
    state: SessionState,
    data: {
      turn: number
      step: number
      message: DshMessage
      error?: { name: string; code: string }
    },
    endTime: number,
  ): void {
    const step = state.turn?.step
    if (state.turn?.turn !== data.turn || step?.step !== data.step) return
    const callId = typeof data.message.source.callId === 'string'
      ? data.message.source.callId
      : undefined
    if (callId === undefined) return
    const tool = step.tools.get(callId)
    if (tool === undefined || tool.ended) return
    tool.ended = true
    const resultBlock = data.message.content.find(block => block.type === 'tool-result')
    const result = resultBlock?.type === 'tool-result'
      ? mapContent((resultBlock as { content: DshMessage['content'] }).content)
      : mapContent(data.message.content)
    if (this.config.captureContent) {
      tool.invocation.toolCallResult = result
      ;(tool.invocation.attributes ??= {})[CONTENT_ATTRIBUTES.toolResult] = serializeCaptured(
        result,
        this.config.contentMaxChars,
      )
    }
    const isError = data.error !== undefined
      || (resultBlock?.type === 'tool-result'
        && (resultBlock as { isError?: boolean }).isError === true)
    if (isError) {
      const error = data.error
      this.handler.failExecuteTool(tool.invocation, {
        message: error?.name ?? 'Tool execution failed',
        type: error?.code ?? 'TOOL_ERROR',
      }, endTime)
      return
    }
    succeed(tool.invocation)
    this.handler.stopExecuteTool(tool.invocation, endTime)
  }

  private failTool(tool: ToolState, error: unknown, endTime: number): void {
    if (tool.ended) return
    tool.ended = true
    this.handler.failExecuteTool(tool.invocation, genAiError(error, 'ToolError'), endTime)
  }

  private captureTurnInput(state: SessionState, message: DshMessage): void {
    if (state.turn === undefined) return
    state.turn.inputs.push(mapInputMessage(message))
  }

  private captureTurnOutput(
    state: SessionState,
    turn: number,
    step: number,
    message: DshMessage,
  ): void {
    const active = state.turn
    if (active?.turn !== turn) return
    const finish = active.step?.step === step
      ? active.step.lastFinishReason ?? 'unknown'
      : 'unknown'
    active.outputs.push(mapOutputMessage(message, finish))
  }

  private closeStep(turn: TurnState, endTime: number, forcedReason?: string): void {
    const step = turn.step
    if (step === undefined) return
    for (const llm of step.llms) {
      if (!llm.ended) this.failLlm(llm, new Error('DSH step ended before the LLM stream'), endTime)
    }
    for (const tool of step.tools.values()) {
      if (!tool.ended) this.failTool(tool, new Error('DSH step ended before the tool result'), endTime)
    }
    const finishReason = forcedReason ?? step.lastFinishReason ?? 'completed'
    step.invocation.finishReason = finishReason
    const failureReason = forcedReason
      ?? (finishReason === 'error' || finishReason === 'cancelled' ? finishReason : undefined)
    if (failureReason === undefined) {
      succeed(step.invocation)
      this.handler.stopReactStep(step.invocation, endTime)
    } else {
      this.handler.failReactStep(step.invocation, {
        message: `DSH step ${failureReason}`,
        type: failureReason.toUpperCase(),
      }, endTime)
    }
    turn.step = undefined
  }

  private closeTurn(state: SessionState, reason: DshTurnReason, endTime: number): void {
    const turn = state.turn
    if (turn === undefined) return
    if (turn.step !== undefined) this.closeStep(turn, endTime, 'interrupted')
    const finishReason = mapFinishReason(reason.kind)
    turn.agent.finishReasons = [finishReason]
    applyTotals(turn.agent, turn.usage)
    ;(turn.agent.attributes ??= {})['dsh.turn.end_reason'] = reason.kind
    ;(turn.entry.attributes ??= {})['dsh.turn.end_reason'] = reason.kind
    if (this.config.captureContent) {
      turn.agent.inputMessages = turn.inputs
      turn.agent.outputMessages = turn.outputs
      turn.entry.inputMessages = turn.inputs
      turn.entry.outputMessages = turn.outputs
      const captured = capturedConversationAttributes(
        turn.inputs,
        turn.outputs,
        this.config.contentMaxChars,
      )
      Object.assign(turn.agent.attributes, captured)
      Object.assign(turn.entry.attributes, captured)
    }
    const failure = finishFailure(reason)
    if (failure === undefined) {
      succeed(turn.agent)
      this.handler.stopInvokeAgent(turn.agent, endTime)
      succeed(turn.entry)
      this.handler.stopEntry(turn.entry, endTime)
    } else {
      const error = { message: failure.message, type: failure.code }
      this.handler.failInvokeAgent(turn.agent, error, endTime)
      this.handler.failEntry(turn.entry, error, endTime)
    }
    this.debug(`closed turn ${String(state.session.id)}:${turn.turn} with reason ${reason.kind}`)
    state.turn = undefined
  }

  private debug(message: string): void {
    if (this.config.debug) this.logger.debug?.(`[loongsuite-observability] ${message}`)
  }

  private warn(message: string): void {
    this.logger.warn(`[loongsuite-observability] ${message}`)
  }
}
