/**
 * dsh-adapter-compat/repair.js — 会话日志 seq 断号扫描与补行修复
 *
 * 背景（2026-10-12 session-790e9a59 实证）：强退会丢掉一次未落盘的追加批次，
 * 重启后宿主按内存续写，文件中间出现 seq 断号——zstd 帧结构完整、checksum 都对，
 * 但加载器要求 seq 严格连续，读到断号就抛
 *   "corrupt Zstandard session log: complete frame contains a torn JSONL record"
 * （误导性文案：不是 zstd 撕裂，是中间缺行导致 committedBytes 停滞）。
 * 宿主自带的自愈只覆盖**尾部撕裂**（截断丢弃），覆盖不了这种中间断号 → 历史打不开。
 *
 * 修复策略 = 按上下文补行（不重编号、不动任何既有行）：
 *   - 断在 tool/call 之后最常见（工具执行中强退：result / step-end 所在批次没落盘）；
 *     工具协议决定了缺失行必然是该 call 的 tool/result（± step/end），
 *     这是能从上下文**确定性推断**的唯一形态；
 *   - 无法识别的断号形态一律只报告不动手（unsupported），绝不猜；
 *   - verify（true-delete.js 移植的宿主全套校验：seq dense + 状态机 + callId 配对）
 *     全绿才允许落盘，写完回读复核，不过就回滚——补错宁可不修。
 *
 * 占位正文用 [NaN]（与 slim.js 的 SLIM_PLACEHOLDER 同一惯例：结构合法、正文确实
 * 没了、一眼识别是修复占位而非真实输出）。
 */
import { randomUUID } from 'node:crypto'
import { readSession, verify } from './true-delete.js'
import { SLIM_PLACEHOLDER } from './slim.js'

/**
 * 扫描事件数组里的 seq 断号。一个「连续断段」只报一个缺口：
 * 断口之后所有行都相对 index 平行偏移，逐行比较 index 会把一个缺口报成一串——
 * 改为与上一行比较（seq 必须逐行 +1），跳变处即断口。
 * @param {object[]} events
 * @returns {{index:number, expected:number, got:number, missing:number,
 *            prevType:string|null, nextType:string|null}[]}
 */
export function scanGaps(events) {
  const gaps = []
  if (!Array.isArray(events)) return gaps
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]
    if (!ev) continue
    const expected = i === 0 ? 0 : (Number.isSafeInteger(events[i - 1]?.seq) ? events[i - 1].seq + 1 : i)
    const got = Number.isSafeInteger(ev.seq) ? ev.seq : NaN
    if (got === expected) continue
    gaps.push({
      index: i,
      expected,
      got,
      missing: Number.isSafeInteger(got) ? got - expected : 1,
      prevType: i > 0 && events[i - 1] ? events[i - 1].type : null,
      nextType: ev.type ?? null,
    })
  }
  return gaps
}

/** 合成行用的合法 time：基点 +1/+2，非法基点退回一个安全整数。 */
function safeTime(base, plus) {
  const b = Number.isSafeInteger(base) ? base : 1
  const t = b + plus
  return Number.isSafeInteger(t) && t >= 0 ? t : 1
}

/** 合成 tool/result 行（结构照真实行：sourceEventSeqs / surfaceOp 在**顶层**信封）。 */
function makeToolResult(seq, time, prev) {
  const callId = prev?.data?.callId
  return {
    type: 'tool/result',
    seq,
    time: safeTime(time, 1),
    data: {
      turn: prev.data.turn,
      step: prev.data.step,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: SLIM_PLACEHOLDER }],
        isError: false,
        id: randomUUID(),
      },
    },
    sourceEventSeqs: [prev.seq],
    surfaceOp: 'append',
  }
}

/** 合成 step/end 行。 */
function makeStepEnd(seq, time, prev) {
  return {
    type: 'step/end',
    seq,
    time: safeTime(time, 2),
    data: { turn: prev.data.turn, step: prev.data.step },
  }
}

/**
 * 按上下文推断一个断号缺口该补哪些行。
 * 只认两种从工具协议可确定性推断的形态，其余返回 null（调用方报告 unsupported）：
 *   R1: missing=2, prev=tool/call, next=step/start(同 turn, step+1)
 *       → [tool/result, step/end]（result 与 step-end 两行批次整体丢失）
 *   R2: missing=1, prev=tool/call, next 属同 turn/step
 *       → [tool/result]（工具协议：call 之后第一条必是它的 result）
 * @returns {object[]|null}
 */
export function buildInserts(gap, events) {
  const prev = gap.index > 0 ? events[gap.index - 1] : null
  const next = events[gap.index]
  if (!prev || prev.type !== 'tool/call') return null
  if (!prev.data || typeof prev.data.callId !== 'string' || !Number.isSafeInteger(prev.data.turn) || !Number.isSafeInteger(prev.data.step)) return null
  const sameStepCtx = next && next.data && next.data.turn === prev.data.turn && next.data.step === prev.data.step

  if (gap.missing === 2 && next && next.type === 'step/start' &&
      next.data?.turn === prev.data.turn && next.data.step === prev.data.step + 1) {
    return [
      makeToolResult(gap.expected, prev.time, prev),
      makeStepEnd(gap.expected + 1, prev.time, prev),
    ]
  }
  if (gap.missing === 1 && sameStepCtx) {
    return [makeToolResult(gap.expected, prev.time, prev)]
  }
  return null
}

/**
 * 对整个会话做断号修复（纯函数，不碰文件）。
 * @param {object} header - 会话头
 * @param {object[]} events - readSession 读出的事件
 * @returns {{ok:boolean, alreadyHealthy?:boolean, gaps:object[], unsupported:object[],
 *            inserted:object[], fixed?:object[], problems:string[], stats?:object}}
 */
export function repairEvents(header, events) {
  const gaps = scanGaps(events)
  if (gaps.length === 0) {
    return { ok: true, alreadyHealthy: true, gaps: [], unsupported: [], inserted: [], problems: [], stats: { events: events.length } }
  }

  const unsupported = []
  const insertsAt = new Map()
  for (const gap of gaps) {
    const rows = buildInserts(gap, events)
    if (rows) insertsAt.set(gap.index, rows)
    else unsupported.push(gap)
  }
  if (unsupported.length > 0) {
    return { ok: false, gaps, unsupported, inserted: [], problems: unsupported.map(describeGap) }
  }

  // 按原顺序拼装：断号处插行（后续既有行的 seq 原值正好接上，无需重编号）
  const inserted = []
  const fixed = []
  for (let i = 0; i < events.length; i += 1) {
    const rows = insertsAt.get(i)
    if (rows) { fixed.push(...rows); inserted.push(...rows) }
    fixed.push(events[i])
  }

  const v = verify(header, fixed)
  return {
    ok: v.ok === true,
    gaps,
    unsupported: [],
    inserted,
    fixed: v.ok === true ? fixed : undefined,
    problems: v.problems ?? [],
    stats: v.stats,
  }
}

/** 缺口的人类可读描述（日志 / unsupported 报告用）。 */
export function describeGap(gap) {
  return `seq 断号：第 ${gap.index} 行应为 seq=${gap.expected}，实为 ${gap.got}` +
    `（缺 ${gap.missing} 行；前一行=${gap.prevType ?? '∅'}，后一行=${gap.nextType ?? '∅'}）`
}

/**
 * 读盘扫描一个会话文件：断号 + 读取警告（坏行跳过 / 坏帧跳过）。
 * 文件读不开时返回 {error}（不抛）。
 * @param {string} file - session.v4.jsonl.zstd 路径
 */
export function scanFile(file) {
  try {
    const { header, events, warnings } = readSession(file)
    if (!header) return { error: '没有可解析的会话头' }
    const gaps = scanGaps(events)
    return { header, events, warnings: warnings ?? [], gaps }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}
