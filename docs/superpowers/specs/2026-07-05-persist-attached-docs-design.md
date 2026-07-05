# localStorage 持久化选中文档 — 设计文档

日期：2026-07-05

## 背景与问题

刚做的"输入框上方文档标签行"里，选中态（`attachedIds`）只存在内存里，刷新页面就丢失，得重新点选。希望把选中态持久化到 localStorage，刷新后自动恢复。

## 目标

- `attachedIds` 持久化到 localStorage，**按用户隔离**。
- 刷新 / 重新登录后，自动恢复上次的选中文档。
- 已被删除的文档不残留在选中集里。

## 非目标

- 不持久化文档列表本身（仍从服务端拉）。
- 不改聊天历史的服务端持久化策略。选中态是纯前端临时 UI 状态，用 localStorage 恰当，不违背 CLAUDE.md 里"聊天历史服务端为准"的原则。

## 方案

改动集中在 `hooks/useDocuments.ts`，外加 `ChatView.tsx` 传入 `userId`。

### 1. `useDocuments(userId: string | null)`

新增入参。ChatView 改为 `useDocuments(user.id)`。

存储 key：`docmind:attachedDocs:<userId>`。`userId` 为 null（登出）时不读不写。

### 2. 写入：只在显式操作时持久化（避免跨账号误写）

不使用"attachedIds 变化就写"的响应式 effect —— 那样在切换 userId 的那一帧会把上一个账号的选中集写进新账号的 key。改为集中一个 `applyAttached(next)`：更新 state + 同步一个 `attachedIdsRef` + 写 localStorage（有 userId 时）。`attach` / `detach` / `remove` / 上传后的 attach / 清理，全部走 `applyAttached`。

### 3. 读取：userId 变化时从 localStorage 恢复

一个 effect（dep `[userId]`）：读 `key(userId)`，解析成 string[]，`setAttachedIds` + 同步 ref。**只读不写**，不触发持久化。解析失败兜底为空数组。

### 4. 清理失效 id：必须等文档加载完成后

新增 `documentsLoaded` 标志，文档 fetch 的 `.finally` 里置 true。

清理 effect（dep `[documents, documentsLoaded]`）：**仅当 `documentsLoaded` 为 true** 时，把 `attachedIdsRef` 里已不在 `documents` 中的 id 剔除；有变化则 `applyAttached(pruned)`（同时回写 localStorage）。

> 关键：文档列表初始为 `[]`，fetch 未完成前若拿它去清理，会把刚恢复的选中项全部误删。`documentsLoaded` 门控避免这一点。

### 5. 组件生命周期

登出会卸载 ChatView → useDocuments 卸载；重新登录重新挂载并按新 userId 走一遍读取，因此不存在跨账号的内存残留。

## 数据流

```
挂载 → 读 key(userId) 恢复 attachedIds（内存 + ref）
文档 fetch 完成 → documentsLoaded=true → 清理失效 id → 回写
点标签 / 弹窗勾选 / 上传 / 删除 → applyAttached(next) → setState + ref + 写 localStorage
刷新 → 重新读 key → 恢复
```

## 改动清单

1. 改 `packages/client/src/hooks/useDocuments.ts`：加 `userId` 入参、`attachedIdsRef`、`applyAttached`、读取 effect、`documentsLoaded` + 清理 effect；`attach`/`detach`/`remove`/`upload` 走 `applyAttached`。
2. 改 `packages/client/src/components/ChatView.tsx`：`useDocuments(user.id)`。

## 验证

- 选中若干文档 → 刷新 → 选中态恢复。
- 删除某文档 → 它从选中集消失、localStorage 同步更新。
- 换账号（登出再登录）→ 各自恢复各自的选中集，不串。
- `pnpm exec tsc --noEmit` + `vite build` 通过。

> 注：聊天界面登录态才挂载，沙箱 OAuth 被挡，端到端刷新验证需真实登录环境手动确认；自动化以 tsc + 构建为准。
