import { Type, type Static } from '@sinclair/typebox'

export const TagDefinitionSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false })

export type TagDefinition = Static<typeof TagDefinitionSchema>

export const FileSourceSchema = Type.Object({
  type: Type.Literal('file'),
  path: Type.String({ minLength: 1 }),
}, { additionalProperties: false })

export const UrlSourceSchema = Type.Object({
  type: Type.Literal('url'),
  url: Type.String({ minLength: 1 }),
}, { additionalProperties: false })

export const TextSourceSchema = Type.Object({
  type: Type.Literal('text'),
  content: Type.String({ minLength: 1 }),
}, { additionalProperties: false })

export const ArticleSourceSchema = Type.Union([FileSourceSchema, UrlSourceSchema, TextSourceSchema])
export type ArticleSource = Static<typeof ArticleSourceSchema>

export const ClassificationContextSchema = Type.Object({
  title: Type.Optional(Type.String({ maxLength: 500 })),
  summary: Type.Optional(Type.String({ maxLength: 4000 })),
}, { additionalProperties: false })

export type ClassificationContext = Static<typeof ClassificationContextSchema>

export const ClassificationRequestSchema = Type.Object({
  tagSet: Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 120 }),
  source: ArticleSourceSchema,
  context: Type.Optional(ClassificationContextSchema),
}, { additionalProperties: false })

export type ClassificationRequest = Static<typeof ClassificationRequestSchema>

export const ClassificationResultSchema = Type.Object({
  tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  createdTags: Type.Array(TagDefinitionSchema),
}, { additionalProperties: false })

export type ClassificationResult = Static<typeof ClassificationResultSchema>

export const TagSetSchema = Type.Object({
  name: Type.String(),
  tags: Type.Array(TagDefinitionSchema),
}, { additionalProperties: false })

export type TagSet = Static<typeof TagSetSchema>

export const TagSetUpsertSchema = Type.Object({
  tags: Type.Array(TagDefinitionSchema),
}, { additionalProperties: false })

export type TagSetUpsert = Static<typeof TagSetUpsertSchema>

export const TagSetReplaceSchema = TagSetUpsertSchema
export type TagSetReplace = Static<typeof TagSetReplaceSchema>

export const TagSetWriteSchema = Type.Object({
  tags: Type.Array(TagDefinitionSchema),
  mode: Type.Optional(Type.Union([Type.Literal('merge'), Type.Literal('replace')])),
}, { additionalProperties: false })

export type TagSetWrite = Static<typeof TagSetWriteSchema>

export const TagSetListSchema = Type.Object({
  tagSets: Type.Array(Type.String()),
}, { additionalProperties: false })

export const HealthSchema = Type.Object({ status: Type.Literal('ok') }, { additionalProperties: false })

export const ErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
  }, { additionalProperties: false }),
}, { additionalProperties: false })

export const TagSetParamsSchema = Type.Object({
  name: Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 120 }),
}, { additionalProperties: false })

export const SkillParamsSchema = TagSetParamsSchema

export const SkillSchema = Type.Object({
  name: Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 120 }),
  content: Type.String(),
}, { additionalProperties: false })

export type Skill = Static<typeof SkillSchema>

export const SkillUpdateSchema = Type.Object({
  content: Type.String({ minLength: 1 }),
}, { additionalProperties: false })

export type SkillUpdate = Static<typeof SkillUpdateSchema>

export const AgentDecisionSchema = Type.Object({
  existingTags: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  newTags: Type.Array(TagDefinitionSchema),
}, { additionalProperties: false })

export type AgentDecision = Static<typeof AgentDecisionSchema>
