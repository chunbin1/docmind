# 展示可折叠灰色思考内容（reasoning） — 设计文档

日期：2026-07-05

## 背景与问题

glm-4.7 是推理模型：流式响应里先输出 `delta.reasoning_content`（思考，实测 145~193 块、持续 20~30s），之后才输出 `delta.content`（答案）。当前 `streamZhipu` 只读 `delta.content`、丢弃 `reasoning_content`，因此思考阶段前端收到 0 字节、一片空白，看起来像"流式失效"。

## 目标

- 把模型思考内容（reasoning）展示给用户：**灰色字体、可折叠**。
- 思考阶段实时流式显示，消除 20~30s 空白。
- 思考内容**持久化**，刷新/重登后仍可展开查看。

## 非目标

- 不改 `streamChat` 的"yield 字符串"契约（compact/nudge/eval 依赖它）。
- 不把思考内容作为历史喂回 LLM（history 仍只用 content）。
- 不在 compact/nudge/eval 路径展示思考。

## 方案

### 服务端

**1. `llm.ts` — 通过回调 side-channel 传出 reasoning**

- `StreamChatOptions` 增加 `onReasoning?: (delta: string) => void`。
- `streamZhipu`：for-await 里，`delta.reasoning_content` 非空则调 `onReasoning(...)`；`content` 仍照常 `yield`。
- `streamAnthropic`：处理 `chunk.delta.type === 'thinking_delta'` → `onReasoning(...)`（当前未开 thinking，是 no-op，为完整性保留）。
- `streamChat(opts)` 已整体透传 opts，回调自动带下去。

**2. `chatStore.ts` — 加 `reasoning` 列**

- `initChatTables`：CREATE TABLE 后加 idempotent 迁移 `ALTER TABLE chat_messages ADD COLUMN reasoning TEXT`（try/catch 吞"已存在"）。
- `ChatMessageRow` 增加 `reasoning: string | null`。
- `updateMessageContent(id, content, status, reasoning?)`：新增可选 `reasoning`，提供时一并写入。

**3. `chatGeneration.ts` — 累积并持久化 reasoning**

- `StreamAndPersistOpts` 增加 `getReasoning?: () => string`。
- done / abort / error 三条持久化路径都把 `getReasoning?.()` 传给 `updateMessageContent`。

**4. `routes/chat.ts`**

- `SSEPayload` 增加 `{ reasoning: string }`。
- `/chat/stream` 里 `let reasoningOut = ''`；`onReasoning = (t) => { reasoningOut += t; trySend({ reasoning: t }) }` 传入 `streamChat`；`streamAndPersist` 传 `getReasoning: () => reasoningOut`。
- `rowToChatMessage` 带出 `reasoning`。

### 客户端

**5. `useChat.ts` + 类型**

- `ChatMessage` 增加 `reasoning?: string`。
- 乐观占位的 assistant 消息初始 `reasoning: ''`。
- SSE 解析新增分支：`json.reasoning` → `appendReasoningToLast(json.reasoning)`（与 `appendToLast` 对称，追加到末条消息的 reasoning）。

**6. `Message.tsx` — ReasoningBlock**

- 新增 `ReasoningBlock`（组件内，仿 `SummaryBar`）：标题「💭 思考过程」+ 折叠箭头，展开区为灰色 `white-space: pre-wrap` 文本。
- 渲染位置：assistant 气泡内、答案 markdown **之上**，仅当 `reasoning` 非空时显示。
- 折叠默认：`useState(isStreaming)` 初始展开态 = 是否在流式；配 `useEffect(() => { if (!isStreaming) setExpanded(false) }, [isStreaming])` —— 流式中展开（实时看思考），完成/历史消息默认折叠，用户可手动点开。
- `MessageProps` 增加 `reasoning?: string`；`ChatView` 传 `reasoning={msg.reasoning}`。

## 数据流

```
glm-4.7 流式 → streamZhipu：reasoning_content → onReasoning；content → yield
route：onReasoning → reasoningOut 累积 + SSE {reasoning}
       streamAndPersist：content 落库 + getReasoning() 落 reasoning 列
client：SSE {reasoning} → 追加到末条消息 reasoning → ReasoningBlock 实时灰字流
        SSE {text}      → 追加到 content → 答案 markdown
完成 → ReasoningBlock 自动折叠
刷新 → GET /chat/messages 带回 reasoning → 思考块仍可展开
```

## 改动清单

服务端：`types.ts`、`llm.ts`、`chatStore.ts`、`chatGeneration.ts`、`routes/chat.ts`
客户端：`types.ts`、`hooks/useChat.ts`、`components/Message.tsx`（+ `Message.module.css` 灰字样式）、`components/ChatView.tsx`

## 验证

- 提问 → 思考阶段灰字实时流出（不再 20~30s 空白）→ 答案开始后思考块自动折叠。
- 点击思考块可展开/收起。
- 刷新页面 → 该条思考仍可展开。
- `tsc --noEmit`（server + client）+ `vite build` 通过。
- llm 层 reasoning 回调用一次性脚本实测（reasoning_content 到达时触发 onReasoning）。

> 注：登录态 UI 端到端验证受沙箱 OAuth 限制，需真实登录环境手动确认；自动化以 tsc + build + llm 层脚本为准。
