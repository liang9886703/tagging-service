import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaggingClient } from '../src/client.js'
import type { TaggingAgentProvider } from '../src/opencode.js'
import { buildTaggingServer } from '../src/server.js'

const apps: ReturnType<typeof buildTaggingServer>[] = []
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())))

const provider: TaggingAgentProvider = {
  classify: async () => ({
    existingTags: [],
    newTags: [{ name: 'Architecture', description: 'System design.' }],
  }),
}

describe('HTTP and SDK contracts', () => {
  it('validates routes with inject and protects v1 without protecting health', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-api-'))
    const app = buildTaggingServer({ tagsRoot: root, apiKey: 'secret', provider })
    apps.push(app)
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/v1/tag-sets' })).json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: 'A valid Bearer token is required.' } })
    const response = await app.inject({ method: 'PUT', url: '/v1/tag-sets/song-article', headers: { authorization: 'Bearer secret' }, payload: { tags: [{ name: 'Local-first', description: 'Local data.' }] } })
    expect(response.statusCode).toBe(200)
    expect(response.json().tags).toHaveLength(1)
  })

  it('replaces a complete tag set through the public SDK while upsert remains a merge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-replace-network-'))
    const app = buildTaggingServer({ tagsRoot: root, provider })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = createTaggingClient({ baseUrl: address })

    await client.tagSets.upsert('song-article', {
      tags: [
        { name: 'Keep', description: 'Old.' },
        { name: 'Remove', description: 'Gone.' },
      ],
    })
    expect(await client.tagSets.replace('song-article', {
      tags: [
        { name: 'Keep', description: 'Edited.' },
        { name: 'Added', description: 'New.' },
      ],
    })).toEqual({
      name: 'song-article',
      tags: [
        { name: 'Added', description: 'New.' },
        { name: 'Keep', description: 'Edited.' },
      ],
    })

    await client.tagSets.upsert('song-article', { tags: [{ name: 'Merged', description: 'Still merges.' }] })
    expect((await client.tagSets.get('song-article')).tags.map(tag => tag.name)).toEqual(['Added', 'Keep', 'Merged'])
  })

  it('reads and atomically updates the intelligent-tagging skill through authenticated v1 SDK calls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-skill-network-'))
    const skillsRoot = path.join(root, 'skills')
    const skillDirectory = path.join(skillsRoot, 'intelligent-tagging')
    await mkdir(skillDirectory, { recursive: true })
    const skillFile = path.join(skillDirectory, 'SKILL.md')
    await writeFile(skillFile, 'original skill\n')
    const app = buildTaggingServer({ tagsRoot: path.join(root, 'tags'), skillsRoot, apiKey: 'secret', provider })
    apps.push(app)

    expect((await app.inject({ method: 'GET', url: '/v1/skills/intelligent-tagging' })).statusCode).toBe(401)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = createTaggingClient({ baseUrl: address, apiKey: 'secret' })
    expect(await client.skills.get('intelligent-tagging')).toEqual({
      name: 'intelligent-tagging',
      content: 'original skill\n',
    })
    expect(await client.skills.update('intelligent-tagging', { content: 'updated skill\n' })).toEqual({
      name: 'intelligent-tagging',
      content: 'updated skill\n',
    })
    expect(await readFile(skillFile, 'utf8')).toBe('updated skill\n')
  })

  it('uses the public SDK against a temporary listening port', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-network-'))
    const article = path.join(root, 'article.md')
    await writeFile(article, '# Architecture')
    const app = buildTaggingServer({ tagsRoot: path.join(root, 'tags'), provider })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = createTaggingClient({ baseUrl: address })
    expect(await client.tagSets.list()).toEqual([])
    expect(await client.classify({ tagSet: 'song-article', source: { type: 'file', path: article } })).toEqual({
      tags: ['Architecture'], createdTags: [{ name: 'Architecture', description: 'System design.' }],
    })
  })
})
