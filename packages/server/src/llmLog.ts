// packages/server/src/llmLog.ts
//
// 统一打印「真正发给 LLM 的内容」——用于调试 prompt 拼装（注入的记忆 /
// 文档片段 / 工具结果）以及评估各阶段的 prompt。所有发往 AI 的调用点都应
// 经过这里，保证一处开关、全局可见。
//
// 默认关闭。通过环境变量 LOG_LLM 开启：
//   LOG_LLM=1     —— 打印请求，超长字段截断（默认每段 1500 字）
//   LOG_LLM=full  —— 完整打印，不截断
//
// 输出走 stderr（与评估日志 console.error 一致），不会被流式响应干扰。

// content 用 unknown：兼容 OpenAI 的 ChatCompletionMessageParam（其 content
// 可能是字符串、内容块数组或 null），非字符串一律 JSON 序列化后打印。
type Msg = { role: string; content?: unknown }

const RAW = (process.env.LOG_LLM ?? '').toLowerCase()
const ENABLED = RAW === '1' || RAW === 'true' || RAW === 'full'
const FULL = RAW === 'full'
const MAX = 1500 // 非 full 模式下每段最大字符数

export function llmLogEnabled(): boolean {
  return ENABLED
}

function toText(c: unknown): string {
  return typeof c === 'string' ? c : JSON.stringify(c)
}

function clip(s: string): string {
  if (FULL || s.length <= MAX) return s
  return `${s.slice(0, MAX)}\n  …（已截断 ${s.length - MAX} 字，设 LOG_LLM=full 查看全部）`
}

export interface LlmLogPayload {
  model?: string
  system?: string
  messages: Msg[]
  tools?: unknown[]
}

/**
 * 打印一次 LLM 请求。tag 标识来源（如 chat/stream、eval/judge），
 * 方便在混杂日志里区分是哪条链路发出的。
 */
export function logLlmRequest(tag: string, p: LlmLogPayload): void {
  if (!ENABLED) return
  const bar = '═'.repeat(64)
  const lines: string[] = ['', bar, `🤖 发给 AI ▸ ${tag}${p.model ? `  (model=${p.model})` : ''}`]

  if (p.system) {
    lines.push('', '── system ──', clip(p.system))
  }
  lines.push('', `── messages (${p.messages.length}) ──`)
  p.messages.forEach((m, i) => {
    lines.push(`[${i}] ${m.role}:`, clip(toText(m.content)))
  })
  if (p.tools?.length) {
    lines.push('', `── tools (${p.tools.length}) ──`, clip(JSON.stringify(p.tools)))
  }
  lines.push(bar, '')
  console.error(lines.join('\n'))
}
