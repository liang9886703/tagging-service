import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { TaggingServiceError, asTaggingServiceError } from './errors.js'
import { OpenCodeTaggingProvider, type TaggingAgentProvider } from './opencode.js'
import { TagDatasetRepository } from './repository.js'
import {
  ClassificationRequestSchema, ClassificationResultSchema, ErrorResponseSchema, HealthSchema,
  SkillParamsSchema, SkillSchema, SkillUpdateSchema, TagSetListSchema, TagSetParamsSchema, TagSetSchema, TagSetWriteSchema,
} from './schemas.js'
import { TaggingApplicationService } from './service.js'
import { SkillRepository } from './skills.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface BuildTaggingServerOptions {
  tagsRoot?: string
  skillsRoot?: string
  apiKey?: string
  opencode?: {
    baseUrl: string
    agent: string
    username?: string
    password?: string
    timeoutMs?: number
    workspace?: string
  }
  provider?: TaggingAgentProvider
  source?: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; fetchImpl?: typeof fetch }
  logger?: boolean
}

export function buildTaggingServer(options: BuildTaggingServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false }).withTypeProvider<TypeBoxTypeProvider>()
  const repository = new TagDatasetRepository(options.tagsRoot ?? path.resolve(repositoryRoot, '..', 'data', 'tags'))
  const skills = new SkillRepository(options.skillsRoot ?? path.resolve(repositoryRoot, '.opencode', 'skills'))
  const provider = options.provider ?? new OpenCodeTaggingProvider({
    baseUrl: options.opencode?.baseUrl ?? 'http://127.0.0.1:4096',
    agent: options.opencode?.agent ?? 'build',
    workspace: options.opencode?.workspace ?? repositoryRoot,
    ...(options.opencode?.username ? { username: options.opencode.username } : {}),
    ...(options.opencode?.password ? { password: options.opencode.password } : {}),
    ...(options.opencode?.timeoutMs ? { timeoutMs: options.opencode.timeoutMs } : {}),
  })
  const service = new TaggingApplicationService({ repository, provider, ...options.source })

  app.setErrorHandler((error: unknown, request, reply) => {
    const validation = error && typeof error === 'object' && 'validation' in error ? error.validation : undefined
    if (validation) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Request validation failed.', details: validation } })
    }
    const known = asTaggingServiceError(error)
    if (known.statusCode >= 500) request.log.error({ err: error }, known.message)
    return reply.code(known.statusCode).send({ error: { code: known.code, message: known.message, ...(known.details === undefined ? {} : { details: known.details }) } })
  })

  app.get('/health', { schema: { response: { 200: HealthSchema } } }, async () => ({ status: 'ok' as const }))

  app.register(async rawRoutes => {
    const protectedRoutes = rawRoutes.withTypeProvider<TypeBoxTypeProvider>()
    if (options.apiKey) {
      protectedRoutes.addHook('onRequest', async request => {
        if (request.headers.authorization !== `Bearer ${options.apiKey}`) {
          throw new TaggingServiceError('AUTH_REQUIRED', 'A valid Bearer token is required.', 401)
        }
      })
    }
    protectedRoutes.get('/v1/tag-sets', {
      schema: { response: { 200: TagSetListSchema, 400: ErrorResponseSchema, 500: ErrorResponseSchema } },
    }, async () => ({ tagSets: await repository.list() }))
    protectedRoutes.get('/v1/tag-sets/:name', {
      schema: { params: TagSetParamsSchema, response: { 200: TagSetSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 500: ErrorResponseSchema } },
    }, async request => repository.get(request.params.name))
    protectedRoutes.put('/v1/tag-sets/:name', {
      schema: { params: TagSetParamsSchema, body: TagSetWriteSchema, response: { 200: TagSetSchema, 400: ErrorResponseSchema, 500: ErrorResponseSchema } },
    }, async request => request.body.mode === 'replace'
      ? repository.replace(request.params.name, request.body.tags)
      : (await repository.upsert(request.params.name, request.body.tags)).tagSet)
    protectedRoutes.get('/v1/skills/:name', {
      schema: { params: SkillParamsSchema, response: { 200: SkillSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 500: ErrorResponseSchema } },
    }, async request => skills.get(request.params.name))
    protectedRoutes.put('/v1/skills/:name', {
      schema: { params: SkillParamsSchema, body: SkillUpdateSchema, response: { 200: SkillSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema, 500: ErrorResponseSchema } },
    }, async request => skills.update(request.params.name, request.body.content))
    protectedRoutes.post('/v1/classifications', {
      schema: { body: ClassificationRequestSchema, response: { 200: ClassificationResultSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 413: ErrorResponseSchema, 422: ErrorResponseSchema, 502: ErrorResponseSchema, 503: ErrorResponseSchema, 504: ErrorResponseSchema } },
    }, async request => service.classify(request.body))
  })

  return app
}
