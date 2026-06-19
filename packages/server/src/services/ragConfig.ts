// packages/server/src/services/ragConfig.ts
//
// 检索策略配置：用「距离阈值 + 动态 k」替代固定 top-k。
//
// 固定 top-k 的毛病：不管相关与否，永远返回正好 k 个 —— 答案只在 1 块里时
// 硬塞 k 块（噪音拉低精确率），文档没答案时也照样返回 k 块（逼 LLM 编）。
// 改为：先粗筛一批候选，再按 cosine 距离阈值精筛，返回数量在 [minK, maxK]
// 之间动态浮动。
//
// 全部可通过环境变量覆盖，无需改代码即可调参。

function numEnv(key: string, def: number, allowZero = false): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  const v = Number(raw)
  if (!Number.isFinite(v) || v < 0) return def
  if (v === 0 && !allowZero) return def
  return v
}

export const RAG = {
  // cosine 距离阈值：只保留 distance <= 此值的块（越小越相似，范围约 0~1）。
  distanceThreshold: numEnv('RAG_DISTANCE_THRESHOLD', 0.5),
  // 最少返回块数：即使都超过阈值，也兜底返回最近的 minK 个。
  // 设为 0 可启用「无相关内容 → 不返回任何块」的拒答行为。
  minK: numEnv('RAG_MIN_K', 1, true),
  // 最多返回块数：通过阈值的块超过此数时截断（取最近的 maxK 个）。
  maxK: numEnv('RAG_MAX_K', 5),
}

/** 粗筛候选池大小：先从向量库多取一些，再按阈值精筛。 */
export function candidatePool(maxK: number): number {
  return Math.max(maxK * 4, 20)
}
