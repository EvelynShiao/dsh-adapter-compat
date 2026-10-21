/**
 * nl-utterance.js 重建（2026-10-21——第六批写于 node_modules 运行版，灾后 git 重建时丢在仓库外）
 *
 * 功能不变：全局自然语言协议翻译层（adapter-compat 的 llm/stream egress 管道挂载）。
 * 照知识库 k-6edae5dc 的设计重建，且对齐 webin 版的锚点白名单判据
 * （2026-10-20 单测迭代三轮定案：锚点必须为 0 或前导只含语气词）。
 */

/** 句式锚点前导白名单（语气词/标点——「关于」这类实义词不翻）。 */
const UTTERANCE_LEADINS = /^[嗯等稍让我想想下啊哦呃呀好，。,.!！？?\s]{0,8}$/u;

/** 知识库两层句式。 */
export function translateKbUtterance(text, toolNames) {
  const t = String(text ?? '').trim()
  if (t === '' || t.length > 400) return null
  const anchor = t.search(/我要调动(第一层|第二层)知识库/u)
  if (anchor < 0) return null
  if (anchor > 0 && !UTTERANCE_LEADINS.test(t.slice(0, anchor))) return null
  const m = t.slice(anchor).match(/^我要调动(第一层|第二层)知识库[，,、\s]*(?:搜索|查|查查|找找?|检索)\s*(.+?)\s*$/u)
  if (m === null) return null
  const query = m[2].replace(/[。.！!？?～~「」"'"']+\s*$/u, '').trim()
  if (query === '' || query.length > 200) return null
  const tool = m[1] === '第一层' ? 'knowledge_search' : 'archives_search'
  if (!toolNames.has(tool)) return null
  return { name: tool, arguments: JSON.stringify({ query }) }
}

/** 通用工具句式（动态映射）。 */
export function translateToolUtterance(text, tools) {
  const t = String(text ?? '').trim()
  if (t === '' || t.length > 240) return null
  const anchor = t.search(/我要(?:用工具|调用|使用)\s*[A-Za-z_]/u)
  if (anchor < 0) return null
  if (anchor > 0 && !UTTERANCE_LEADINS.test(t.slice(0, anchor))) return null
  const rest = t.slice(anchor)
  const m = rest.match(/^我要(?:用工具|调用|使用)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*[，,、]?\s*(?:参数\s*)?(.+?)\s*$/u)
  if (m === null) return null
  const tool = (Array.isArray(tools) ? tools : []).find((x) => x?.name === m[1])
  if (tool === undefined) return null
  let raw = m[2].trim()
  if (raw.startsWith('{')) {
    const last = raw.lastIndexOf('}')
    if (last > 0) raw = raw.slice(0, last + 1)
  } else {
    const params = tool.parameters ?? {}
    const required = Array.isArray(params.required) ? params.required : []
    if (required.length !== 1) return null
    raw = JSON.stringify({ [required[0]]: raw.replace(/^["']|["']$/g, '') })
  }
  try {
    const args = JSON.parse(raw)
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
    return { name: tool.name, arguments: JSON.stringify(args) }
  } catch { return null }
}

/** 两层按序尝试（KB 优先）。 */
export function translateUtterance(text, tools, { kb = true, nl = false } = {}) {
  const names = new Set((Array.isArray(tools) ? tools : []).map((t) => t?.name))
  if (kb) {
    const hit = translateKbUtterance(text, names)
    if (hit !== null) return hit
  }
  if (nl) return translateToolUtterance(text, tools)
  return null
}

/** 流式缓冲判据：块开头像句式前缀就缓冲到 block-end 再判。 */
export function looksLikeUtteranceStart(text) {
  const t = String(text ?? '').trim()
  if (t === '') return false
  return t.length <= 64 && /^我要/.test(t)
}
