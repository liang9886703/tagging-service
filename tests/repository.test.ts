import { lstat, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TagDatasetRepository } from '../src/repository.js'

describe('TagDatasetRepository', () => {
  it('stores only normalized tag definitions and reuses display names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-repo-'))
    const repository = new TagDatasetRepository(root)
    const first = await repository.upsert('song-article', [
      { name: 'Architecture', description: 'System boundaries.' },
      { name: ' architecture ', description: 'Updated description.' },
    ])

    expect(first.created).toEqual([{ name: 'Architecture', description: 'Updated description.' }])
    expect(first.tagSet.tags).toEqual([{ name: 'Architecture', description: 'Updated description.' }])
    expect(JSON.parse(await readFile(path.join(root, 'song-article', 'architecture.json'), 'utf8'))).toEqual({
      name: 'Architecture', description: 'Updated description.',
    })
    expect(await readdir(path.join(root, 'song-article'))).toEqual(['architecture.json'])
    expect(await readdir(root)).toEqual(['song-article'])
  })

  it('serializes concurrent writes without creating relation files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-lock-'))
    const repository = new TagDatasetRepository(root)
    await Promise.all([
      repository.upsert('song-article', [{ name: 'One', description: 'First.' }]),
      repository.upsert('song-article', [{ name: 'Two', description: 'Second.' }]),
      repository.upsert('song-article', [{ name: 'THREE', description: 'Third.' }]),
    ])
    expect((await repository.get('song-article')).tags).toHaveLength(3)
    const files = (await readdir(root, { recursive: true })).filter(name => name.endsWith('.json'))
    expect(files).toEqual(expect.arrayContaining(['song-article/one.json', 'song-article/two.json', 'song-article/three.json']))
    expect(files.every(name => !/(relation|count|cache)/i.test(name))).toBe(true)
  })

  it('replaces the complete tag set while preserving unrelated and unsafe directory entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-replace-'))
    const repository = new TagDatasetRepository(root)
    await repository.upsert('song-article', [
      { name: 'Architecture', description: 'Old description.' },
      { name: 'Removed', description: 'Should disappear.' },
    ])
    const directory = path.join(root, 'song-article')
    await writeFile(path.join(directory, '.hidden.json'), '{"hidden":true}\n')
    await writeFile(path.join(directory, 'notes.txt'), 'keep me')
    const outside = path.join(root, 'outside.json')
    await writeFile(outside, '{"outside":true}\n')
    await symlink(outside, path.join(directory, 'linked.json'))

    const result = await repository.replace('song-article', [
      { name: 'Architecture', description: 'New description.' },
      { name: 'Renamed', description: 'Replacement name.' },
    ])

    expect(result.tags).toEqual([
      { name: 'Architecture', description: 'New description.' },
      { name: 'Renamed', description: 'Replacement name.' },
    ])
    expect(await repository.get('song-article')).toEqual(result)
    expect(await readdir(directory)).toEqual([
      '.hidden.json',
      'architecture.json',
      'linked.json',
      'notes.txt',
      'renamed.json',
    ])
    expect((await lstat(path.join(directory, 'linked.json'))).isSymbolicLink()).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe('{"outside":true}\n')
  })

  it('validates every replacement before mutating and rejects duplicate normalized names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-replace-validation-'))
    const repository = new TagDatasetRepository(root)
    await repository.upsert('song-article', [{ name: 'Original', description: 'Keep this.' }])

    await expect(repository.replace('song-article', [
      { name: 'First', description: 'Would otherwise be written.' },
      { name: ' first ', description: 'Duplicate.' },
    ])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(repository.replace('song-article', [
      { name: 'Valid', description: 'Would otherwise be written.' },
      { name: '../invalid', description: 'No traversal.' },
    ])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    expect(await repository.get('song-article')).toEqual({
      name: 'song-article',
      tags: [{ name: 'Original', description: 'Keep this.' }],
    })
  })

  it('rejects traversal in tag-set and tag names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tag-safe-'))
    const repository = new TagDatasetRepository(root)
    await expect(repository.upsert('../outside', [])).rejects.toMatchObject({ code: 'INVALID_TAG_SET' })
    await expect(repository.upsert('safe', [{ name: '../outside', description: 'No.' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
