/**
 * dsh-adapter-compat/head-guard.js — 受保护系统头守卫
 *
 * ============ 症状 ============
 *   历史加载失败：stored session "session-xxx" is corrupt:
 *     system/message requires a protected first surface head
 *   整条会话打不开，/compact、续聊、导出全废。
 *
 * ============ 根因 ============
 *   dsh-session-format-v3-to-v4 的表层状态机（Relationships.foldSurface）只认一种
 *   合法头：**首个 append 到空表层的 system/message**（node 0，受保护）。之后
 *   compact 替换/外科切除只要把这颗 system 拔掉，"无头" 状态本身**能读**——
 *   但下一轮系统提示词一变（换模型、工具集变化、startsSeries），宿主 agent-loop 的
 *   SystemPromptProjection 会往表层 append 一条新的 system/message，而这时表层
 *   非空 + 没有受保护头 → 落盘的就是一份**再也读不回来**的日志。
 *
 *   excise/purge 的旧"头序自愈"正是在这一步做了最坏的选择：把**所有**
 *   system/message 一起删掉（认为"无头合法"）。合法是合法，脆弱也是真脆弱——
 *   会话就这么埋着，直到下一次提示词变化引爆。本模块补上正确的收尾：
 *   给它一颗受保护头（空内容占位），宿主的 project() 下一轮会用真实提示词把它替换掉。
 *
 * ============ 修法 ============
 *   1. diagnoseProtectedHead(events)：判定「首个表面节点是不是 system/message append」；
 *   2. insertProtectedHead(events)：在首个表面节点**之前**插一条空 system/message，
 *      并把其后所有 seq 与 seq 引用整体 +1（保持 seq 密集、引用自洽）；
 *   3. guardSessionFile(file)：读 → 诊断 → 插头 → verify（宿主规则移植版）→ 备份 → 安全写盘 → 读回复核。
 *
 *   live 会话绝不碰（内存事件数组与文件必须对齐），由调用方用 isSessionLive 挡住。
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { SEQ_REF_RULES, SURFACE_TYPES, readSession, verify, writeSession, zstdFrameLength } from './true-delete.js'

/** 判定用表面类型集合（与宿主一致）。 */
export const HEAD_SURFACE_TYPES = SURFACE_TYPES

/** 首个表面事件的下标；没有表面事件返回 -1。 */
export function firstSurfaceIndex(events) {
  for (let i = 0; i < events.length; i += 1) {
    if (SURFACE_TYPES.has(events[i]?.type)) return i
  }
  return -1
}

/**
 * 诊断受保护头。
 * @returns {{ok:boolean, reason:string, insertAt?:number, firstSurface?:object, illegalSeq?:number}}
 */
export function diagnoseProtectedHead(events) {
  const at = firstSurfaceIndex(events)
  if (at < 0) return { ok: true, reason: 'no-surface' }
  const first = events[at]
  if (first.type === 'system/message' && (first.surfaceOp === 'append' || first.surfaceOp === undefined)) {
    return { ok: true, reason: 'head-ok', headSeq: first.seq }
  }
  /* 顺带找出「表层非空却还没有受保护头」的后续 system/message —— 那是宿主的硬拒绝点 */
  let protectedSeq
  let surface = 0
  let illegalSeq
  for (const e of events) {
    if (!SURFACE_TYPES.has(e.type)) continue
    if (e.type === 'system/message' && surface > 0 && protectedSeq === undefined) { illegalSeq = e.seq; break }
    if (e.surfaceOp === 'append' || e.surfaceOp === undefined) {
      if (e.type === 'system/message' && surface === 0) protectedSeq = e.seq
      surface += 1
    } else if (surface === 0) surface = 1 /* 替换锚点必然落在已有节点上 */
  }
  return {
    ok: false,
    reason: illegalSeq === undefined ? 'head-missing' : 'head-missing+illegal-append',
    insertAt: at,
    firstSurface: { seq: first.seq, type: first.type },
    ...(illegalSeq === undefined ? {} : { illegalSeq }),
  }
}

const shiftNum = (v, at) => (typeof v === 'number' && v >= at ? v + 1 : v)

/** sourceEventSeqs 存储形（数字 / [start,end] 区间）整体右移。 */
function shiftSeqRanges(value, at) {
  if (!Array.isArray(value)) return value
  const out = []
  for (const entry of value) {
    if (typeof entry === 'number') { out.push(shiftNum(entry, at)); continue }
    if (!Array.isArray(entry) || entry.length !== 2) { out.push(entry); continue }
    const [s, e] = entry
    if (s >= at) out.push([s + 1, e + 1])
    else if (e >= at) out.push([s, at - 1], [at + 1, e + 1])
    else out.push([s, e])
  }
  return out
}

function shiftByRule(value, kind, at) {
  if (kind === 'ranges') return shiftSeqRanges(value, at)
  if (Array.isArray(value)) return value.map((v) => shiftNum(v, at))
  return shiftNum(value, at)
}

/** 按 SEQ_REF_RULES 逐条改写引用（绝不碰 data.start / JSON schema 里的同名字段）。 */
function shiftEventReferences(event, at) {
  for (const [path, rule] of Object.entries(SEQ_REF_RULES)) {
    const parts = path.split('.')
    let node = event
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (node === null || typeof node !== 'object') { node = undefined; break }
      node = node[parts[i]]
    }
    if (node === null || typeof node !== 'object') continue
    const key = parts[parts.length - 1]
    if (!Object.hasOwn(node, key)) continue
    node[key] = shiftByRule(node[key], rule.kind, at)
  }
  return event
}

/** 插入点之前仍打开的那个 step/start（system/message 必须归属一个打开的 step）。 */
function openStepBefore(events, index) {
  let open
  for (let i = 0; i < index; i += 1) {
    const e = events[i]
    if (e?.type === 'step/start') open = { turn: e.data?.turn, step: e.data?.step, time: e.time }
    else if (e?.type === 'step/end') open = undefined
  }
  return open
}

/**
 * 在首个表面节点前插一条空 system/message 作为受保护头，其后 seq 与全部引用整体 +1。
 * 空内容不是"没提示词"：宿主 project() 把它当占位头，下一轮会用渲染好的提示词替换掉它。
 * @param {object[]} events
 * @param {object} [diagnosis] - diagnoseProtectedHead 的结果（可省）
 * @returns {object[]} 新事件数组（seq 自 0 密集）
 */
export function insertProtectedHead(events, diagnosis) {
  const diag = diagnosis ?? diagnoseProtectedHead(events)
  if (diag.ok) return events
  const at = diag.insertAt ?? firstSurfaceIndex(events)
  if (at < 0) throw new Error('没有表面事件，无法定位受保护头的位置')
  const step = openStepBefore(events, at)
  if (step === undefined) throw new Error('插入点之前没有打开的 step/start，system/message 无处归属')
  const template = events.slice(at).find((e) => e.type === 'system/message')
  const source = template?.data?.message?.source ?? { kind: 'system-prompt' }
  const first = events[at]
  const head = {
    type: 'system/message',
    seq: at,
    time: Math.max(0, Number(events[at - 1]?.time ?? first?.time ?? 0) + 1),
    data: {
      turn: step.turn,
      step: step.step,
      message: {
        role: 'system',
        content: [],
        source: { ...source },
        id: `session-head-repair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      },
    },
    surfaceOp: 'append',
  }
  const out = []
  for (let i = 0; i < events.length; i += 1) {
    if (i === at) out.push(head)
    const e = events[i]
    if (i >= at) {
      shiftEventReferences(e, at)
      e.seq += 1
    }
    out.push(e)
  }
  return out
}

/** 解析「完整行」的前缀（尾部不完整的行丢弃；有任何坏行则返回 undefined）。 */
function parsePrefixEvents(text) {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.pop()
  const events = []
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && typeof parsed.seq === 'number') events.push(parsed)
    } catch {
      return undefined
    }
  }
  return events
}

/** 只读文件开头的一段（预筛用；整文件读在几十份会话上太贵）。 */
function readFilePrefix(file, maxBytes) {
  const fd = openSync(file, 'r')
  try {
    const size = Math.min(maxBytes, statSync(file).size)
    if (size <= 0) return Buffer.alloc(0)
    const buf = Buffer.allocUnsafe(size)
    const read = readSync(fd, buf, 0, size, 0)
    return buf.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * 便宜的预筛：只解前几帧，够看到首个表面节点就下结论。
 * 首个表面节点永远落在最前面的两三帧里（seq 个位数），所以只读文件开头即可。
 * @returns {object|undefined} diagnoseProtectedHead 结果；前缀看不到表面节点时返回 undefined（不下结论）
 */
export function probeProtectedHead(file, options = {}) {
  const maxFrames = Number.isFinite(options.maxFrames) ? options.maxFrames : 4
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 768 * 1024
  let buf
  try {
    buf = readFilePrefix(file, maxBytes)
  } catch {
    return undefined
  }
  const parts = []
  let at = 0
  for (let i = 0; i < maxFrames && at < buf.length; i += 1) {
    const len = zstdFrameLength(buf, at)
    if (len === null || len <= 0 || at + len > buf.length) break
    try {
      parts.push(zstdDecompressSync(buf.subarray(at, at + len)))
    } catch {
      return undefined
    }
    at += len
    const events = parsePrefixEvents(Buffer.concat(parts).toString('utf8'))
    if (events === undefined) continue
    if (firstSurfaceIndex(events) >= 0) return diagnoseProtectedHead(events)
  }
  return undefined
}

/**
 * 找「同段写了两遍」：连续 seq 原地重复一次（同步/写盘重试留下的痕迹）。
 * @returns {{firstStart:number, secondStart:number, length:number}|undefined} 下标区间
 */
export function findDuplicateBlock(events) {
  for (let i = 1; i < events.length; i += 1) {
    if (!(events[i].seq < events[i - 1].seq)) continue
    const back = events[i - 1].seq - events[i].seq + 1
    if (i - back < 0 || i + back > events.length) continue
    let same = true
    for (let k = 0; k < back; k += 1) {
      if (JSON.stringify(events[i - back + k]) !== JSON.stringify(events[i + k])) { same = false; break }
    }
    if (same) return { firstStart: i - back, secondStart: i, length: back }
  }
  return undefined
}

/** 去掉重复块里的一份（keepSecond=true 丢第一份），seq 随之重新变密集。 */
export function repairDuplicateBlock(events, options = {}) {
  const keepSecond = options.keepSecond !== false
  const dup = findDuplicateBlock(events)
  if (dup === undefined) throw new Error('没有发现重复块')
  const dropFrom = keepSecond ? dup.firstStart : dup.secondStart
  const dropped = events.filter((_, i) => i >= dropFrom && i < dropFrom + dup.length)
  const kept = events.filter((_, i) => i < dropFrom || i >= dropFrom + dup.length)
  return { events: kept.map((e, i) => ({ ...e, seq: i })), dup, dropped: dropped.length }
}

/** 临时文件 → 读回复核 → 原子替换；任何一步不过，原文件分毫不动。 */
function writeSessionSafe(file, header, events) {
  const tmp = `${file}.headguard.tmp`
  try {
    writeSession(tmp, header, events)
    const back = readSession(tmp)
    const v = verify(back.header, back.events)
    if (!v.ok) {
      rmSync(tmp, { force: true })
      return { ok: false, problems: (v.problems ?? []).slice(0, 6).map(String) }
    }
    renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return { ok: false, problems: [String(error?.message ?? error).slice(0, 200)] }
  }
}

/**
 * tool/result 的**替换**只允许改 `message.content`（宿主 Session 构造期
 * assertToolResultRewrite）。任何非 content 字段与被遮蔽原事件不一致——典型是
 * 「就地擦文本」的写入器把 `data.meta.lines[].text` 一并清空——整份日志就会以
 *   invalid seed event at index N: tool/result surface replacement may change only content
 * 拒载。修法：把原事件的 data 整份搬过来，只保留替换体自己的 content
 * （占位正文照留 = 省上下文的收益不变，只把结构元数据对齐）。
 * @returns {{events:object[], repaired:number}}
 */
export function repairToolResultRewrites(events) {
  let repaired = 0
  const out = events.map((e) => {
    if (e?.type !== 'tool/result') return e
    const op = e.surfaceOp
    if (op === undefined || op === 'append') return e
    const source = events[op?.startSeq]
    if (source?.type !== 'tool/result' || typeof source.data !== 'object' || source.data === null || typeof e.data !== 'object' || e.data === null) return e
    const message = {
      ...source.data.message,
      content: e.data.message?.content ?? source.data.message?.content,
    }
    const data = { ...source.data, message }
    if (JSON.stringify(data) === JSON.stringify(e.data)) return e
    repaired += 1
    return { ...e, data }
  })
  return { events: out, repaired }
}

/**
 * 处理一个会话文件：读 → 诊断 → （按需）去重复块 / 对齐 tool-result 替换 / 插受保护头
 *                    → verify → 备份 + 安全写盘 + 读回复核。
 *
 * 三类病都治：
 *   1. 受保护头缺失（哑弹 / 已拒载）—— 首个表面节点前插空 system/message；
 *   2. 同段写了两遍导致 seq 断口（下载/合并/写盘重试的痕迹）—— 去掉重复的那一份；
 *   3. tool/result 替换改到了 content 之外的字段 —— 用被遮蔽原事件对齐（2026-10-11 新增）。
 * 都没病就一个字节都不动；`deep` 为 false 且没缺头时直接返回（调用方的便宜预筛路径）。
 *
 * @param {string} file - session.v4.jsonl.zstd 绝对路径
 * @param {object} [options] - { write, backupDir, deep }
 * @returns {{file:string, status:string, notes:string[], problems:string[], diagnosis?:object}}
 */
export function guardSessionFile(file, options = {}) {
  const out = { file, status: 'clean', notes: [], problems: [] }
  let doc
  try {
    doc = readSession(file)
  } catch (error) {
    out.status = 'unreadable'
    out.notes.push(`readSession: ${String(error?.message ?? error).slice(0, 200)}`)
    return out
  }
  const { header } = doc
  let events = doc.events
  let changed = false

  /* 1) verify 不过先试两组「结构还能救」的招：去重复块 → 对齐 tool-result 替换。 */
  if (!verify(header, events).ok) {
    const dup = findDuplicateBlock(events)
    if (dup !== undefined) {
      try {
        const repaired = repairDuplicateBlock(events, { keepSecond: true })
        if (verify(header, repaired.events).ok) {
          events = repaired.events
          changed = true
          out.deduped = { at: dup.secondStart, length: dup.length }
          out.notes.push(`去重复块：seq ${dup.secondStart} 起 ${dup.length} 条此前被写了两遍（两份逐字节相同）`)
        }
      } catch { /* 交给下面报 problems */ }
    }
    if (!verify(header, events).ok) {
      const rewrites = repairToolResultRewrites(events)
      if (rewrites.repaired > 0 && verify(header, rewrites.events).ok) {
        events = rewrites.events
        changed = true
        out.rewritesAligned = rewrites.repaired
        out.notes.push(`对齐 tool/result 替换 ${rewrites.repaired} 处：非 content 字段（如 meta.lines[].text）曾与被遮蔽原事件不一致 → 宿主会以 "surface replacement may change only content" 拒载`)
      }
    }
  }

  /* 2) 受保护头。 */
  const diag = diagnoseProtectedHead(events)
  if (!diag.ok) {
    out.diagnosis = diag
    try {
      const fixed = insertProtectedHead(events, diag)
      const v = verify(header, fixed)
      if (!v.ok) {
        out.status = 'skipped'
        out.problems = (v.problems ?? []).slice(0, 6).map(String)
        return out
      }
      events = fixed
      changed = true
      out.insertedAt = diag.insertAt
      out.notes.push(`补受保护头 @seq ${diag.insertAt}（原状：${diag.reason}${diag.illegalSeq === undefined ? '' : `，宿主的拒绝点在 seq ${diag.illegalSeq}`}）`)
    } catch (error) {
      out.status = 'failed'
      out.notes.push(`insert: ${String(error?.message ?? error).slice(0, 200)}`)
      return out
    }
  } else if (!changed && options.deep !== true) {
    return out // 便宜预筛路径：没缺头就不是这一层的事
  }

  if (!changed) return out
  out.status = 'planned'
  if (options.write !== true) return out
  try {
    if (options.backupDir) {
      mkdirSync(options.backupDir, { recursive: true })
      const backup = join(options.backupDir, `${String(header?.id ?? 'session')}.before-headguard.zstd`)
      if (!existsSync(dirname(backup))) mkdirSync(dirname(backup), { recursive: true })
      copyFileSync(file, backup)
    }
    const w = writeSessionSafe(file, header, events)
    if (!w.ok) {
      out.status = 'write-refused'
      out.problems = w.problems
      return out
    }
    out.status = 'written'
  } catch (error) {
    out.status = 'failed'
    out.notes.push(`write: ${String(error?.message ?? error).slice(0, 200)}`)
  }
  return out
}
