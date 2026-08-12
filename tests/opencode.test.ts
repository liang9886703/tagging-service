import { describe, expect, it, vi } from 'vitest'
import { OpenCodeTaggingProvider } from '../src/opencode.js'

describe('OpenCode provider', () => {
  it('performs health/session/message/delete with auth and structured output', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      calls.push({ url, ...(init ? { init } : {}) })
      if (url.endsWith('/global/health')) return Response.json({ healthy: true })
      if (url.endsWith('/session') && init?.method === 'POST') return Response.json({ id: 'session-1' })
      if (url.endsWith('/message')) return Response.json({ info: { structured: { existingTags: ['Existing'], newTags: [] } } })
      return new Response(null, { status: 204 })
    })
    const provider = new OpenCodeTaggingProvider({ baseUrl: 'http://opencode.test', agent: 'tagger', workspace: '/repo', username: 'opencode', password: 'secret', fetchImpl })
    expect(await provider.classify({ content: 'Article', tags: [{ name: 'Existing', description: 'Existing tag.' }] })).toEqual({ existingTags: ['Existing'], newTags: [] })
    expect(calls.map(call => [new URL(call.url).pathname, call.init?.method])).toEqual([
      ['/global/health', 'GET'], ['/session', 'POST'], ['/session/session-1/message', 'POST'], ['/session/session-1', 'DELETE'],
    ])
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('opencode:secret').toString('base64')}`)
    expect(headers.get('x-opencode-directory')).toBe('/repo')
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({ agent: 'tagger', format: { type: 'json_schema' } })
  })

  it('rejects invalid output and still deletes its session', async () => {
    const methods: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      methods.push(`${init?.method}:${new URL(String(input)).pathname}`)
      if (String(input).endsWith('/global/health')) return Response.json({ healthy: true })
      if (String(input).endsWith('/session')) return Response.json({ id: 'session-2' })
      if (String(input).endsWith('/message')) return Response.json({ parts: [{ type: 'text', text: 'invalid' }] })
      return new Response(null, { status: 204 })
    })
    const provider = new OpenCodeTaggingProvider({ baseUrl: 'http://opencode.test', agent: 'tagger', workspace: '/repo', fetchImpl })
    await expect(provider.classify({ content: 'Article', tags: [] })).rejects.toMatchObject({ code: 'OPENCODE_INVALID_RESULT' })
    expect(methods.at(-1)).toBe('DELETE:/session/session-2')
  })

  it('maps missing agents and timeouts to stable errors', async () => {
    const missingAgentFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/global/health')) return Response.json({ healthy: true })
      if (String(input).endsWith('/session')) return Response.json({ id: 'session-3' })
      if (String(input).endsWith('/message')) return new Response('AgentNotFoundError', { status: 400 })
      return new Response(null, { status: 204 })
    })
    const missingAgent = new OpenCodeTaggingProvider({ baseUrl: 'http://opencode.test', agent: 'missing', workspace: '/repo', fetchImpl: missingAgentFetch })
    await expect(missingAgent.classify({ content: 'Article', tags: [] })).rejects.toMatchObject({ code: 'OPENCODE_AGENT_NOT_FOUND' })
    expect(missingAgentFetch).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: '/session/session-3' }), expect.objectContaining({ method: 'DELETE' }))

    const timeoutFetch = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const timed = new OpenCodeTaggingProvider({ baseUrl: 'http://opencode.test', agent: 'tagger', workspace: '/repo', timeoutMs: 5, fetchImpl: timeoutFetch })
    await expect(timed.classify({ content: 'Article', tags: [] })).rejects.toMatchObject({ code: 'OPENCODE_TIMEOUT' })
  })
})
