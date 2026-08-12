#!/usr/bin/env node
import path from 'node:path'
import { loadConfig, resolveRepositoryRoot } from './config.js'
import { buildTaggingServer } from './server.js'

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'serve') {
    process.stderr.write('Usage: tagging-service serve\n')
    process.exitCode = 1
    return
  }
  const config = loadConfig()
  const repositoryRoot = resolveRepositoryRoot()
  const app = buildTaggingServer({
    ...(config.TAGS_ROOT ? { tagsRoot: path.resolve(config.TAGS_ROOT) } : {}),
    ...(config.TAGGING_SERVICE_API_KEY ? { apiKey: config.TAGGING_SERVICE_API_KEY } : {}),
    opencode: {
      baseUrl: config.OPENCODE_BASE_URL,
      agent: config.OPENCODE_AGENT,
      workspace: repositoryRoot,
      ...(config.OPENCODE_USERNAME ? { username: config.OPENCODE_USERNAME } : {}),
      ...(config.OPENCODE_PASSWORD ? { password: config.OPENCODE_PASSWORD } : {}),
      timeoutMs: config.OPENCODE_TIMEOUT_MS,
    },
    source: { maxBytes: config.SOURCE_MAX_BYTES, timeoutMs: config.SOURCE_TIMEOUT_MS, maxRedirects: config.SOURCE_MAX_REDIRECTS },
    logger: true,
  })
  await app.listen({ host: config.HOST, port: config.PORT })
}

await main()
