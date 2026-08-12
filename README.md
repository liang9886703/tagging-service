# tagging-service

`tagging-service` 是一个独立的 TypeScript 智能标签服务，可作为 HTTP 服务运行，也可以通过配套 SDK 调用。

它负责：

1. 从内联文本、本地文件或公开 URL 加载文章内容；
2. 调用 OpenCode Server 完成语义分类；
3. 复用已有标签，或持久化本次分类产生的新标签；
4. 返回文章最终对应的标签名称。

tagging-service 的本地数据模型只包含**标签字典**和配置的 skill root 中已有的 skill，没有专门的文章正文、源路径、计数、缓存或“文章—标签”关系字段。CLI 使用项目内的默认 skill root；嵌入式构造器可以覆盖该路径。**这不构成“文章内容不会落盘”的保证**：文章正文、`context` 和现有标签会发送给配置的 OpenCode Server；模型生成的标签名称或描述也可能复述其中的片段，并被写入本地标签 JSON。OpenCode 的日志、会话和保留策略不由本服务控制。调用方（例如 song’s lab，对应实现目录 `blogV2`）仍需自行把返回的标签写入业务数据。

## 运行要求

- Node.js 24 或更高版本
- npm
- 一个正在运行的 [OpenCode Server](https://opencode.ai/docs/zh-cn/server/#%E4%BC%9A%E8%AF%9D)

## 快速开始

```bash
npm install
cp .env.example .env
npm run build
npm run serve
```

默认监听地址：

```text
http://127.0.0.1:4010
```

开发模式：

```bash
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:4010/health
```

## 配置

服务会读取当前目录下的 `.env`。所有配置也可以直接通过环境变量传入。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `4010` | HTTP 监听端口 |
| `TAGS_ROOT` | 未设置时为 `path.resolve(包根目录, '..', 'data', 'tags')` | 标签字典根目录；在本仓库运行时即仓库同级的 `data/tags`。只有显式设置该变量时，相对路径才会由 CLI 按进程当前目录解析 |
| `TAGGING_SERVICE_API_KEY` | 未设置 | 可选的 HTTP Bearer Token |
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | OpenCode Server 地址 |
| `OPENCODE_USERNAME` | 未设置 | OpenCode Basic Auth 用户名，通常为 `opencode` |
| `OPENCODE_PASSWORD` | 未设置 | OpenCode Basic Auth 密码 |
| `OPENCODE_AGENT` | `build` | OpenCode 消息使用的 Agent 名称 |
| `OPENCODE_TIMEOUT_MS` | `60000` | OpenCode 健康检查、创建会话和分类消息共用的中止计时器，单位为毫秒；之后的会话清理另有最多 5 秒，故整个 HTTP 请求耗时可能更长 |
| `SOURCE_MAX_BYTES` | `2097152` | 来源加载层的大小阈值：检查内联文本的 UTF-8 字节数、本地文件打开前的 `stat` 大小，并限制 URL 响应读取量；HTTP 请求体和本地文件竞态另有下述边界 |
| `SOURCE_TIMEOUT_MS` | `15000` | URL 加载使用的中止计时器，单位为毫秒；DNS 预检查不响应该中止信号，因此它不是整个加载过程的硬超时上限 |
| `SOURCE_MAX_REDIRECTS` | `5` | URL 最多允许的重定向次数 |

> 默认只监听 `127.0.0.1`。如果需要对外提供服务，建议同时配置 `TAGGING_SERVICE_API_KEY`，并在可信的反向代理或访问控制层之后暴露接口。

内置服务不终止 TLS、不做速率限制，也没有启用 CORS。浏览器跨源调用时，需要由同源应用或反向代理提供相应的 CORS 策略；CORS 本身不构成非浏览器客户端的访问控制。

OpenCode Basic Auth 只有在 `OPENCODE_USERNAME` 或 `OPENCODE_PASSWORD` 至少设置一项时才发送。只设置密码时，用户名回退为 `opencode`；只设置用户名时，密码为空。若 OpenCode 位于远端，应使用受信任的 HTTPS 或安全内网链路，避免 Basic Auth 和文章内容明文经过不可信网络。每次 OpenCode 请求还会携带 `x-opencode-directory`，其值是 tagging-service 配置的 workspace 路径字符串；该路径由 **OpenCode Server 所在主机**解释，并不会自动把本机仓库或 skill 传输到远端，同时会向远端披露这个本机路径字符串。

## 鉴权

当 `TAGGING_SERVICE_API_KEY` **未设置**时，所有接口均不要求鉴权。

设置该变量后，所有 `/v1/*` 接口都必须携带完全匹配的 Bearer Token：

```http
Authorization: Bearer <TAGGING_SERVICE_API_KEY>
```

例如：

```bash
curl \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  http://127.0.0.1:4010/v1/tag-sets
```

`GET /health` 始终公开，不受 API Key 保护。

## HTTP 接口约定

### 基础地址

以下示例均假设：

```bash
export TAGGING_BASE_URL=http://127.0.0.1:4010
```

如果服务启用了 API Key，再设置：

```bash
export TAGGING_SERVICE_API_KEY='<你的 API Key>'
```

带请求体的接口使用 `application/json`。示例中的鉴权请求头可以按需加入：

```bash
-H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}"
```

### 名称格式

HTTP 请求中的 `tagSet`、标签集路径参数和 skill 名称必须满足：

```text
^[a-z0-9]+(?:-[a-z0-9]+)*$
```

也就是仅允许小写字母、数字和单个连字符分隔，最长 120 个字符。例如：

```text
song-article
mine-tasks
knowledge-v2
```

### 通用错误响应

所有业务错误均使用统一结构：

```json
{
  "error": {
    "code": "SOURCE_INVALID",
    "message": "File sources must be absolute .md or .txt paths.",
    "details": {}
  }
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `error.code` | `string` | 稳定的机器可读错误码 |
| `error.message` | `string` | 面向开发者的错误说明；当前为英文 |
| `error.details` | `unknown`，可选 | 校验错误或下游错误的补充信息，不保证固定结构 |

调用方应优先依据 HTTP 状态码和 `error.code` 处理错误，不应依赖 `message` 文本。

上表只描述已注册路由中的业务错误。请求未注册的路径时，Fastify 使用自身的 `404 Not Found` 响应结构，不保证符合这里的 `{ "error": ... }` 形式。

### HTTP 请求体限制与解析错误

Fastify 当前使用默认的 `bodyLimit = 1048576`，即序列化后的整个 HTTP 请求体最多 1 MiB。这个限制独立于 `SOURCE_MAX_BYTES`，并且会在请求进入 Schema 和来源加载器之前生效。因此，在默认配置下，`text` source 的可提交正文会小于 1 MiB（还要扣除 JSON 结构和转义产生的字节），不能按 `SOURCE_MAX_BYTES = 2097152` 理解为 HTTP 文本正文可达到 2 MiB。

当前自定义错误处理器只把带 Fastify `validation` 信息的 Schema 校验错误映射为 `400 INVALID_REQUEST`。以下由 HTTP 解析层提前拒绝的情况目前会落到 `500 INTERNAL_ERROR`：

- 畸形 JSON；
- 整个请求体超过 Fastify 的 1 MiB 默认上限；
- 被 Fastify 内容类型解析器拒绝的媒体类型。

这是当前实现行为，不是推荐的客户端错误语义。调用方应发送合法且小于 1 MiB 的 `application/json`；只有成功进入 Schema 校验或业务逻辑后，下面各接口列出的 `400` / `413` 等错误映射才适用。

## 接口总览

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | 否 | 健康检查 |
| `GET` | `/v1/tag-sets` | 可选 | 列出根目录扫描到的标签集名称；可能包含旧有的超长目录名 |
| `GET` | `/v1/tag-sets/:name` | 可选 | 读取一个标签集 |
| `PUT` | `/v1/tag-sets/:name` | 可选 | 合并或完整替换标签集 |
| `GET` | `/v1/skills/:name` | 可选 | 读取一个已有 skill 的 `SKILL.md` |
| `PUT` | `/v1/skills/:name` | 可选 | 原子更新一个已有 skill 的 `SKILL.md` |
| `POST` | `/v1/classifications` | 可选 | 加载内容并执行智能分类 |

这里的“可选”表示：只有设置了 `TAGGING_SERVICE_API_KEY` 时才要求鉴权。

---

## `GET /health`

检查 HTTP 服务是否存活。该接口不会检查 OpenCode Server 是否可用。

### 请求

```bash
curl "${TAGGING_BASE_URL}/health"
```

### 成功响应

状态码：`200 OK`

```json
{
  "status": "ok"
}
```

---

## `GET /v1/tag-sets`

按名称升序列出 `TAGS_ROOT` 中名称符合小写字母、数字和连字符正则的普通目录。调用该接口时，repository 会先以递归方式创建尚不存在的 `TAGS_ROOT`，因此一次成功的空列表读取也可能在本机留下空的标签根目录。该扫描当前**不检查 120 字符上限**：手工或旧版本创建的超长目录也可能出现在列表中，但随后会被其他 HTTP 路由的路径 Schema 拒绝，无法通过 `/v1/tag-sets/:name` 读取或写入。

### 请求

```bash
curl \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  "${TAGGING_BASE_URL}/v1/tag-sets"
```

### 成功响应

状态码：`200 OK`

```json
{
  "tagSets": [
    "mine-tasks",
    "song-article"
  ]
}
```

没有标签集时返回：

```json
{
  "tagSets": []
}
```

---

## `GET /v1/tag-sets/:name`

读取指定标签集目录中的标签定义。只读取非隐藏的普通 `.json` 文件；隐藏文件、符号链接、子目录和其他后缀会被忽略。标签按存储文件名稳定排序。

如果受管 `.json` 文件不是合法 JSON，当前返回 `500 INTERNAL_ERROR`；如果 JSON 可以解析、但不符合标签定义 Schema，则返回 HTTP `500` + `INVALID_REQUEST`。后者是存储损坏路径中的实际组合，不等同于客户端请求校验的 `400 INVALID_REQUEST`。

### 路径参数

| 参数 | 说明 |
| --- | --- |
| `name` | 标签集名称，例如 `song-article` |

### 请求

```bash
curl \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  "${TAGGING_BASE_URL}/v1/tag-sets/song-article"
```

### 成功响应

状态码：`200 OK`

```json
{
  "name": "song-article",
  "tags": [
    {
      "name": "Architecture",
      "description": "系统边界、组件关系和设计决策。"
    },
    {
      "name": "Local-first",
      "description": "以本地数据为主、远端同步为辅的系统设计。"
    }
  ]
}
```

### 常见错误

- `400 INVALID_REQUEST`：路径参数不符合接口 Schema。
- `404 TAG_SET_NOT_FOUND`：标签集不存在。
- `401 AUTH_REQUIRED`：已启用 API Key，但 Token 缺失或不匹配。
- `500 INTERNAL_ERROR` / `500 INVALID_REQUEST`：受管标签文件损坏，或发生未预期的文件系统错误。

---

## `PUT /v1/tag-sets/:name`

写入指定标签集。支持**合并**和**完整替换**两种模式。

如果标签集不存在，该接口会创建它。

### 请求体

```json
{
  "tags": [
    {
      "name": "Architecture",
      "description": "系统边界、组件关系和设计决策。"
    }
  ],
  "mode": "merge"
}
```

| 字段 | 类型 | 必填 | 约束与语义 |
| --- | --- | --- | --- |
| `tags` | `TagDefinition[]` | 是 | 可以为空数组 |
| `tags[].name` | `string` | 是 | 原始值和 NFKC 规范化后的值都不能超过 120 个字符；去除首尾空白后必须非空，不能以 `.` 结尾，且不能包含 U+0000–U+001F 或 `\\ / : * ? " < > \|` |
| `tags[].description` | `string` | 是 | 原始值长度 `1..1000`；去除首尾空白后必须非空 |
| `mode` | `"merge" \| "replace"` | 否 | 缺省为 `merge` |

当前兼容性限制：API 尚未主动拒绝以 `.` 开头的标签名，但这类名称会生成隐藏 JSON 文件，而读取标签集时隐藏文件会被忽略。调用方不应使用以 `.` 开头的标签名。

标签名称会经过 Unicode NFKC、首尾空白清理和不区分大小写的规范化，用于去重和生成文件名。两种模式对显示名称的处理不同：

- `merge`：若规范化后的标签已经存在，保留已有显示名称，只用本次请求的 `description` 更新描述；
- `replace`：以本次请求为完整事实来源，显示名称采用本次请求清理后的值；请求内出现规范化后重名的标签会被拒绝。

`merge` 不拒绝请求内规范化后重名的条目，而是按数组顺序处理：对于本次新建的标签，第一个条目决定显示名称，最后一个同名条目的 `description` 决定最终描述；对于已有标签，显示名称继续沿用存储值，描述同样以后出现的同名条目为准。

### 合并模式：`merge`

合并模式只新增标签或更新同名标签的描述，不删除请求中未出现的旧标签。省略 `mode` 时即为合并模式。

```bash
curl -X PUT \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{
    "tags": [
      {
        "name": "Architecture",
        "description": "系统边界、组件关系和设计决策。"
      }
    ]
  }' \
  "${TAGGING_BASE_URL}/v1/tag-sets/song-article"
```

### 完整替换模式：`replace`

完整替换模式会使仓库管理的非隐藏、普通、小写 `.json` 文件与本次 `tags` 完全一致；未出现在请求中的这类旧文件会被删除。隐藏文件、符号链接、目录、其他后缀以及大写 `.JSON` 文件不会被删除。`tags: []` 会清空该标签集中的全部受管理标签定义，但仍保留这些非受管条目。

`replace` 会先校验本次所有标签，再开始修改；但之后仍是逐文件写入和逐文件删除，整次请求**不是事务**。如果中途出现文件系统错误，目录中可能留下已写入的新文件和尚未删除的旧文件。

> **大小写 / Unicode 文件名兼容性边界：**删除阶段使用写入前 `readdir` 得到的原始文件名，并与目标小写 NFKC 文件名做区分大小写的精确字符串比较。在大小写不敏感或会把 Unicode 等价名称视为同一文件的文件系统上，如果旧文件名与目标文件名只有大小写或 Unicode 规范化形式不同（例如 `Foo.json` / `foo.json`，或 NFD `é.json` / NFC `é.json`），原子写入可能先替换同一个文件系统条目，随后删除循环又按旧名称删除刚写入的文件。接口仍可能返回 `200` 和目标标签，但磁盘上缺少该标签，后续 `GET` 也可能返回空集或不完整标签集。执行 `replace` 前应先把受管文件名迁移为服务生成的规范形式并备份目录；在修复实现前，不要把 `200` 响应当作持久化回读证明。

如果目录中已存在与本次目标文件同名的符号链接，`replace` 会在任何写入前返回 `400 INVALID_REQUEST`；其他符号链接仍按非受管条目保留。

```bash
curl -X PUT \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{
    "mode": "replace",
    "tags": [
      {
        "name": "Local-first",
        "description": "以本地数据为主、远端同步为辅的系统设计。"
      }
    ]
  }' \
  "${TAGGING_BASE_URL}/v1/tag-sets/song-article"
```

### 成功响应

状态码：`200 OK`

返回本次操作在内存中计算出的目标标签集；该接口不会在写入和删除后重新读取目录，因此响应不一定证明磁盘最终状态与其一致。尤其要注意上述大小写 / Unicode 等价文件名删除问题。响应中的标签按显示名称执行 `localeCompare` 排序，与 `GET` 按存储文件名读取的排序依据不同：

```json
{
  "name": "song-article",
  "tags": [
    {
      "name": "Local-first",
      "description": "以本地数据为主、远端同步为辅的系统设计。"
    }
  ]
}
```

### 常见错误

- `400 INVALID_REQUEST`：请求体不合法、标签定义不安全，或 `replace` 中存在规范化后重名的标签。
- `401 AUTH_REQUIRED`：已启用 API Key，但 Token 缺失或不匹配。
- `500 INTERNAL_ERROR` / `500 INVALID_REQUEST`：合并模式读取到损坏的存储文件，或写入期间发生未预期的文件系统错误。

---

## `GET /v1/skills/:name`

读取配置的 skill root 中已有的：

```text
<skillsRoot>/<name>/SKILL.md
```

CLI 和默认构造参数下，`skillsRoot` 是本项目的 `.opencode/skills`；嵌入式 `buildTaggingServer()` 可以覆盖它。

该接口只读取已有 skill，不会创建新目录或新文件。读取前后都会检查默认 `200000` 字节阈值；如果本地文件在检查后增长，服务可能先分配并读取更大的内容、再返回 `413 SKILL_TOO_LARGE`，所以该阈值不是面对可并发修改本机文件系统者的硬内存隔离边界。

### 请求

```bash
curl \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  "${TAGGING_BASE_URL}/v1/skills/intelligent-tagging"
```

### 成功响应

状态码：`200 OK`

```json
{
  "name": "intelligent-tagging",
  "content": "---\nname: intelligent-tagging\n---\n\n# Intelligent Tagging\n"
}
```

### 常见错误

- `400 INVALID_REQUEST`：skill 名称不合法，或直接的 skill 子目录 / `SKILL.md` 是符号链接或非常规文件系统对象；该检查不覆盖配置的 skill root 本身及其祖先是符号链接的情况。
- `404 SKILL_NOT_FOUND`：对应的 `SKILL.md` 不存在。
- `413 SKILL_TOO_LARGE`：文件超过 `200000` 字节。
- `401 AUTH_REQUIRED`：已启用 API Key，但 Token 缺失或不匹配。

---

## `PUT /v1/skills/:name`

完整更新配置的 skill root 中已有 skill 的 `SKILL.md`。写入采用同目录临时文件加原子替换。

该接口**不会创建不存在的 skill**。内容不能为空，UTF-8 编码后不能超过 `200000` 字节。

> **权限与安全边界：**该接口不会解释或净化 Markdown 内容，而是完整替换已有 `SKILL.md`，属于受信任配置写操作；不要向不受信任调用方开放。默认配置把 skill root 的词法路径设为本项目的 `.opencode/skills`，但实现会对该 root 执行 `realpath` 并把解析结果作为信任锚，只对其直接 skill 子目录和 `SKILL.md` 执行 `lstat` 符号链接检查。它不拒绝 skill root 本身或其祖先是符号链接：预先存在的符号链接 root 可以指向项目外，GET / PUT 仍会读写其目标。部署方必须保证配置的 root、全部祖先及其解析目标可信。检查与实际打开或重命名之间还存在本地文件系统竞态，因此这些检查不构成对可并发修改本机文件系统者的沙箱。

更新本机 `SKILL.md` 也不必然改变分类 Agent。只有 OpenCode Server 能在它自己的文件系统中通过 `x-opencode-directory` 所指路径访问同一 workspace 时，这个本地修改才可能被该 Agent 发现；远程 OpenCode 若没有共享相同路径和内容，PUT 只会改变 tagging-service 所在主机的文件。

### 请求体

```json
{
  "content": "---\nname: intelligent-tagging\n---\n\n# 更新后的内容\n"
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `content` | `string` | 是 | 至少 1 个字符，最多 `200000` UTF-8 字节 |

### 请求

为了避免在 Shell 中手工转义多行 Markdown，可以先由程序读取文件并生成 JSON：

```bash
node -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.stringify({ content: fs.readFileSync("./SKILL.md", "utf8") }));
' | curl -X PUT \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "${TAGGING_BASE_URL}/v1/skills/intelligent-tagging"
```

### 成功响应

状态码：`200 OK`

```json
{
  "name": "intelligent-tagging",
  "content": "---\nname: intelligent-tagging\n---\n\n# 更新后的内容\n"
}
```

### 常见错误

- `400 INVALID_REQUEST`：请求体或路径不合法。
- `404 SKILL_NOT_FOUND`：对应的 `SKILL.md` 不存在。
- `413 SKILL_TOO_LARGE`：内容超过 `200000` 字节。
- `401 AUTH_REQUIRED`：已启用 API Key，但 Token 缺失或不匹配。

---

## `POST /v1/classifications`

加载文章内容，调用 OpenCode 执行智能分类，并把新标签持久化到指定标签集。

如果 `tagSet` 不存在，分类会从空标签集开始。分类进入标签持久化步骤后，即使 OpenCode 返回的 `newTags` 为空，仓库也会创建对应的空目录；因此“最终没有选中任何标签”的 `502 OPENCODE_INVALID_RESULT` 响应仍可能留下一个空标签集目录。

### 请求体

```json
{
  "tagSet": "song-article",
  "source": {
    "type": "text",
    "content": "这是一篇讨论本地优先架构的文章。"
  },
  "context": {
    "title": "本地优先架构",
    "summary": "讨论本地数据与远端同步的边界。"
  }
}
```

| 字段 | 类型 | 必填 | 约束与语义 |
| --- | --- | --- | --- |
| `tagSet` | `string` | 是 | 标签集名称，最长 120 个字符 |
| `source` | `TextSource \| FileSource \| UrlSource` | 是 | 文章来源，三选一 |
| `context` | `object` | 否 | 提供给分类 Agent 的辅助上下文 |
| `context.title` | `string` | 否 | 最长 500 个字符 |
| `context.summary` | `string` | 否 | 最长 4000 个字符 |

请求对象及其各层对象均不接受未声明的额外字段。

### 来源一：内联文本

```json
{
  "type": "text",
  "content": "文章正文"
}
```

- `content` 不能为空；
- 来源加载器要求 UTF-8 字节数不超过 `SOURCE_MAX_BYTES`；通过 HTTP 调用时，整个 JSON 请求体还必须先低于 Fastify 的 1 MiB 默认上限，因此默认配置下正文实际达不到 2 MiB。

请求示例：

```bash
curl -X POST \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{
    "tagSet": "song-article",
    "source": {
      "type": "text",
      "content": "这是一篇讨论本地优先架构的文章。"
    },
    "context": {
      "title": "本地优先架构"
    }
  }' \
  "${TAGGING_BASE_URL}/v1/classifications"
```

### 来源二：服务端本地文件

```json
{
  "type": "file",
  "path": "/absolute/path/to/article.md"
}
```

文件来源的约束：

- 路径是 **tagging-service 所在机器上的路径**，不是调用方机器的路径；
- 必须是绝对路径；
- 只接受 `.md` 和 `.txt` 后缀，后缀不区分大小写；
- 读取前会对最终路径组件执行检查，要求其当时不是符号链接，并要求路径解析结果是普通文件；
- 打开文件前会用 `stat` 检查当时的大小；若已超过 `SOURCE_MAX_BYTES`，返回 `413 SOURCE_TOO_LARGE`。

> **安全边界：**file source 没有允许目录白名单。能够调用该接口的客户端，实际上可以请求读取服务进程有权限访问的任意绝对 `.md` / `.txt` 文件。当前检查不排除祖先目录中的符号链接，而且 `lstat` / `stat`、打开文件和完整读取不是同一个原子操作。文件可在检查后被替换或继续增长，读取过程本身也没有再次按字节截断，因此 `SOURCE_MAX_BYTES` 对本地文件只是打开前预检查，不是硬内存保护边界。这也不是文件系统沙箱。只应向完全可信的调用方开放 file source，并通过操作系统权限、进程隔离和可信目录约束限制可读范围。

请求示例：

```bash
curl -X POST \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{
    "tagSet": "song-article",
    "source": {
      "type": "file",
      "path": "/absolute/path/to/article.md"
    }
  }' \
  "${TAGGING_BASE_URL}/v1/classifications"
```

### 来源三：公开 URL

```json
{
  "type": "url",
  "url": "https://example.com/article"
}
```

URL 来源的约束：

- 只接受 `http` 和 `https`；
- URL 中不能携带用户名或密码；
- 发起请求前会解析主机，并按当前阻止规则拒绝识别出的回环、私网或链路本地地址；DNS 没有返回任何地址（包括解析失败）时也返回 `400 SOURCE_BLOCKED`；
- 每次重定向后的目标都会再次执行同样的预检查；
- 重定向次数不能超过 `SOURCE_MAX_REDIRECTS`；
- 加载开始时会启动 `SOURCE_TIMEOUT_MS` 计时器，并把信号传给实际 `fetch`；DNS 预检查没有接收该信号，因此真实耗时可能超过配置值；
- 响应体不能超过 `SOURCE_MAX_BYTES`；
- HTML 响应会移除 `script`、`style` 和 HTML 标签后再交给分类 Agent。

> **安全边界：**URL 的 DNS 预检查与后续实际连接彼此分离，没有固定已验证的解析地址；当前地址规则也不是对所有地址表示形式的完备覆盖。因此该检查只能降低常见 SSRF 风险，不能作为严格的网络隔离边界。处理不受信任请求时，还应在运行环境中配置出站网络限制或可信代理。

重定向缺少 `Location` 或超过次数上限时返回 `400 SOURCE_INVALID`。当前实现没有捕获语法错误的 `Location`；这类畸形重定向会以 `500 INTERNAL_ERROR` 结束，而不是 `SOURCE_INVALID`。

计时器在等待 `fetch` 返回响应头或流式读取正文时触发，最外层 HTTP 错误处理都会把 `AbortError` 映射为 `408 SOURCE_TIMEOUT`。DNS 预检查不响应该中止信号，因此整个加载过程仍可能明显超过 `SOURCE_TIMEOUT_MS`。

请求示例：

```bash
curl -X POST \
  -H "Authorization: Bearer ${TAGGING_SERVICE_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{
    "tagSet": "song-article",
    "source": {
      "type": "url",
      "url": "https://example.com/article"
    }
  }' \
  "${TAGGING_BASE_URL}/v1/classifications"
```

### 成功响应

状态码：`200 OK`

```json
{
  "tags": [
    "Architecture",
    "Local-first"
  ],
  "createdTags": [
    {
      "name": "Local-first",
      "description": "以本地数据为主、远端同步为辅的系统设计。"
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tags` | `string[]` | 当前文章最终选中的标签显示名称；至少包含 1 项且不会重复 |
| `createdTags` | `TagDefinition[]` | 本次请求中新建、且最终被选中的标签；没有新标签时为空数组 |

OpenCode 返回的已有标签必须存在于当前标签集中；否则服务会返回 `502 OPENCODE_INVALID_RESULT`。OpenCode 的结构化结果虽然已通过返回 Schema，但其中的新标签仍要经过 repository 的 NFKC、长度和文件名安全校验：不满足这些额外约束时返回 `400 INVALID_REQUEST`。通过校验的新标签会先写入标签字典，再执行“最终至少选中一个标签”的检查；因此后续的 `502 OPENCODE_INVALID_RESULT` 不代表本次请求没有留下标签文件或空标签集目录。读取当前标签集时遇到存储损坏，也可能在调用 OpenCode 前返回 `500 INTERNAL_ERROR` 或 `500 INVALID_REQUEST`。

`AgentDecisionSchema` 当前没有限制 `existingTags` 或 `newTags` 的数组项数；结合 OpenCode 响应体没有字节上限，受控或异常 Agent 可以在一次请求中返回大量新标签，触发大量文件写入和较大的 HTTP 响应。部署时应在可信代理、OpenCode Agent 策略或实现外层限制响应大小、并发与请求频率，不能把单个标签的 `120` / `1000` 字符限制理解为整次分类的资源上限。

> **模型与内容安全边界：**正文、`context` 和当前标签（包括标签描述）都会作为文本直接拼接到 OpenCode prompt 中，没有提示注入净化或语义隔离。模型生成的新标签可能包含这些输入的片段并被持久化，随后又会作为 `Existing tags` 进入未来请求；因此恶意或被注入的标签可形成**跨请求的持久提示注入通道**。JSON Schema 只约束返回结构，不能保证分类语义正确，也不能阻止所选 Agent 在分类期间使用其自身拥有的工具。默认 Agent 名称是 `build`；处理不受信任内容时，应在 OpenCode 侧配置专用、最小权限且无敏感工具的 Agent，并把 OpenCode 主机上的 workspace、网络、文件权限、会话、日志和数据保留策略一并视为安全边界。HTML 的正则去标签处理只是文本提取，不是安全净化。

### 常见错误

| HTTP 状态 | 错误码 | 说明 |
| ---: | --- | --- |
| `400` | `INVALID_REQUEST` | 请求体不符合 Schema，或 OpenCode 生成的新标签未通过 repository 的规范化、长度或文件名安全约束 |
| `400` | `SOURCE_INVALID` | 文件路径或初始 URL 不合法、URL 获取失败、远端返回非成功状态、重定向缺少 `Location` 或超过次数上限；语法错误的重定向地址除外 |
| `400` | `SOURCE_BLOCKED` | URL 含凭据、DNS 未返回地址，或目标解析到被阻止的地址 |
| `401` | `AUTH_REQUIRED` | API Key 缺失或不匹配 |
| `408` | `SOURCE_TIMEOUT` | URL 的 `fetch` 或响应正文读取被计时器中止；此外，OpenCode 响应正文若自行抛出 `AbortError`、但共享 OpenCode 计时器尚未中止，也会被通用错误映射误归到此码 |
| `413` | `SOURCE_TOO_LARGE` | 来源加载器识别到文本、文件预检查或 URL 响应超过阈值；不包括 Fastify 的独立 HTTP body limit |
| `422` / `503` | `OPENCODE_AGENT_NOT_FOUND` | OpenCode 消息接口返回 `404`，或其非 2xx 正文匹配 Agent-not-found 文本；`404` 映射为 `422`，其他匹配状态映射为 `503`。这是当前启发式分类，消息接口的任意 `404` 都会使用该错误码 |
| `502` | `OPENCODE_INVALID_RESULT` | 创建会话或分类消息返回 `204` / 空 2xx 正文，解析后的 JSON 缺少会话 ID 或有效结构化结果，已有标签选择不存在，或最终没有选中任何标签；健康检查的空 2xx 正文自身不会失败 |
| `422` / `503` | `OPENCODE_UNAVAILABLE` | 取得响应头前的网络请求失败，或 OpenCode 返回未被识别为 Agent 缺失的非 2xx；健康检查或创建会话的 `404` 映射为 `422`，其余常见分支映射为 `503` |
| `504` | `OPENCODE_TIMEOUT` | OpenCode 分类会话超时 |
| `500` | `INVALID_REQUEST` | 当前标签集中某个 JSON 可以解析，但不符合标签定义 Schema |
| `500` | `INTERNAL_ERROR` | 未预期错误；也包括上述 HTTP 解析错误、语法错误的重定向地址、OpenCode 非空 2xx 正文不是合法 JSON，以及取得响应头后发生的普通非 `AbortError` 正文读取失败 |

## 完整错误码

下面列出服务内部定义的全部稳定错误码。并非每个错误码都能从每条 HTTP 路由到达；HTTP 状态与错误码也不总是一一对应。

OpenCode 非 2xx 响应的正文会先完整读取，成功后最多前 1000 个字符放入 `error.details` 返回给调用方。不要让 OpenCode 或其前置代理在错误正文中包含凭据；对外暴露本服务时，也应把错误详情视为可能包含下游诊断信息。如果取得响应头后读取正文发生普通非 `AbortError` 错误，当前不会得到 `OPENCODE_UNAVAILABLE`，而会落入 `500 INTERNAL_ERROR`；若共同计时器已触发中止，则外层分类逻辑返回 `504 OPENCODE_TIMEOUT`。若正文流自行抛出 `AbortError`，但共享计时器尚未中止，通用错误映射反而会返回 `408 SOURCE_TIMEOUT`。

| 错误码 | 常见 HTTP 状态 | 含义 |
| --- | ---: | --- |
| `AUTH_REQUIRED` | `401` | 需要有效的 Bearer Token |
| `INVALID_REQUEST` | `400` / `500` | 请求 Schema、标签定义或受控文件内容不合法；调用方或 Agent 产生的不安全标签通常为 `400`，已存储 JSON 的结构损坏为 `500` |
| `INVALID_TAG_SET` | `400` | Repository 直接调用时标签集名称或解析后的存储路径不合法；公开 HTTP 路由会先做 Schema 校验，非法名称通常返回 `INVALID_REQUEST` |
| `TAG_SET_NOT_FOUND` | `404` | 标签集不存在 |
| `SKILL_NOT_FOUND` | `404` | skill 或其 `SKILL.md` 不存在 |
| `SKILL_TOO_LARGE` | `413` | skill 内容超过 200000 字节 |
| `SOURCE_INVALID` | `400` | 来源格式、路径或远端响应不合法；当前不覆盖语法错误的重定向 `Location` |
| `SOURCE_TOO_LARGE` | `413` | 来源加载器识别到内容超过配置阈值；Fastify 的独立 HTTP body limit 超限目前返回 `500 INTERNAL_ERROR` |
| `SOURCE_TIMEOUT` | `408` | URL 的 `fetch` 或响应正文读取被中止；DNS 预检查可能使总耗时超过配置值。OpenCode 正文流在共享计时器未中止时自行抛出的 `AbortError` 也会被通用映射归到此码 |
| `SOURCE_BLOCKED` | `400` | URL 来源触发安全阻止规则 |
| `OPENCODE_UNAVAILABLE` | `422` / `503` | 取得响应头前的网络失败，或未识别为 Agent 缺失的非 2xx；健康检查或创建会话的 `404` 为 `422`，其他常见分支为 `503` |
| `OPENCODE_AGENT_NOT_FOUND` | `422` / `503` | 消息接口 `404`，或其非 2xx 正文匹配 Agent-not-found 文本；前者为 `422`，后者通常为 `503`，且该启发式可能把消息接口的其他 `404` 归入此码 |
| `OPENCODE_INVALID_RESULT` | `502` | 创建会话或消息返回空 2xx 正文，或已解析 JSON 中的会话 ID、结构化结果、标签选择或最终分类结果无效；健康检查不校验正文结构 |
| `OPENCODE_TIMEOUT` | `504` | OpenCode 分类超时 |
| `INTERNAL_ERROR` | `500` | 未被识别的内部异常；当前也承载部分 HTTP 解析错误、畸形重定向地址、OpenCode 非空且非 JSON 的 2xx 正文，以及取得 OpenCode 响应头后的普通非 `AbortError` 正文读取失败 |

## TypeScript SDK

安装或在工作区中引用包后，可以通过 SDK 调用同一套 HTTP 接口：

```ts
import { createTaggingClient, TaggingClientError } from 'tagging-service'

const client = createTaggingClient({
  baseUrl: 'http://127.0.0.1:4010',
  ...(process.env.TAGGING_SERVICE_API_KEY
    ? { apiKey: process.env.TAGGING_SERVICE_API_KEY }
    : {}),
})

const tagSets = await client.tagSets.list()

await client.tagSets.upsert('song-article', {
  tags: [
    {
      name: 'Architecture',
      description: '系统边界、组件关系和设计决策。',
    },
  ],
})

await client.tagSets.replace('song-article', {
  tags: [
    {
      name: 'Local-first',
      description: '以本地数据为主、远端同步为辅的系统设计。',
    },
  ],
})

const result = await client.classify({
  tagSet: 'song-article',
  source: {
    type: 'file',
    path: '/absolute/path/to/article.md',
  },
  context: {
    title: '本地优先架构',
    summary: '讨论本地数据与远端同步的边界。',
  },
})

console.log(result.tags)
```

SDK 能力：

```ts
client.classify(input)

client.tagSets.list()
client.tagSets.get(name)
client.tagSets.upsert(name, { tags })
client.tagSets.replace(name, { tags })

client.skills.get(name)
client.skills.update(name, { content })
```

SDK 的所有请求都会设置 `Accept: application/json`；有请求体时还会设置 `Content-Type: application/json`；`apiKey` 为非空字符串时会设置 `Authorization: Bearer <apiKey>`。这些公开方法不提供逐请求的任意 headers 或 `AbortSignal` 参数；如需注入额外请求头、取消、超时或重试策略，需要在构造客户端时提供自定义 `fetch`。

当 HTTP 响应不是 2xx，且响应体是服务约定的 JSON 错误结构时，SDK 会抛出 `TaggingClientError`：

```ts
try {
  await client.tagSets.get('missing-set')
} catch (error) {
  if (error instanceof TaggingClientError) {
    console.error(error.status)  // HTTP 状态码
    console.error(error.code)    // 稳定错误码
    console.error(error.message)
    console.error(error.details) // 可选补充信息
  }
}
```

SDK 会先执行 `response.json()`。如果网络请求本身失败，或者反向代理、网关等中间层返回非 JSON / 非标准 JSON，则可能抛出原生 `fetch` 错误、JSON 解析错误或 `TypeError`，而不是 `TaggingClientError`。调用方若无法保证网络和中间层响应格式，应同时处理未知异常。

SDK 也不会在运行时按导出的 TypeScript Schema 校验 2xx JSON；成功响应只会被类型断言为目标类型。因此，来自不受信任代理或不兼容服务端的结构错误可能在后续属性访问时暴露，而不是在 SDK 请求边界被拒绝。SDK 没有内置请求超时、重试或取消策略；需要时应通过自定义 `fetch` 实现。

服务端构造器单独从 `tagging-service/server` 导出，便于嵌入其他进程或测试：

```ts
import { buildTaggingServer } from 'tagging-service/server'

const app = buildTaggingServer({
  tagsRoot: '/absolute/path/to/data/tags',
  skillsRoot: '/absolute/path/to/.opencode/skills',
  ...(process.env.TAGGING_SERVICE_API_KEY
    ? { apiKey: process.env.TAGGING_SERVICE_API_KEY }
    : {}),
  opencode: {
    baseUrl: 'http://127.0.0.1:4096',
    agent: 'build',
    workspace: '/path/visible/on-the-opencode-server',
  },
})
```

`skillsRoot` 是 tagging-service 主机上的本地受管目录；`opencode.workspace` 只是发送给 OpenCode Server 的 `x-opencode-directory` 路径字符串。两者没有自动同步关系，也不要求位于同一主机。

## 标签存储

`TAGS_ROOT` 默认指向当前仓库同级工作区中的 `data/tags`：

```text
data/tags/
└── song-article/
    ├── architecture.json
    └── local-first.json
```

每个文件只保存一个标签定义：

```json
{
  "name": "Architecture",
  "description": "系统边界、组件关系和设计决策。"
}
```

标签写入会：

- 使用 Unicode NFKC、首尾空白清理和不区分大小写的名称规范化进行去重；
- `merge` 保留已有显示名称，`replace` 采用本次请求中的显示名称；
- 在同一个服务进程、同一个 repository 实例内，对每个标签集串行化并发写入；不同进程或不同实例之间没有文件锁；
- 对单个标签文件在同一目录内使用临时文件和原子替换；多文件的 merge / replace 请求整体不是事务；
- `replace` 的响应来自内存中的目标集合，不做写后回读；大小写不敏感或 Unicode 规范化文件系统上的旧别名可能使删除阶段删掉刚写入的文件；
- 不创建专门的文章正文、文章关系、计数或缓存文件；但模型从正文、`context` 或现有标签中派生出的内容仍可能进入标签名称 / 描述并落盘。

> **存储安全边界：**标签集名称校验只能阻止名称中的路径穿越。repository 没有对 `TAGS_ROOT` 或其标签集子目录执行 `realpath` containment，也不拒绝标签集目录本身是符号链接。能够并发修改本机标签目录的主体可能把读、写或 `replace` 删除操作重定向到其他目录；操作系统权限、独占进程和可信的 `TAGS_ROOT` 内容仍是必要边界。

## OpenCode 调用流程

每次分类按以下顺序调用 OpenCode Server：

1. `GET /global/health`；
2. `POST /session` 创建临时会话；
3. `POST /session/:id/message`，要求按 JSON Schema 返回结构化分类结果；
4. `DELETE /session/:id` 尝试清理临时会话。

OpenCode 返回 HTTP 2xx 后，`204` 或空正文会被表示为 `null`，非空正文才会按 JSON 解析。健康检查只要求 HTTP 成功，不检查正文，所以空正文可以继续；创建会话或分类消息得到空正文时，最终返回 `502 OPENCODE_INVALID_RESULT`。非空正文若能解析为 JSON，但缺少会话 ID 或结构化分类结果不符合 Schema，也返回 `502 OPENCODE_INVALID_RESULT`；若非空 2xx 正文不是合法 JSON，当前未转换该 `SyntaxError`，最终返回 `500 INTERNAL_ERROR`。

取得响应头前的 `fetch` 失败会被包装为 `OPENCODE_UNAVAILABLE`；但取得响应头后，读取 2xx 或非 2xx 正文的失败不在该包装范围内。普通非 `AbortError` 最终为 `500 INTERNAL_ERROR`；正文流自行抛出 `AbortError`、但共享计时器尚未中止时，会被通用映射误归为 `408 SOURCE_TIMEOUT`。健康检查或创建会话返回 `404` 时是 `422 OPENCODE_UNAVAILABLE`；消息接口返回任意 `404` 时是 `422 OPENCODE_AGENT_NOT_FOUND`，其他非 2xx 通常为 `503`。如果正文读取失败发生在共同的 OpenCode 计时器中止之后，外层会改为返回 `504 OPENCODE_TIMEOUT`。

OpenCode 响应体当前没有字节上限：2xx 和非 2xx 正文都会先完整读入内存；非 2xx 只是在读完后把详情截到前 1000 个字符。应把配置的 OpenCode Server 和其前置代理视为可信依赖，并在代理层限制响应大小。

会话清理使用独立的 5 秒超时，失败会被忽略，不会改变主要分类响应。因此清理是 best-effort，不能把 tagging-service 的成功或失败响应当作 OpenCode 已删除会话的证明；OpenCode 侧的持久化与日志策略需要单独配置和核对。

通过 CLI 启动或使用默认服务端构造参数时，tagging-service 会把本机仓库根目录字符串放入 `x-opencode-directory`。只有 OpenCode Server 与 tagging-service 位于同一主机，或远端挂载了相同路径和内容时，OpenCode 才能据此发现：

```text
.opencode/skills/intelligent-tagging/SKILL.md
```

嵌入式调用 `buildTaggingServer()` 时，可以通过 `opencode.workspace` 覆盖发送的路径字符串。路径始终由 OpenCode Server 主机解释；它不会上传 tagging-service 主机的目录。Agent 可见的 workspace 文件、skill 和可用工具均取决于 OpenCode 主机上的真实文件系统、配置与权限域。

项目不内置自定义 OpenCode Agent，实际 Agent 由 `OPENCODE_AGENT` 配置。

## 开发与验证

```bash
npm test
npm run typecheck
npm run build
```
