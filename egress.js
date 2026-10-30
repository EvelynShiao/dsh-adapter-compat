/**
 * dsh-adapter-compat/egress.js —— 出口规范化（2026-10-17）
 *
 * 用户诉求：「思考链 / 工具调用被当正文」这类**跨 provider 的格式问题**在 adapter 层修，
 * 并且要能选「只对网页端生效（web）」还是「对全局生效（all）」。**不改 webin**。
 *
 * 两类症状（都有实证，见 work/Evelyn/adapter-交接-思考链与工具调用.md）：
 *   ① 思考链被当正文：上游（inai.top 的 deepseek-v4.1-flash）把 thinking 同时写进
 *      content 与 reasoning 通道 ⇒ 正文里出现字面 `<thinking>…</thinking>`。
 *      实证：session-1895273e 正文长度 4896 == reasoning 块长度 4896。
 *   ② XML 式工具调用漏成正文：模型按 XML 风格想调工具，解析失败后被**原样**吐进正文。
 *      实证：一次压缩摘要只有 500 字，全是
 *      `[调用工具 read><parameter name="file_path">…</parameter>` 这类垃圾。
 *
 * ⚠️ 挂载点（2026-10-17 修正上一轮的判断错误）：
 *   必须挂 `llm/stream` 瀑布，**不能**包装 `llm.stream`。
 *   主循环（dsh-agent-loop）走的是 `preparedCall.stream(request)` →
 *   `LlmRuntime.streamWithRegistration` → `ctx.waterfall(this,'llm/stream',…)`，
 *   **根本不经过 `llm.stream`**。上一轮包装 llm.stream 后本插件日志里
 *   「剥离正文开头」计数恒为 0，就是这个原因（装了但没被调到）。
 *
 * 安全取向（重要）：
 *   - 默认 `xmlToolCalls: 'strip'` —— **剥掉标记，但不伪造工具调用**。
 *     把正文里的 XML 语法自动变成真工具调用 = 让模型"说的话"变成"执行的命令"，
 *     一旦误判（模型只是在引用/讨论这段语法）就会真的跑 pwsh/read。
 *     要真执行必须显式切到 'convert'，且仅当工具名在本次请求的 tools 名单里才转。
 *   - 压缩请求（purpose === 'compaction'）永不转换：那是纯摘要任务。
 *   - 剥标记只认**有明确边界的完整段**；半个标记一律留到块结束再判，绝不吞正文。
 */

/** 出口规范化器标记（防止重复包装）。 */
export const EGRESS_NORMALIZER = Symbol.for('dsh-adapter-compat.egress-normalizer')

/** 自然语言调用翻译（2026-10-21 重建——全局 egress 层，API 车道同样生效）。 */
import { translateUtterance } from './nl-utterance.js'
import { zhToolName, ZH_TOOL_DESCRIPTIONS } from './tool-names.js'

/** 统计（自检接口展示；>0 说明真的在干活）。 */
export const egressStats = { thinkingStripped: 0, xmlToolCalls: 0, markersDropped: 0, skippedByScope: 0, nlUtterances: 0, chatOnlyStripped: 0, nlTaught: 0, zhLocalized: 0, catalogTrimmed: 0 }

/** 内置「网页端」路由判定前缀：webin 的路由名形如 `webin-<平台>`（见 webin 的 routeFor()）。 */
export const BUILTIN_WEB_ROUTE_PREFIX = 'webin'

/**
 * 这条 provider 路由是不是「网页端」（webin 驱动真浏览器那一类）。
 * @param {string} provider - GenerateOptions.provider
 * @param {string[]} [extra] - 用户额外声明的路由名/前缀
 */
export function isWebRoute(provider, extra = []) {
  if (typeof provider !== 'string' || provider === '') return false
  if (provider === BUILTIN_WEB_ROUTE_PREFIX || provider.startsWith(BUILTIN_WEB_ROUTE_PREFIX)) return true
  const list = Array.isArray(extra) ? extra : []
  return list.some((r) => typeof r === 'string' && r !== '' && (provider === r || provider.startsWith(r)))
}

/* ==================== ① 思考标签 ==================== */

/** 正文开头是否以 `<thinking…>` 起头（允许前导空白；大小写不敏感、允许属性）。 */
const THINK_OPEN_RE = /^\s*<thinking(\s[^>]*)?>/i
const THINK_CLOSE = '</thinking>'

/**
 * 剥离「正文开头」的 thinking 段（纯函数，便于单测与流式复用）。
 * 正文**中间/后面**出现的标签一律保留（那可能是在引用别人的输出、或在讨论标签本身）。
 * @param {string} text - 累计要处理的正文（已含上次 pending）。
 * @param {boolean} inTag - 进入时是否已在 thinking 段内。
 * @returns {{text:string, inTag:boolean, changed:boolean, pending?:string}}
 */
export function stripLeadingThinking(text, inTag = false) {
  let out = text
  let inside = inTag === true
  let changed = false
  for (;;) {
    if (inside) {
      const close = out.search(/<\/thinking>/i)
      if (close === -1) {
        /* 闭合标签可能也被切开了（`…</thin`）：把结尾的半个标签留进 pending，
           否则下一段补上的 `king>` 永远拼不回来 —— 后面的正文会被永久吞掉
           （单测抓到过）。 */
        const partial = /<\/?t?h?i?n?k?i?n?g?$/i.exec(out)
        return { text: '', inTag: true, changed: true, pending: partial === null ? '' : partial[0] }
      }
      out = out.slice(close + THINK_CLOSE.length)
      inside = false
      changed = true
      continue
    }
    const m = THINK_OPEN_RE.exec(out)
    if (m === null) {
      /* 开头不是 thinking 标签。若看起来像「半个开标签」（`<thin` 之类），缓冲等下一段。 */
      const looksPartial = /^\s*<[a-z]*$/i.test(out)
      if (looksPartial) return { text: '', inTag: false, changed, pending: out }
      return { text: out, inTag: false, changed }
    }
    const close = out.search(/<\/thinking>/i)
    if (close === -1) return { text: '', inTag: true, changed: true }     // 开标签完整、闭合还没来
    out = out.slice(close + THINK_CLOSE.length)
    changed = true
  }
}

/* ==================== ② XML 式工具调用 ==================== */

/**
 * 标记候选起点。delta 层遇到这些的**真前缀**就缓冲，等后续 delta 拼完整，
 * 避免把半个标记当正文吐出去（也避免把普通 `<` 误当标记）。
 */
const MARKERS = [
  '[调用工具', '[tool call', '[tool_call', '[tool_calls',
  '<tool_calls', '<tool_call', '<function_call', '<function_calls', '<invoke',
]

/** 是否可能是某个标记的真前缀（含已是标记本身）。 */
function isMarkerPrefix(tail) {
  return MARKERS.some((m) => m.startsWith(tail) || tail.startsWith(m))
}

/**
 * 找 buf 里「标记可能从哪开始」的位置；没有则 -1。
 *
 * 分两步，顺序不能反：
 *   ① 完整标记的最早出现位置（`[调用工具 read><paramet…` 里的 `[调用工具`）；
 *   ② 没有完整标记时，才看结尾是不是某个标记的**真前缀**（标记被 delta 切开了）。
 *
 * ⚠️ 不能只做 ②：实测那段泄漏是 `[调用工具 read><parameter name="…`，
 * 结尾那个 `<` 属于**参数标签**，若从末尾往回找、遇到不像标记的 `<` 就放弃，
 * 整个 `[调用工具 read><paramet` 会被当正文吐出去（单测抓到过）。
 */
function findMarkerStart(buf) {
  let best = -1
  for (const m of MARKERS) {
    const at = buf.indexOf(m)
    if (at !== -1 && (best === -1 || at < best)) best = at
  }
  if (best !== -1) return best
  for (let i = buf.length - 1; i >= 0; i -= 1) {
    const c = buf[i]
    if (c !== '<' && c !== '[') continue
    const tail = buf.slice(i)
    if (tail.length > 64) return -1          // 太长，不像标记开头
    return MARKERS.some((m) => m.startsWith(tail)) ? i : -1
  }
  return -1
}

/** 兼容旧名（内部与单测都可能引用）。 */
function markerHoldStart(buf) {
  return findMarkerStart(buf)
}

/** 属性名：`name="x"` / `name=x` / `=x`（实测泄漏里 `<parameter=limit>90</parameter>`）。 */
function readParamName(attrs) {
  const named = /\bname\s*=\s*["']?([\w.:\-]+)["']?/i.exec(attrs)
  if (named !== null) return named[1]
  const bare = /^\s*=\s*["']?([\w.:\-]+)["']?/.exec(attrs)
  return bare === null ? '' : bare[1]
}

/**
 * 读一段 `<parameter …>` 序列。
 * @returns {{args:Record<string,string>, end:number, count:number}}
 *   `end` 是参数区结束的绝对位置，`count` 是读到的参数个数。
 */
function readParams(text, from) {
  const args = {}
  let p = from
  let count = 0
  for (;;) {
    const head = /^\s*<parameter\b([^>]*?)(\/?)>/i.exec(text.slice(p))
    if (head === null) break
    const attrs = head[1]
    const selfClose = head[2] === '/'
    const name = readParamName(attrs)
    let value = null
    const inline = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(attrs)
    if (inline !== null) {
      value = inline[1]
      p += head[0].length
    } else if (selfClose) {
      p += head[0].length
    } else {
      const start = p + head[0].length
      const end = text.indexOf('</parameter>', start)
      if (end === -1) break                       // 未闭合：不认（等块结束再判）
      value = text.slice(start, end)
      p = end + '</parameter>'.length
    }
    if (name !== '' && value !== null) { args[name] = value; count += 1 }
  }
  return { args, end: p, count }
}

/** 尾部闭合标签（实测泄漏末尾带 `</function></tool_call>`，可能连续多个）。 */
const TAIL_CLOSE_RE = /^(?:\s*<\/(?:function|function_call|tool_call|tool_calls|invoke)>)+/i

/**
 * 解析正文里的 XML 式工具调用。
 *
 * 只认**有明确边界**的形式，宁可漏剥也不吞正文：
 *   a. `[调用工具 name>…<parameter name="k">v</parameter>…`（实测泄漏形态）
 *   b. `<tool_calls>…</tool_calls>` / `<function_call>…</function_call>` 成对包裹
 *
 * @returns {{calls:{name:string,arguments:string}[], clean:string, complete:boolean}}
 *   `clean` 是剥掉标记后的正文；`complete=false` 表示结尾有未闭合的标记段
 *   （调用方应继续缓冲，别急着当正文吐）。
 */
export function parseXmlToolCalls(text) {
  const src = typeof text === 'string' ? text : ''
  if (src === '') return { calls: [], clean: src, complete: true }
  const calls = []
  const spans = []
  let complete = true

  /* a. `[调用工具 name>…` —— 实测泄漏形态。 */
  const LEGACY = /\[(?:调用工具|tool[_ ]?calls?)\s*([A-Za-z_][\w.:\-]*)\s*[>：]/g
  let m
  while ((m = LEGACY.exec(src)) !== null) {
    const from = m.index
    const bodyStart = m.index + m[0].length
    const { args, end, count } = readParams(src, bodyStart)
    let bodyEnd = end
    if (count === 0) {
      /* 一个参数都没读到：只认「后面确实另有内容（换行）」的段；
         否则可能只是流还没吐完 ⇒ 不认，交给缓冲。 */
      const nl = src.indexOf('\n', bodyStart)
      if (nl === -1) { complete = false; break }
      bodyEnd = nl
    }
    const tail = TAIL_CLOSE_RE.exec(src.slice(bodyEnd))
    const to = bodyEnd + (tail === null ? 0 : tail[0].length)
    calls.push({ name: m[1], arguments: JSON.stringify(args) })
    spans.push([from, to])
    LEGACY.lastIndex = to
  }

  /* b. 成对包裹形态。 */
  const WRAPPED = /<(tool_calls|function_calls)>([\s\S]*?)<\/\1>/gi
  while ((m = WRAPPED.exec(src)) !== null) {
    const inner = m[2]
    const INNER = /<(?:tool_call|function_call|invoke)\b([^>]*)>([\s\S]*?)<\/(?:tool_call|function_call|invoke)>/gi
    let im
    while ((im = INNER.exec(inner)) !== null) {
      const attrs = im[1]
      const body = im[2]
      const named = /\bname\s*=\s*["']?([\w.:\-]+)["']?/i.exec(attrs)
      const tag = /<name>\s*([\w.:\-]+)\s*<\/name>/i.exec(body)
      const name = named !== null ? named[1] : (tag !== null ? tag[1] : '')
      if (name === '') continue
      const { args } = readParams(body, 0)
      calls.push({ name, arguments: JSON.stringify(args) })
    }
    spans.push([m.index, m.index + m[0].length])
  }

  /* 单个 <function_call>…</function_call>（没有外层 <tool_calls>）。 */
  const SINGLE = /<function_call\b([^>]*)>([\s\S]*?)<\/function_call>/gi
  while ((m = SINGLE.exec(src)) !== null) {
    if (spans.some(([s, e]) => m.index >= s && m.index < e)) continue
    const named = /\bname\s*=\s*["']?([\w.:\-]+)["']?/i.exec(m[1])
    const tag = /<name>\s*([\w.:\-]+)\s*<\/name>/i.exec(m[2])
    const name = named !== null ? named[1] : (tag !== null ? tag[1] : '')
    if (name === '') continue
    const { args } = readParams(m[2], 0)
    calls.push({ name, arguments: JSON.stringify(args) })
    spans.push([m.index, m.index + m[0].length])
  }

  /* 结尾的半个标记：告诉调用方"还没完"，别当正文吐。 */
  if (spans.length === 0 && markerHoldStart(src) !== -1 && isMarkerPrefix(src.slice(markerHoldStart(src)))) {
    const tail = src.slice(markerHoldStart(src))
    /* 已是完整标记开头、但既没参数也没闭合 ⇒ 可能还在流里 */
    if (!/[\n]/.test(tail) && !/<\/parameter>|\/>/.test(tail)) complete = false
  }

  if (spans.length === 0) return { calls, clean: src, complete }

  spans.sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [s, e] of spans) {
    if (s < cursor) continue
    out += src.slice(cursor, s)
    cursor = e
  }
  out += src.slice(cursor)
  return { calls, clean: out, complete }
}

/** 只剥标记、不关心调用的便捷入口。 */
export function stripXmlToolMarkers(text) {
  return parseXmlToolCalls(text).clean
}

/* ==================== ③ 流式状态机 ==================== */

/** delta 层单块状态。 */
export function createEgressState() {
  return { started: false, pending: '', inThinking: false }
}

/**
 * 处理一个 text-delta。
 * @returns {{text:string, state:object, changed:boolean}}
 */
export function pushEgressDelta(state, delta, opts = {}) {
  const st = state ?? createEgressState()
  let buf = st.pending + (typeof delta === 'string' ? delta : '')
  st.pending = ''
  let out = ''
  let changed = false
  const thinking = opts.thinking !== false
  for (;;) {
    if (st.inThinking) {
      const close = buf.search(/<\/thinking>/i)
      if (close === -1) {
        const partial = /<\/?t?h?i?n?k?i?n?g?$/i.exec(buf)
        st.pending = partial === null ? '' : partial[0]
        return { text: out, state: st, changed: true }
      }
      buf = buf.slice(close + THINK_CLOSE.length)
      st.inThinking = false
      changed = true
      continue
    }
    if (!st.started) {
      if (thinking) {
        const open = THINK_OPEN_RE.exec(buf)
        if (open !== null) { buf = buf.slice(open[0].length); st.inThinking = true; changed = true; continue }
        if (/^\s*<[a-z]*$/i.test(buf)) { st.pending = buf; return { text: out, state: st, changed } }
      }
      st.started = true
    }
    const hold = findMarkerStart(buf)
    if (hold === -1) { out += buf; return { text: out, state: st, changed } }
    const tail = buf.slice(hold)
    const parsed = parseXmlToolCalls(tail)
    if (parsed.clean !== tail) {
      /* 完整标记段：剥掉。（convert 模式不在这里产出调用 —— 调用要按**整块**的完整
         文本重建，delta 层只有片段，早转会把参数截断。真正的转换在 block-end。） */
      out += buf.slice(0, hold) + parsed.clean
      changed = true
      return { text: out, state: st, changed }
    }
    /* 没解析出完整段：只要尾部**还可能是标记的一部分**（含标记已出现但参数还没写完），
       就整段缓冲等后续 delta，绝不当正文吐出去。 */
    if (isMarkerPrefix(tail) || parsed.complete === false) { st.pending = tail; return { text: out, state: st, changed } }
    out += buf
    return { text: out, state: st, changed }
  }
}

/**
 * 块结束（或一次性拿到完整文本）时的最终处理。
 * 注意：block-end 的 `block.text` 是**完整文本**，不是增量 —— 所以这里从零重算，
 * 不与 delta 层的 pending 拼接（上一轮那样拼会把前缀重复一遍）。
 *
 * @param {string} fullText - 该块的完整正文
 * @param {{thinking?:boolean, xmlTools?:string, allowConvert?:boolean}} opts
 *   —— 归一化后的选项（不是 heal options 原文，见 normalizeOptions()）
 * @returns {{text:string, calls:{name:string,arguments:string}[], parts:string[]}}
 */
export function finalizeEgressText(fullText, opts = {}) {
  let text = typeof fullText === 'string' ? fullText : ''
  const parts = []
  if (opts.thinking !== false) {
    const r = stripLeadingThinking(text)
    if (r.changed) { text = r.text; parts.push('thinking') }
  }
  const parsed = parseXmlToolCalls(text)
  if (parsed.clean !== text) { text = parsed.clean; parts.push('xml-markers') }
  const convert = opts.xmlTools === 'convert' && opts.allowConvert === true && parsed.calls.length > 0
  let calls = convert ? parsed.calls : []
  /**
  * 自然语言调用（全局版，2026-10-21 重建——第六批版本灾后丢失）：
  * KB 协议 > 通用工具协议 > 不翻。命中时正文置空（人话不重复显示），
  * 产出 tool-call 块由流包装层发射（reason 同步改 tool-calls）。
  * 与 .txt 出口不冲突：NL 在【回复端】翻译，.txt 在【发送端】打包——不同端。
  */
  if (calls.length === 0 && opts.nlUtterance?.enabled === true) {
    const hit = translateUtterance(text, opts.tools ?? [], {
      kb: opts.nlUtterance.kb !== false,
      nl: opts.nlUtterance.nl === true,
    })
    if (hit !== null) {
      calls = [hit]
      text = ''
      parts.push('nl-utterance')
      egressStats.nlUtterances += 1
    }
  }
  return { text, calls, parts }
}

/**
 * 把 heal options（用户设置）归一成流处理用的选项对象。
 * 单独一个函数是为了**字段名只在一处映射** —— 之前 delta 层用 `opts.thinking`、
 * finalize 用 `opts.xmlToolCalls`，两边对不上导致 convert 静默失效（单测抓到过）。
 */
export function normalizeEgressOptions(raw = {}) {
  return {
    thinking: raw?.egressThinking !== false,
    xmlTools: raw?.egressXmlTools === 'convert' ? 'convert' : (raw?.egressXmlTools === 'off' ? 'off' : 'strip'),
    /* NL 协议全局开关（真源 webin config 的 kbProtocol/nlToolProtocol——同排钮控制两道）。 */
    kbProtocol: raw?.kbProtocol !== false,
    nlToolProtocol: raw?.nlToolProtocol === true,
    /* 入口三件套（2026-10-24 用户点名单）：chatOnly（API 通道纯聊天：进 provider 前清 tools） */
    chatOnly: raw?.chatOnly === true,
    /* NL 教学（API 通道模型不知道 NL 句式——system 里注入一句式说明，仅 nlToolProtocol 开时） */
    nlTeach: raw?.nlToolProtocol === true && raw?.kbProtocol !== false,
    /* [2026-10-29 按钮优先级·工具目录层]（用户清单第 4/5 条）：
     * kbTrim   = KB 开 且 通用 NL 非开 ⇒ 目录只留知识库工具
     * noKbTrim = 通用 NL 开 且 KB 显式关 ⇒ 目录去掉知识库工具
     * 两个标志只由 readHealOptions 从 webin config 的【显式布尔】算出（见 index.js），
     * 缺省/文件缺失一律 false ⇒ 绝不从 kbProtocol 的默认值推断裁剪——防默认态丢光工具。 */
    kbTrim: raw?.kbTrim === true,
    noKbTrim: raw?.noKbTrim === true,
    /* 中文工具名（用户点名「调用时用汉字代替不要漏名字」）：目录与翻译层双向映射 */
    zhToolNames: raw?.zhToolNames === true,
  }
}

/* ==================== ③½ 按钮优先级·工具目录裁剪（2026-10-29） ====================
 * 用户清单第 4/5 条 + 10-25 铁律「上对下有优先级，因为有的功能互斥」：
 *   纯聊天（chatOnly）            > 全清（已有逻辑，最高优先）
 *   知识库 NL（kbProtocol 开）     > 目录只留知识库工具（knowledge_* + archives_search）
 *   通用 NL（nlToolProtocol 开）   > KB 显式关时目录去掉知识库工具，其余全留
 *   都开 ⇒ 全留；都关/缺省 ⇒ 全留（不裁）。
 * 裁剪只改【传给 provider 的目录副本】，宿主原对象与工具对象一律不动；
 * 压缩/标题请求豁免（与 chatOnly 同规）。
 */

/** 知识库工具判定：第一层 knowledge_* + 第二层 archives_search（KB 句式能翻译到的全部目标）。 */
export function isKnowledgeTool(name) {
  if (typeof name !== 'string' || name === '') return false
  return name === 'archives_search' || name.startsWith('knowledge_')
}

/** 目录裁剪模式：'kb-only' | 'no-kb' | 'none'。只认显式标志，绝不从默认值推断。 */
export function resolveToolTrimMode(eo) {
  if (eo?.kbTrim === true) return 'kb-only'
  if (eo?.noKbTrim === true) return 'no-kb'
  return 'none'
}

/** 按模式裁剪目录，恒返回新数组（原数组与工具对象一律不动）。 */
export function filterToolCatalogByMode(tools, mode) {
  const list = Array.isArray(tools) ? tools : []
  if (mode === 'kb-only') return list.filter((t) => t !== null && typeof t === 'object' && isKnowledgeTool(t.name))
  if (mode === 'no-kb') return list.filter((t) => !(t !== null && typeof t === 'object' && isKnowledgeTool(t.name)))
  return list.slice()
}

/* ==================== ④ 安装 ==================== */

/**
 * 把出口规范化挂到 `llm/stream` 瀑布上（provider 收到 options、产出 chunk 的唯一必经点）。
 * @param {object} ctx - cordis 上下文
 * @param {object} config - 插件 config（`egressNormalize: false` 可整体关掉；`egressProviders` 追加网页端路由名单）
 * @param {{log?:Function, readOptions?:Function}} deps - 依赖注入（避免循环 import）
 * @returns {boolean} 是否安装成功
 */
export function installEgressNormalizer(ctx, config = {}, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const readOptions = typeof deps.readOptions === 'function' ? deps.readOptions : () => ({})
  if (config?.egressNormalize === false) {
    log('egress normalizer: disabled (config.egressNormalize === false)')
    return false
  }
  const llm = ctx?.llm ?? (typeof ctx?.get === 'function' ? ctx.get('llm') : undefined)
  if (llm === undefined || llm === null) { log('egress normalizer: llm unavailable'); return false }
  if (llm[EGRESS_NORMALIZER] === true) return true
  const extraRoutes = Array.isArray(config?.egressProviders) ? config.egressProviders : []
  try {
    ctx.effect(function* () {
      yield ctx.on('llm/stream', function (options, next) {
        let opts
        try { opts = readOptions() ?? {} } catch { opts = {} }
        const scope = opts.egressScope ?? 'all'
        if (scope === 'off') return next()
        if (scope === 'web' && !isWebRoute(options?.provider, extraRoutes)) {
          egressStats.skippedByScope += 1
          return next()
        }
        /**
        * ## 入口改造（2026-10-24 用户点名单，llm/stream 瀑布在 next() 前改 options）：
        *
        * ① chatOnly（API 通道纯聊天）：true ⇒ tools 清空——模型收不到任何工具定义，
        *    自然退化成纯聊天。LDW 车道不受影响（webin 自己有 lite-chat 预设）。
        *    ⚠️ 独立开关（webin config.chatOnly），关=零影响。压缩请求/标题请求不清
        *    （那些不带工具本来也不受影响，但明确跳过防误伤）。
        *
        * ② nlTeach（API 通道 NL 教学）：LDW 有 TOOL_PROTOCOL 教模型句式，API 通道裸的
        *    ——模型不知道可以说「我要调动第一层知识库，搜索XX」。在 system 尾部
        *    注入一小段句式说明（只有 kb/nl 开关开着才注）。
        *
        * ③ zhToolNames（中文工具名）：工具目录里给模型看的名字/描述换成中文优先
        *    （真名保留在 name 字段——API 的 function calling 调用时还是用真名，
        *    description 前缀加「中文名」标注让模型知道两个名字等价）。
        *    回复端的 NL 翻译层同步认中文名（translateUtterance 收到「我要用工具 读取文件」
        *    能翻回 read）。
        */
        const eo = normalizeEgressOptions(opts)
        if (options !== null && typeof options === 'object') {
          const purpose = String(options.purpose ?? '')
          /**
           * 🔥 2026-10-25 根因修复：cordis waterfall 的 next() 是无参闭包——
           * `(cbs.shift() ?? inner)(...args)`，args 里的 options 是【原始对象引用】。
           * 之前 `options = { ...options, ... }` 只改局部变量（新对象传给下游=从没发生），
           * 用户实测三件套全失效（c8bdf267：教学没进 system/目录没中文名/tools 没清）。
           * 修法：**原位 mutate** options 对象——瀑布下游（provider）持有的同一引用。
           */
          /* 🔥 2026-10-25 二次修复（session-beae66b3 实证）：options 可能被宿主冻结
           * （Object.freeze/deepFreeze——beae66b3 turn 105/106 连环
           * `Cannot add property system, object is not extensible` 就是 488 行裸写
           * 冻结 options 炸的，整轮 turn 死掉会话发不出消息）。
           * 修法与 inject.js 同款 fail-open：可扩展 → 原位 mutate（下游同引用）；
           * 冻结 → 退化为局部副本（下游拿不到教学，但轮次绝不崩——
           * 教学文案是增值不是命脉，inject.js 的哲学在这里同样适用）。 */
          /* 🔥 2026-10-26 晚定案（用户子代理实测铁证）：宿主 agent-loop 在 L1269
           * `Object.freeze({...header.config, ...})` 把整个 request options 深冻结后
           * 才进 llm/stream 瀑布——【原位 mutate 永远不可能】（Object.isExtensible=false
           * 恒走副本，副本改动传不到 provider）。此前 stats 涨是 handler 在跑的假象。
           *
           * 真解：【接管 inner 调用】。瀑布 handler 不再 next() 放行原始 options，
           * 而是 next() 后拿到流、并自己用【改写后的副本 options】重新调用
           * ……不行——next() 内部才真正调 provider，无法二次调用。
           *
           * 唯一可行：**cordis 瀑布 args 传引用**——waterfall(...args) 的 args 数组
           * 持有 options 引用，下游 (cbs.shift()||inner)(...args) 展开的也是同一引用。
           * 冻结的是 options 对象本身的属性树，但【args 数组本身可改】！
           * handler 收到的第二参数 next 闭包捕获 args——handler 无法改 args……
           *
           * ⭐ 真正能用的位：宿主 streamWithRegistration(options, prepared) 的
           * prepared.stream(options) —— 瀑布 innermost 是 adapterStream(options, prepared)。
           * 传给 provider 的就是瀑布收到的 options 引用。所以：**改不了对象，
           * 但可以改的是【adapter 收到的消息内容】**——不行，同样在 options 里。
           *
           * ⭐⭐ 最终落地：教学/中文名只在【options 可扩展】时生效（保底场景），
           * 冻结时改走【回复端补】，即在 normalizeEgressStream 的 text 块尾部追加
           * 教学提示？——污染正文，不行。
           *
           * ⭐⭐⭐ 唯一正解（本轮实现）：**包装 inner 适配器路径**——替换
           * prepared.stream：在 next() 前把瀑布里的 options 换成可变副本，
           * 内层 adapterStream 用副本调用。但 next() 无参不可传……
           * → 检查 cordis waterfall 源码（lib/index.js L317-325）：
           *   next = () => (cbs.shift() ?? inner)(...args) —— args 是闭包数组，
           *   handler 收到的 options 就是 args[0]。【args 数组没被冻结】，
           *   但 handler 拿不到 args 本体（只拿到展开值）。
           * → 结论：**修改 args 不可能，mutate 冻结对象不可能** ⇒
           *   在 egress 层对冻结请求的教学/中文名【物理上不可行】。
           *   保持 fail-open 副本（至少 thinking 剥离等流层功能不受影响），
           *   并在 stats 旁标记 frozenSkipped，让「为什么没生效」可观测。
           */
          const optionsMutable = options !== null && typeof options === 'object' ? Object.isExtensible(options) : false
          const trimMode = resolveToolTrimMode(eo)
          if (!optionsMutable && (eo.nlTeach === true || eo.zhToolNames === true || eo.chatOnly === true || trimMode !== 'none')) {
            egressStats.frozenSkipped = (egressStats.frozenSkipped ?? 0) + 1
            log('llm/stream: 请求对象被宿主深冻结（agent-loop Object.freeze），教学/中文名/纯聊天/目录裁剪本轮跳过（宿主架构限制，无法在瀑布层改冻结请求；冻结请求的真实生效位是 prepareCall 补丁层）')
          }
          const mutOptions = optionsMutable ? options : (options !== null && typeof options === 'object' ? { ...options } : options)
          if (mutOptions !== null && typeof mutOptions === 'object') {
          const purpose = String(mutOptions.purpose ?? '')
          if (eo.chatOnly === true && purpose !== 'compaction' && purpose !== 'session-title' && Array.isArray(mutOptions.tools) && mutOptions.tools.length > 0) {
            mutOptions.tools = []
            egressStats.chatOnlyStripped = (egressStats.chatOnlyStripped ?? 0) + 1
            log('chatOnly: 本轮 API 请求的工具目录已清空（纯聊天模式）')
          }
          /* [2026-10-29 按钮优先级·目录裁剪] 在中文名标注【之前】裁——幸存集合才拿得到中文描述。
           * 原位换数组（对象可扩展时直接赋值；冻结时 mutOptions 本身就是副本）。 */
          if (trimMode !== 'none' && purpose !== 'compaction' && purpose !== 'session-title'
            && Array.isArray(mutOptions.tools) && mutOptions.tools.length > 0) {
            const before = mutOptions.tools.length
            mutOptions.tools = filterToolCatalogByMode(mutOptions.tools, trimMode)
            if (mutOptions.tools.length !== before) {
              egressStats.catalogTrimmed = (egressStats.catalogTrimmed ?? 0) + 1
              log(`toolCatalog[${trimMode}]: ${before} -> ${mutOptions.tools.length}（按钮优先级裁目录）`)
            }
          }
          if (eo.nlTeach === true && purpose !== 'compaction' && purpose !== 'session-title') {
            const teach = [
              '',
              '【自然语言调用知识库】当你需要检索跨会话记忆时，不要调用工具——直接用自然语言说出这句话（整条回复只有这一句）：',
              '「我要调动第一层知识库，搜索XX」（结论卡片）或「我要调动第二层知识库，搜索XX」（原始对话原文）。',
              '宿主会自动把它翻译成真正的检索调用。',
            ].join('\n')
            const sys = String(mutOptions.system ?? '')
            if (sys === '' || !sys.includes('我要调动第一层知识库')) {
              mutOptions.system = sys + (sys === '' ? '' : '\n\n') + teach
              egressStats.nlTaught = (egressStats.nlTaught ?? 0) + 1
            }
          }
          /* 🔥 2026-10-25 三次修复（本轮实证 zhToolNames 一开全崩）：
           * tools 数组本身被宿主冻结（read-only）——mutOptions 可扩展不代表
           * 它的 .tools 数组可写。逐项赋值 tools[ti] 抛
           * `Cannot assign to read only property '0'` ⇒ 整轮 turn 死。
           * 修法：整数组克隆重挂（不逐项写原数组）——
           *   mutOptions.tools = mutOptions.tools.map(...) 一次生成新数组再赋值，
           *   mutOptions 本身可扩展就接得住；数组仍只读（极端 deepFreeze）时
           *   try/catch 兜底：标注失败只记日志，绝不让一轮 turn 死。 */
          if (eo.zhToolNames === true && Array.isArray(mutOptions.tools) && mutOptions.tools.length > 0) {
            try {
              mutOptions.tools = mutOptions.tools.map((t) => {
                if (t === null || typeof t !== 'object') return t
                const zh = zhToolName(t.name)
                if (zh === t.name) return t
                /* 2026-10-26 用户点名「为什么还有英文工具名」——中文描述完全替换英文
                 * description（name 字段保留英文真名供 function calling；没映射的退回原文）。 */
                const zhDesc = ZH_TOOL_DESCRIPTIONS[t.name]
                return { ...t, description: typeof zhDesc === 'string' && zhDesc !== '' ? zhDesc : String(t.description ?? '') }
              })
              egressStats.zhLocalized = (egressStats.zhLocalized ?? 0) + 1
            } catch (e) {
              log('zhToolNames: 工具数组只读，本轮跳过中文名（不影响发送）: ' + String(e?.message ?? e).slice(0, 80))
            }
          }
          }
        }
        const inner = next()
        return normalizeEgressStream(inner, options, eo, log)
      })
    }, 'adapter-compat: egress normalizer')
  } catch (e) {
    log('egress normalizer: hook failed: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
  try { Object.defineProperty(llm, EGRESS_NORMALIZER, { value: true }) } catch { /* ignore */ }
  log('egress normalizer: installed')
  return true
}

/** 包一层流：思考剥离 + XML 标记归一。
 * @param opts - **已归一化**的选项（{thinking, xmlTools}，见 normalizeEgressOptions）
 */
function normalizeEgressStream(inner, options, opts, log) {
  const xmlMode = opts.xmlTools
  const allowConvert = xmlMode === 'convert' && options?.purpose !== 'compaction'
  const stripMarkers = xmlMode !== 'off'
  const toolNames = new Set((Array.isArray(options?.tools) ? options.tools : [])
    .map((t) => (t === null || typeof t !== 'object' ? '' : t.name))
    .filter((n) => typeof n === 'string' && n !== ''))
  return (async function* () {
    const states = new Map()
    let maxIndex = -1
    let converted = 0
    let logged = false
    /**
    * NL 协议选项（2026-10-21 重建）：压缩请求/空工具目录不翻——
    * 与 .txt 出口互不干扰（NL 翻译在回复端，.txt 在发送端）。
    */
    const nlUtteranceOpts = options?.purpose === 'compaction' || toolNames.size === 0
      ? { enabled: false }
      : { enabled: true, kb: opts.kbProtocol !== false, nl: opts.nlToolProtocol === true }
    for await (const chunk of inner) {
      if (chunk === null || typeof chunk !== 'object') { yield chunk; continue }
      if (typeof chunk.index === 'number' && chunk.index > maxIndex) maxIndex = chunk.index

      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        if (!stripMarkers) { yield chunk; continue }
        const key = chunk.index ?? 0
        const r = pushEgressDelta(states.get(key) ?? createEgressState(), chunk.text, opts)
        states.set(key, r.state)
        if (r.changed && !logged) {
          logged = true
          log('egress normalizer: 正文里出现思考/工具标记，已按出口规则处理')
        }
        if (r.text === '') continue
        yield { ...chunk, text: r.text }
        continue
      }

      if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
        const key = chunk.index ?? 0
        states.delete(key)
        const f = finalizeEgressText(chunk.block.text, { ...opts, xmlTools: stripMarkers ? opts.xmlTools : 'off', allowConvert, tools: options?.tools ?? [], nlUtterance: nlUtteranceOpts })
        yield { ...chunk, block: { ...chunk.block, text: f.text } }
        if (f.parts.includes('thinking')) egressStats.thinkingStripped += 1
        if (f.parts.includes('xml-markers')) egressStats.markersDropped += 1
        /** NL 命中与 XML convert 共用「产调用 + reason→tool-calls」出口。 */
        const usable = allowConvert
          ? f.calls.filter((c) => toolNames.has(c.name))
          : f.calls.filter((c) => toolNames.has(c.name) && f.parts.includes('nl-utterance'))
        for (const call of usable) {
          const idx = ++maxIndex
          const id = `call_egress_${idx}_${Math.random().toString(36).slice(2, 10)}`
          yield { type: 'block-start', index: idx, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: idx, id, name: call.name, argumentsDelta: call.arguments }
          yield { type: 'block-end', index: idx, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
          converted += 1
        }
        continue
      }

      /* 真的转换出了工具调用 ⇒ 终止原因必须从 stop 改成 tool-calls，
         否则主循环（dsh-agent-loop）不会去执行它们。 */
      if (chunk.type === 'finish' && converted > 0 && chunk.reason?.kind === 'stop') {
        egressStats.xmlToolCalls += converted
        log(`egress normalizer: XML 工具调用转成 tool-call 块 ${converted} 个（reason → tool-calls）`)
        yield { ...chunk, reason: { kind: 'tool-calls' } }
        continue
      }
      if (chunk.type === 'finish') {
        if (converted > 0) egressStats.xmlToolCalls += converted
        converted = 0
      }
      yield chunk
    }
  })()
}