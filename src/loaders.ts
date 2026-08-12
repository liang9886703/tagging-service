import { lookup } from 'node:dns/promises'
import { lstat, open, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { TaggingServiceError } from './errors.js'
import type { ArticleSource } from './schemas.js'

export interface SourceLoaderOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  fetchImpl?: typeof fetch
  lookupHost?: typeof lookup
}

export interface LoadedArticle {
  content: string
  source: ArticleSource
}

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^0\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
]

function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) return PRIVATE_V4.some(pattern => pattern.test(address))
  const value = address.toLowerCase().split('%')[0] ?? ''
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.')
}

export async function loadArticle(source: ArticleSource, options: SourceLoaderOptions = {}): Promise<LoadedArticle> {
  if (source.type === 'file') return loadFile(source, options)
  if (source.type === 'text') return loadText(source, options)
  return loadUrl(source, options)
}

async function loadText(source: Extract<ArticleSource, { type: 'text' }>, options: SourceLoaderOptions): Promise<LoadedArticle> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  if (Buffer.byteLength(source.content, 'utf8') > maxBytes) {
    throw new TaggingServiceError('SOURCE_TOO_LARGE', 'Inline text source exceeds the configured size limit.', 413)
  }
  return { content: source.content, source }
}

async function loadFile(source: Extract<ArticleSource, { type: 'file' }>, options: SourceLoaderOptions): Promise<LoadedArticle> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  if (!path.isAbsolute(source.path) || !['.md', '.txt'].includes(path.extname(source.path).toLowerCase())) {
    throw new TaggingServiceError('SOURCE_INVALID', 'File sources must be absolute .md or .txt paths.', 400)
  }
  const linkInfo = await lstat(source.path).catch(() => null)
  if (!linkInfo || linkInfo.isSymbolicLink()) {
    throw new TaggingServiceError('SOURCE_INVALID', 'File source must exist and may not be a symbolic link.', 400)
  }
  const info = await stat(source.path)
  if (!info.isFile()) throw new TaggingServiceError('SOURCE_INVALID', 'File source must be a regular file.', 400)
  if (info.size > maxBytes) throw new TaggingServiceError('SOURCE_TOO_LARGE', 'File source exceeds the configured size limit.', 413)
  const handle = await open(source.path, 'r')
  try {
    const content = await handle.readFile('utf8')
    return { content, source }
  } finally {
    await handle.close()
  }
}

async function assertPublicUrl(url: URL, lookupHost: typeof lookup): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TaggingServiceError('SOURCE_INVALID', 'URL sources must use HTTP or HTTPS.', 400)
  }
  if (url.username || url.password) throw new TaggingServiceError('SOURCE_BLOCKED', 'Credentials in source URLs are not allowed.', 400)
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookupHost(url.hostname, { all: true, verbatim: true }).catch(() => [])
  if (!addresses.length || addresses.some(entry => isBlockedAddress(entry.address))) {
    throw new TaggingServiceError('SOURCE_BLOCKED', 'The source URL resolves to a blocked address.', 400)
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > maxBytes) throw new TaggingServiceError('SOURCE_TOO_LARGE', 'URL response exceeds the configured size limit.', 413)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new TaggingServiceError('SOURCE_TOO_LARGE', 'URL response exceeds the configured size limit.', 413)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

async function loadUrl(source: Extract<ArticleSource, { type: 'url' }>, options: SourceLoaderOptions): Promise<LoadedArticle> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxRedirects = options.maxRedirects ?? 5
  const fetchImpl = options.fetchImpl ?? fetch
  const lookupHost = options.lookupHost ?? lookup
  let current: URL
  try { current = new URL(source.url) } catch { throw new TaggingServiceError('SOURCE_INVALID', 'Source URL is invalid.', 400) }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      await assertPublicUrl(current, lookupHost)
      let response: Response
      try {
        response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal, headers: { accept: 'text/markdown, text/plain, text/html' } })
      } catch (error) {
        if (controller.signal.aborted) throw new TaggingServiceError('SOURCE_TIMEOUT', 'The source request timed out.', 408)
        throw new TaggingServiceError('SOURCE_INVALID', 'The source URL could not be loaded.', 400, error instanceof Error ? error.message : undefined)
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new TaggingServiceError('SOURCE_INVALID', 'Redirect response did not include a location.', 400)
        if (redirect === maxRedirects) throw new TaggingServiceError('SOURCE_INVALID', 'Source URL exceeded the redirect limit.', 400)
        current = new URL(location, current)
        continue
      }
      if (!response.ok) throw new TaggingServiceError('SOURCE_INVALID', `Source URL returned HTTP ${response.status}.`, 400)
      const raw = await readLimitedBody(response, maxBytes)
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      const content = contentType.includes('html')
        ? raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : raw
      return { content, source }
    }
    throw new TaggingServiceError('SOURCE_INVALID', 'Source URL exceeded the redirect limit.', 400)
  } finally {
    clearTimeout(timer)
  }
}
