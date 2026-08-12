import { Value } from '@sinclair/typebox/value'
import { TaggingServiceError } from './errors.js'
import { AgentDecisionSchema, type AgentDecision, type ClassificationContext, type TagDefinition } from './schemas.js'

export interface TaggingAgentProvider {
  classify(input: { content: string; context?: ClassificationContext; tags: TagDefinition[] }): Promise<AgentDecision>
}

export interface OpenCodeProviderOptions {
  baseUrl: string
  agent: string
  workspace: string
  username?: string
  password?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function extractPayload(value: unknown): unknown {
  if (value && typeof value === 'object' && 'data' in value) return (value as { data: unknown }).data
  return value
}

export class OpenCodeTaggingProvider implements TaggingAgentProvider {
  constructor(private readonly options: OpenCodeProviderOptions) {}

  async classify(input: { content: string; context?: ClassificationContext; tags: TagDefinition[] }): Promise<AgentDecision> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000)
    let sessionId: string | undefined
    try {
      await this.request('/global/health', { method: 'GET', signal: controller.signal })
      const session = extractPayload(await this.request('/session', {
        method: 'POST', signal: controller.signal, body: JSON.stringify({ title: 'Intelligent tagging' }),
      }))
      sessionId = typeof session === 'object' && session && 'id' in session ? String(session.id) : undefined
      if (!sessionId) throw new TaggingServiceError('OPENCODE_INVALID_RESULT', 'OpenCode did not return a session id.', 502)

      const prompt = this.buildPrompt(input)
      const response = extractPayload(await this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          agent: this.options.agent,
          parts: [{ type: 'text', text: prompt }],
          format: { type: 'json_schema', schema: AgentDecisionSchema, retryCount: 2 },
        }),
      }))
      return this.parseDecision(response)
    } catch (error) {
      if (controller.signal.aborted) throw new TaggingServiceError('OPENCODE_TIMEOUT', 'OpenCode classification timed out.', 504)
      throw error
    } finally {
      clearTimeout(timer)
      if (sessionId) {
        await this.request(`/session/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(5_000),
        }).catch(() => undefined)
      }
    }
  }

  private buildPrompt(input: { content: string; context?: ClassificationContext; tags: TagDefinition[] }): string {
    return [
      'Use the intelligent-tagging skill installed in this project.',
      'Classify the article by meaning, argument, and durable use. Return JSON only.',
      `Context: ${JSON.stringify(input.context ?? {})}`,
      `Existing tags: ${JSON.stringify(input.tags)}`,
      'Article:',
      input.content,
    ].join('\n\n')
  }

  private parseDecision(response: unknown): AgentDecision {
    let candidate: unknown
    if (response && typeof response === 'object') {
      const object = response as Record<string, unknown>
      candidate = object.structured ?? object.structured_output ?? (object.info as Record<string, unknown> | undefined)?.structured
      if (!candidate && Array.isArray(object.parts)) {
        const text = object.parts.find(part => part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') as Record<string, unknown> | undefined
        if (typeof text?.text === 'string') {
          try { candidate = JSON.parse(text.text) } catch { candidate = undefined }
        }
      }
    }
    if (!Value.Check(AgentDecisionSchema, candidate)) {
      throw new TaggingServiceError('OPENCODE_INVALID_RESULT', 'OpenCode returned an invalid structured classification result.', 502)
    }
    return candidate
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    const base = this.options.baseUrl.endsWith('/') ? this.options.baseUrl : `${this.options.baseUrl}/`
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    headers.set('content-type', 'application/json')
    headers.set('x-opencode-directory', this.options.workspace)
    if (this.options.username || this.options.password) {
      headers.set('authorization', `Basic ${Buffer.from(`${this.options.username ?? 'opencode'}:${this.options.password ?? ''}`).toString('base64')}`)
    }
    let response: Response
    try {
      response = await (this.options.fetchImpl ?? fetch)(new URL(pathname.replace(/^\//, ''), base), { ...init, headers })
    } catch (error) {
      throw new TaggingServiceError('OPENCODE_UNAVAILABLE', 'OpenCode server is unavailable.', 503, error instanceof Error ? error.message : undefined)
    }
    if (!response.ok) {
      const body = await response.text()
      const agentMissing = pathname.includes('/message') && (response.status === 404 || /AgentNotFound|agent.+not found/i.test(body))
      const code = agentMissing ? 'OPENCODE_AGENT_NOT_FOUND' : 'OPENCODE_UNAVAILABLE'
      throw new TaggingServiceError(code, `OpenCode request failed with HTTP ${response.status}.`, response.status === 404 ? 422 : 503, body.slice(0, 1000))
    }
    if (response.status === 204) return null
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }
}
