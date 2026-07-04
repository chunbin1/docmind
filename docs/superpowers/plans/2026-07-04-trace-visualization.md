# Trace 可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已有的管理员 trace 接口构建前端可视化 —— `/traces` 列表页 + `/traces/:id` span 瀑布详情页。

**Architecture:** 引入 `react-router-dom` 做客户端路由;`App.tsx` 退化为「鉴权 + 路由」外壳,现有聊天 UI 抽取到 `ChatView`;新增 `useTraces` 数据 hook、`buildWaterfall` 纯函数(可单测)、以及列表/详情/瀑布三个展示组件。后端零改动(三个接口已就绪)。

**Tech Stack:** React 19 + Vite + TypeScript + CSS Modules + react-router-dom v7;纯函数用 `node:test`(经 `tsx --test`)单测。

**参考 spec:** `docs/superpowers/specs/2026-07-04-trace-visualization-design.md`

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/client/package.json` | 修改 | 加 `react-router-dom` 依赖、`tsx` devDep、`test` 脚本 |
| `packages/client/src/types.ts` | 修改 | 追加 `TraceStatus` / `TraceRecord` / `SpanRecord` / `WaterfallRow` |
| `packages/client/src/lib/waterfall.ts` | 新建 | 纯函数 `buildWaterfall` |
| `packages/client/src/lib/waterfall.test.ts` | 新建 | `buildWaterfall` 单测 |
| `packages/client/src/hooks/useTraces.ts` | 新建 | 数据层:`fetchList` / `fetchDetail` |
| `packages/client/src/components/SpanWaterfall.tsx` + `.module.css` | 新建 | span 瀑布图 + 点击展开详情 |
| `packages/client/src/components/TraceList.tsx` + `.module.css` | 新建 | trace 列表表格 |
| `packages/client/src/components/TracesPage.tsx` + `.module.css` | 新建 | 列表页容器(过滤/刷新) |
| `packages/client/src/components/TraceDetailPage.tsx` + `.module.css` | 新建 | 详情页容器(摘要 + 瀑布) |
| `packages/client/src/components/ChatView.tsx` | 新建 | 从 `App.tsx` 抽取的聊天界面 + Traces 入口 |
| `packages/client/src/App.tsx` | 重写 | 鉴权 + `<Routes>` |
| `packages/client/src/main.tsx` | 修改 | 外层包 `<BrowserRouter>` |
| `packages/client/src/App.module.css` | 修改 | 追加 `.tracesLink` 样式 |

---

## Task 1: 安装依赖 + 追加 trace 类型

**Files:**
- Modify: `packages/client/package.json`
- Modify: `packages/client/src/types.ts`

- [ ] **Step 1: 安装 react-router-dom + tsx + @types/node**

Run(在仓库根目录):
```bash
pnpm --filter @docmind/client add react-router-dom
pnpm --filter @docmind/client add -D tsx @types/node
```
Expected: `package.json` 的 `dependencies` 出现 `react-router-dom`,`devDependencies` 出现 `tsx` 与 `@types/node`。

> `@types/node` 是必需的:client tsconfig `include: ["src"]` 会连带类型检查 `waterfall.test.ts`,而它 `import 'node:test'` / `'node:assert/strict'`,缺少 Node 类型会导致 `tsc --noEmit` 报「Cannot find module 'node:test'」。

- [ ] **Step 2: 为 client 加 test 脚本**

编辑 `packages/client/package.json`,在 `"scripts"` 中加入(与 `build` 同级):
```json
"test": "tsx --test src/lib/waterfall.test.ts"
```

- [ ] **Step 3: 追加 trace 类型**

在 `packages/client/src/types.ts` 末尾追加:
```ts
// === Trace 可视化类型（对齐 server 端 tracing.ts）===

export type TraceStatus = 'ok' | 'degraded' | 'error'

/** GET /api/traces 列表项 / GET /api/traces/:id 的 trace 字段 */
export interface TraceRecord {
  id: string
  route: string
  user_id: string | null
  status: TraceStatus
  duration_ms: number
  span_count: number
  degraded_count: number
  error_count: number
  started_at: string
  created_at: string
}

/** GET /api/traces/:id 返回的单个 span */
export interface SpanRecord {
  id: string
  trace_id: string
  parent_span_id: string | null
  name: string
  status: TraceStatus
  start_offset_ms: number
  duration_ms: number
  degraded_reason: string | null
  input: string | null
  output: string | null
  /** JSON 字符串 */
  metadata: string
  error_message: string | null
}

/** buildWaterfall 的输出行 */
export interface WaterfallRow {
  span: SpanRecord
  depth: number
  leftPct: number
  widthPct: number
}
```

- [ ] **Step 4: 类型检查**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: PASS(无报错)。

- [ ] **Step 5: 提交**

```bash
git add packages/client/package.json packages/client/src/types.ts pnpm-lock.yaml
git commit -m "feat(traces): 引入 react-router-dom + trace 前端类型"
```

---

## Task 2: `buildWaterfall` 纯函数(TDD)

**Files:**
- Create: `packages/client/src/lib/waterfall.ts`
- Test: `packages/client/src/lib/waterfall.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/client/src/lib/waterfall.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWaterfall } from './waterfall.ts'
import type { SpanRecord } from '../types.ts'

function span(p: Partial<SpanRecord>): SpanRecord {
  return {
    id: 'sp', trace_id: 'tr', parent_span_id: null, name: 'x',
    status: 'ok', start_offset_ms: 0, duration_ms: 0,
    degraded_reason: null, input: null, output: null,
    metadata: '{}', error_message: null,
    ...p,
  }
}

test('单个根 span：depth=0，按 total 计算百分比', () => {
  const rows = buildWaterfall([span({ id: 'a', start_offset_ms: 0, duration_ms: 50 })], 100)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].depth, 0)
  assert.equal(rows[0].leftPct, 0)
  assert.equal(rows[0].widthPct, 50)
})

test('子 span：depth 随 parent 链递增', () => {
  const spans = [
    span({ id: 'a', start_offset_ms: 0, duration_ms: 100 }),
    span({ id: 'b', parent_span_id: 'a', start_offset_ms: 10, duration_ms: 20 }),
    span({ id: 'c', parent_span_id: 'b', start_offset_ms: 12, duration_ms: 5 }),
  ]
  const rows = buildWaterfall(spans, 100)
  assert.equal(rows[1].depth, 1)
  assert.equal(rows[1].leftPct, 10)
  assert.equal(rows[1].widthPct, 20)
  assert.equal(rows[2].depth, 2)
})

test('totalMs<=0 时回退到 max(offset+duration)', () => {
  const spans = [
    span({ id: 'a', start_offset_ms: 0, duration_ms: 40 }),
    span({ id: 'b', start_offset_ms: 60, duration_ms: 40 }), // 末端 100
  ]
  const rows = buildWaterfall(spans, 0)
  assert.equal(rows[1].leftPct, 60)
  assert.equal(rows[1].widthPct, 40)
})

test('duration_ms=0 给最小可见宽度', () => {
  const rows = buildWaterfall([span({ id: 'a', start_offset_ms: 10, duration_ms: 0 })], 100)
  assert.equal(rows[0].widthPct, 0.5)
})

test('空数组返回空数组', () => {
  assert.deepEqual(buildWaterfall([], 100), [])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd packages/client && pnpm exec tsx --test src/lib/waterfall.test.ts
```
Expected: FAIL —— 报错找不到模块 `./waterfall.ts` 或 `buildWaterfall` 未定义。

- [ ] **Step 3: 实现最小代码**

创建 `packages/client/src/lib/waterfall.ts`:
```ts
import type { SpanRecord, WaterfallRow } from '../types'

/** span 条最小可见宽度（百分比），避免 0 时长 span 不可见。 */
const MIN_WIDTH_PCT = 0.5

/**
 * 把 span 列表转成瀑布图行：计算每个 span 的树深度与水平定位。
 * spans 由接口按 start_offset_ms 升序返回；totalMs 通常取 trace.duration_ms。
 */
export function buildWaterfall(spans: SpanRecord[], totalMs: number): WaterfallRow[] {
  const byId = new Map<string, SpanRecord>()
  for (const s of spans) byId.set(s.id, s)

  // 有效总时长：给定 totalMs，否则回退到 max(offset+duration)
  let total = totalMs
  if (!total || total <= 0) {
    total = 0
    for (const s of spans) total = Math.max(total, s.start_offset_ms + s.duration_ms)
  }

  const depthOf = (s: SpanRecord): number => {
    let depth = 0
    let cur = s.parent_span_id
    const seen = new Set<string>()
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      depth++
      cur = byId.get(cur)!.parent_span_id
    }
    return depth
  }

  return spans.map(span => {
    const leftPct = total > 0 ? (span.start_offset_ms / total) * 100 : 0
    const rawWidth = total > 0 ? (span.duration_ms / total) * 100 : 0
    return { span, depth: depthOf(span), leftPct, widthPct: Math.max(rawWidth, MIN_WIDTH_PCT) }
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
cd packages/client && pnpm exec tsx --test src/lib/waterfall.test.ts
```
Expected: PASS(5 个测试全过)。

- [ ] **Step 5: 提交**

```bash
git add packages/client/src/lib/waterfall.ts packages/client/src/lib/waterfall.test.ts
git commit -m "feat(traces): buildWaterfall 纯函数 + 单测"
```

---

## Task 3: `useTraces` 数据 hook

**Files:**
- Create: `packages/client/src/hooks/useTraces.ts`

- [ ] **Step 1: 创建 hook**

创建 `packages/client/src/hooks/useTraces.ts`:
```ts
import { useCallback, useState } from 'react'
import type { TraceRecord, SpanRecord } from '../types'

const API = '/api'

export interface TraceDetail {
  trace: TraceRecord
  spans: SpanRecord[]
}

export interface UseTracesReturn {
  traces: TraceRecord[]
  loading: boolean
  error: string | null
  fetchList: (filter?: { status?: string; limit?: number }) => Promise<void>
  fetchDetail: (id: string) => Promise<TraceDetail | null>
}

export function useTraces(): UseTracesReturn {
  const [traces, setTraces] = useState<TraceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchList = useCallback(async (filter?: { status?: string; limit?: number }) => {
    setLoading(true); setError(null)
    try {
      const qs = new URLSearchParams()
      if (filter?.status) qs.set('status', filter.status)
      if (filter?.limit) qs.set('limit', String(filter.limit))
      const res = await fetch(`${API}/traces?${qs.toString()}`)
      if (!res.ok) { setError(`加载失败 (${res.status})`); setTraces([]); return }
      const data = await res.json() as { traces: TraceRecord[] }
      setTraces(data.traces ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchDetail = useCallback(async (id: string): Promise<TraceDetail | null> => {
    const res = await fetch(`${API}/traces/${id}`)
    if (!res.ok) return null
    return res.json() as Promise<TraceDetail>
  }, [])

  return { traces, loading, error, fetchList, fetchDetail }
}
```

- [ ] **Step 2: 类型检查**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/client/src/hooks/useTraces.ts
git commit -m "feat(traces): useTraces 数据 hook"
```

---

## Task 4: `SpanWaterfall` 组件

**Files:**
- Create: `packages/client/src/components/SpanWaterfall.tsx`
- Create: `packages/client/src/components/SpanWaterfall.module.css`

- [ ] **Step 1: 创建组件**

创建 `packages/client/src/components/SpanWaterfall.tsx`:
```tsx
import { useState } from 'react'
import type { SpanRecord, TraceStatus } from '../types'
import { buildWaterfall } from '../lib/waterfall'
import styles from './SpanWaterfall.module.css'

interface Props {
  spans: SpanRecord[]
  totalMs: number
}

const barClass: Record<TraceStatus, string> = {
  ok: styles.barOk,
  degraded: styles.barDegraded,
  error: styles.barError,
}

function fmtMeta(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function SpanWaterfall({ spans, totalMs }: Props) {
  const rows = buildWaterfall(spans, totalMs)
  const [selected, setSelected] = useState<string | null>(null)

  if (rows.length === 0) {
    return <div className={styles.empty}>该 trace 没有 span</div>
  }

  return (
    <div className={styles.container}>
      {rows.map(({ span, depth, leftPct, widthPct }) => (
        <div key={span.id}>
          <div
            className={styles.row}
            onClick={() => setSelected(selected === span.id ? null : span.id)}
          >
            <div className={styles.label} style={{ paddingLeft: depth * 16 + 8 }}>
              <span className={styles.name}>{span.name}</span>
              {span.status !== 'ok' && (
                <span className={styles.tag}>{span.status === 'error' ? '错误' : '降级'}</span>
              )}
            </div>
            <div className={styles.track}>
              <div
                className={`${styles.bar} ${barClass[span.status]}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                title={`${span.duration_ms}ms`}
              />
            </div>
            <div className={styles.dur}>{span.duration_ms}ms</div>
          </div>

          {selected === span.id && (
            <div className={styles.detail}>
              {span.degraded_reason && (
                <div className={styles.detailRow}><b>降级原因：</b>{span.degraded_reason}</div>
              )}
              {span.error_message && (
                <div className={styles.detailRow}><b>错误：</b>{span.error_message}</div>
              )}
              <div className={styles.detailRow}>
                <b>输入：</b>{span.input ?? <i className={styles.muted}>内容未记录</i>}
              </div>
              <div className={styles.detailRow}>
                <b>输出：</b>{span.output ?? <i className={styles.muted}>内容未记录</i>}
              </div>
              <div className={styles.detailRow}>
                <b>metadata：</b>
                <pre className={styles.pre}>{fmtMeta(span.metadata)}</pre>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: 创建样式**

创建 `packages/client/src/components/SpanWaterfall.module.css`:
```css
.container {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 16px;
}

.empty {
  padding: 24px;
  color: var(--gray-400);
  text-align: center;
}

.row {
  display: grid;
  grid-template-columns: 220px 1fr 72px;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
  border-radius: var(--radius-sm);
}

.row:hover {
  background: var(--gray-50);
}

.label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--gray-900);
  overflow: hidden;
}

.name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--gray-100);
  color: var(--gray-600);
}

.track {
  position: relative;
  height: 16px;
  background: var(--gray-100);
  border-radius: var(--radius-sm);
}

.bar {
  position: absolute;
  top: 0;
  height: 16px;
  min-width: 2px;
  border-radius: var(--radius-sm);
}

.barOk { background: #16a34a; }
.barDegraded { background: #d97706; }
.barError { background: #dc2626; }

.dur {
  font-size: 11px;
  color: var(--gray-400);
  text-align: right;
}

.detail {
  margin: 4px 0 8px 8px;
  padding: 10px 12px;
  background: var(--gray-50);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--gray-900);
}

.detailRow {
  margin-bottom: 6px;
  word-break: break-word;
}

.muted { color: var(--gray-400); }

.pre {
  margin: 4px 0 0;
  padding: 8px;
  background: var(--gray-900);
  color: #f9fafb;
  border-radius: var(--radius-sm);
  font-size: 11px;
  overflow-x: auto;
  white-space: pre-wrap;
}
```

- [ ] **Step 3: 类型检查**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/SpanWaterfall.tsx packages/client/src/components/SpanWaterfall.module.css
git commit -m "feat(traces): SpanWaterfall 瀑布图组件"
```

---

## Task 5: `TraceList` 组件

**Files:**
- Create: `packages/client/src/components/TraceList.tsx`
- Create: `packages/client/src/components/TraceList.module.css`

- [ ] **Step 1: 创建组件**

创建 `packages/client/src/components/TraceList.tsx`:
```tsx
import type { TraceRecord, TraceStatus } from '../types'
import styles from './TraceList.module.css'

interface Props {
  traces: TraceRecord[]
  onSelect: (id: string) => void
}

const statusLabel: Record<TraceStatus, string> = {
  ok: '正常',
  degraded: '降级',
  error: '错误',
}

const badgeClass: Record<TraceStatus, string> = {
  ok: styles.badgeOk,
  degraded: styles.badgeDegraded,
  error: styles.badgeError,
}

export function TraceList({ traces, onSelect }: Props) {
  if (traces.length === 0) {
    return <div className={styles.empty}>暂无 trace 记录</div>
  }
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>状态</th><th>路由</th><th>耗时</th><th>span</th><th>降级/错误</th><th>时间</th>
        </tr>
      </thead>
      <tbody>
        {traces.map(t => (
          <tr key={t.id} className={styles.row} onClick={() => onSelect(t.id)}>
            <td><span className={`${styles.badge} ${badgeClass[t.status]}`}>{statusLabel[t.status]}</span></td>
            <td className={styles.route}>{t.route}</td>
            <td>{t.duration_ms}ms</td>
            <td>{t.span_count}</td>
            <td>{t.degraded_count}/{t.error_count}</td>
            <td className={styles.time}>{new Date(t.started_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 2: 创建样式**

创建 `packages/client/src/components/TraceList.module.css`:
```css
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th {
  text-align: left;
  padding: 8px 12px;
  color: var(--gray-600);
  border-bottom: 1px solid var(--gray-200);
  font-weight: 600;
}

.row {
  cursor: pointer;
  border-bottom: 1px solid var(--gray-100);
}

.row:hover {
  background: var(--gray-50);
}

.row td {
  padding: 8px 12px;
  color: var(--gray-900);
}

.route {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

.time {
  color: var(--gray-400);
  white-space: nowrap;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
}

.badgeOk { background: #dcfce7; color: #16a34a; }
.badgeDegraded { background: #fef3c7; color: #d97706; }
.badgeError { background: #fee2e2; color: #dc2626; }

.empty {
  padding: 48px;
  text-align: center;
  color: var(--gray-400);
}
```

- [ ] **Step 3: 类型检查**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/TraceList.tsx packages/client/src/components/TraceList.module.css
git commit -m "feat(traces): TraceList 列表组件"
```

---

## Task 6: `TracesPage` 列表页

**Files:**
- Create: `packages/client/src/components/TracesPage.tsx`
- Create: `packages/client/src/components/TracesPage.module.css`

- [ ] **Step 1: 创建页面**

创建 `packages/client/src/components/TracesPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTraces } from '../hooks/useTraces'
import { TraceList } from './TraceList'
import styles from './TracesPage.module.css'

export function TracesPage() {
  const { traces, loading, error, fetchList } = useTraces()
  const [status, setStatus] = useState('')
  const navigate = useNavigate()

  const load = (): void => { void fetchList({ status: status || undefined, limit: 100 }) }

  useEffect(load, [status])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.back}>← 返回对话</Link>
        <h1 className={styles.title}>🔍 Traces</h1>
        <div className={styles.controls}>
          <select
            className={styles.select}
            value={status}
            onChange={e => setStatus(e.target.value)}
          >
            <option value="">全部状态</option>
            <option value="ok">正常</option>
            <option value="degraded">降级</option>
            <option value="error">错误</option>
          </select>
          <button className={styles.btn} onClick={load}>刷新</button>
        </div>
      </header>

      {error && (
        <div className={styles.error}>
          {error}
          <button className={styles.retry} onClick={load}>重试</button>
        </div>
      )}

      {loading
        ? <div className={styles.loading}>加载中…</div>
        : <TraceList traces={traces} onSelect={id => navigate(`/traces/${id}`)} />}
    </div>
  )
}
```

- [ ] **Step 2: 创建样式**

创建 `packages/client/src/components/TracesPage.module.css`:
```css
.page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
}

.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.back {
  color: var(--purple);
  text-decoration: none;
  font-size: 13px;
}

.back:hover { text-decoration: underline; }

.title {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
  color: var(--gray-900);
}

.controls {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.select, .btn {
  padding: 6px 10px;
  border: 1px solid var(--gray-200);
  border-radius: var(--radius-sm);
  font-size: 13px;
  background: white;
  cursor: pointer;
}

.btn:hover { background: var(--gray-50); }

.error {
  padding: 12px 16px;
  background: #fee2e2;
  color: #dc2626;
  border-radius: var(--radius-sm);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.retry {
  padding: 4px 10px;
  border: 1px solid #dc2626;
  border-radius: var(--radius-sm);
  background: white;
  color: #dc2626;
  cursor: pointer;
}

.loading {
  padding: 48px;
  text-align: center;
  color: var(--gray-400);
}
```

- [ ] **Step 3: 类型检查**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/TracesPage.tsx packages/client/src/components/TracesPage.module.css
git commit -m "feat(traces): TracesPage 列表页"
```

---

## Task 7: `TraceDetailPage` 详情页

**Files:**
- Create: `packages/client/src/components/TraceDetailPage.tsx`
- Create: `packages/client/src/components/TraceDetailPage.module.css`

- [ ] **Step 1: 创建页面**

创建 `packages/client/src/components/TraceDetailPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTraces, type TraceDetail } from '../hooks/useTraces'
import { SpanWaterfall } from './SpanWaterfall'
import styles from './TraceDetailPage.module.css'

export function TraceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { fetchDetail } = useTraces()
  const [detail, setDetail] = useState<TraceDetail | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!id) return
    void fetchDetail(id).then(d => {
      if (d) setDetail(d)
      else setNotFound(true)
    })
  }, [id, fetchDetail])

  if (notFound) {
    return (
      <div className={styles.page}>
        <Link to="/traces" className={styles.back}>← 返回列表</Link>
        <div className={styles.empty}>trace 不存在</div>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={styles.page}>
        <Link to="/traces" className={styles.back}>← 返回列表</Link>
        <div className={styles.loading}>加载中…</div>
      </div>
    )
  }

  const { trace, spans } = detail
  return (
    <div className={styles.page}>
      <Link to="/traces" className={styles.back}>← 返回列表</Link>
      <div className={styles.summary}>
        <h1 className={styles.title}>{trace.route}</h1>
        <div className={styles.meta}>
          <span>状态：{trace.status}</span>
          <span>总耗时：{trace.duration_ms}ms</span>
          <span>span：{trace.span_count}</span>
          <span>降级/错误：{trace.degraded_count}/{trace.error_count}</span>
          <span>{new Date(trace.started_at).toLocaleString()}</span>
        </div>
      </div>
      <SpanWaterfall spans={spans} totalMs={trace.duration_ms} />
    </div>
  )
}
```

- [ ] **Step 2: 创建样式**

创建 `packages/client/src/components/TraceDetailPage.module.css`:
```css
.page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
}

.back {
  color: var(--purple);
  text-decoration: none;
  font-size: 13px;
}

.back:hover { text-decoration: underline; }

.summary {
  margin-top: 12px;
}

.title {
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 8px;
  color: var(--gray-900);
  font-family: ui-monospace, monospace;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
  color: var(--gray-600);
}

.loading, .empty {
  padding: 48px;
  text-align: center;
  color: var(--gray-400);
}
```

- [ ] **Step 3: 类型检查**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/TraceDetailPage.tsx packages/client/src/components/TraceDetailPage.module.css
git commit -m "feat(traces): TraceDetailPage 详情页"
```

---

## Task 8: 路由接线(main.tsx + App.tsx + ChatView 抽取)

**Files:**
- Modify: `packages/client/src/main.tsx`
- Create: `packages/client/src/components/ChatView.tsx`
- Modify: `packages/client/src/App.tsx`
- Modify: `packages/client/src/App.module.css`

- [ ] **Step 1: main.tsx 包 BrowserRouter**

把 `packages/client/src/main.tsx` 整体替换为:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found in DOM')

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
```

- [ ] **Step 2: 抽取 ChatView**

创建 `packages/client/src/components/ChatView.tsx`(内容是原 `App.tsx` 中「已登录」时渲染的布局,改为接收 `user` / `onLogout`,并新增管理员的 Traces 入口):
```tsx
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { AuthUser } from '../hooks/useAuth'
import { useChat } from '../hooks/useChat'
import { useDocuments } from '../hooks/useDocuments'
import { Message } from './Message'
import { ChatInput } from './ChatInput'
import { MemoryPanel } from './MemoryPanel'
import { EvalPanel } from './EvalPanel'
import styles from '../App.module.css'

interface Props {
  user: AuthUser
  onLogout: () => void
}

export function ChatView({ user, onLogout }: Props) {
  const {
    messages, streaming, compacting,
    sendMessage, stopStreaming, clearMessages, togglePin,
  } = useChat(user.id)
  const docs = useDocuments()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const limitReached = !user.unlimited && (user.remaining ?? 0) <= 0

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>D</span>
          <span className={styles.logoText}>DocMind</span>
        </div>

        <MemoryPanel />

        {user.isAdmin && <EvalPanel documents={docs.documents} />}
        {user.isAdmin && (
          <Link to="/traces" className={styles.tracesLink}>🔍 Traces</Link>
        )}

        <div className={styles.sideBottom}>
          <button className={styles.clearBtn} onClick={clearMessages}>
            清空对话
          </button>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>智能文档问答</h1>
            <p className={styles.subtitle}>
              {messages.length === 0
                ? '上传文档后即可基于文档内容提问'
                : `${messages.filter(m => m.role === 'user').length} 条对话`}
            </p>
          </div>
          <div className={styles.userBox}>
            <span className={styles.quota} title="剩余可发送消息数">
              {user.unlimited ? '∞ 无限' : `剩余 ${user.remaining ?? 0}/${user.limit}`}
            </span>
            {user.avatarUrl && (
              <img className={styles.avatar} src={user.avatarUrl} alt={user.username} />
            )}
            <span className={styles.userName}>{user.username}</span>
            <button className={styles.logoutBtn} onClick={onLogout}>
              退出
            </button>
          </div>
        </header>

        <div className={styles.messages}>
          {messages.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>💬</div>
              <p className={styles.emptyTitle}>开始你的第一个问题</p>
              <p className={styles.emptyDesc}>
                现在可以直接和 AI 对话，上传文档后将基于文档内容回答
              </p>
              <div className={styles.suggestions}>
                {['你好，你能做什么？', '什么是 RAG？', '解释一下 Embedding'].map(s => (
                  <button
                    key={s}
                    className={styles.suggestion}
                    onClick={() => void sendMessage(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <Message
                key={i}
                index={i}
                role={msg.role}
                content={msg.content}
                isError={msg.isError}
                pinned={msg.pinned}
                compactedCount={msg.compactedCount}
                isStreaming={
                  streaming && i === messages.length - 1 && msg.role === 'assistant'
                }
                onTogglePin={togglePin}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {compacting && (
          <div className={styles.compactingBar}>⚡ 正在压缩历史对话...</div>
        )}
        {limitReached && (
          <div className={styles.limitBar}>
            已达每位用户 {user.limit} 条消息上限，如需继续请联系管理员开通无限调用。
          </div>
        )}
        <ChatInput
          onSend={(msg, docIds) => void sendMessage(msg, undefined, docIds)}
          onStop={stopStreaming}
          streaming={streaming || compacting}
          disabled={limitReached}
          documents={docs.documents}
          attachedIds={docs.attachedIds}
          uploading={docs.uploading}
          uploadError={docs.uploadError}
          onAttach={docs.attach}
          onDetach={docs.detach}
          onUpload={docs.upload}
          onRemoveDoc={docs.remove}
        />
      </main>
    </div>
  )
}
```

- [ ] **Step 3: App.tsx 改为鉴权 + 路由**

把 `packages/client/src/App.tsx` 整体替换为:
```tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { LoginGate } from './components/LoginGate'
import { ChatView } from './components/ChatView'
import { TracesPage } from './components/TracesPage'
import { TraceDetailPage } from './components/TraceDetailPage'
import styles from './App.module.css'

export default function App() {
  const auth = useAuth()

  if (auth.loading) {
    return <div className={styles.authLoading}>加载中…</div>
  }
  if (!auth.user) {
    return <LoginGate onLogin={auth.login} />
  }

  const { user } = auth
  return (
    <Routes>
      <Route path="/" element={<ChatView user={user} onLogout={() => void auth.logout()} />} />
      <Route
        path="/traces"
        element={user.isAdmin ? <TracesPage /> : <Navigate to="/" replace />}
      />
      <Route
        path="/traces/:id"
        element={user.isAdmin ? <TraceDetailPage /> : <Navigate to="/" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 4: 追加 Traces 入口样式**

在 `packages/client/src/App.module.css` 末尾追加:
```css
.tracesLink {
  display: block;
  margin: 8px 12px 0;
  padding: 8px 10px;
  border: 1px solid var(--gray-200);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--gray-900);
  text-decoration: none;
  text-align: center;
}

.tracesLink:hover {
  background: var(--gray-50);
}
```

- [ ] **Step 5: 类型检查**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/client/src/main.tsx packages/client/src/App.tsx packages/client/src/components/ChatView.tsx packages/client/src/App.module.css
git commit -m "feat(traces): 路由接线 + 抽取 ChatView + Traces 入口"
```

---

## Task 9: 集成验证(preview)

**Files:** 无(仅验证)

前置:后端需运行且 SQLite 中有 trace 数据。用管理员账号登录(见 `docmind-deploy-topology` 记忆里的 is_admin 开权限方式)。若本地无 trace 数据,先在聊天页发一两条消息以产生 trace。

- [ ] **Step 1: 启动 dev server 并打开列表页**

用 preview 工具启动 client(`pnpm run dev:client`,需后端 `pnpm run dev:server` 同时运行),访问 `http://localhost:5173/traces`。
Expected:显示「🔍 Traces」标题、状态过滤下拉、trace 表格(或空态)。检查控制台无报错。

- [ ] **Step 2: 验证过滤与刷新**

在状态下拉选「降级」,列表应只剩降级 trace;点「刷新」重新拉取。
Expected:列表按状态过滤,网络面板显示 `GET /api/traces?status=degraded&limit=100`。

- [ ] **Step 3: 验证详情跳转与瀑布图**

点某一行 → 跳到 `/traces/:id`。
Expected:显示 trace 摘要头 + span 瀑布图,条形按状态着色(绿/橙/红),缩进反映父子层级。点某个 span,展开输入/输出/metadata/降级原因。

- [ ] **Step 4: 验证权限重定向**

用非管理员账号(或临时改库去掉 is_admin)访问 `/traces`。
Expected:前端重定向回 `/`;直接调 `GET /api/traces` 返回 403。

- [ ] **Step 5: 最终确认无遗留问题**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit && pnpm test
```
Expected:类型检查 PASS,`buildWaterfall` 单测 PASS。

---

## 完成标准

- `/traces` 列表页可按状态过滤、刷新,展示最近 trace
- 点击行进入 `/traces/:id`,span 瀑布图正确渲染层级、时间线、配色,可展开 span 详情
- 非管理员被前端重定向、后端 403
- `buildWaterfall` 单测通过,全项目 `tsc --noEmit` 通过
- 现有聊天功能(抽取到 `ChatView` 后)行为不变
