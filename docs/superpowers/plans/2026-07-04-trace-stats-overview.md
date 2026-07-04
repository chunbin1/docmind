# Trace 概览统计可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/traces` 列表页顶部加一个概览区,把后端 `GET /api/traces/stats` 的总数 / 降级率 / 降级原因分布可视化。

**Architecture:** 一个纯函数 `statBars`(把 `byReason` 转成降序、最大值归一化的条数据,可单测)+ `useTraces` 增补 `stats`/`fetchStats` + 新增 `TraceStats` 展示组件 + `TracesPage` 顶部渲染并让刷新联动。纯前端,无后端改动,无新依赖。

**Tech Stack:** React 19 + Vite + TS + CSS Modules;纯函数用 `node:test`(经 `tsx --test`)单测。

**参考 spec:** `docs/superpowers/specs/2026-07-04-trace-stats-overview-design.md`

**分支:** `feature/trace-stats`(栈式基于 `feature/trace-visualization`)。已在此分支,直接提交。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/client/src/lib/statBars.ts` | 新建 | 纯函数 `statBars(byReason)` |
| `packages/client/src/lib/statBars.test.ts` | 新建 | `statBars` 单测 |
| `packages/client/src/hooks/useTraces.ts` | 修改 | 加 `TraceStats` 类型、`stats` 状态、`fetchStats()` |
| `packages/client/src/components/TraceStats.tsx` + `.module.css` | 新建 | 概览展示组件 |
| `packages/client/src/components/TracesPage.tsx` | 修改 | 顶部渲染 `<TraceStats>`,刷新联动 |
| `packages/client/package.json` | 修改 | `test` 脚本追加 `statBars.test.ts` |

> 注:client tsconfig 已有 `exclude: ["src/**/*.test.ts"]`,测试文件不进 `tsc`;`.ts` 扩展名导入是刻意允许的(`allowImportingTsExtensions`)。

---

## Task 1: `statBars` 纯函数(TDD)

**Files:**
- Create: `packages/client/src/lib/statBars.ts`
- Test: `packages/client/src/lib/statBars.test.ts`
- Modify: `packages/client/package.json`

- [ ] **Step 1: 让 test 脚本也跑 statBars 测试**

编辑 `packages/client/package.json`,把 `test` 脚本改为(在原有 waterfall 测试后追加):
```json
"test": "tsx --test src/lib/waterfall.test.ts src/lib/statBars.test.ts"
```

- [ ] **Step 2: 写失败测试**

创建 `packages/client/src/lib/statBars.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statBars } from './statBars.ts'

test('按次数降序排列', () => {
  const bars = statBars({ a: 2, b: 5, c: 1 })
  assert.deepEqual(bars.map(x => x.reason), ['b', 'a', 'c'])
})

test('pct 按最大值归一化（最多的占满 100）', () => {
  const bars = statBars({ a: 5, b: 10 })
  assert.equal(bars[0].reason, 'b')
  assert.equal(bars[0].pct, 100)
  assert.equal(bars[1].reason, 'a')
  assert.equal(bars[1].pct, 50)
})

test('空对象返回空数组', () => {
  assert.deepEqual(statBars({}), [])
})

test('单一原因占满 100', () => {
  const bars = statBars({ only: 3 })
  assert.equal(bars.length, 1)
  assert.equal(bars[0].pct, 100)
  assert.equal(bars[0].count, 3)
})

test('并列次数保留全部项', () => {
  const bars = statBars({ a: 4, b: 4 })
  assert.equal(bars.length, 2)
  assert.equal(bars[0].pct, 100)
  assert.equal(bars[1].pct, 100)
})
```

- [ ] **Step 3: 运行测试确认失败**

Run:
```bash
cd packages/client && pnpm exec tsx --test src/lib/statBars.test.ts
```
Expected: FAIL —— 找不到模块 `./statBars.ts` 或 `statBars` 未定义。

- [ ] **Step 4: 实现最小代码**

创建 `packages/client/src/lib/statBars.ts`:
```ts
/** 一条降级原因的展示数据。 */
export interface StatBar {
  reason: string
  count: number
  /** 相对最大次数归一化的百分比（0–100），供占比条宽度用。 */
  pct: number
}

/**
 * 把 byReason（原因 → 次数）转成按次数降序的条数据。
 * pct 按最大值归一化：次数最多的原因占满 100，便于横向比较。
 */
export function statBars(byReason: Record<string, number>): StatBar[] {
  const entries = Object.entries(byReason)
  if (entries.length === 0) return []
  const maxCount = Math.max(...entries.map(([, c]) => c))
  return entries
    .map(([reason, count]) => ({
      reason,
      count,
      pct: maxCount > 0 ? (count / maxCount) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count)
}
```

- [ ] **Step 5: 运行测试确认通过**

Run:
```bash
cd packages/client && pnpm exec tsx --test src/lib/statBars.test.ts
```
Expected: PASS(5 个测试全过)。

再跑 `cd packages/client && pnpm exec tsc --noEmit`,确认 PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/client/src/lib/statBars.ts packages/client/src/lib/statBars.test.ts packages/client/package.json
git commit -m "feat(traces): statBars 纯函数 + 单测"
```

---

## Task 2: `useTraces` 增补 stats

**Files:**
- Modify: `packages/client/src/hooks/useTraces.ts`

- [ ] **Step 1: 加类型、状态与 fetchStats**

把 `packages/client/src/hooks/useTraces.ts` 整体替换为(在现有基础上新增 `TraceStats`、`stats`、`fetchStats`):
```ts
import { useCallback, useState } from 'react'
import type { TraceRecord, SpanRecord } from '../types'

const API = '/api'

export interface TraceDetail {
  trace: TraceRecord
  spans: SpanRecord[]
}

export interface TraceStats {
  total: number
  degradedPct: number
  byReason: Record<string, number>
}

export interface UseTracesReturn {
  traces: TraceRecord[]
  stats: TraceStats | null
  loading: boolean
  error: string | null
  fetchList: (filter?: { status?: string; limit?: number }) => Promise<void>
  fetchStats: () => Promise<void>
  fetchDetail: (id: string) => Promise<TraceDetail | null>
}

export function useTraces(): UseTracesReturn {
  const [traces, setTraces] = useState<TraceRecord[]>([])
  const [stats, setStats] = useState<TraceStats | null>(null)
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

  // 概览统计。失败时静默置空，不写 error、不阻塞列表。
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/traces/stats`)
      if (!res.ok) { setStats(null); return }
      setStats(await res.json() as TraceStats)
    } catch {
      setStats(null)
    }
  }, [])

  const fetchDetail = useCallback(async (id: string): Promise<TraceDetail | null> => {
    const res = await fetch(`${API}/traces/${id}`)
    if (!res.ok) return null
    return res.json() as Promise<TraceDetail>
  }, [])

  return { traces, stats, loading, error, fetchList, fetchStats, fetchDetail }
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
git commit -m "feat(traces): useTraces 增补 stats/fetchStats"
```

---

## Task 3: `TraceStats` 组件

**Files:**
- Create: `packages/client/src/components/TraceStats.tsx`
- Create: `packages/client/src/components/TraceStats.module.css`

- [ ] **Step 1: 创建组件**

创建 `packages/client/src/components/TraceStats.tsx`:
```tsx
import type { TraceStats as TraceStatsData } from '../hooks/useTraces'
import { statBars } from '../lib/statBars'
import styles from './TraceStats.module.css'

interface Props {
  stats: TraceStatsData
}

export function TraceStats({ stats }: Props) {
  const bars = statBars(stats.byReason)
  return (
    <div className={styles.container}>
      <div className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.value}>{stats.total}</div>
          <div className={styles.label}>总 trace 数</div>
        </div>
        <div className={styles.card}>
          <div className={`${styles.value} ${styles.degraded}`}>{stats.degradedPct}%</div>
          <div className={styles.label}>降级率</div>
        </div>
      </div>

      <div className={styles.reasons}>
        <div className={styles.reasonsTitle}>降级原因</div>
        {bars.length === 0 ? (
          <div className={styles.muted}>暂无降级</div>
        ) : (
          bars.map(b => (
            <div key={b.reason} className={styles.reasonRow}>
              <span className={styles.reasonName} title={b.reason}>{b.reason}</span>
              <span className={styles.barTrack}>
                <span className={styles.barFill} style={{ width: `${b.pct}%` }} />
              </span>
              <span className={styles.reasonCount}>{b.count}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建样式**

创建 `packages/client/src/components/TraceStats.module.css`:
```css
.container {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  padding: 16px;
  margin-bottom: 20px;
  background: var(--gray-50);
  border: 1px solid var(--gray-200);
  border-radius: var(--radius);
}

.cards {
  display: flex;
  gap: 16px;
  flex-shrink: 0;
}

.card {
  min-width: 96px;
  padding: 12px 16px;
  background: white;
  border: 1px solid var(--gray-200);
  border-radius: var(--radius-sm);
  text-align: center;
}

.value {
  font-size: 24px;
  font-weight: 700;
  color: var(--gray-900);
  line-height: 1.2;
}

.degraded { color: #d97706; }

.label {
  margin-top: 4px;
  font-size: 12px;
  color: var(--gray-600);
}

.reasons {
  flex: 1;
  min-width: 0;
}

.reasonsTitle {
  font-size: 12px;
  font-weight: 600;
  color: var(--gray-600);
  margin-bottom: 8px;
}

.muted {
  font-size: 12px;
  color: var(--gray-400);
}

.reasonRow {
  display: grid;
  grid-template-columns: 160px 1fr 40px;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.reasonName {
  font-size: 12px;
  color: var(--gray-900);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.barTrack {
  position: relative;
  height: 12px;
  background: var(--gray-100);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.barFill {
  position: absolute;
  left: 0;
  top: 0;
  height: 12px;
  min-width: 2px;
  background: #d97706;
  border-radius: var(--radius-sm);
}

.reasonCount {
  font-size: 12px;
  color: var(--gray-600);
  text-align: right;
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
git add packages/client/src/components/TraceStats.tsx packages/client/src/components/TraceStats.module.css
git commit -m "feat(traces): TraceStats 概览组件"
```

---

## Task 4: `TracesPage` 接入概览

**Files:**
- Modify: `packages/client/src/components/TracesPage.tsx`

- [ ] **Step 1: 渲染 TraceStats 并让刷新联动**

把 `packages/client/src/components/TracesPage.tsx` 整体替换为(相对现有版本:多取 `stats`/`fetchStats`,`load()` 里并发拉 stats,`<header>` 之下渲染 `<TraceStats>`):
```tsx
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTraces } from '../hooks/useTraces'
import { TraceList } from './TraceList'
import { TraceStats } from './TraceStats'
import styles from './TracesPage.module.css'

export function TracesPage() {
  const { traces, stats, loading, error, fetchList, fetchStats } = useTraces()
  const [status, setStatus] = useState('')
  const navigate = useNavigate()

  const load = (): void => {
    void fetchList({ status: status || undefined, limit: 100 })
    void fetchStats()
  }

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

      {stats && <TraceStats stats={stats} />}

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

- [ ] **Step 2: 类型检查**

Run:
```bash
cd packages/client && pnpm exec tsc --noEmit
```
Expected: PASS。

- [ ] **Step 3: 生产构建冒烟**

Run(仓库根目录):
```bash
pnpm run build:client
```
Expected: 构建成功,无报错。

- [ ] **Step 4: 提交**

```bash
git add packages/client/src/components/TracesPage.tsx
git commit -m "feat(traces): TracesPage 接入概览统计"
```

---

## Task 5: 集成验证(preview)

**Files:** 无(仅验证)

前置:后端运行且以管理员登录(本地无 GitHub OAuth 时鉴权后界面无法自动化,只能验证到 LoginGate;完整交互需你手动)。

- [ ] **Step 1: 单测 + 类型 + 构建总检**

Run:
```bash
cd packages/client && pnpm test && pnpm exec tsc --noEmit
```
Expected:`statBars` 与 `waterfall` 共 10 个测试 PASS,tsc PASS。

- [ ] **Step 2: dev server 冒烟**

用 preview 工具启动 client(需后端同时运行),访问 `/traces`。
Expected:顶部概览区渲染 —— 两张数字卡(总数、降级率%)+ 降级原因 mini 占比条(或「暂无降级」);控制台无报错。

- [ ] **Step 3: 刷新联动**

点「刷新」按钮。
Expected:网络面板出现 `GET /api/traces/stats`,概览随之刷新。

- [ ] **Step 4: stats 失败不阻塞**

（可选）临时让 `/api/traces/stats` 返回非 200(如后端未起),确认概览区隐藏但列表与其错误处理不受影响。

---

## 完成标准

- `/traces` 顶部显示概览:总数、降级率%、降级原因 mini 占比条(降序、最大值归一化)
- 刷新按钮同时刷新列表与概览
- stats 拉取失败时概览隐藏,列表照常
- `statBars` 单测通过,全项目 `tsc --noEmit` 与 `pnpm run build:client` 通过
