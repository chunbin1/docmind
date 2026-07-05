# 输入框上方常驻文档标签行 — 设计文档

日期：2026-07-05

## 背景与问题

当前文档附件交互：输入框上方只显示**已选中**的文档 chip（带 × 移除），要选别的文档必须点 📎 打开 `DocumentPicker` 弹窗，在里面勾选。用户看不到"有哪些文档可选"，每次切换都要开弹窗，体验绕。

期望：上传后文档**常驻**显示在输入框上方，通过**高亮/非高亮**直接点选，不必开弹窗。

## 目标

- 输入框上方一行展示**全部已上传文档**，作为可切换标签（pill）。
- 高亮 = 已选中（本次消息会带上）；淡色 = 未选中。
- 点击标签切换选中状态；再点一下取消。
- 上传新文档后立刻以高亮态出现在标签行。

## 非目标

- 不改上传与删除入口：仍走 📎 + `DocumentPicker` 弹窗（删除是破坏性操作，留在弹窗避免误删）。
- 不改后端、不改 `useDocuments` hook（已具备所需状态与方法）。

## 方案

### 1. 改 `ChatInput` 的文档展示区（`ChatInput.tsx:45-59`）

把"只渲染 `attachedIds` 的 chip"改成"渲染全部 `documents` 的可切换标签"：

- 遍历 `documents`，每个渲染一个 `DocumentTag`。
- `selected = attachedIds.includes(doc.id)`。
- `onToggle`：`selected ? onDetach(doc.id) : onAttach(doc.id)`。
- 仅当 `documents.length > 0` 时渲染该行；容器 `flex-wrap` 自动换行。
- 标签上不再有 × —— 取消选中即再点一次。

`ChatInput` 已经拿到 `documents` / `attachedIds` / `onAttach` / `onDetach` 这些 props，无需新增入参。

### 2. 新增 `DocumentTag.tsx`（+ `DocumentTag.module.css`）

一个切换 pill：

```tsx
interface DocumentTagProps {
  filename: string
  selected: boolean
  onToggle: () => void
}
```

- 结构：📄 图标 + 文件名（过长截断，`title` 显示全名）。
- `type="button"`，整体可点击，`onClick={onToggle}`。
- 样式：`selected` → 高亮态（填充色背景 + 主题色边框/文字）；未选 → 淡色态（浅灰描边 + 次要文字色）。复用现有 CSS 变量，与 DocumentChip 的视觉体系一致。
- `aria-pressed={selected}` 表达切换语义。

### 3. 移除 `DocumentChip.tsx` + `DocumentChip.module.css`

仅 `ChatInput` 使用过它；被 `DocumentTag` 取代后成为死代码，删除。

### 4. 不动的部分

- 📎 按钮 + `DocumentPicker` 弹窗：继续负责上传 PDF 与删除文档。
- 弹窗内的勾选列表与标签行共用同一份 `attachedIds`，天然双向同步。
- `useDocuments`：`upload` 成功后本就 `setDocuments([新, ...]) + attach(id)`，新文档立即以高亮态出现在标签行，无需改动。

## 数据流

```
上传 PDF → useDocuments.upload
  → setDocuments([新文档, ...]) + attach(新id)
  → ChatInput 标签行渲染全部 documents，新文档 selected=true（高亮）
点击标签 → onToggle → attach/detach → attachedIds 变化 → 高亮态切换
发送消息 → sendMessage(msg, attachedIds)
```

## 改动清单

1. 新建 `packages/client/src/components/DocumentTag.tsx`
2. 新建 `packages/client/src/components/DocumentTag.module.css`
3. 改 `packages/client/src/components/ChatInput.tsx`：文档展示区改为遍历 `documents` 渲染 `DocumentTag`；移除 `DocumentChip` import
4. 删除 `packages/client/src/components/DocumentChip.tsx` 与 `DocumentChip.module.css`

## 验证

- 上传 PDF → 标签行出现该文档且为高亮态。
- 点击高亮标签 → 变淡色（取消选中）；再点 → 变回高亮。
- 📎 弹窗勾选/取消 → 外面标签高亮同步变化，反之亦然。
- 发送消息只带高亮（已选）文档。
- `pnpm exec tsc --noEmit`（client）通过。

> 注：聊天界面在登录态才挂载，本地 OAuth 登录在沙箱被挡，端到端点击验证需在真实登录环境手动确认；自动化以 `tsc` + 生产构建为准。
