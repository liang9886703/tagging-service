import type { ClassificationRequest, ClassificationResult, Skill, SkillUpdate, TagSet, TagSetReplace, TagSetUpsert } from './schemas.js'

export interface TaggingClientOptions {
  baseUrl: string
  apiKey?: string
  fetch?: typeof fetch
}

export class TaggingClientError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly details?: unknown) {
    super(message)
    this.name = 'TaggingClientError'
  }
}

export interface TaggingClient {
  classify(input: ClassificationRequest): Promise<ClassificationResult>
  tagSets: {
    list(): Promise<string[]>
    get(name: string): Promise<TagSet>
    upsert(name: string, input: TagSetUpsert): Promise<TagSet>
    replace(name: string, input: TagSetReplace): Promise<TagSet>
  }
  skills: {
    get(name: string): Promise<Skill>
    update(name: string, input: SkillUpdate): Promise<Skill>
  }
}

export function createTaggingClient(options: TaggingClientOptions): TaggingClient {
  const request = async <T>(pathname: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body) headers.set('content-type', 'application/json')
    if (options.apiKey) headers.set('authorization', `Bearer ${options.apiKey}`)
    const base = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`
    const response = await (options.fetch ?? fetch)(new URL(pathname.replace(/^\//, ''), base), { ...init, headers })
    const body = await response.json() as T | { error: { code: string; message: string; details?: unknown } }
    if (!response.ok) {
      const failure = body as { error: { code: string; message: string; details?: unknown } }
      throw new TaggingClientError(failure.error.code, failure.error.message, response.status, failure.error.details)
    }
    return body as T
  }
  return {
    classify: input => request('/v1/classifications', { method: 'POST', body: JSON.stringify(input) }),
    tagSets: {
      list: async () => (await request<{ tagSets: string[] }>('/v1/tag-sets')).tagSets,
      get: name => request(`/v1/tag-sets/${encodeURIComponent(name)}`),
      upsert: (name, input) => request(`/v1/tag-sets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(input) }),
      replace: (name, input) => request(`/v1/tag-sets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ ...input, mode: 'replace' }) }),
    },
    skills: {
      get: name => request(`/v1/skills/${encodeURIComponent(name)}`),
      update: (name, input) => request(`/v1/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(input) }),
    },
  }
}
