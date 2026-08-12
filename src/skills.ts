import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TaggingServiceError } from './errors.js'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillDocument {
  name: string
  content: string
}

export interface SkillRepositoryOptions {
  maxBytes?: number
}

export class SkillRepository {
  private readonly maxBytes: number

  constructor(public readonly root: string, options: SkillRepositoryOptions = {}) {
    this.maxBytes = options.maxBytes ?? 200_000
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new TypeError('maxBytes must be a positive safe integer.')
    }
  }

  async get(name: string): Promise<SkillDocument> {
    const file = await this.safeSkillFile(name)
    let handle
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const fileStat = await handle.stat()
      if (!fileStat.isFile()) throw new TaggingServiceError('INVALID_REQUEST', 'Skill content must be a regular file.', 400)
      if (fileStat.size > this.maxBytes) {
        throw new TaggingServiceError('SKILL_TOO_LARGE', `Skill ${name} exceeds the configured byte limit.`, 413)
      }
      const content = await handle.readFile('utf8')
      if (Buffer.byteLength(content, 'utf8') > this.maxBytes) {
        throw new TaggingServiceError('SKILL_TOO_LARGE', `Skill ${name} exceeds the configured byte limit.`, 413)
      }
      return { name, content }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TaggingServiceError('SKILL_NOT_FOUND', `Skill ${name} does not exist.`, 404)
      }
      throw error
    } finally {
      await handle?.close()
    }
  }

  async update(name: string, content: string): Promise<SkillDocument> {
    const file = await this.safeSkillFile(name)
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) {
      throw new TaggingServiceError('SKILL_TOO_LARGE', `Skill ${name} exceeds the configured byte limit.`, 413)
    }
    const temp = path.join(path.dirname(file), `.SKILL.md.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temp, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TaggingServiceError('SKILL_NOT_FOUND', `Skill ${name} does not exist.`, 404)
      }
      throw error
    } finally {
      await unlink(temp).catch(() => undefined)
    }
    return { name, content }
  }

  private async safeSkillFile(name: string): Promise<string> {
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new TaggingServiceError('INVALID_REQUEST', `Invalid skill name: ${name}`, 400)
    }
    const root = path.resolve(this.root)
    const file = path.resolve(root, name, 'SKILL.md')
    if (!file.startsWith(`${root}${path.sep}`)) {
      throw new TaggingServiceError('INVALID_REQUEST', 'Skill path escapes the configured root.', 400)
    }
    try {
      const rootReal = await realpath(root)
      const directory = path.dirname(file)
      const directoryStat = await lstat(directory)
      const fileStat = await lstat(file)
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new TaggingServiceError('INVALID_REQUEST', 'Skill path must contain only regular directories and files.', 400)
      }
      const directoryReal = await realpath(directory)
      if (path.dirname(directoryReal) !== rootReal) {
        throw new TaggingServiceError('INVALID_REQUEST', 'Skill path escapes the configured root.', 400)
      }
      return file
    } catch (error) {
      if (error instanceof TaggingServiceError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TaggingServiceError('SKILL_NOT_FOUND', `Skill ${name} does not exist.`, 404)
      }
      throw error
    }
  }
}
