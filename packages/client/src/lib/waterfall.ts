import type { SpanRecord, WaterfallRow } from '../types.ts'

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
