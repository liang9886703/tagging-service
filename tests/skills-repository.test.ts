import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillRepository } from '../src/skills.js'

describe('SkillRepository', () => {
  it('rejects skill content larger than the configured byte limit when reading', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-size-read-'))
    const directory = path.join(root, 'intelligent-tagging')
    await mkdir(directory)
    await writeFile(path.join(directory, 'SKILL.md'), '123456789')
    const repository = new SkillRepository(root, { maxBytes: 8 })

    await expect(repository.get('intelligent-tagging')).rejects.toMatchObject({ code: 'SKILL_TOO_LARGE' })
  })

  it('rejects oversized skill updates without changing the existing file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-size-write-'))
    const directory = path.join(root, 'intelligent-tagging')
    const file = path.join(directory, 'SKILL.md')
    await mkdir(directory)
    await writeFile(file, 'original')
    const repository = new SkillRepository(root, { maxBytes: 8 })

    await expect(repository.update('intelligent-tagging', '123456789')).rejects.toMatchObject({
      code: 'SKILL_TOO_LARGE',
    })
    expect(await readFile(file, 'utf8')).toBe('original')
  })

  it('rejects skill directories and files that are symbolic links', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-safe-root-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'skill-safe-outside-'))
    await writeFile(path.join(outside, 'SKILL.md'), 'outside\n')
    await symlink(outside, path.join(root, 'intelligent-tagging'))
    const repository = new SkillRepository(root)

    await expect(repository.get('intelligent-tagging')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(repository.update('intelligent-tagging', 'changed\n')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('outside\n')

    await mkdir(path.join(root, 'safe-skill'))
    await symlink(path.join(outside, 'SKILL.md'), path.join(root, 'safe-skill', 'SKILL.md'))
    await expect(repository.get('safe-skill')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(repository.update('safe-skill', 'changed\n')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('outside\n')
  })
})
