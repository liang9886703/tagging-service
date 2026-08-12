import { TaggingServiceError } from './errors.js'
import { loadArticle, type SourceLoaderOptions } from './loaders.js'
import type { TaggingAgentProvider } from './opencode.js'
import { normalizeTagName, TagDatasetRepository } from './repository.js'
import type { ClassificationRequest, ClassificationResult, TagDefinition } from './schemas.js'

export interface TaggingApplicationServiceOptions extends SourceLoaderOptions {
  repository: TagDatasetRepository
  provider: TaggingAgentProvider
}

export class TaggingApplicationService {
  constructor(private readonly options: TaggingApplicationServiceOptions) {}

  async classify(request: ClassificationRequest): Promise<ClassificationResult> {
    const [{ content }, tagSet] = await Promise.all([
      loadArticle(request.source, this.options),
      this.options.repository.getOrEmpty(request.tagSet),
    ])
    const decision = await this.options.provider.classify({
      content,
      tags: tagSet.tags,
      ...(request.context ? { context: request.context } : {}),
    })
    const existing = new Map(tagSet.tags.map(tag => [normalizeTagName(tag.name), tag]))
    const selected = new Map<string, TagDefinition>()

    for (const name of decision.existingTags) {
      const tag = existing.get(normalizeTagName(name))
      if (!tag) throw new TaggingServiceError('OPENCODE_INVALID_RESULT', `OpenCode selected unknown tag: ${name}`, 502)
      selected.set(normalizeTagName(tag.name), tag)
    }

    const { tagSet: updated, created } = await this.options.repository.upsert(request.tagSet, decision.newTags)
    const canonical = new Map(updated.tags.map(tag => [normalizeTagName(tag.name), tag]))
    for (const proposed of decision.newTags) {
      const tag = canonical.get(normalizeTagName(proposed.name))
      if (tag) selected.set(normalizeTagName(tag.name), tag)
    }
    if (!selected.size) throw new TaggingServiceError('OPENCODE_INVALID_RESULT', 'OpenCode classification must select at least one tag.', 502)

    return {
      tags: [...selected.values()].map(tag => tag.name),
      createdTags: created.filter(tag => selected.has(normalizeTagName(tag.name))),
    }
  }
}
