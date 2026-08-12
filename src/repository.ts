import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Value } from '@sinclair/typebox/value'
import { TaggingServiceError } from './errors.js'
import { TagDefinitionSchema, type TagDefinition, type TagSet } from './schemas.js'

const TAG_SET_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const UNSAFE_TAG_NAME = /[\u0000-\u001f\\/:*?"<>|]/u

export function normalizeTagName(name: string): string {
  return name.normalize('NFKC').trim().toLocaleLowerCase('en-US')
}

function validateTagSetName(name: string): void {
  if (!TAG_SET_PATTERN.test(name)) {
    throw new TaggingServiceError('INVALID_TAG_SET', `Invalid tag set name: ${name}`, 400)
  }
}

function validateDefinition(tag: TagDefinition): TagDefinition {
  const name = tag.name.normalize('NFKC').trim()
  const description = tag.description.trim()
  if (!name || !description || UNSAFE_TAG_NAME.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    throw new TaggingServiceError('INVALID_REQUEST', 'Tag names and descriptions must be non-empty and filesystem-safe.', 400)
  }
  const value = { name, description }
  if (!Value.Check(TagDefinitionSchema, value)) {
    throw new TaggingServiceError('INVALID_REQUEST', 'Invalid tag definition.', 400, [...Value.Errors(TagDefinitionSchema, value)])
  }
  return value
}

export class TagDatasetRepository {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(public readonly root: string) {}

  async list(): Promise<string[]> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && TAG_SET_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
  }

  async get(name: string): Promise<TagSet> {
    validateTagSetName(name)
    const directory = this.tagSetDirectory(name)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TaggingServiceError('TAG_SET_NOT_FOUND', `Tag set ${name} does not exist.`, 404)
      }
      throw error
    }

    const tags: TagDefinition[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
      const filePath = path.join(directory, entry.name)
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
      if (!Value.Check(TagDefinitionSchema, parsed)) {
        throw new TaggingServiceError('INVALID_REQUEST', `Invalid tag definition at ${filePath}.`, 500)
      }
      tags.push(parsed)
    }
    return { name, tags }
  }

  async getOrEmpty(name: string): Promise<TagSet> {
    try {
      return await this.get(name)
    } catch (error) {
      if (error instanceof TaggingServiceError && error.code === 'TAG_SET_NOT_FOUND') return { name, tags: [] }
      throw error
    }
  }

  async upsert(name: string, input: readonly TagDefinition[]): Promise<{ tagSet: TagSet; created: TagDefinition[] }> {
    validateTagSetName(name)
    return this.withLock(name, async () => {
      const existing = await this.getOrEmpty(name)
      const byNormalized = new Map(existing.tags.map(tag => [normalizeTagName(tag.name), tag]))
      const createdKeys = new Set<string>()
      const writes: TagDefinition[] = []

      for (const rawTag of input) {
        const tag = validateDefinition(rawTag)
        const key = normalizeTagName(tag.name)
        const current = byNormalized.get(key)
        if (current) {
          if (current.description !== tag.description) {
            const updated = { ...current, description: tag.description }
            byNormalized.set(key, updated)
            writes.push(updated)
          }
          continue
        }
        byNormalized.set(key, tag)
        createdKeys.add(key)
        writes.push(tag)
      }

      const directory = this.tagSetDirectory(name)
      await mkdir(directory, { recursive: true })
      for (const tag of writes) await this.writeAtomic(directory, tag)

      const tags = [...byNormalized.values()].sort((a, b) => a.name.localeCompare(b.name))
      return {
        tagSet: { name, tags },
        created: tags.filter(tag => createdKeys.has(normalizeTagName(tag.name))),
      }
    })
  }

  async replace(name: string, input: readonly TagDefinition[]): Promise<TagSet> {
    validateTagSetName(name)
    const byNormalized = new Map<string, TagDefinition>()
    for (const rawTag of input) {
      const tag = validateDefinition(rawTag)
      const key = normalizeTagName(tag.name)
      if (byNormalized.has(key)) {
        throw new TaggingServiceError('INVALID_REQUEST', `Duplicate normalized tag name: ${tag.name}`, 400)
      }
      byNormalized.set(key, tag)
    }

    return this.withLock(name, async () => {
      const directory = this.tagSetDirectory(name)
      await mkdir(directory, { recursive: true })
      const entries = await readdir(directory, { withFileTypes: true })
      const desiredFilenames = new Set([...byNormalized.keys()].map(key => `${key}.json`))
      for (const entry of entries) {
        if (entry.isSymbolicLink() && desiredFilenames.has(entry.name)) {
          throw new TaggingServiceError('INVALID_REQUEST', `Refusing to replace symbolic link: ${entry.name}`, 400)
        }
      }

      for (const tag of byNormalized.values()) await this.writeAtomic(directory, tag)
      for (const entry of entries) {
        if (
          entry.isFile()
          && !entry.isSymbolicLink()
          && !entry.name.startsWith('.')
          && entry.name.endsWith('.json')
          && !desiredFilenames.has(entry.name)
        ) {
          await unlink(path.join(directory, entry.name))
        }
      }

      const tags = [...byNormalized.values()].sort((a, b) => a.name.localeCompare(b.name))
      return { name, tags }
    })
  }

  private tagSetDirectory(name: string): string {
    const resolved = path.resolve(this.root, name)
    const root = path.resolve(this.root)
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new TaggingServiceError('INVALID_TAG_SET', 'Tag set path escapes the configured root.', 400)
    }
    return resolved
  }

  private async writeAtomic(directory: string, tag: TagDefinition): Promise<void> {
    const filename = `${normalizeTagName(tag.name)}.json`
    const finalPath = path.join(directory, filename)
    const tempPath = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(tempPath, `${JSON.stringify(tag, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(tempPath, finalPath)
    } finally {
      await unlink(tempPath).catch(() => undefined)
    }
    const written = await stat(finalPath)
    if (!written.isFile()) throw new TaggingServiceError('INTERNAL_ERROR', 'Atomic tag write did not produce a regular file.', 500)
  }

  private async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const queued = previous.then(() => current)
    this.locks.set(name, queued)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.locks.get(name) === queued) this.locks.delete(name)
    }
  }
}
