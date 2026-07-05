# 服务端对话持久化 — 设计方案

> 日期:2026-07-05
> 状态:已确认,待实现
> 缘起:刷新页面丢失"正在生成/未答完"的回答。当前架构下聊天完全无状态——历史由前端每次请求带上,SSE 实时转发不留存,唯一存储是前端 localStorage,连接一断答案永久丢失。

## 1. 背景与目标

**现状**:`/api/chat/stream` 把 LLM 回答通过 SSE 实时转发给浏览器,服务端边转发边扔;历史存在前端 localStorage(`docmind:chat:<userId>`)。用户在回答生成中刷新 → SSE 连接被掐断 → 服务端没存过这次回答 → 答案永久丢失。

**目标**:对齐 ChatGPT 那种"生成与浏览器连接解耦"的体验——**服务器不管用户在不在都把回答生成完并存好,刷新后前端从服务器拉;若还在生成就轮询直到出完整答案**。

**已确认的关键决策**:
- **雄心档位**:答案保住 + 自动补齐(轮询),**不做**逐字实时续传。
- **存储权威**:服务端 DB 为唯一权威,localStorage 退役。
- **旧历史**:丢弃,从空开始(不迁移)。
- **会话模型**:维持"每用户单条对话"(YAGNI,不做多会话列表)。

## 2. 范围

**包含:**
- 新增 `chat_messages` 表 + `services/chatStore.ts` 存储层。
- `/api/chat/stream` 改造:落库 + 断开续跑 + 状态机。
- 新增 `GET /api/chat/messages`、`PATCH /api/chat/messages/:id`、`DELETE /api/chat/messages`。
- `/api/chat/compact` 改造:摘要后替换旧消息并落库。
- 历史裁剪(`trimHistoryByTokens`)与早期摘要注入 system prompt 从前端**挪到服务端**。
- `useChat` 改造:以服务端为准 + 乐观追加 + 刷新轮询恢复;移除 localStorage。

**不做(YAGNI):**
- 逐字实时续传(SSE 回放/重连)。
- 多会话 / 会话列表 / 会话标题。
- 本地历史迁移。
- 失败退还配额(维持现状,单独议题)。
- 用户自定义 system prompt(仅在文档里说明:未来若加,也应存服务端,不由前端每次带原始 prompt)。

## 3. 数据模型

在现有共享 `memory.db` 里新增表(沿用 documentStore/memoryStore 的建表 + 幂等迁移模式),新建 `services/chatStore.ts` 封装。

```sql
CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  seq             INTEGER NOT NULL,     -- 每用户内递增,稳定排序
  role            TEXT NOT NULL,        -- 'user' | 'assistant' | 'summary'
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'done',  -- 'generating' | 'done' | 'error'
  pinned          INTEGER,              -- 0/1,可空
  compacted_count INTEGER,              -- summary 行用
  compacted_at    INTEGER,              -- summary 行用(unix ms)
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_user_seq ON chat_messages(user_id, seq);
```

- 单用户单对话,`user_id` 即"会话 id",无需 conversations 表。
- `seq`:插入时取该用户 `MAX(seq)+1`,保证顺序稳定(不依赖 created_at 的毫秒碰撞)。
- `status` 是恢复机制核心;仅 assistant 行会经历 `generating`。
- 列对齐前端 `ChatMessage`(role/content/pinned/compactedCount/compactedAt),`isError` 由 `status='error'` 映射。

`chatStore.ts` 导出:
- `initChatTables(db)` — 建表 + 迁移;**并在启动时执行 `UPDATE chat_messages SET status='error' WHERE status='generating'`**(崩溃兜底,见 §6.3)。
- `getMessages(userId)` — 按 seq 升序。
- `appendMessage(userId, {role, content, status?, pinned?, compactedCount?, compactedAt?})` → `{ id, seq }`。
- `updateMessageContent(id, content, status)` — 流结束/出错时写回。
- `setPinned(userId, id, pinned)`。
- `clearMessages(userId)`。
- `replaceForCompaction(userId, deleteIds[], summary)` — 删旧行 + 头插 summary 行。
- `hasGenerating(userId)` — 并发检查用。

## 4. 服务端接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/chat/messages` | 拉当前用户整条对话(按 seq) |
| POST | `/api/chat/stream` | 改造:落库 + 断开续跑 |
| PATCH | `/api/chat/messages/:id` | 改 pinned |
| DELETE | `/api/chat/messages` | 清空对话 |
| POST | `/api/chat/compact` | 改造:摘要后替换旧消息并落库 |
| POST | `/api/chat/nudge` | 不变 |

### 4.1 `/chat/stream` 改造流程

1. 鉴权 + `canSend` + `incrementMessageCount`(不变,仍开头扣一次配额)。
2. **并发检查**:若 `hasGenerating(userId)`,返回 `409`(前端提示"上一条还在生成")。
3. 落库用户消息(`role=user, status=done`)。
4. 落库 assistant 占位(`role=assistant, status=generating, content=''`),记住其 `id`。
5. **历史从 DB 读**(不再信任 body):取该用户已落库消息,`trimHistoryByTokens` 裁剪,summary 行注入 system prompt。请求体瘦身为 `{ message, docIds }`。
6. 记忆/文档/工具预检 + 拼 prompt(基本不变,只是历史来源换成 DB)。
7. 流式循环:每 chunk 累加 `out`,并 `send()` 推给在线浏览器;**`send()` 包 try/catch,socket 关了静默跳过,循环不中断**。
8. 完成:`updateMessageContent(assistantId, out, 'done')`;socket 在则发 `{done}`。
9. 出错:`updateMessageContent(assistantId, errText, 'error')`;socket 在则发 `{error}`。

### 4.2 其余接口

- `GET /messages`:返回 `{ messages: ChatMessage[] }`,`status='error'` 映射为 `isError:true`。
- `PATCH /messages/:id`:`{ pinned }` → `setPinned`(限本用户)。
- `DELETE /messages`:`clearMessages(userId)`。
- `POST /compact`:前端仍决定**何时**压缩(token 阈值)并在 body 里带上**要压缩的消息 id 数组**(从 `GET` 拿到的 id);服务端按这些 id 取内容做摘要 LLM 调用,`replaceForCompaction` 删掉这些行、头插 summary 行;返回 `{ summary }`,前端随后重新 `GET` 拉规范状态。

## 5. 前端改造(`useChat`)与恢复流程

- **加载**:挂载 / userId 变化 → `GET /api/chat/messages` → `setMessages`;新增 `loading` 态。
- **发送**:`POST /chat/stream`,body `{ message, docIds }`。本地乐观追加 `[user, assistant('')]`,SSE 到达 `appendToLast`(不变)。
- **pin 切换**:`PATCH`,成功更新本地。
- **清空**:`DELETE`,再清本地。
- **压缩**:`POST /compact` → 重新 `GET`。
- 移除 localStorage 全部逻辑(读/写/迁移/`storageKey`)。
- 新增内部状态 `loading`(首拉)、`polling`(恢复轮询)。

**刷新恢复时序**:
```
发送"广州天气如何"
  → 前端乐观 [user, assistant('')] + POST
  → 服务端落库 user(done) + assistant(generating),开始生成
刷新
  → 重挂载 → GET /messages → [..., user"广州", assistant(generating)]
  → 最后一条是 generating → 轮询每 ~1s GET
服务端(不依赖已断连接)生成完 → assistant(content=完整答案, done)
  → 前端下次轮询拿到 done → 渲染完整答案 + 停轮询 ✅
```

**轮询收尾控制**:
- 拿到 `done`/`error` 立即停。
- 封顶 2 分钟,超时停并把该条显示为"已中断"。
- 生成中禁用输入(禁用条件从"streaming"扩展为"最后一条是 generating"),防重复触发。

## 6. 错误与边界

1. **浏览器中途断开**(核心):`send()` try/catch 静默跳过,生成循环照跑并落库。
2. **LLM 生成报错**:assistant 写 `status='error'` + 错误文本;前端渲染出错气泡、停轮询。
3. **服务器崩溃/重启导致 `generating` 卡死**:启动时 `initChatTables` 执行 `UPDATE ... SET status='error' WHERE status='generating'`;前端轮询封顶作为第二道防线。
4. **并发生成**:前端"最后一条 generating"时禁用输入;服务端 `hasGenerating` → `409`。前端收到 `409` 时**回滚刚才的乐观追加**(移除本地那对 user+assistant 占位)并提示。
5. **配额**:仍开头扣一次;"扣了却失败"的情况因断开也能生成完而大幅减少;**不改**退配额行为。
6. **加载失败**:`GET /messages` 出错 → 前端显示空对话 + "加载失败"提示,不静默吞成空数组。

## 7. 测试策略

沿用现有基座:服务端 `node:test` + tsx(如 `traceStore.test.ts`),前端 vitest + happy-dom。

**服务端 `chatStore.test.ts`**:seq 递增 + getMessages 排序;updateMessageContent 改状态写内容;setPinned/clearMessages;按 user_id 隔离;压缩替换顺序;**崩溃兜底**(插 generating → 启动迁移 → 变 error)。

**服务端路由测试**:stream 落库 user(done)+assistant(generating)→ 完成变 done 且内容等于拼接;**断开续跑**(模拟 reply socket 关闭,断言仍落库 done——核心特性必须守住);GET 顺序;PATCH pin;DELETE 清空;并发第二个 stream 返回 409。

**前端 `useChat.test.ts`**(替换现有 localStorage 用例):加载填充;**轮询恢复**(首拉 generating → 后续 GET done → 切换到显示完整答案并停轮询);轮询封顶标记中断;发送乐观追加;togglePin/clearMessages 调对应端点。现有 localStorage 持久化测试随 localStorage 逻辑一并删除。

**真实数据**:管理员账号手动验证(本地无 GitHub OAuth,鉴权后界面无法自动化,见 `docmind-oauth-blocks-local-verify` 记忆)。

## 8. 依赖与分支

- 无新依赖(better-sqlite3 已在用)。
- 建议分支 `feature/server-side-chat-persistence`,基于 master(当前 `fix/persist-chat-during-streaming` 的两个 localStorage 修复被本设计取代——localStorage 整体移除,那两个 PR 可关掉或让本特性覆盖)。
