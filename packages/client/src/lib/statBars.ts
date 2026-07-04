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
