export type TaggingErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_REQUEST'
  | 'INVALID_TAG_SET'
  | 'TAG_SET_NOT_FOUND'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_TOO_LARGE'
  | 'SOURCE_INVALID'
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_BLOCKED'
  | 'OPENCODE_UNAVAILABLE'
  | 'OPENCODE_AGENT_NOT_FOUND'
  | 'OPENCODE_INVALID_RESULT'
  | 'OPENCODE_TIMEOUT'
  | 'INTERNAL_ERROR'

export class TaggingServiceError extends Error {
  constructor(
    public readonly code: TaggingErrorCode,
    message: string,
    public readonly statusCode = 500,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'TaggingServiceError'
  }
}

export function asTaggingServiceError(error: unknown): TaggingServiceError {
  if (error instanceof TaggingServiceError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new TaggingServiceError('SOURCE_TIMEOUT', 'The source request timed out.', 408)
  }
  return new TaggingServiceError('INTERNAL_ERROR', 'The tagging service encountered an unexpected error.', 500)
}
