# Trace 概览统计可视化 — 设计方案

> 日期:2026-07-04
> 状态:已确认,待实现
> 前置:Trace 可视化前端(`docs/superpowers/specs/2026-07-04-trace-visualization-design.md`,分支 `feature/trace-visualization` / PR #13)。本特性栈式叠加其上。

## 1. 背景与目标

Trace 可视化第一版(PR #13)刻意略过了「统计概览」(YAGNI)。后端 `GET /api/traces/stats` 已就绪,返回:

```ts
{ total: number; degradedPct: number; byReason: Record<string, number> }
```

- `total` — trace 总数
- `degradedPct` — 含降级 span 的 trace 占比(整数百分比)
- `byReason` — 降级 span 按 `degraded_reason` 分组的次数(注:该项后端不随 route 过滤,是全局降级 span 计数)

本特性把这三个字段在 `/traces` 列表页顶部做成可视化概览。

## 2. 范围

**包含:**

- `/traces` 列表页顶部新增概览区:两张数字卡(**总数**、**降级率%**)+ **降级原因 mini 占比条**
- 概览随「刷新」按钮一起刷新

**不做(YAGNI):**

- 按 `route` 过滤概览(接口支持 `route` 参数,但列表页当前只按 `status` 过滤;概览按全局口径,不接 route)
- 时间趋势 / 历史曲线
- 概览随状态下拉联动(stats 接口不支持 `status` 过滤)

## 3. 架构

3 处纯前端改动 + 1 个纯函数单测文件。

### 3.1 `lib/statBars.ts`(新建,纯函数)

```ts
export interface StatBar { reason: string; count: number; pct: number }
export function statBars(byReason: Record<string, number>): StatBar[]
```

- 把 `byReason` 转成数组,按 `count` **降序**
- `pct` 按**最大值归一化**:`pct = maxCount > 0 ? count / maxCount * 100 : 0`(次数最多的原因占满条,便于横向比较)
- 空对象返回 `[]`

配套 `lib/statBars.test.ts`(`node:test`)。

### 3.2 `hooks/useTraces.ts`(修改)

- 新增导出类型 `TraceStats = { total: number; degradedPct: number; byReason: Record<string, number> }`
- 新增状态 `stats: TraceStats | null`
- 新增 `fetchStats(): Promise<void>`:`GET /api/traces/stats`;成功写入 `stats`,失败则 `setStats(null)`(**不写 `error`,不阻塞列表**)
- `UseTracesReturn` 增补 `stats` 与 `fetchStats`

### 3.3 `components/TraceStats.tsx`(+ `.module.css`,新建)

- Props:`{ stats: TraceStats }`
- 渲染:
  - 数字卡「总数」= `stats.total`
  - 数字卡「降级率」= `stats.degradedPct%`(橙色强调)
  - 「降级原因」区:`statBars(stats.byReason)` 逐行渲染 `名称 + 归一化横条 + 次数`;数组为空时显示「暂无降级」

### 3.4 `components/TracesPage.tsx`(修改)

- 从 `useTraces()` 取出 `stats`、`fetchStats`
- `load()` 里同时调用 `fetchStats()`(挂载 effect 与刷新按钮都会触发)
- 在 `<header>` 之下、列表之上渲染 `{stats && <TraceStats stats={stats} />}`

## 4. 数据流

```
TracesPage 挂载 / 点刷新
  → load(): fetchList({status,limit}) + fetchStats()
  → GET /api/traces/stats → { total, degradedPct, byReason }
  → stats 状态 → <TraceStats>
     → 数字卡 total / degradedPct
     → statBars(byReason) → mini 占比条
```

## 5. 错误与边界

- **stats 拉取失败**:`stats` 置 `null`,概览区不渲染,列表与其自身的 error 处理不受影响
- **`byReason` 为空**:原因区显示「暂无降级」
- **`total = 0`**:数字卡显示 0,降级率显示 `0%`
- **`maxCount = 0`**(理论上 byReason 非空时不会):`pct` 归 0,避免除零

## 6. 测试策略

- **`lib/statBars.ts` 纯函数**:`node:test` 单测,覆盖:降序排序、最大值归一化、空对象、单一原因、并列次数
- **UI**:`tsc --noEmit` + `pnpm run build:client` + dev server 冒烟(概览区渲染、刷新联动)
- **真实数据**:需登录管理员账号手动验证(本地环境无 GitHub OAuth,鉴权后界面无法自动化,见 `docmind-oauth-blocks-local-verify` 记忆)

## 7. 依赖与分支

- 无后端改动、无新依赖
- 栈式分支:`feature/trace-stats` 基于 `feature/trace-visualization`。PR #13 合入 master 后,本特性 PR 的 diff 收敛为仅概览改动(或先合 #13 再 rebase)
