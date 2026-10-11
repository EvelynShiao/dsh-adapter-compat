/**
 * dsh-adapter-compat/wire-tap.js —— 线上"线级"取证
 *
 * 为什么需要：宿主/provider 报的错都是**线级**的（例：`messages.181.2: tool_use ids were
 * found without tool_result blocks immediately after: call_xxx`），而用「日志 + 自己复刻
 * 拼装」去对账时，只要有一处理解偏差就会得出"文件是干净的"，永远抓不到真凶。
 * 这个探针把 **provider 真正收到的 messages 结构**原样记下来（正文只记长度，不落内容），
 * 于是可以对任意一次失败请求做逐条比对。
 *
 * 落盘：$DSH_HOME/llm-wire.jsonl（有界，超过 8MB 轮转一次），每行一次请求：
 *   { t, provider, model, count, messages: [{ i, role, blocks: [{ type, id, tool_use_id, textLen }] }] }
 * 默认开启（结构摘要很小）；config.wireTap === false 关闭。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'

export const WIRE_TAP_FILE = 'llm-wire.jsonl'
const MAX_BYTES = 8 * 1024 * 1024

/** DSH 主目录（与 index.js 的 dshHomeDir 同规则；这里自带一份以免循环 import）。 */
function homeDir(env = process.env) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = env?.USERPROFILE ?? env?.HOME
  return home ? `${String(home).replace(/[\\/]+$/u, '')}/.dsh` : '.dsh'
}

/** 一个内容块 → 结构摘要（正文只留长度，避免把会话正文写进调试文件）。 */
export function digestBlock(block) {
  if (block === null || typeof block !== 'object') return { type: typeof block }
  const out = { type: block.type }
  for (const key of ['id', 'tool_use_id', 'toolCallId', 'name', 'is_error']) {
    if (block[key] !== undefined) out[key] = block[key]
  }
  for (const key of ['text', 'thinking', 'arguments']) {
    if (typeof block[key] === 'string') out[key + 'Len'] = block[key].length
  }
  if (Array.isArray(block.content)) {
    out.content = block.content.map((b) => (b && typeof b === 'object' ? { type: b.type, textLen: typeof b.text === 'string' ? b.text.length : undefined } : { type: typeof b }))
  }
  return out
}

/** 一条消息 → 结构摘要。 */
export function digestMessage(message, index) {
  const out = { i: index, role: message?.role }
  if (typeof message?.toolCallId === 'string') out.toolCallId = message.toolCallId
  if (typeof message?.isError === 'boolean') out.isError = message.isError
  out.blocks = Array.isArray(message?.content) ? message.content.map(digestBlock) : null
  return out
}

/** 整个请求 → 可落盘的一行。 */
export function digestRequest(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  return {
    t: new Date().toISOString(),
    provider: options?.provider,
    model: options?.model,
    purpose: options?.purpose,
    count: messages.length,
    systemLen: typeof options?.system === 'string' ? options.system.length : 0,
    messages: messages.map(digestMessage),
  }
}

/** 有界追加：超过上限就把旧文件改名（只保留一代 .1）。 */
function appendBounded(line, home) {
  const path = `${home}/${WIRE_TAP_FILE}`
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      const rotated = `${path}.1`
      try { rmSync(rotated, { force: true }) } catch { /* ignore */ }
      renameSync(path, rotated)
    }
  } catch { /* 轮转失败就继续追加 */ }
  try {
    mkdirSync(home, { recursive: true })
    appendFileSync(path, line + '\n')
  } catch { /* 取证失败绝不影响请求 */ }
}

/**
 * 出口修：把「正文全空的 tool 结果」补一个占位文本。
 *
 * 为什么必须修在出口、而不是只修日志：provider（Anthropic 风格）把
 * `tool_result.content = []` 视为**没有结果**，于是报
 *   messages.N.M: `tool_use` ids were found without `tool_result` blocks immediately after
 * 宿主侧一切合法（assistant 宣告了 tool_use、下一条就是对应 tool 结果），但空内容远端不认。
 * 实证 2026-10-11：session-3a8e374a 有 7 条全空 tool/result（#941/#946/#951/#956/#958/#963/#971，
 * 正文被历史上的清空操作擦空），导致该会话每次请求都被 deepseek 拒收、连续三轮同一错误。
 *
 * cordis 的 waterfall 语义（cordis/lib/index.js:317）：`next()` 复用同一个 args 数组，
 * 所以在这里**直接改 options.messages** 就改到了真正发出去的请求——无需重建 options。
 *
 * @returns {number} 实际修补的消息条数（0 = 无需修补）
 */
export function repairWireRequest(options) {
  const messages = options?.messages
  if (!Array.isArray(messages)) return 0
  const isBlank = (m) => {
    if (!m || typeof m !== 'object' || m.role !== 'tool') return false
    const content = Array.isArray(m.content) ? m.content : []
    return !content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
  }
  const fixed = (m) => ({ ...m, content: [{ type: 'text', text: '[内容已清除]' }] })
  let repaired = 0
  for (let i = 0; i < messages.length; i += 1) {
    if (!isBlank(messages[i])) continue
    /* 关键：宿主的消息对象是**深度冻结**的（dsh-session deriveMessages 文档明说 Message 对象
       SHARED and deep-frozen），直接 `message.content = [...]` 在严格模式下抛错 / 静默失败
       —— 第一版就是这样被自己的 try/catch 吞掉、连一行日志都没留下的。
       改法：**换掉数组元素**（新对象、未冻结），而不是改旧对象。 */
    try {
      messages[i] = fixed(messages[i])
      repaired += 1
    } catch {
      /* 连数组都冻结：退化成重建整个数组挂回 options */
      try {
        options.messages = messages.map((m) => (isBlank(m) ? fixed(m) : m))
        repaired += messages.filter(isBlank).length
        break
      } catch { /* 彻底改不动就放弃，别弄挂请求 */ }
    }
  }
  return repaired
}

/**
 * 挂上探针（顺带出口修）。挂在 `llm/stream` 瀑布上——那是 provider 收到 options 的
 * **唯一入口**，也是所有路由（含第三方 adapter）都必经的一层。
 * @returns {boolean} 是否装上
 */
export function installWireTap(ctx, config = {}, deps = {}) {
  if (config?.wireTap === false && config?.wireGuard === false) return false
  const home = deps.home ?? homeDir()
  const tap = config?.wireTap !== false
  const guard = config?.wireGuard !== false
  try {
    ctx.effect(function* () {
      yield ctx.on('llm/stream', (options, next) => {
        try {
          if (guard) {
            const n = repairWireRequest(options)
            if (n > 0) appendBounded(JSON.stringify({ t: new Date().toISOString(), event: 'wire-guard', repaired: n, provider: options?.provider, model: options?.model }), home)
          }
        } catch { /* 修补失败不阻断请求 */ }
        try {
          if (tap) appendBounded(JSON.stringify(digestRequest(options)), home)
        } catch { /* 摘要失败不阻断请求 */ }
        return next()
      })
    }, 'adapter-compat: llm wire tap')
    return true
  } catch {
    return false
  }
}
