import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadArticle } from '../src/loaders.js'

describe('source loaders', () => {
  it('loads bounded inline text without creating a source file', async () => {
    await expect(loadArticle({ type: 'text', content: 'Finish the task index.' })).resolves.toMatchObject({
      content: 'Finish the task index.',
      source: { type: 'text' },
    })
    await expect(loadArticle({ type: 'text', content: 'too long' }, { maxBytes: 2 })).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
    })
  })

  it('loads absolute markdown files and rejects relative paths, symlinks, and size overflow', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tag-source-'))
    const file = path.join(directory, 'article.md')
    const link = path.join(directory, 'link.md')
    await writeFile(file, '# Article')
    await symlink(file, link)
    await expect(loadArticle({ type: 'file', path: file })).resolves.toMatchObject({ content: '# Article' })
    await expect(loadArticle({ type: 'file', path: 'article.md' })).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    await expect(loadArticle({ type: 'file', path: link })).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
    await expect(loadArticle({ type: 'file', path: file }, { maxBytes: 2 })).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' })
  })

  it('blocks private targets before fetch and validates redirect targets', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(loadArticle({ type: 'url', url: 'http://example.test/a' }, {
      fetchImpl,
      lookupHost: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]) as never,
    })).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' })
    expect(fetchImpl).not.toHaveBeenCalled()

    const redirectFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://internal.test/a' } }))
    const lookupHost = vi.fn(async (hostname: string) => [{ address: hostname === 'internal.test' ? '10.0.0.1' : '93.184.216.34', family: 4 }])
    await expect(loadArticle({ type: 'url', url: 'https://public.test/a' }, {
      fetchImpl: redirectFetch,
      lookupHost: lookupHost as never,
    })).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' })
  })

  it('loads bounded public URL content', async () => {
    const result = await loadArticle({ type: 'url', url: 'https://public.test/a' }, {
      fetchImpl: vi.fn(async () => new Response('<main>Hello <b>world</b></main>', { headers: { 'content-type': 'text/html' } })),
      lookupHost: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never,
    })
    expect(result.content).toBe('Hello world')
  })

  it('returns a stable timeout error', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    await expect(loadArticle({ type: 'url', url: 'https://public.test/a' }, {
      fetchImpl,
      timeoutMs: 5,
      lookupHost: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never,
    })).rejects.toMatchObject({ code: 'SOURCE_TIMEOUT' })
  })
})
