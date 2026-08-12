# tagging-service

`tagging-service` is an independent TypeScript package that can be used as an HTTP SDK or started as a standalone Fastify service. It loads an article, classifies it through an OpenCode Server, stores any reusable tag definitions, and returns the final tag names.

The service owns only a tag dictionary. It never stores articles, source paths, counters, caches, or article-to-tag relationships. Callers such as **song’s lab** (implementation directory: `blogV2`) remain responsible for writing returned tag names to their own records.

## Requirements and setup

- Node.js 24
- npm
- A running [OpenCode Server](https://opencode.ai/docs/zh-cn/server/#%E4%BC%9A%E8%AF%9D)

```bash
npm install
npm run build
npm run serve
```

The CLI listens on `127.0.0.1:4010` by default. It does not enable CORS. If `TAGGING_SERVICE_API_KEY` is set, all `/v1/*` routes require `Authorization: Bearer <token>`; `/health` remains public.

## SDK

```ts
import { createTaggingClient } from 'tagging-service'

const client = createTaggingClient({
  baseUrl: 'http://127.0.0.1:4010',
  apiKey: process.env.TAGGING_SERVICE_API_KEY,
})

const result = await client.classify({
  tagSet: 'song-article',
  source: { type: 'file', path: '/absolute/path/to/article.md' },
  context: { title: 'Article title', summary: 'Optional summary' },
})

await client.tagSets.get('song-article')
await client.tagSets.upsert('song-article', {
  tags: [{ name: 'architecture', description: 'System boundaries and design decisions.' }],
})
```

The server builder is exported separately for embedding and tests:

```ts
import { buildTaggingServer } from 'tagging-service/server'
```

## HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check |
| `GET` | `/v1/tag-sets` | List tag set names |
| `GET` | `/v1/tag-sets/:name` | Read definitions |
| `PUT` | `/v1/tag-sets/:name` | Upsert definitions |
| `POST` | `/v1/classifications` | Classify a file or URL |

Errors always use `{ "error": { "code": "...", "message": "...", "details": {} } }`. Stable error codes include `AUTH_REQUIRED`, `INVALID_REQUEST`, `INVALID_TAG_SET`, `TAG_SET_NOT_FOUND`, `SOURCE_INVALID`, `SOURCE_TOO_LARGE`, `SOURCE_TIMEOUT`, `SOURCE_BLOCKED`, `OPENCODE_UNAVAILABLE`, `OPENCODE_AGENT_NOT_FOUND`, `OPENCODE_INVALID_RESULT`, and `OPENCODE_TIMEOUT`.

File sources must be absolute regular `.md` or `.txt` files, may not be symbolic links, and are size-limited. URL sources are limited by protocol, byte size, timeout, and redirect count; every redirect target is checked against loopback, private, and link-local networks.

## Storage

`TAGS_ROOT` defaults to the sibling workspace path `data/tags`:

```text
data/tags/song-article/
├── architecture.json
└── local-first.json
```

Each file contains only:

```json
{
  "name": "architecture",
  "description": "System boundaries and design decisions."
}
```

Names are deduplicated with Unicode NFKC, whitespace trimming, and case normalization while the first display name is retained. Writes are serialized per tag set and use same-directory temporary files followed by atomic replacement.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `4010` | HTTP port |
| `TAGS_ROOT` | `../data/tags` | Tag dictionary root |
| `TAGGING_SERVICE_API_KEY` | unset | Optional Bearer token |
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode Server URL |
| `OPENCODE_USERNAME` | unset | Basic Auth username, normally `opencode` |
| `OPENCODE_PASSWORD` | unset | Basic Auth password |
| `OPENCODE_AGENT` | `build` | Agent selected for the message |
| `OPENCODE_TIMEOUT_MS` | `60000` | Whole OpenCode conversation timeout |
| `SOURCE_MAX_BYTES` | `2097152` | File and response size limit |
| `SOURCE_TIMEOUT_MS` | `15000` | URL loading timeout |
| `SOURCE_MAX_REDIRECTS` | `5` | URL redirect limit |

OpenCode is called in this order: health, session creation, structured message, and session deletion. The working directory is fixed to this repository so OpenCode can discover `.opencode/skills/intelligent-tagging/SKILL.md`. No custom OpenCode Agent is included; the agent name is configuration.
