# Trace 可视化 — 设计方案

> 日期:2026-07-04
> 状态:已确认,待实现
> 前置:请求级 Tracing 后端(PR #12,`docs/superpowers/specs/2026-07-01-observability-tracing-design.md`)已合并

## 1. 背景与目标

Tracing 后端已经完全就绪并合并:SQLite 存 `traces` + `trace_spans` 两张表,并提供三个**仅管理员**可用的接口:

- `GET /api/traces` — 列表,可按 `status` / `route` 过滤,`limit` 限制条数
- `GET /api/traces/stats` — 统计(总数 / 降级率 / 按降级原因分布)
- `GET /api/traces/:id` — 完整 span 树,含 `parent_span_id`、`start_offset_ms`、`duration_ms`、`status`、`degraded_reason`、`input`/`output`/`metadata`

目前这些数据**只能靠直接调 API** 查看,没有任何前端界面。本项目为其构建管理员可视化界面。

## 2. 范围

**第一版包含:**

- `/traces` 列表页 — 展示最近的 trace,支持按状态过滤
- `/traces/:id` 详情页 — span 瀑布图(时间线),可通过 URL 深链接分享
- 管理员专属,非管理员前端重定向、后端 403 兜底

**第一版不做(YAGNI):**

- 统计概览页(`/stats` 接口留待后续接入)
- 按 `route` 过滤(第一版仅按 `status`;接口已支持,以后可加)
- trace 的删除 / 导出

## 3. 架构

### 3.1 路由改造(引入 `react-router-dom` v7)

- `main.tsx`:最外层包 `<BrowserRouter>`
- `App.tsx`:保留 `useAuth` 及 loading / 登录门逻辑,通过后渲染 `<Routes>`:
  - `/` → `ChatView`(把现有 `App` 的 sidebar + main 聊天 UI 抽取到独立组件)
  - `/traces` → `element={user.isAdmin ? <TracesPage/> : <Navigate to="/" replace/>}`
  - `/traces/:id` → `element={user.isAdmin ? <TraceDetailPage/> : <Navigate to="/" replace/>}`
- `user` 通过 props 从 `App` 传入各路由组件
- 生产环境:`packages/client/nginx.conf` 已有 SPA fallback(`try_files $uri $uri/ /index.html`),`/traces` 深链接无需额外改动

### 3.2 新增文件(`packages/client/src/`)

| 文件 | 职责 |
|---|---|
| `hooks/useTraces.ts` | 数据层(仿 `useEval`):`fetchList(filter)`、`fetchDetail(id)`;持有 `traces` / `detail` / `loading` / `error` 状态 |
| `lib/waterfall.ts` | **纯函数** `buildWaterfall(spans, totalMs)`:为每个 span 计算树深度、`leftPct`、`widthPct`。无 DOM 依赖,可单测 |
| `components/TracesPage.tsx` | 列表页容器:标题 + 「← 返回对话」链接 + 状态过滤下拉 + 刷新按钮 + `TraceList` |
| `components/TraceList.tsx` | trace 表格:状态徽章 / 路由 / 耗时 / span 数 / 降级·错误数 / 时间;行点击 `navigate('/traces/:id')` |
| `components/TraceDetailPage.tsx` | 详情页容器:trace 摘要头 + `SpanWaterfall` + 选中 span 的详情面板 |
| `components/SpanWaterfall.tsx` | 核心可视化:每行左侧按 `depth` 缩进的 span 名,右侧时间轴按 `leftPct` / `widthPct` 画条,颜色由 `status` 决定;点击 span 展开其详情 |
| `components/*.module.css` | 上述组件的 scoped 样式,遵循现有 CSS Modules 约定 |
| `types.ts`(追加) | `TraceRecord`、`SpanRecord` 类型,与 server 端形状对齐 |

### 3.3 导航入口

- `ChatView` 侧边栏在 `user.isAdmin` 为真时,新增「🔍 Traces」链接跳转 `/traces`(与现有 `EvalPanel` 的管理员门一致)
- `TracesPage` 与 `TraceDetailPage` 提供「← 返回对话」链接回到 `/`

## 4. 数据流

```
TracesPage
  → useTraces.fetchList({ status, limit })
  → GET /api/traces?status=&limit=
  → TraceList 表格渲染

行点击 → navigate('/traces/:id')

TraceDetailPage
  → useTraces.fetchDetail(id)
  → GET /api/traces/:id  → { trace, spans }
  → buildWaterfall(spans, trace.duration_ms)
  → SpanWaterfall 渲染;点击某 span → 展开输入/输出/metadata/降级原因/错误
```

## 5. 瀑布图布局逻辑(`buildWaterfall`,纯函数)

输入:`spans: SpanRecord[]`(接口已按 `start_offset_ms` 升序)、`totalMs: number`。

- **深度**:顺 `parent_span_id` 链向上数,得到每个 span 的 `depth`(根 span depth = 0)
- **总时长**:`totalMs = trace.duration_ms`;若为 0 或缺失,兜底取所有 span `start_offset_ms + duration_ms` 的最大值
- **水平定位**:
  - `leftPct = totalMs > 0 ? (start_offset_ms / totalMs) * 100 : 0`
  - `widthPct = max(totalMs > 0 ? (duration_ms / totalMs) * 100 : 0, MIN_WIDTH_PCT)`
- **顺序**:保持 `start_offset_ms` 升序
- **颜色**:由 `status`(`ok` / `degraded` / `error`)映射到样式类

输出:`WaterfallRow[] = Array<{ span: SpanRecord; depth: number; leftPct: number; widthPct: number }>`。

## 6. 错误与边界处理

- **非管理员访问 `/traces` 或 `/traces/:id`**:前端 `<Navigate to="/" replace/>` 重定向;后端 API 亦返回 403
- **trace id 不存在(404)**:详情页显示「trace 不存在」空态
- **网络 / 接口错误**:显示错误横幅 + 「重试」按钮
- **列表为空**:显示空态提示
- **`TRACE_CONTENT=off`** 导致 `input`/`output` 为 `null`:span 详情显示「内容未记录」
- **`duration_ms = 0`**(晚追加的 span 或极短 span):赋予 `MIN_WIDTH_PCT` 最小宽度,保证可见
- **`totalMs = 0`**:所有 `leftPct` 归 0,`widthPct` 用最小宽度,避免除零

## 7. 测试策略

- **`lib/waterfall.ts` 纯函数**:用 server 端同款 `node:test` 编写单测,遵循 TDD。覆盖:
  - 单层 span 的百分比计算
  - 多层 `parent_span_id` 的深度计算
  - `totalMs = 0` 兜底
  - `duration_ms = 0` 的最小宽度
  - 空数组输入
- **UI**:用 preview 工具启动 dev server,实测:
  - 列表加载与状态过滤
  - 行点击跳转到详情
  - 瀑布图渲染与配色
  - 点击 span 展开输入/输出/metadata
  - 非管理员重定向

## 8. 依赖变更

- 新增前端依赖:`react-router-dom`(v7)
- 无后端改动(现有三个接口已满足需求)
- 无 nginx / Docker 改动(SPA fallback 已存在)
