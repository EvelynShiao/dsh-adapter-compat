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

/** 空正文占位符（与 purge.js 出口修同款：清空语义不变，但结构合法）。 */
export const WIRE_PLACEHOLDER = '[内容已清除]'

/** 打标用（instance + prototype 双层，防重复包装）。 */
const WIRE_GUARD_MARK = Symbol.for('dsh-adapter-compat.wire-guard')

/** 这条消息是不是「正文全空的 tool 结果」（provider 会当成没有结果、拒收整轮）。 */
export function isBlankToolMessage(message) {
  if (!message || typeof message !== 'object' || message.role !== 'tool') return false
  const content = Array.isArray(message.content) ? message.content : []
  return !content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
}

/** 空 tool 结果计数（诊断用）。 */
export function countBlankToolMessages(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  return messages.filter(isBlankToolMessage).length
}

/**
 * assistant 消息里「tool-call 之后还跟着 text 块」→ 把 text/reasoning 提前、tool-call 收到末尾。
 *
 * 为什么必须动：DSHA 网关（DeepSeek Messages / Anthropic 风格）校验的是
 * 「tool_use 的下一条消息必须带它的 tool_result」。2026-10-11 实证：全 541 条线上消息里
 * 只有 2 条 assistant 是「tool-call 后面还有 text」（wire[181]/[183]，即会话 seq 634 那轮），
 * 而远端报的就是 messages.181.2 —— 消息索引 181 + 第 2 块(tool_use) 双双重合。
 * 网关把 [thinking, tool_use, text] 拆开后，tool_use 后面跟的成了 text 而不是 tool_result。
 * 规范顺序 [reasoning…, text…, tool-call…]（thinking 必须留在最前，签名要跟着它）。
 *
 * @returns {Array|null} 重排后的内容块；null = 无需动（tool-call 本来就在末尾）
 */
export function reorderAssistantContent(content) {
  if (!Array.isArray(content)) return null
  let lastCall = -1
  for (let i = 0; i < content.length; i += 1) if (content[i]?.type === 'tool-call') lastCall = i
  if (lastCall < 0 || lastCall === content.length - 1) return null
  const calls = content.filter((b) => b?.type === 'tool-call')
  const rest = content.filter((b) => b?.type !== 'tool-call')
  return [...rest, ...calls]
}

/**
 * 出口修 v2 —— 真正生效的那条路。
 *
 * v1（repairWireRequest）挂在 `llm/stream` 上原地改，但宿主在发请求前已经把
 * request / messages 数组 / 每条消息全部冻死（dsh-agent-loop/lib/index.js:1246-1257：
 * `deepFreeze(message)` + `Object.freeze(boundaryMessages)` + `Object.freeze({ ...messages })`），
 * 于是 `messages[i] = …` 与 `options.messages = …` 两条路都抛 TypeError、被 try/catch 吞掉
 * → 2026-10-11 实测：载荷里明明有 7 条空 tool 结果，wire-guard 却一条没修、零日志。
 *
 * v2 的做法：**完全不碰原对象**，重建一个未冻结的 request（浅拷贝 + 新 messages 数组），
 * 在 `streamWithRegistration` 这一层换进去。宿主的 adapterStream 对未冻结 options 是友好
 * 处理的（只在 `Object.isFrozen(options)` 时才 deepFreeze 投影），适配器最终序列化的就是我们
 * 这版数组 —— 不写盘、不改历史，纯出口拦截。
 *
 * 修两件事（都是 provider 拒收整轮的成因）：
 *   ① assistant 里 tool-call 之后还带 text ⇒ 重排成 [reasoning…, text…, tool-call…]
 *   ② 正文全空的 tool 结果 ⇒ 补占位符（否则远端当成「没有结果」）
 *
 * @returns {{request:object,repaired:number,reordered:number}|null} null = 无需修补
 */
export function guardRequestMessages(options) {
  const messages = options?.messages
  if (!Array.isArray(messages)) return null
  let repaired = 0
  let reordered = 0
  const next = messages.map((message) => {
    if (isBlankToolMessage(message)) {
      repaired += 1
      return Object.freeze({ ...message, content: Object.freeze([{ type: 'text', text: WIRE_PLACEHOLDER }]) })
    }
    if (message?.role === 'assistant') {
      const fixed = reorderAssistantContent(message.content)
      if (fixed) {
        reordered += 1
        return Object.freeze({ ...message, content: Object.freeze(fixed) })
      }
    }
    return message
  })
  if (repaired + reordered === 0) return null
  return { request: { ...options, messages: next }, repaired, reordered }
}

/**
 * ── 上下文预算（出口端硬闸，2026-10-11）─────────────────────────────
 *
 * 症状：仪表盘显示 95%（949,320 / 1,000,000），一发消息却被拒：
 *   This model's maximum context length is 1048576 tokens. However, you requested
 *   1209316 tokens (953316 in the messages, 256000 in the completion)
 * 根因**不是计数错**（实测 pressureTokens=942928、官方外推 949,320，与真实 953,316 只差
 * 0.4%），而是**分母没扣输出预留**：提供方的判据是 messages + max_tokens ≤ window，
 * 而 256,000 的输出预留从来没被算进「占用」里。
 *
 * 修法（从无损到有损，逐级降级）：
 *   ① 装得下 → 不动。
 *   ② 只差输出预留 → 把 max_tokens 压到 window - est - margin（**不丢上下文**，只影响
 *      单次回复能写多长；deepseek 那个 256k 预留远超实际需要）。
 *   ③ 连最小预留都塞不下 → 从最老的轮次开始截断，保留 system 头、绝不切断 tool 配对。
 * 全部只改「这一份要发出去的 request」，历史零改动。
 */

/** 兜底窗口（宿主目录里的 catalog 值优先）。 */
export const DEFAULT_CONTEXT_WINDOW = 1048576
/** 单次回复最少留多少（再小就该截断了）。 */
export const MIN_COMPLETION_TOKENS = 8192
/** 不知道提供方默认预留时的保守估法。 */
export const FALLBACK_RESERVE_TOKENS = 65536
/** 安全边距（窗口的百分比）。 */
export const BUDGET_SAFETY_RATIO = 0.02

/**
 * 实测校准（2026-10-11，session-3a8e374a 真实请求）：2,849,867 字符 → 953,316 token，
 * 整体密度 0.334 token/字符（该会话 CJK 只占 2.9%，大头是代码/英文/JSON）。
 * 官方 chars/4 低估 24.6%，所以这里按实测取「略偏保守」的密度。
 */
const CJK_TOKENS_PER_CHAR = 0.7
const OTHER_TOKENS_PER_CHAR = 0.34
const BLOCK_OVERHEAD_TOKENS = 4
const MESSAGE_OVERHEAD_TOKENS = 4
const CJK_RE = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\u3000-\u303F]/g

/** 一段文本的 token 估算（CJK 感知；官方 CHARS_PER_TOKEN=4 对中文低估 1.2~2 倍）。 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const cjk = (text.match(CJK_RE) || []).length
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (text.length - cjk) * OTHER_TOKENS_PER_CHAR)
}

/** 一条消息的 token 估算。 */
export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0
  let total = MESSAGE_OVERHEAD_TOKENS
  const content = Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    total += BLOCK_OVERHEAD_TOKENS
    if (typeof block.text === 'string') total += estimateTextTokens(block.text)
    else if (block.type === 'tool-call') total += estimateTextTokens(String(block.name ?? '')) + estimateTextTokens(String(block.arguments ?? ''))
    else if (block.type === 'file' || block.type === 'image') total += Math.ceil(JSON.stringify(block).length / 4)
  }
  return total
}

/** 整个消息数组的 token 估算。 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

/**
 * 从最老的轮次开始截断到预算内：保留头部 system 消息，且绝不把 tool_use 与它的
 * tool_result 切散（丢到 assistant 时把紧跟其后的 tool 结果一并丢）。
 * @returns {{messages:Array,dropped:number,tokens:number}}
 */
export function truncateMessagesToBudget(messages, budgetTokens) {
  if (!Array.isArray(messages)) return { messages, dropped: 0, tokens: 0 }
  const per = messages.map(estimateMessageTokens)
  let head = 0
  while (head < messages.length && messages[head]?.role === 'system') head += 1
  let tokens = 0
  for (const value of per) tokens += value
  let start = head
  let dropped = 0
  while (start < messages.length && tokens > budgetTokens) {
    tokens -= per[start]
    start += 1
    dropped += 1
    while (start < messages.length && messages[start]?.role === 'tool') {
      tokens -= per[start]
      start += 1
      dropped += 1
    }
  }
  if (dropped === 0) return { messages, dropped: 0, tokens }
  return { messages: [...messages.slice(0, head), ...messages.slice(start)], dropped, tokens }
}

/**
 * 给一份要发出去的 request 做上下文预算（要 prepared 才能拿到模型默认预留）。
 * @returns {{request:object,estimated:number,window:number,clampedFrom?:number,clampedTo?:number,dropped?:number,estimatedAfter?:number}|null}
 */
export function applyContextBudget(options, prepared, config = {}) {
  const messages = options?.messages
  if (!Array.isArray(messages)) return null
  /* 窗口取候选里最大的那个：宿主目录里的 1,000,000 是保守的十进制写法，
     提供方真实上限是 1,048,576（错误原文），按真实值算 + 2% 边距才既安全又不误截。 */
  const candidates = [Number(options?.contextWindow), Number(prepared?.config?.contextWindow), Number(config?.contextWindow), DEFAULT_CONTEXT_WINDOW].filter((v) => Number.isFinite(v) && v > 0)
  const window = candidates.length > 0 ? Math.max(...candidates) : DEFAULT_CONTEXT_WINDOW
  if (!Number.isFinite(window) || window <= 0) return null
  const requested = Number(options?.maxTokens) || Number(prepared?.config?.maxTokens) || 0
  const reserve = Math.max(MIN_COMPLETION_TOKENS, requested || Number(config?.reserveTokens) || FALLBACK_RESERVE_TOKENS)
  const margin = Math.max(1024, Math.round(window * (Number(config?.safetyRatio) || BUDGET_SAFETY_RATIO)))
  const estimated = estimateMessagesTokens(messages)
  if (estimated + reserve + margin <= window) return null
  if (estimated + MIN_COMPLETION_TOKENS + margin <= window) {
    const clampedTo = Math.min(reserve, window - estimated - margin)
    if (clampedTo >= MIN_COMPLETION_TOKENS && clampedTo < reserve) {
      return { request: { ...options, maxTokens: clampedTo }, estimated, window, clampedFrom: reserve, clampedTo }
    }
  }
  const cut = truncateMessagesToBudget(messages, window - MIN_COMPLETION_TOKENS - margin)
  if (cut.dropped === 0) return null
  return {
    request: { ...options, messages: cut.messages, maxTokens: MIN_COMPLETION_TOKENS },
    estimated, window, dropped: cut.dropped, estimatedAfter: cut.tokens,
    ...requested > 0 ? { clampedFrom: requested, clampedTo: MIN_COMPLETION_TOKENS } : {},
  }
}

/**
 * 把 v2 闸装在 llm 服务上（instance + prototype 双层打标，覆盖同类未来实例）。
 * @param ctx - cordis 上下文；也可直接给 LlmRuntime 实例（瀑布里的 this）
 * @returns 实际装上的层数（0 = llm 服务还没就绪）
 */
export function installWireGuard(ctx, deps = {}) {
  const log = typeof deps?.log === 'function' ? deps.log : () => {}
  const budgetConfig = deps?.config ?? {}
  const llm = ctx?.llm ?? ctx
  if (!llm || typeof llm.streamWithRegistration !== 'function') return 0
  let patched = 0
  for (const target of [llm, Object.getPrototypeOf(llm)]) {
    if (!target || typeof target.streamWithRegistration !== 'function') continue
    const original = target.streamWithRegistration
    if (original[WIRE_GUARD_MARK]) continue
    const wrapped = function (options, prepared) {
      let next = options
      try {
        /* ① 结构修：空 tool 结果补占位符 + tool-call 之后的 text 重排到前面 */
        const guarded = guardRequestMessages(next)
        if (guarded) {
          log({ t: new Date().toISOString(), event: 'wire-guard', via: 'streamWithRegistration', repaired: guarded.repaired, reordered: guarded.reordered, provider: next?.provider, model: next?.model })
          next = guarded.request
        }
      } catch { /* 修补失败不阻断请求 */ }
      try {
        /* ② 上下文预算：先压 max_tokens（无损），压不动才截断最老的轮次 */
        const budget = budgetConfig.wireBudget === false ? null : applyContextBudget(next, prepared, budgetConfig)
        if (budget) {
          log({
            t: new Date().toISOString(), event: 'wire-budget', sessionId: next?.sessionId,
            provider: next?.provider, model: next?.model, window: budget.window, estimated: budget.estimated,
            ...budget.clampedFrom === undefined ? {} : { clampedFrom: budget.clampedFrom, clampedTo: budget.clampedTo },
            ...budget.dropped === undefined ? {} : { dropped: budget.dropped, estimatedAfter: budget.estimatedAfter },
          })
          next = budget.request
        }
      } catch { /* 预算失败不阻断请求 */ }
      return original.call(this, next, prepared)
    }
    wrapped[WIRE_GUARD_MARK] = true
    try { target.streamWithRegistration = wrapped; patched += 1 } catch { /* 只读对象：交给另一层 */ }
  }
  return patched
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
  const append = (doc) => { try { appendBounded(JSON.stringify(doc), home) } catch { /* 取证失败绝不影响请求 */ } }
  /* 出口修 v2 先装（真正生效的那条路）。llm 服务此刻可能还没就绪：记一行，再定时重试。 */
  let guardPatched = 0
  if (guard) {
    try { guardPatched = installWireGuard(ctx, { log: append, config }) } catch { guardPatched = 0 }
    append({ t: new Date().toISOString(), event: 'wire-guard-installed', targets: guardPatched })
    for (const ms of [1000, 3000, 8000]) {
      const t = setTimeout(() => { try { if (guardPatched === 0) guardPatched = installWireGuard(ctx, { log: append, config }) } catch { /* ignore */ } }, ms)
      if (typeof t.unref === 'function') t.unref()
    }
  }
  try {
    ctx.effect(function* () {
      yield ctx.on('llm/stream', function (options, next) {
        try {
          if (guard) {
            /* 兜底：llm 服务若一直没拿到，用瀑布的 this（LlmRuntime 实例）现场补装一次 */
            if (guardPatched === 0) { try { guardPatched = installWireGuard(this, { log: append, config }) } catch { /* ignore */ } }
            const n = repairWireRequest(options)
            if (n > 0) append({ t: new Date().toISOString(), event: 'wire-guard', via: 'in-place', repaired: n, provider: options?.provider, model: options?.model })
            const left = countBlankToolMessages(options)
            /* 冻结导致的静默失效从此有据可查：有残留就落一行（v2 生效时这里恒为 0）。 */
            if (left > 0) append({
              t: new Date().toISOString(), event: 'wire-guard-blocked', blanks: left,
              optionsFrozen: Object.isFrozen(options), messagesFrozen: Object.isFrozen(options?.messages),
              note: 'llm/stream 上原地改被 deepFreeze 拦下；正常应由 v2（streamWithRegistration）在上游修好',
            })
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
