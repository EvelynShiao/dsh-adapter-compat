/**
 * dsh-adapter-compat/slim.js — 会话瘦身
 *
 * 就地改写载荷、保留结构：把老轮次里「推理流 + 工具输出 + 工具入参」的正文
 * 物理替换成占位（真删除内容，不是隐藏），但事件数、seq、callId 配对、turn/step
 * 全部不动 —— 不重编号、无断链风险。效果：文件体积↓ + 真实上下文 pressureTokens↓
 * + UI 统计 surfaceTokens↓（三层都降，因为内容真的没了，不是藏起来）。
 *
 * 与「隐藏(surfaceOp replace)」的本质区别：隐藏只是不发给模型、内容还在文件里、
 * UI 字符统计照样算（用户明确否掉）；本模块是把正文从文件里抹掉。
 *
 * 与「整轮物理切除(excise)」的区别：excise 删事件、要重编号、live 会话不能碰；
 * 本模块不删事件只改正文，结构零变化，但**仍需目标会话非 live**（live 时内存事件
 * 数组与文件错位，下次 flush 会把原文写回 + seq 错乱）。
 */
import { readSession, writeSession, verify } from './true-delete.js'
import { emptyTextBlocks } from './purge.js'

/** 文本类字段名（擦正文用；不碰 id/role/kind/callId 等结构字符串）。 */
const TEXT_KEYS = new Set(['text', 'texts', 'delta', 'deltas', 'reasoning', 'reasoning_content', 'reasoningContent', 'thinking'])

/** 按 key 名递归擦文本：只把字符串置空，键/数组长度/dt/chunk 结构不动（宿主仍能解析）。 */
export function scrubTexts(node, depth = 0) {
  if (depth > 14 || node === null || typeof node !== 'object') return node
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (TEXT_KEYS.has(key)) {
      if (typeof value === 'string') node[key] = ''
      else if (Array.isArray(value)) node[key] = value.map((x) => (typeof x === 'string' ? '' : x))
      else if (value && typeof value === 'object') {
        for (const inner of Object.keys(value)) if (typeof value[inner] === 'string') value[inner] = ''
      }
      continue
    }
    if (value && typeof value === 'object') scrubTexts(value, depth + 1)
  }
  return node
}

/** 只清 reasoning 块的正文，保留 text(assistant 回复) 与 tool-call 块。 */
function slimContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((b) => {
    if (!b || typeof b !== 'object' || b.type !== 'reasoning') return b
    const c = { ...b }
    for (const k of ['text', 'reasoning', 'reasoning_content', 'thinking']) {
      if (typeof c[k] === 'string') c[k] = ''
    }
    return c
  })
}

/** 瘦身单条事件（纯函数，入参不改）。只动 assistant/tool 类，其余原样返回。 */
export function slimEvent(event) {
  const e = structuredClone(event)
  const d = e?.data
  if (!d || typeof d !== 'object') return e
  if (e.type === 'assistant/message') {
    // 推理块正文 + 内嵌提供方流文本 → 空；text(回复) 与 tool-call 块保留
    if (Array.isArray(d.message?.content)) d.message.content = slimContentBlocks(d.message.content)
    if (Array.isArray(d.stream)) scrubTexts({ stream: d.stream })
    if (typeof d.reasoning === 'string') d.reasoning = ''
    if (typeof d.reasoning_content === 'string') d.reasoning_content = ''
  } else if (e.type === 'assistant/attempt' || e.type === 'llm/retry' || e.type === 'llm/retry-started') {
    // 思考过程载体：只留 turn/step/retryId/attemptId/reason 标量，文本载体擦空
    for (const k of ['content', 'text', 'messages', 'prompt', 'reasoning', 'reasoning_content', 'thinking']) {
      if (d[k] !== undefined) delete d[k]
    }
    if (d.stream !== undefined) { try { scrubTexts({ stream: d.stream }) } catch { /* 保结构优先 */ } }
  } else if (e.type === 'tool/result') {
    // 工具输出：content 块 + result/output 全清
    if (Array.isArray(d.message?.content)) d.message.content = emptyTextBlocks(d.message.content)
    if (typeof d.result === 'string') d.result = ''
    if (typeof d.output === 'string') d.output = ''
    if (d.output && typeof d.output === 'object') d.output = {}
  }
  // 注意：tool/call 的 arguments 不碰——它必须与 assistant/message 里 tool-call
  // 块「宣告」的参数一致，只清一边 verify 会报「与宣告的 tool call 不符」。工具入参
  // 本来就小，大头是推理流与工具输出（实测占省下体积的绝大头）。
  return e
}

/** 参与瘦身的事件类型（user/message、turn/*、step/*、request/header、tool/call 等一律不碰）。 */
export const SLIM_TYPES = new Set([
  'assistant/message', 'assistant/attempt', 'llm/retry', 'llm/retry-started', 'tool/result',
])

/**
 * 瘦身整个会话文件：读 → 逐条瘦身 → verify → （调用方决定）备份+写+读回复核。
 * @returns {{ok, problems, before, after, saved, events, header, slimmed}}
 */
export function slimSession(file) {
  const { header, events } = readSession(file)
  const before = JSON.stringify(events).length
  const slimmed = events.map((e) => (SLIM_TYPES.has(e.type) ? slimEvent(e) : e))
  const after = JSON.stringify(slimmed).length
  const v = verify(header, slimmed)
  return {
    ok: v.ok,
    problems: v.problems ?? [],
    before,
    after,
    saved: before - after,
    events: slimmed.length,
    header,
    slimmed,
  }
}
