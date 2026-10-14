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

/* ═════════════════ 大缺口（missing ≥ 3）结构重建 ═════════════════
 *
 * base 规则只覆盖 1~2 行（紧邻 tool/call 的 tool/result ± step/end），因为那是唯一
 * 「从工具协议确定性推断」的形态。missing ≥ 3 只有一种常见成因：**整段 zstd 帧丢失**
 * （2026-10-14 session-8420e924 实测：缺 10 行 = 2509-2518，跨了 3 个 step）。
 * 帧边界是物理事实，帧里写了什么已经没了 —— 所以分两条线处理：
 *
 *   能确定的：**结构**。断口处的 open turn/step 与下一跳 next 的 data.turn/step 之间，
 *     坐标只能前进，且只能经 step/end+step/start、turn/end+turn/start 走过去，
 *     每一步是确定的行数。用 0-1 BFS 在 (open 状态 × 已用行数) 上找「恰好 missing 行、
 *     落点满足 next 硬约束」的最省结构路径（结构行越少 ⇒ 不可见填充越多）。
 *   不能确定的：**正文**。合成行一律 [NaN] 占位；填充优先用 assistant/attempt ——
 *     它不是表层事件（不带 surfaceOp），界面上不会多出假消息。
 *
 * 三条底线（都是宿主真实拒载规则，见 dsh-session/lib/{index,invariant}.js）：
 *   1. 不改任何既有行，只在断口处插行；
 *   2. 合成 assistant/message 必须带真实 provider/model（assertMessageEventShape：
 *      source.kind==='model' 且有 provider/model），从断口前最近一条真实 assistant/message 抄；
 *   3. assistant/attempt|message 必须带 stream 数组（assertAssistantSettlementShape +
 *      purge.assertRowsDense 的 settlement 规则）。
 *
 * 找不到合法路径就返回 null → 调用方按 unsupported 报告，绝不硬凑。
 */

/** 自动重建的行数上限（再大就不猜了，交给人工按 RUNBOOK 处理）。 */
const MAX_FABRICATE = 240
/** base 规则覆盖 1~2 行；≥3 行才走扩展（保守：小缺口形态学上仍可能是别的东西）。 */
const MIN_EXTENDED_GAP = 3
/** 未 started 的 call 被收尾时，宿主 dsh-session repair.js 用的模型可见措辞（照抄）。 */
const CLOSER_NOT_STARTED = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'

/** 断口前最近一条 assistant/message 的真实 source（合成消息要抄 provider/model）。 */
function modelSourceBefore(events, upto) {
  for (let i = upto - 1; i >= 0; i -= 1) {
    const e = events[i]
    const src = e?.data?.message?.source
    if (e?.type === 'assistant/message' && src && typeof src.provider === 'string' && src.provider && typeof src.model === 'string' && src.model) {
      return { kind: 'model', provider: src.provider, model: src.model }
    }
  }
  return null
}

/** 断口前最近一次真实 tool/call 的工具名（合成声明要用一个像样的 name）。 */
function toolNameBefore(events, upto) {
  for (let i = upto - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e?.type === 'tool/call' && typeof e.data?.name === 'string' && e.data.name) return e.data.name
  }
  return null
}

/** 合成 assistant/attempt（填充用：非表层、settlement 必须带 stream）。 */
function makeAttemptSeq(seq, time, turn, step) {
  return { type: 'assistant/attempt', seq, time, data: { turn, step, stream: [] } }
}

/** 合成 assistant/message（声明一个丢失的 tool-call 用；必须 surfaceOp + 真实 source）。 */
function makeAssistantMessageSeq(seq, time, turn, step, content, source) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, stream: [], message: { role: 'assistant', content, source, id: randomUUID() } },
    surfaceOp: 'append',
  }
}

/**
 * 合成 tool/result。started 的 call → [NaN] 占位成功结果（与 base 规则同款）；
 * 未 started 的 call → 照宿主 openTurnClosers 的 TOOL_NOT_STARTED 错误形态。
 */
function makeResultSeq(seq, time, turn, step, call) {
  const notStarted = call?.started !== true
  const callId = call?.id
  const message = {
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content: [{ type: 'text', text: notStarted ? CLOSER_NOT_STARTED : SLIM_PLACEHOLDER }],
    isError: notStarted,
    id: randomUUID(),
  }
  const data = { turn, step, message }
  if (notStarted) data.error = { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' }
  const ev = { type: 'tool/result', seq, time, data, surfaceOp: 'append' }
  if (Number.isSafeInteger(call?.seq) && call.seq < seq) ev.sourceEventSeqs = [call.seq]
  return ev
}

/**
 * 回放断口前的状态机（镜像 true-delete.js verify 的 Relationships 分支）。
 * 返回 {turn, step, nextTurn, nextStep, pending:[{id,seq,started,name,arguments}]}，
 * 输入本身结构非法（step/start 时 step 还开着等）时返回 null —— 那种文件 verify 也过不了。
 */
function replayGapState(events, count) {
  let turn = null
  let step = null
  let nextTurn = 1
  let nextStep = 1
  const pending = []
  for (let i = 0; i < count; i += 1) {
    const e = events[i]
    if (!e || typeof e.type !== 'string') return null
    const d = e.data
    switch (e.type) {
      case 'turn/start':
        if (turn !== null) return null
        turn = nextTurn
        nextStep = 1
        pending.length = 0
        break
      case 'turn/end':
        if (turn === null || step !== null) return null
        turn = null
        nextTurn += 1
        pending.length = 0
        break
      case 'step/start':
        if (turn === null || step !== null) return null
        step = nextStep
        break
      case 'step/end':
        if (turn === null || step === null) return null
        step = null
        nextStep += 1
        pending.length = 0
        break
      case 'assistant/message': {
        if (turn === null || step === null) break
        const content = d?.message?.content
        if (!Array.isArray(content)) break
        for (const b of content) {
          if (b?.type === 'tool-call' && typeof b.id === 'string' && b.id && !pending.some((p) => p.id === b.id)) {
            pending.push({ id: b.id, seq: e.seq, started: false, name: b.name, arguments: b.arguments })
          }
        }
        break
      }
      case 'tool/call': {
        const p = pending.find((x) => x.id === d?.callId)
        if (p && !p.started) {
          p.started = true
          p.seq = e.seq
          if (typeof d.name === 'string') p.name = d.name
          if (typeof d.arguments === 'string') p.arguments = d.arguments
        }
        break
      }
      case 'tool/result': {
        const id = d?.message?.toolCallId ?? d?.message?.source?.callId
        const idx = pending.findIndex((x) => x.id === id)
        if (idx >= 0) pending.splice(idx, 1)
        break
      }
      default: break
    }
  }
  return { turn, step, nextTurn, nextStep, pending }
}

/** 一个「动作」推进后的状态（BFS 扩展与最终物化共用，保证两者不会走样）。 */
function applyMove(st, mv) {
  switch (mv.kind) {
    case 'attempt':
      return st
    case 'settle': {
      const idx = st.pending.findIndex((p) => p.id === mv.id)
      if (idx < 0) return null
      return { ...st, pending: st.pending.filter((_, i) => i !== idx) }
    }
    case 'step-end':
      return { ...st, step: null, nextStep: st.nextStep + 1, pending: [] }
    case 'step-start':
      return { ...st, step: st.nextStep }
    case 'turn-end':
      return { ...st, turn: null, nextTurn: st.nextTurn + 1, pending: [] }
    case 'turn-start':
      return { ...st, turn: st.nextTurn, nextStep: 1, pending: [] }
    case 'declare':
      if (st.pending.some((p) => p.id === mv.id)) return null
      return { ...st, pending: [...st.pending, { id: mv.id, seq: null, started: false, name: mv.name, arguments: mv.arguments }] }
    case 'call': {
      const p = st.pending.find((x) => x.id === mv.id)
      if (!p || p.started) return null
      return { ...st, pending: st.pending.map((x) => (x.id === mv.id ? { ...x, started: true } : x)) }
    }
    default:
      return null
  }
}

/** 下一跳对「缺口收尾状态」的硬约束（与 verify / 宿主 invariant 同口径）。 */
function gapTargetOk(st, next, need) {
  const d = next?.data
  switch (next?.type) {
    case 'turn/start':
      return st.turn === null && st.nextTurn === d?.turn
    case 'turn/end':
      return st.turn === d?.turn && st.step === null && st.pending.length === 0
    case 'step/start':
      return st.turn === d?.turn && st.step === null && st.nextStep === d?.step
    case 'step/end':
      return st.turn === d?.turn && st.step === d?.step && st.pending.length === 0
    case 'tool/call':
      return st.turn === d?.turn && st.step === d?.step && st.pending.some((p) => p.id === d?.callId && p.started === false)
    case 'tool/result':
      if (next.surfaceOp !== 'append') return st.turn !== null
      return st.turn === d?.turn && st.step === d?.step && st.pending.some((p) => p.id === need?.id && p.started === true)
    case 'assistant/attempt':
    case 'assistant/message':
    case 'system/message':
    case 'developer/message':
      return st.turn === d?.turn && st.step === d?.step
    default:
      if (st.turn === null) return false
      if (Number.isSafeInteger(d?.turn) && st.turn !== d.turn) return false
      return true
  }
}

/** 从当前状态能走的下一步（cost 0 = 不可见填充 attempt，cost 1 = 结构行）。 */
function gapNeighbors(st, ctx) {
  const { need, maxTurn, maxStep, declSpec } = ctx
  const inBounds = (s) => s !== null && s.turn <= maxTurn && s.nextTurn <= maxTurn + 1 &&
    (s.step === null || s.step <= maxStep) && s.nextStep <= maxStep + 1
  const out = []
  const add = (cost, mv) => { const ns = applyMove(st, mv); if (inBounds(ns)) out.push({ cost, mv, st: ns }) }

  if (st.turn !== null && st.step !== null) add(0, { kind: 'attempt' })
  for (const p of st.pending) {
    if (need && p.id === need.id) continue   // 下一跳要它留着，不能结算
    if (st.step === null) continue           // tool/result(append) 必须落在开着的 step 里
    add(1, { kind: 'settle', id: p.id })
  }
  if (st.step !== null && st.pending.length === 0) add(1, { kind: 'step-end' })
  if (st.turn !== null && st.step === null) add(1, { kind: 'step-start' })
  if (st.turn !== null && st.step === null && st.pending.length === 0) add(1, { kind: 'turn-end' })
  if (st.turn === null) add(1, { kind: 'turn-start' })
  if (need && st.turn !== null && st.step !== null) {
    const have = st.pending.find((p) => p.id === need.id)
    if (!have) add(1, { kind: 'declare', id: need.id, ...declSpec })
    else if (!have.started && need.kind === 'result') add(1, { kind: 'call', id: need.id })
  }
  return out
}

/** 把动作序列物化成行（seq/time 从断口起点连续排布，turn/step 取动作发生时的 open 状态）。 */
function materializeGapPlan(path, st0, ctx) {
  let st = st0
  const rows = []
  if (Array.isArray(ctx.trace)) {
    ctx.trace.push(`物化开始：len=${path.length} kinds=${path.map((m) => m.kind).join(',')} st0=${JSON.stringify({ turn: st0.turn, step: st0.step, nextTurn: st0.nextTurn, nextStep: st0.nextStep })}`)
  }
  for (let i = 0; i < path.length; i += 1) {
    const mv = path[i]
    const seq = ctx.expected + i
    const time = ctx.timeBase + i
    const turn = st.turn
    const step = st.step
    let row
    switch (mv.kind) {
      case 'attempt':
        row = makeAttemptSeq(seq, time, turn, step)
        break
      case 'settle':
        row = makeResultSeq(seq, time, turn, step, st.pending.find((x) => x.id === mv.id))
        break
      case 'step-end':
        row = { type: 'step/end', seq, time, data: { turn, step } }
        break
      case 'step-start':
        row = { type: 'step/start', seq, time, data: { turn, step: st.nextStep } }
        break
      case 'turn-end':
        row = { type: 'turn/end', seq, time, data: { turn } }
        break
      case 'turn-start':
        row = { type: 'turn/start', seq, time, data: { turn: st.nextTurn } }
        break
      case 'declare':
        row = makeAssistantMessageSeq(seq, time, turn, step, [{ type: 'tool-call', id: mv.id, name: mv.name, arguments: mv.arguments }], ctx.source)
        break
      case 'call': {
        const p = st.pending.find((x) => x.id === mv.id)
        row = { type: 'tool/call', seq, time, data: { turn, step, callId: mv.id, name: p?.name, arguments: p?.arguments } }
        break
      }
      default:
        if (Array.isArray(ctx.trace)) ctx.trace.push(`物化断在第 ${i} 步：未知动作 kind=${JSON.stringify(mv)}`)
        return null
    }
    rows.push(row)
    st = applyMove(st, mv)
    if (!st) {
      if (Array.isArray(ctx.trace)) ctx.trace.push(`物化断在第 ${i} 步：${mv.kind} → applyMove 返回 null（当时状态 ${JSON.stringify({ turn, step })}）`)
      return null
    }
  }
  return rows
}

/** 会真正约束 open turn/step 的事件类型（其余如插件事件、user/message 不约束）。 */
const GAP_ANCHOR_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'assistant/attempt', 'assistant/message', 'system/message', 'developer/message',
  'tool/call', 'tool/result', 'request/header', 'request/context',
  'llm/retry', 'compaction/start', 'compaction/summary', 'compaction/end',
])

/**
 * 断口的锚点：**下一跳可能是无坐标的插件事件**（如 `session-log-deepseek/delivery-accepted`），
 * 它对 open turn/step 没有任何要求；真正决定「缺口收尾状态」的是往后第一条带坐标的事件。
 * 实测 8420 [1250+12]：下一跳是 delivery-accepted，按它收尾就把 step 停在 6，
 * 而真实后续 assistant/message 在 step 8 → 整条链错位、verify 拒绝。
 */
function gapAnchorIndex(events, from) {
  const limit = Math.min(events.length, from + 64)
  for (let i = from; i < limit; i += 1) {
    const t = events[i]?.type
    if (typeof t === 'string' && GAP_ANCHOR_TYPES.has(t)) return i
  }
  return from
}

/**
 * 大缺口规划：找「恰好 missing 行、落点满足锚点事件硬约束」的最省结构路径。
 * @returns {object[]|null} 合成行；无解返回 null（调用方按 unsupported 报告）。
 */
function planGapRows(gap, events, { forceSettle = false, trace = null } = {}) {
  const T = (m) => { if (Array.isArray(trace)) trace.push(m) }
  const M = gap.missing
  const next = events[gap.index]
  if (!next || typeof next.type !== 'string') { T('早退：没有下一跳'); return null }
  const anchorIdx = gapAnchorIndex(events, gap.index)
  const anchor = events[anchorIdx] ?? next
  const source = modelSourceBefore(events, gap.index)   // 惰性：只有真要合成 assistant/message 时才是硬要求
  const base = replayGapState(events, gap.index)
  if (!base) { T('早退：断口前状态机回放失败'); return null }

  // 锚点是不是在等一个 call（result 等它 started，tool/call 等它 declared 未 started）
  const nd = anchor.data && typeof anchor.data === 'object' ? anchor.data : {}
  let need = null
  let declSpec = null
  if (anchor.type === 'tool/result' && anchor.surfaceOp === 'append') {
    const id = nd?.message?.toolCallId ?? nd?.message?.source?.callId
    if (typeof id !== 'string' || !id) return null
    need = { id, kind: 'result' }
  } else if (anchor.type === 'tool/call') {
    if (typeof nd?.callId !== 'string' || !nd.callId) return null
    need = { id: nd.callId, kind: 'call' }
  }
  if (need) {
    const original = base.pending.find((p) => p.id === need.id)
    // 下一跳等的 call 不在断口前的 pending 里 → 它的声明（assistant/message）也丢了，得补一条。
    // 合成 assistant/message 必须带真实 provider/model（宿主 assertMessageEventShape），所以这里才要 source。
    if (!original && !source) {
      T('早退：需合成 assistant/message 声明，但断口前没有真实 assistant/message（缺 provider/model）')
      return null
    }
    if (need.kind === 'call') {
      declSpec = { name: nd.name, arguments: nd.arguments }
    } else if (original) {
      declSpec = { name: original.name, arguments: original.arguments }
    } else {
      const name = toolNameBefore(events, gap.index)
      if (!name) { T('早退：声明 call 至少要一个真实工具名'); return null }
      declSpec = { name, arguments: JSON.stringify({ command: SLIM_PLACEHOLDER }) }
    }
    if (typeof declSpec.name !== 'string' || !declSpec.name) { T('早退：declSpec 没有合法 name'); return null }
  }

  // forceSettle 候选：先把断口前「已 started、且下一跳不是它 result」的 call 结算掉
  // （工具协议：call 之后必是它的 result，所以它们几乎必然落在缺口里）。
  let st = base
  const prefix = []
  if (forceSettle) {
    for (const p of base.pending.filter((x) => x.started && x.id !== need?.id)) {
      const ns = applyMove(st, { kind: 'settle', id: p.id })
      if (!ns) return null
      st = ns
      prefix.push({ kind: 'settle', id: p.id })
    }
    if (prefix.length >= M) return null
  }

  const maxTurn = Math.max(Number.isSafeInteger(nd?.turn) ? nd.turn : 0, base.turn ?? 0, base.nextTurn) + 1
  const maxStep = Math.max(Number.isSafeInteger(nd?.step) ? nd.step : 0, base.step ?? 0, base.nextStep) + 2
  const ctx = {
    need, declSpec, source, trace,
    expected: gap.expected,
    timeBase: Number.isSafeInteger(events[gap.index - 1]?.time) ? events[gap.index - 1].time : (Number.isSafeInteger(next.time) ? next.time : 1),
    maxTurn,
    maxStep,
  }

  // 0-1 BFS：cost 0 = attempt 填充，cost 1 = 结构行。队列按 cost 单调，首个命中目标即最省。
  T(`M=${M} forceSettle=${forceSettle} prefix=${prefix.length} state0=${JSON.stringify({ turn: base.turn, step: base.step, nextTurn: base.nextTurn, nextStep: base.nextStep, pending: base.pending.map((p) => p.id.slice(0, 8) + (p.started ? '+' : '-')) })} need=${need ? need.kind + ':' + String(need.id).slice(0, 10) : 'null'} bounds=turn≤${maxTurn},step≤${maxStep} anchor=${anchor.type}@${anchorIdx}(${nd?.turn}/${nd?.step})${anchorIdx > gap.index ? ` [下一跳 ${next.type} 无坐标，跳过]` : ''}`)
  const key = (s, k) => `${s.turn}|${s.step}|${s.nextTurn}|${s.nextStep}|${[...s.pending].map((p) => p.id + (p.started ? '+' : '-')).sort().join(',')}|${k}`
  const start = { st, k: prefix.length, path: prefix, cost: 0 }
  const best = new Map([[key(st, prefix.length), 0]])
  const queue = [start]
  let head = 0
  let expanded = 0
  while (head < queue.length) {
    const node = queue[head]
    head += 1
    if (node.k === M) {
      const ok = gapTargetOk(node.st, anchor, need)
      T(`pop k=M cost=${node.cost} target=${ok} st=${JSON.stringify({ turn: node.st.turn, step: node.st.step, nextTurn: node.st.nextTurn, nextStep: node.st.nextStep })}`)
      if (ok) {
        const rows = materializeGapPlan(node.path, base, ctx)
        T(rows === null ? '物化失败 → null' : `物化成功 ${rows.length} 行`)
        return rows
      }
      continue
    }
    expanded += 1
    if (expanded > 200000) return null
    for (const nb of gapNeighbors(node.st, ctx)) {
      const nk = node.k + 1
      const ncost = node.cost + nb.cost
      const kk = key(nb.st, nk)
      if (best.has(kk) && best.get(kk) <= ncost) continue
      best.set(kk, ncost)
      const item = { st: nb.st, k: nk, path: node.path.concat(nb.mv), cost: ncost }
      if (nb.cost === 0) queue.splice(head, 0, item)   // 0-cost 边插队首（0-1 BFS）
      else queue.push(item)
    }
  }
  return null
}

/** 扩展候选：两种口味（先结算断口前的 call / 交给规划器按需结算），都试一遍。 */
function buildExtendedCandidates(gap, events) {
  if (!gap || !Number.isSafeInteger(gap.missing) || gap.missing < MIN_EXTENDED_GAP || gap.missing > MAX_FABRICATE) return []
  const out = []
  for (const forceSettle of [true, false]) {
    const rows = planGapRows(gap, events, { forceSettle })
    if (Array.isArray(rows) && rows.length === gap.missing) out.push(rows)
  }
  return out
}

/** 导出版：单个最优扩展候选（对外只暴露这一个）。 */
export function buildInsertsExtended(gap, events) {
  const cands = buildExtendedCandidates(gap, events)
  return cands.length > 0 ? cands[0] : null
}

export function buildInserts(gap, events) {
  const cands = insertCandidates(gap, events)
  return cands.length > 0 ? cands[0] : null
}

/**
 * base 规则（1~2 行、从工具协议确定性推断）：
 *   R1: missing=2, prev=tool/call, next=step/start(同 turn, step+1)
 *       → [tool/result, step/end]（result 与 step-end 两行批次整体丢失）
 *   R2: missing=1, prev=tool/call, next 属同 turn/step
 *       → [tool/result]（工具协议：call 之后第一条必是它的 result）
 * @returns {object[]|null}
 */
function buildInsertsBase(gap, events) {
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
  // 1~2 行的其余形态一律不猜（形态学上还有别的可能，宁可报告）。
  // missing ≥ 3 只可能是整帧丢失 —— 结构可从 turn/step 坐标确定性重建，正文用 [NaN] 占位。
  return buildInsertsExtended(gap, events)
}

/** 一个缺口的全部候选补行方案（按优先级；空数组 = unsupported）。 */
function insertCandidates(gap, events) {
  const base = buildInsertsBase(gap, events)
  if (base) return [base]
  return buildExtendedCandidates(gap, events)
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

  // 每个缺口的候选方案（base 优先；扩展规划可能给两种口味）
  const candidates = gaps.map((gap) => insertCandidates(gap, events))
  const unsupported = gaps.filter((_, i) => candidates[i].length === 0)
  if (unsupported.length > 0) {
    return { ok: false, gaps, unsupported, inserted: [], problems: unsupported.map((gap) => describeGapReport(gap, events).describe) }
  }

  const assemble = (idx) => {
    const insertsAt = new Map()
    gaps.forEach((gap, i) => insertsAt.set(gap.index, candidates[i][idx[i]]))
    const rows = []
    const inserted = []
    for (let i = 0; i < events.length; i += 1) {
      const add = insertsAt.get(i)
      if (add) { rows.push(...add); inserted.push(...add) }
      rows.push(events[i])
    }
    return { rows, inserted }
  }

  // 候选组合搜索（缺口通常只有 1 个；上限 64 组，超了就按当前组合的 verify 结果报告）
  const idx = new Array(gaps.length).fill(0)
  const MAX_COMBOS = 64
  let last = null
  for (let attempt = 0; attempt < MAX_COMBOS; attempt += 1) {
    const { rows, inserted } = assemble(idx)
    const v = verify(header, rows)
    if (v.ok === true) {
      return { ok: true, gaps, unsupported: [], inserted, fixed: rows, problems: [], stats: v.stats }
    }
    last = v
    let p = gaps.length - 1
    while (p >= 0 && idx[p] + 1 >= candidates[p].length) { idx[p] = 0; p -= 1 }
    if (p < 0) break
    idx[p] += 1
  }
  // 所有组合都过不了 verify —— 说明合成行与既有行冲突（如 result 被补了两次），不许落盘
  return { ok: false, gaps, unsupported: [], inserted: [], problems: (last?.problems ?? []).slice(0, 8).map(String), comboExhausted: true }
}

/** 缺口的人类可读描述（日志 / unsupported 报告用）。 */
export function describeGap(gap) {
  return `seq 断号：第 ${gap.index} 行应为 seq=${gap.expected}，实为 ${gap.got}` +
    `（缺 ${gap.missing} 行；前一行=${gap.prevType ?? '∅'}，后一行=${gap.nextType ?? '∅'}）`
}

/**
 * 缺口的结构化报告（unsupported / 人工按 RUNBOOK 处理时用）。
 * @returns {{describe:string, missing:number, seqFrom:number, seqTo:number,
 *            prev:object|null, next:object|null, autoRepairable:boolean, hints:string[]}}
 */
export function describeGapReport(gap, events) {
  const prev = gap.index > 0 ? events[gap.index - 1] : null
  const next = events[gap.index] ?? null
  const strip = (e) => (e ? {
    seq: e.seq,
    type: e.type,
    turn: e.data?.turn ?? null,
    step: e.data?.step ?? null,
    callId: e.data?.callId ?? e.data?.message?.toolCallId ?? null,
  } : null)
  const hints = []
  if (!Number.isSafeInteger(gap.missing) || gap.missing < 0) {
    hints.push('后一行 seq 比预期还小（重复/重叠写入），插行修不了，得先弄清是谁写了重复行')
  } else {
    if (gap.missing < MIN_EXTENDED_GAP) hints.push('缺口只有 1~2 行，必须是紧邻 tool/call 的 tool/result（± step/end）才补；本例不满足，只能人工看上下文')
    if (gap.missing > MAX_FABRICATE) hints.push(`缺口 ${gap.missing} 行超过自动重建上限 ${MAX_FABRICATE}，要按 RUNBOOK §1 人工构造`)
    const anchor = events[gapAnchorIndex(events, gap.index)] ?? next
    const nd = anchor?.data
    const waitId = anchor?.type === 'tool/call' ? nd?.callId
      : (anchor?.type === 'tool/result' && anchor.surfaceOp === 'append' ? (nd?.message?.toolCallId ?? nd?.message?.source?.callId) : null)
    if (typeof waitId === 'string' && waitId) {
      const st0 = replayGapState(events, gap.index)
      const declared = Boolean(st0 && st0.pending.some((p) => p.id === waitId))
      if (!declared && !modelSourceBefore(events, gap.index)) {
        hints.push('锚点事件在等一个未声明的 call，需要补 assistant/message，但断口前没有真实 assistant/message（缺 provider/model），宿主会拒载 → 人工补')
      }
    }
  }
  const anchorIdx = gapAnchorIndex(events, gap.index)
  return {
    describe: describeGap(gap),
    missing: gap.missing,
    seqFrom: gap.expected,
    seqTo: gap.expected + gap.missing - 1,
    prev: strip(prev),
    next: strip(next),
    anchor: anchorIdx > gap.index ? { ...strip(events[anchorIdx]), note: '下一跳无坐标，锚点后移' } : undefined,
    autoRepairable: buildExtendedCandidates(gap, events).length > 0,
    hints,
  }
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

/** 调试导出：内部函数不外露成公共 API，但排障脚本需要单步看规划器。 */
export const __repairDebug = {
  replayGapState,
  planGapRows,
  buildExtendedCandidates,
  gapNeighbors,
  gapTargetOk,
  applyMove,
  modelSourceBefore,
  toolNameBefore,
  MAX_FABRICATE,
  MIN_EXTENDED_GAP,
}
