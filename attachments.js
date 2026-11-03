/**
 * 附件/图片失效兜底（2026-10-17）
 *
 * 背景（实测）：附件对象是内容寻址的，磁盘上只要缺了那个 sha256 对象，
 * `attachments.imageHostPath(ref)` 返回的路径就不存在 →
 *   - 官方 DeepSeek：`readImageRequest` → ENOENT → ATTACHMENT_NOT_FOUND，
 *     整轮请求失败（不是「模型看不到图」，是发都发不出去）；
 *   - 第三方纯文本路由：图片块直接 `[image unavailable]`，白烧 token。
 *
 * 原来的 isBrokenAttachmentBlock 只查**结构**残缺（attachment / attachmentId 缺失），
 * 所以「结构完好但字节没了」的引用照旧放行 → 这就是「占位符没生效、官方 API 拒收」的真因。
 * 实证：session-afa6ba0b 的截图 attachmentId=sha256:0f7034b2…，结构完好，
 * 但 attachments/v1/objects/0f/ 下没有那个对象。
 *
 * 判据分两层：
 *   ① 结构（attachment / attachmentId 存在且非空）
 *   ② 字节（能定位到主机路径、文件存在且非空）
 * 定位优先走宿主附件服务（`imageHostPath` / `fileHostPath`）；服务拿不到时按
 * dsh-attachment-local 的固定布局推断（`<home>/attachments/v1/objects/<xx>/<sha>` 等）。
 *
 * 失效块 → 占位文本（保留位置语义：正文里留一行说明，比整块悄悄消失好排查）。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

/** attachmentId → 磁盘对象名（`sha256:ab12…` → `ab12…`；其他形态原样返回）。 */
export function attachmentObjectName(ref) {
  const id = typeof ref?.attachmentId === 'string' ? ref.attachmentId : ''
  if (id === '') return ''
  return id.startsWith('sha256:') ? id.slice(7) : id
}

/**
 * 按宿主本地附件库的布局推断主机路径（服务不可用时的退路）。
 *
 * 只在 `<home>/attachments/v1` 这个库根确实存在时才推断 —— 布局推断是「猜」，
 * 宿主哪天换了存储后端/目录结构，猜错会把**好图**误判成失效。库根不存在
 * （= 这台机器根本没在用本地附件库）就返回 undefined，让调用方退回结构校验。
 * @param {{home?:string, block:object, ref:object}} args
 * @returns {string|undefined}
 */
export function fallbackHostPath({ home, block, ref } = {}) {
  if (typeof home !== 'string' || home === '') return undefined
  const name = attachmentObjectName(ref)
  if (name === '') return undefined
  const root = join(home, 'attachments', 'v1')
  try {
    if (!statSync(root).isDirectory()) return undefined
  } catch { return undefined }
  const shard = name.slice(0, 2)
  if (block?.type === 'image') return join(root, 'objects', shard, name)
  if (block?.type === 'file') {
    const display = typeof ref?.name === 'string' && ref.name !== '' ? ref.name : name
    return join(root, 'files', shard, name, display)
  }
  return undefined
}

/** 附件块 → 主机路径：服务优先，布局推断兜底。 */
function hostPathOf({ attachments, home, block, ref }) {
  const hasService = attachments && typeof attachments === 'object'
  if (hasService) {
    try {
      if (block.type === 'image' && typeof attachments.imageHostPath === 'function') {
        const p = attachments.imageHostPath(ref)
        if (typeof p === 'string' && p !== '') return { path: p, via: 'service' }
      }
      if (block.type === 'file' && typeof attachments.fileHostPath === 'function') {
        const p = attachments.fileHostPath(ref)
        if (typeof p === 'string' && p !== '') return { path: p, via: 'service' }
      }
    } catch { /* 非法引用：宿主自己会抛 AttachmentError，这里当作不可用 */ }
    /* 服务在、却给不出路径：引用本身非法（不是「没法校验」）。 */
    return { path: undefined, via: 'service' }
  }
  const viaLayout = fallbackHostPath({ home, block, ref })
  return viaLayout === undefined ? { path: undefined, via: 'none' } : { path: viaLayout, via: 'layout' }
}

/**
 * 这个附件块的字节是否确实可用。
 * @param {object} options
 * @param {object} [options.attachments] - 宿主 attachments 服务
 * @param {string} [options.home] - DSH 主目录（服务不可用时按布局推断）
 * @param {object} options.block - image / file 内容块
 * @param {boolean} [options.structuralOnly] - true = 只查结构（旧行为）
 * @returns {{ok:boolean, reason?:string, path?:string}}
 *   reason='unverifiable' 表示「这台机器没有可校验的附件库」——按可用放行，
 *   避免宿主换存储后端时把好图误判成失效。
 */
export function attachmentAvailability({ attachments, home, block, structuralOnly } = {}) {
  if (!block || typeof block !== 'object') return { ok: false, reason: 'block' }
  const ref = block.attachment
  if (!ref || typeof ref !== 'object') return { ok: false, reason: 'attachment' }
  const id = ref.attachmentId
  if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: 'attachmentId' }
  if (structuralOnly === true) return { ok: true }
  const hasService = attachments && typeof attachments === 'object'
  const hasHome = typeof home === 'string' && home !== ''
  /* 既没服务也没主目录：无从校验字节，保持旧行为（只查结构）。 */
  if (!hasService && !hasHome) return { ok: true, reason: 'unverifiable' }
  const located = hostPathOf({ attachments: hasService ? attachments : undefined, home, block, ref })
  if (typeof located.path !== 'string' || located.path === '') {
    /* 服务在但引用非法 → 不可用；没有可校验的库 → 放行（见 reason 说明）。 */
    return located.via === 'none' ? { ok: true, reason: 'unverifiable' } : { ok: false, reason: 'hostPath' }
  }
  try {
    const st = statSync(located.path)
    if (!st.isFile() || st.size === 0) return { ok: false, reason: 'bytes', path: located.path }
  } catch { return { ok: false, reason: 'missing', path: located.path } }
  return { ok: true, path: located.path }
}

/** 失效附件块 → 占位文本块（纯 ASCII，与 WIRE_PLACEHOLDER 同一惯例）。 */
export function placeholderForBlock(block, placeholder) {
  const kind = block?.type === 'file' ? 'file' : 'image'
  return { type: 'text', text: `[${placeholder}] [${kind} unavailable]` }
}

/**
 * 盘上事件层的失效附件修复（纯函数，不碰文件；调用方负责备份/校验/原子写）。
 *
 * 与出口守卫（wire-tap 的 guardRequestMessages）同语义，但作用在**存盘事件**上：
 * 出口守卫只保住「这一轮能发出去」，历史里那颗坏附件仍在，下次压缩/分叉/换路由
 * 还会再撞一次。这里一次性把盘上的坏引用换成占位。
 *
 * @param {object[]} events
 * @param {{attachments?:object, home?:string, placeholder?:string}} [deps]
 * @returns {{events:object[], healed:{seq:number,eventType:string,blockType:string,attachmentId:string,reason:string}[], alreadyHealthy:boolean}}
 */
export function healDeadAttachments(events, deps = {}) {
  const healed = []
  if (!Array.isArray(events)) return { events: events ?? [], healed, alreadyHealthy: true }
  const placeholder = typeof deps.placeholder === 'string' ? deps.placeholder : '[NaN]'
  /* 同一个块对象可能同时挂在 data.content 与 data.message.content 上（宿主两种形态都写过），
     按对象身份去重，避免同一颗坏附件在报告里出现两次。 */
  const seen = new WeakSet()
  const walkContent = (content, event) => {
    if (!Array.isArray(content)) return content
    let changed = false
    const next = content.map((block) => {
      if (block?.type !== 'image' && block?.type !== 'file') return block
      const verdict = attachmentAvailability({ attachments: deps.attachments, home: deps.home, block })
      if (verdict.ok) return block
      changed = true
      if (!seen.has(block)) {
        seen.add(block)
        healed.push({
          seq: event?.seq,
          eventType: event?.type,
          blockType: block.type,
          attachmentId: String(block?.attachment?.attachmentId ?? ''),
          reason: verdict.reason ?? 'unknown',
        })
      }
      return placeholderForBlock(block, placeholder)
    })
    return changed ? next : content
  }

  const fixed = events.map((event) => {
    if (!event || typeof event !== 'object') return event
    const data = event.data
    if (!data || typeof data !== 'object') return event
    let touched = false
    const nextData = { ...data }
    /* ① user/message、tool/result、system/message：正文在 data.content 或 data.message.content */
    const direct = walkContent(data.content, event)
    if (direct !== data.content) { nextData.content = direct; touched = true }
    if (data.message && typeof data.message === 'object') {
      const inner = walkContent(data.message.content, event)
      if (inner !== data.message.content) { nextData.message = { ...data.message, content: inner }; touched = true }
    }
    /* ② agent/inbox/spliced：投递记录（data.inserted[] 每条是 message 形态）。
       实测残留就在这里（2026-10-17：4 颗缺失图全在 .data.inserted[].content[]）——
       它不直接进请求（请求走 user/message 投影），但宿主一旦按 splice 重放 inbox
       就会把坏引用重新搬回表面，所以一并清掉。只换 content 里的块类型，
       不动 inserted 的长度/顺序/id/source（inbox 链校验看的是 seq 链与 id）。 */
    if (Array.isArray(data.inserted)) {
      let insertedChanged = false
      const inserted = data.inserted.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry
        const c = walkContent(entry.content, event)
        if (c === entry.content) return entry
        insertedChanged = true
        return { ...entry, content: c }
      })
      if (insertedChanged) { nextData.inserted = inserted; touched = true }
    }
    /* ③ session/title-llm-request：请求快照（data.messages[]）。同 ② 的理由。 */
    if (Array.isArray(data.messages)) {
      let messagesChanged = false
      const messages = data.messages.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry
        const c = walkContent(entry.content, event)
        if (c === entry.content) return entry
        messagesChanged = true
        return { ...entry, content: c }
      })
      if (messagesChanged) { nextData.messages = messages; touched = true }
    }
    return touched ? { ...event, data: nextData } : event
  })
  return { events: fixed, healed, alreadyHealthy: healed.length === 0 }
}
