import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('OpenCode skill', () => {
  it('has the expected location, frontmatter, and non-writing rules', async () => {
    const file = path.resolve('.opencode/skills/intelligent-tagging/SKILL.md')
    const content = await readFile(file, 'utf8')
    expect(content).toMatch(/^---\nname: intelligent-tagging\n/)
    expect(content).toContain('Prefer an existing tag')
    expect(content).toContain('smallest possible number of new tags')
    expect(content).toContain('Never read or write tag files')
  })
})
