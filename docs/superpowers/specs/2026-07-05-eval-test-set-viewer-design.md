# 测试集题目查看页 — 设计文档

日期：2026-07-05

## 背景与问题

RAG 评估功能（EvalPanel）里点「生成测试集」会用 LLM 为文档自动出一套问答题库，落库到 `eval_test_sets` / `eval_cases`。但前端 UI 只显示 `名称 (题目数)`（`EvalPanel.tsx`），**看不到具体生成了哪些题目**。目前想看内容只能查 SQLite 或手动调 API。

需要一个可视化界面，让管理员能查看某个测试集里所有 case 的完整内容。

## 目标

- 管理员可在界面上查看某个测试集的全部题目及其所有字段。
- 展示全部信息，不做筛选。
- 贴合现有 `/traces` / `/traces/:id` 管理员路由模式，改动最小。

## 非目标

- 不做题目的编辑 / 删除 / 增加（只读查看）。
- 不做难度筛选或分组。
- 不改后端（所需接口已存在）。

## 现有可复用资产

- 后端 `GET /api/eval/test-sets/:id` 已存在，已是 admin-only（`requireAdmin`），返回 `{ testSet, cases }`（`routes/eval.ts`）。
- `useEval().fetchTestSetDetail(id)` 已存在，返回 `{ testSet, cases }`（`hooks/useEval.ts`）。
- `/traces/:id` → `TraceDetailPage` 是现成的「管理员专属详情路由」范例，含加载中 / 不存在两个兜底态。
- 类型 `EvalTestSet` / `EvalCase` / `EvalDifficulty` 已定义（`client/src/types.ts`）。

## 方案

### 1. 路由（前端）

在 `App.tsx` 新增一条路由，门控方式与 `/traces/:id` 一致：

```tsx
<Route
  path="/eval/test-sets/:id"
  element={user.isAdmin ? <EvalTestSetDetailPage /> : <Navigate to="/" replace />}
/>
```

非管理员访问直接 `Navigate to="/"`。后端接口本身也已 admin 门控，双重保险。

### 2. 新组件 `EvalTestSetDetailPage.tsx`（+ `EvalTestSetDetailPage.module.css`）

- 用 `useParams<{ id: string }>()` 取 `id`。
- 用 `useEval().fetchTestSetDetail(id)` 拉数据（hook 无需改动）。
- 状态：`detail` / `notFound`，模式照抄 `TraceDetailPage`：
  - 未加载完 → 「加载中…」
  - 接口返回 null → 「测试集不存在」
- 顶部：`← 返回对话` 链接（`Link to="/"`）+ 测试集头信息：名称、题目数（`case_count`）、创建时间（`toLocaleString`）、`doc_id`。
- 列表：遍历 `cases`，每条展示**全部字段**：
  - 难度标签（easy / medium / hard，带颜色区分）
  - 问题 `question`
  - 期望答案 `expected_answer`
  - 来源分块 `ground_truth_chunk_id`
  - case `id`
- 样式新建 `.module.css`，视觉参考 `EvalRunDetail` 的 case 卡片风格（label + 内容行）。

### 3. 入口（EvalPanel）

在 `EvalPanel.tsx` 测试集列表项（现有 `名称 (数量)` + 「删」按钮那行）里，新增一个「查看」按钮：

```tsx
<button className={styles.btn} onClick={() => navigate(`/eval/test-sets/${ts.id}`)}>查看</button>
```

引入 `useNavigate`。「删」按钮保留原样。

## 数据流

```
EvalPanel「查看」按钮
  → navigate('/eval/test-sets/:id')
  → EvalTestSetDetailPage
  → useEval.fetchTestSetDetail(id)
  → GET /api/eval/test-sets/:id  (admin-only, 已存在)
  → 渲染 testSet 头信息 + 全部 cases
```

## 改动清单

1. 新建 `packages/client/src/components/EvalTestSetDetailPage.tsx`
2. 新建 `packages/client/src/components/EvalTestSetDetailPage.module.css`
3. `packages/client/src/App.tsx` — 加一条 route + import
4. `packages/client/src/components/EvalPanel.tsx` — 加「查看」按钮 + `useNavigate`

后端、`useEval` hook、类型定义均无需改动。

## 验证

- 管理员：EvalPanel 点「查看」→ 进入详情页，能看到测试集头信息和全部题目字段。
- 非管理员：直接访问 `/eval/test-sets/:id` → 被重定向回 `/`。
- 不存在的 id → 显示「测试集不存在」。
- `pnpm exec tsc --noEmit`（client）通过。
