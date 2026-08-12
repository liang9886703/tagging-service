import path from 'node:path'
import { fileURLToPath } from 'node:url'
import envSchema from 'env-schema'
import { Type, type Static } from '@sinclair/typebox'

const ConfigSchema = Type.Object({
  HOST: Type.String({ default: '127.0.0.1' }),
  PORT: Type.Number({ default: 4010 }),
  TAGS_ROOT: Type.Optional(Type.String()),
  TAGGING_SERVICE_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
  OPENCODE_BASE_URL: Type.String({ default: 'http://127.0.0.1:4096' }),
  OPENCODE_USERNAME: Type.Optional(Type.String()),
  OPENCODE_PASSWORD: Type.Optional(Type.String()),
  OPENCODE_AGENT: Type.String({ default: 'build' }),
  OPENCODE_TIMEOUT_MS: Type.Number({ default: 60_000 }),
  SOURCE_MAX_BYTES: Type.Number({ default: 2 * 1024 * 1024 }),
  SOURCE_TIMEOUT_MS: Type.Number({ default: 15_000 }),
  SOURCE_MAX_REDIRECTS: Type.Number({ default: 5 }),
})

export type TaggingConfig = Static<typeof ConfigSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TaggingConfig {
  return envSchema<TaggingConfig>({ schema: ConfigSchema, data: env, dotenv: true })
}

export function resolveRepositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}
