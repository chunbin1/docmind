# 多会话（新建对话）设计

> 状态：已批准，待实现
> 日期：2026-07-05

## 背景

DocMind 目前是**单用户单对话**模型：`chat_messages` 表只按 `user_id` 区分，没有"会话"概念；侧边栏底部有一个「清空对话」按钮直接删掉该用户全部消息。生成锁、压缩摘要、pin、刷新恢复轮询等逻辑都假设"一个用户 = 一条对话"。

本设计把它升级为 **ChatGPT 式多会话**：侧边栏列出历史会话，可新建、切换、删除，每条会话有独立历史。

## 目标与非目标

**目标**
- 每个用户可拥有多条会话，各自独立历史。
- 支持三种操作：新建、切换、删除。
- 标题由首条用户消息自动生成。
- **每会话可各自并发生成**（服务端并发，互不阻塞、都不丢）。

**非目标（YAGNI）**
- 会话重命名。
- 会话置顶 / 收藏。
- 会话搜索。
- 跨会话的记忆 / 文档隔离（记忆与文档保持**用户全局共享**）。
- 后台会话的真·多路实时流（后台会话靠切回轮询恢复，不做多 reader 逐字动画）。

## 已定决策

| 议题 | 决定 |
|------|------|
| 形态 | 完整多会话（ChatGPT 式），可切换续聊 |
| 操作范围 | 新建 + 切换 + 删除（无重命名、无置顶） |
| 标题 | 首条用户消息自动生成（截断 ~24 字），不可手动改 |
| 配额 | 每用户 10 条上限**全局总量不变**，跨会话共享，防止新建绕过 |
| 记忆 / 文档 | 保持**用户全局共享**，不加 conversation 维度 |
| 并发 | **每会话各自并发生成**（服务端并发） |
| 客户端流式 | 同一时刻只实时渲染当前会话；后台会话服务端续跑，切回轮询恢复 |
| 当前选中恢复 | `localStorage` 按用户记住最后选中会话，失效回落最近一条，空则草稿 |

## 数据模型

### 新表 `conversations`

放在 `chatStore.ts`，共用 memory DB 连接。

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '新对话',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL          -- 每次追加消息刷新，列表按它倒序
);
CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(user_id, updated_at);
```

### `chat_messages` 增列

幂等 `ALTER TABLE ... ADD COLUMN`（同现有 `reasoning` 列迁移写法）。

```sql
ALTER TABLE chat_messages ADD COLUMN conversation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_conv_seq ON chat_messages(conversation_id, seq);
```

- `seq` 语义从"按 user"改为"按 conversation"：`appendMessage` 里 `MAX(seq) WHERE conversation_id = ?`。
- 保留 `user_id` 列不动（鉴权兜底 + 迁移用）。

### 所有权校验

所有会话 / 消息类操作先查 `conversations.user_id === 当前用户`，否则 404，杜绝越权访问别人会话。

## 启动迁移

在 `initChatTables` 内一次性 backfill 老数据：

1. 建 `conversations` 表、加 `conversation_id` 列、建索引。
2. 对每个"存在 `conversation_id IS NULL` 消息"的 `user_id`：
   - 新建一条会话；`title` 取该用户最早那条 user 消息前 ~24 字（无则留"新对话"）；`created_at` = 最早消息时间，`updated_at` = 最晚消息时间；
   - `UPDATE chat_messages SET conversation_id = ? WHERE user_id = ? AND conversation_id IS NULL`。
   - 迁移后每用户恰好一条会话，老的 per-user `seq` 天然等于 per-conversation `seq`，无需重排。
3. 现有崩溃恢复语句（`generating → error`）保持不变，跨会话一并生效。

**幂等**：`ALTER TABLE` 用 try/catch；backfill 只作用于 `conversation_id IS NULL` 的行，重复启动不会重复建会话。

## 接口改动

### 新增

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/chat/conversations` | 列出本用户会话（id / title / updated_at / message_count / generating），按 `updated_at` 倒序 |
| POST | `/api/chat/conversations` | 建空会话，返回 `{ id }`（首次发消息时前端惰性调用） |
| DELETE | `/api/chat/conversations/:id` | 删会话 + 级联删其消息；若该会话正在生成先 `abortGeneration(id)` |

`generating` 标记由 `hasGenerating(convId)` 派生，用于侧边栏"生成中"圆点。

### 改动（加 `conversationId` 维度）

- `GET /api/chat/messages?conversationId=xxx` — 按会话加载（无参或非法 → 404 / 空）。
- `POST /api/chat/stream` — body 加 `conversationId`；落库 / 取历史 / 生成锁全部按会话；**首条 user 消息落库后**若会话标题仍是默认值，用该消息自动生成标题；每次追加消息刷新 `conversation.updated_at`。
- `POST /api/chat/compact`、`/api/chat/nudge` — 本就按传入 message ids，天然限定单会话；compact 生成的 summary 行继承 `conversation_id`。
- `PATCH /api/chat/messages/:id`（pin）— 按 message id 不变，补所有权校验。
- `POST /api/chat/stop` — body 加 `{ conversationId }`，只中断该会话生成。
- `DELETE /api/chat/messages`（原"清空全部"）— **移除**，由 `DELETE /conversations/:id` 覆盖。

## 并发模型

**服务端（真正的并发）**
- `generationRegistry` 的 key 从 `userId` 改为 `conversationId`：一个用户可同时有多条会话在生成，每条会话至多一个。
- 生成锁 `hasGenerating` 改为**按会话**判断：只有该会话自己在生成时才 409，别的会话不受影响。
- `POST /chat/stop` 按 `conversationId` 中断。
- 配额不受影响（仍按用户全局总量算）。

**客户端（单路实时流 + 轮询恢复）**
- 同一时刻只**实时**流式渲染当前所在会话。
- 在 A 生成时切到 B：只 abort 客户端 reader（**不**调 `/chat/stop`），服务端照常续写落库；切回 A 时用现有"末条 generating → ~1s 轮询恢复"机制补齐内容。
- 侧边栏会话项显示"生成中"小圆点（`GET /conversations` 的 `generating` 标记），存在 generating 会话时以 ~2s 轮询刷新列表，无则停轮询。
- 代价：切回正在生成的会话时内容每秒一批补出，非逐字动画——这与现有刷新恢复行为一致，成熟可靠。

## 前端结构与数据流

### 新 hook `useConversations(userId)`

- 状态：`conversations[]`、`currentId`（`null` = 空草稿）。
- 方法：`selectConversation(id)`、`newConversation()`（置 `currentId=null`、清空视图）、`deleteConversation(id)`、`refresh()`。
- 启动：拉 `GET /conversations`；`currentId` 优先取 `localStorage['docmind.currentConv.<userId>']`，失效回落最近一条，空则草稿。选中变化写回 localStorage。
- 列表轮询：仅当存在 generating 会话时 ~2s `refresh()`，避免常态空转。

### 改造 `useChat(userId, conversationId, onConversationCreated)`

- 按 `conversationId` 加载消息（`conversationId` 变化触发重载，复用现有 `runId`/`mountedRef` 防串号机制，升级为"换会话防护"）。
- **惰性建会话**：`sendMessage` 时若 `conversationId == null` → 先 `POST /conversations` 拿 id → `onConversationCreated(id)`（`useConversations` 将其设为 `currentId` 并插入列表）→ 再带该 id 走 `/chat/stream`。
- 切换会话时 abort 当前 reader（不调 stop），交给目标会话加载 / 轮询。
- `stopStreaming` 带上 `conversationId`。

### 新组件 `ConversationList`

- 放侧边栏 logo 下、`MemoryPanel` 上。
- 顶部「＋ 新建对话」按钮；下方会话项（标题 + 生成中圆点 + hover 出现的删除 🗑）。
- 当前项高亮；点击切换；点删除弹确认后 `DELETE`。

### 数据流（发首条消息）

```
newConversation() → currentId=null, messages=[]
用户发送 → useChat.sendMessage(msg, docIds)
  → POST /conversations → { id } → onConversationCreated(id)
  → 乐观插入 user+assistant 占位
  → POST /chat/stream { conversationId:id, message, docIds }
  → SSE 逐字渲染 → done → refresh 会话列表（标题已由服务端据首句生成）
```

## 错误处理与边界

- **删除当前选中会话**：选中列表中下一条最近会话；删空则回空草稿。
- **删除正在生成的会话**：`DELETE /conversations/:id` 先 `abortGeneration(id)` 再级联删。
- **A 生成时切到 B 再发**：B 是不同会话，`hasGenerating(B)` 为假 → 正常发送；A 服务端继续跑，侧栏圆点提示，切回轮询补齐。
- **同一会话并发点两次发送**：`hasGenerating(convId)` → 409，前端回滚乐观占位（现有逻辑）。
- **惰性建会话失败**：回滚乐观占位、提示错误，不进入流式。
- **越权**：任何带 `conversationId` 的请求校验 `conversation.user_id === user.id`，否则 404。
- **配额 403 / 登录失效 401**：沿用现有处理（回滚 + `auth:refresh`）。
- **崩溃恢复**：`generating → error` 语句保留，跨会话一并生效。

## 涉及文件（预估）

**后端**
- `services/chatStore.ts` — 新 `conversations` 表 + 迁移 + backfill；`chat_messages` 加列；所有查询加 `conversation_id`；`seq` 按会话；会话 CRUD 函数；`hasGenerating(convId)`。
- `services/generationRegistry.ts` — key 改为 `conversationId`。
- `routes/chat.ts` — 会话 CRUD 路由；`/chat/stream`、`/chat/messages`、`/chat/stop` 加 `conversationId`；标题自动生成；移除 `DELETE /chat/messages`。

**前端**
- `hooks/useConversations.ts` — 新增。
- `hooks/useChat.ts` — 按 `conversationId` 重构。
- `components/ConversationList.tsx` — 新增。
- `components/ChatView.tsx` — 接入两个 hook 与新组件；移除底部"清空对话"。
- `App.module.css` — 会话列表样式。
- `types.ts` — `Conversation` 类型。

**文档**
- `CLAUDE.md` — 更新架构、API 表、设计决策。
