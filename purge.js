/**
 * 真删除（物理切除）门面 —— adapter-compat 第六层的引擎侧。
 *
 * 依赖同目录的 true-delete.js（从 _truedelete/excision.mjs 原样移植，已过 52/52 自测）。
 * 本文件只负责「找哪些会话有可清理墓碑 → 算要删的事件 → 切除 → 校验 → 备份写盘」，
 * 不持有任何 DSH 状态；ctx 由调用方注入（只为拿 live 判定与 projcache 路径）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSession, writeSession, excise, verify, seqsOfTurn, decodeSeqRanges, foldSurfaceLoose } from './true-delete.js';

/** 会写盘的调用方必须显式传 write:true；默认干跑。 */
export const PURGE_DEFAULTS = Object.freeze({ write: false, only: undefined, home: undefined });

/**
 * 离线复现宿主 inbox 投影的状态机（移植自 dsh-agent-loop 的 splice apply）。
 * agent/inbox/spliced 是**顺序状态机**：每条 splice 的 start/removedCount 都相对于
 * 前序 splice 演化出的队列，且两边队列的 message.id 不能重复。因此它不能像普通事件
 * 那样删除——删中间一条会让后续全部错位，宿主就会抛
 * "invalid persisted inbox splice at session seq N"，会话直接打不开。
 * @returns {{problems: Array<{seq:number,reason:string}>, final: Record<string,unknown[]>}}
 */
export function checkInboxSplices(events) {
  const state = { 'next-turn': [], 'next-step': [] };
  const problems = [];
  for (const event of events) {
    if (event?.type !== 'agent/inbox/spliced') continue;
    const splice = event.data;
    try {
      const inbox = state[splice.target];
      if (!Array.isArray(inbox)) throw new Error('splice.target 未知: ' + String(splice.target));
      const removedCount = splice.removedCount ?? 0;
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0 || splice.start + removedCount > inbox.length) {
        throw new Error('splice 越界 start=' + String(splice.start) + ' removedCount=' + String(removedCount) + ' queue=' + inbox.length);
      }
      const next = [...inbox.slice(0, splice.start), ...(splice.inserted ?? []), ...inbox.slice(splice.start + removedCount)];
      const ids = new Set();
      const pool = splice.target === 'next-turn' ? [...next, ...state['next-step']] : [...state['next-turn'], ...next];
      for (const message of pool) {
        if (ids.has(message?.id)) throw new Error('message ' + String(message?.id) + ' 已处于 pending');
        ids.add(message?.id);
      }
      state[splice.target] = next;
    } catch (error) {
      problems.push({ seq: event.seq, reason: String(error?.message ?? error) });
      break;
    }
  }
  return { problems, final: state };
}

/** 事件集里所有 agent/inbox/spliced 的 seq。 */
export function inboxSpliceSeqs(events) {
  return events.filter((e) => e?.type === 'agent/inbox/spliced').map((e) => e.seq);
}

/**
 * 判断一个表层事件是不是「轮次删除墓碑」。
 * - 只认插件自己的 source.kind（dsh-session-kit-*），非插件替换一律不碰；
 * - summary.regeneration 存在 = 重新生成，轮次还活着，**整轮删会毁掉新回答** → 跳过；
 * - summary 缺失的旧载体：从被遮蔽的表层节点反推轮号（拿不到就保守跳过）。
 * @returns {{skip?:boolean, turns?:Set<number>, needsNodeLookup?:boolean, sourcesFor?:number[], why?:string}|undefined}
 */
export function classifyTombstoneCarrier(event) {
  const src = event?.data?.source ?? event?.data?.message?.source;
  const kind = src?.kind;
  if (typeof kind !== 'string' || !kind.startsWith('dsh-session-kit-')) return undefined;
  const op = event.surfaceOp;
  if (!op || typeof op !== 'object' || op.op !== 'replace') return undefined;
  let summary = null;
  try { summary = JSON.parse(src.summary ?? 'null') } catch { summary = null }
  if (summary && summary.regeneration !== undefined) return { skip: true, why: 'regenerate' };
  const turns = new Set();
  if (summary && Number.isSafeInteger(summary.turn)) {
    const end = Number.isSafeInteger(summary.endTurn) ? summary.endTurn : summary.turn;
    for (let t = summary.turn; t <= end; t++) turns.add(t);
  }
  if (turns.size === 0) {
    if (!Array.isArray(event.sourceEventSeqs)) {
      const op = event.surfaceOp;
      const surfaceRange = op && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq)
        ? { start: op.startSeq, end: op.endSeq } : undefined;
      return { needsNodeLookup: true, sourcesFor: [], turns, surfaceRange };
    }
    let sourcesFor = [];
    try { sourcesFor = decodeSeqRanges(event.sourceEventSeqs) } catch { sourcesFor = [] }
    return { needsNodeLookup: true, sourcesFor, turns };
  }
  return { turns };
}

/**
 * 算出一个会话要物理删除的事件 seq 集（只针对真删除墓碑）。
 * @returns {{remove:number[], turns:number[], skipped:object[]}}
 */
export function planPurge(events, options = {}) {
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : undefined;
  const byseq = new Map(events.map((e) => [e.seq, e]));
  const turnSet = new Set();
  const skipped = [];
  for (const e of events) {
    const c = classifyTombstoneCarrier(e);
    if (!c) continue;
    /* 只认「刚新增的墓碑」：历史墓碑代表很久以前的删除，动它们会删掉用户
       并不打算删的内容（实测踩过：把两年前的删除当成"刚删的"）。 */
    if (sinceMs !== undefined && !(Number.isFinite(e.time) && e.time >= sinceMs)) continue;
    if (c.skip) { skipped.push({ seq: e.seq, why: c.why }); continue }
    if (c.needsNodeLookup) {
      /* legacy-turn-fallback：旧格式墓碑没有 summary.turn，两步反推：
         ① 被遮蔽的表层节点自带的 data.turn；
         ② 兜底：这些节点里最早那个 seq 之前最近的 turn/start。 */
      let earliest = Infinity;
      for (const sq of c.sourcesFor) {
        const node = byseq.get(sq);
        if (node && Number.isSafeInteger(node.data?.turn)) turnSet.add(node.data.turn);
        if (Number.isFinite(sq) && sq < earliest) earliest = sq;
      }
      /* legacy-surfacepos-fallback：更老的墓碑连 sourceEventSeqs 都没有，只有
         surfaceOp.{startSeq,endSeq} —— 那是**表层位置**（surface 节点数组下标），
         用容错 fold 取出对应节点再推轮号。 */
      if (c.sourcesFor.length === 0 && c.surfaceRange !== undefined) {
        let nodes = [];
        try { nodes = [...foldSurfaceLoose(events).nodes] } catch { nodes = [] }
        /* 注意：surfaceOp.startSeq/endSeq 是**表层节点的 seq**（源码用 nodes.indexOf(op.startSeq) 定位），不是数组下标。 */
        const from = nodes.includes(c.surfaceRange.start) ? c.surfaceRange.start : undefined;
        const to = nodes.includes(c.surfaceRange.end) ? c.surfaceRange.end : undefined;
        if (Number.isSafeInteger(from) && Number.isSafeInteger(to)) {
          for (const sq of [from, to]) {
            const node = byseq.get(sq);
            if (node && Number.isSafeInteger(node.data?.turn)) turnSet.add(node.data.turn);
            if (Number.isFinite(sq) && sq < earliest) earliest = sq;
          }
        }
      }
      if (turnSet.size === 0 && Number.isFinite(earliest)) {
        const starts = events.filter((e) => e.type === 'turn/start' && e.seq < earliest && Number.isSafeInteger(e.data?.turn));
        const last = starts[starts.length - 1];
        if (last) turnSet.add(last.data.turn);
      }
      continue;
    }
    for (const turn of c.turns) turnSet.add(turn);
  }
  const remove = new Set();
  for (const turn of turnSet) for (const sq of seqsOfTurn(events, turn)) remove.add(sq);

  return { remove: [...remove].sort((a, b) => a - b), turns: [...turnSet].sort((a, b) => a - b), skipped };
}

/**
 * 处理一个会话文件：算 → 切除 → 校验（可选写盘，带备份 + 读回复核）。
 * @param {string} file - session.v4.jsonl.zstd 绝对路径
 * @param {string} sid
 * @param {object} options - { write, backupDir, onNote }
 * @returns {object} 结果摘要（status: clean|planned|skipped|failed|written）
 */

/**
 * 重写整条 inbox splice 链，使它在「删掉若干事件之后」依然自洽。
 *
 * 依据（dsh-agent-loop 的 inboxProjectionDefinition）：inbox 的**唯一**驱动是
 * agent/inbox/spliced；连"取走队列"（claim）也是写一条 start=0/removedCount=n/
 * inserted=[] 的 splice。所以整条链就是一个纯函数式的队列操作序列：
 *     next = queue.toSpliced(start, removedCount, ...inserted)
 * 既然能从头 forge 出这样的序列，就能把它**重算**成等价的、在新队列上自洽的序列。
 *
 * 算法：
 *   1. 原样重放一遍，记下每条 splice 执行前的队列快照；
 *   2. 收集「将被删除的消息 id」（被删事件里的 message.id / inserted[].id）；
 *   3. 对每条**存活**的 splice，把它的操作区间按"剔除已删消息"投影到新队列上：
 *        anchor = 区间之后第一个存活元素（在新队列里的下标即插入点）
 *        newStart = anchor 的下标；newRemoved = 区间内仍存活且仍在队列里的条数
 *        newInserted = inserted 里剔除已删消息
 *      （原区间是连续的，删除只做减法 → 存活成员在新队列里仍连续，故投影自洽）
 *   4. 只改这些 splice 的 data，不改事件条数、不改 seq —— 与切除/重编号正交。
 *
 * @param {object[]} events - 原始事件（未切除）
 * @param {number[]} removeSeqs - 将被物理删除的事件 seq
 * @returns {{rewrites: Map<number, object>, deletedIds: Set<string>, stats: object}}
 */
export function planInboxRewrite(events, removeSeqs) {
  const removeSet = new Set(removeSeqs);

  // 1) 原样重放一遍，记下每条 splice 的「执行前队列」快照
  const before = new Map();
  const queue = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    if (event?.type !== 'agent/inbox/spliced') continue;
    before.set(event.seq, { 'next-turn': [...queue['next-turn']], 'next-step': [...queue['next-step']] });
    const s = event.data;
    const q = queue[s.target];
    if (!Array.isArray(q)) continue;
    const removedCount = Number.isSafeInteger(s.removedCount) ? s.removedCount : 0;
    if (!Number.isSafeInteger(s.start) || s.start < 0 || s.start > q.length || s.start + removedCount > q.length) continue;
    queue[s.target] = [...q.slice(0, s.start), ...(s.inserted ?? []), ...q.slice(s.start + removedCount)];
  }

  /* 2) 收集将被删除的消息 id。三类：
     a) 被删事件自身携带的 message（表层 user/assistant 消息体）；
     b) 被删 splice 插入的消息；
     c) **被删 splice 从队列里移除掉的消息** —— 那是被删轮次 claim 走的输入；
        漏掉 c) 它们就会留在新队列里，界面上就是"删掉的东西还挂在排队消息"。 */
  const deletedIds = new Set();
  const collect = (message) => { if (message && typeof message.id === 'string') deletedIds.add(message.id) };
  for (const event of events) {
    if (!removeSet.has(event.seq)) continue;
    collect(event.data?.message);
    if (Array.isArray(event.data?.inserted)) for (const m of event.data.inserted) collect(m);
    if (typeof event.data?.id === 'string' && (event.type === 'user/message' || event.type === 'assistant/message')) deletedIds.add(event.data.id);
    if (event?.type === 'agent/inbox/spliced') {
      const snapshot = before.get(event.seq)?.[event.data?.target];
      if (Array.isArray(snapshot)) {
        const rc = Number.isSafeInteger(event.data.removedCount) ? event.data.removedCount : 0;
        if (Number.isSafeInteger(event.data.start) && event.data.start >= 0 && event.data.start + rc <= snapshot.length) {
          for (const m of snapshot.slice(event.data.start, event.data.start + rc)) collect(m);
        }
      }
    }
  }

  // 3) 投影到新队列
  const rewrites = new Map();
  const newQueue = { 'next-turn': [], 'next-step': [] };
  let touched = 0;
  for (const event of events) {
    if (event?.type !== 'agent/inbox/spliced') continue;
    const s = event.data;
    const target = s.target;
    const oldQ = before.get(event.seq)?.[target];
    if (!Array.isArray(oldQ)) continue;
    const newQ = newQueue[target];
    const removedCount = Number.isSafeInteger(s.removedCount) ? s.removedCount : 0;
    if (!Number.isSafeInteger(s.start) || s.start < 0 || s.start > oldQ.length || s.start + removedCount > oldQ.length) continue;
    const range = oldQ.slice(s.start, s.start + removedCount);
    const survivingRange = range.filter((m) => !deletedIds.has(m?.id));
    /* 插入点 = 区间内第一个存活元素在新队列里的下标；
       区间内全被删则取「区间之前最后一个存活元素」的下标 + 1；
       都找不到就落在队首。 */
    let newStart = -1;
    for (const m of survivingRange) {
      const idx = newQ.findIndex((x) => x?.id === m?.id);
      if (idx >= 0) { newStart = idx; break }
    }
    if (newStart < 0) {
      for (let i = s.start - 1; i >= 0; i--) {
        if (deletedIds.has(oldQ[i]?.id)) continue;
        const idx = newQ.findIndex((x) => x?.id === oldQ[i]?.id);
        newStart = idx >= 0 ? idx + 1 : 0;
        break;
      }
    }
    if (newStart < 0) newStart = 0;
    if (newStart > newQ.length) newStart = newQ.length;
    // 仍在新队列里的「区间存活成员」条数（连续，故可直接 toSpliced）
    let newRemoved = survivingRange.filter((m) => newQ.some((x) => x?.id === m?.id)).length;
    if (newStart + newRemoved > newQ.length) {
      newRemoved = survivingRange.filter((m) => newQ.slice(newStart).some((x) => x?.id === m?.id)).length;
      if (newStart + newRemoved > newQ.length) newRemoved = Math.max(0, newQ.length - newStart);
    }
    const newInserted = (s.inserted ?? []).filter((m) => !deletedIds.has(m?.id));
    newQueue[target] = [...newQ.slice(0, newStart), ...newInserted, ...newQ.slice(newStart + newRemoved)];
    const changed = newStart !== s.start || newRemoved !== removedCount || newInserted.length !== (s.inserted ?? []).length;
    if (changed) {
      touched += 1;
      rewrites.set(event.seq, { target, start: newStart, removedCount: newRemoved, inserted: newInserted });
    }
  }
  return { rewrites, deletedIds, stats: { splices: before.size, rewritten: touched, deletedIds: deletedIds.size } };
}

/** 把 planInboxRewrite 的结果应用到事件副本上（只改 splice 的 data）。 */
export function applyInboxRewrite(events, rewrites) {
  if (!rewrites || rewrites.size === 0) return events;
  return events.map((event) => {
    const next = rewrites.get(event.seq);
    if (!next) return event;
    return { ...event, data: { ...event.data, target: next.target, start: next.start, removedCount: next.removedCount, inserted: next.inserted } };
  });
}

export function purgeSessionFile(file, sid, options = {}) {
  const out = { sid, status: 'clean', events: 0, removed: 0, turns: [], verify: false, problems: [], notes: [] };
  let doc;
  try { doc = readSession(file) } catch (error) {
    out.status = 'failed';
    out.notes.push(`readSession: ${String(error?.message ?? error).slice(0, 160)}`);
    return out;
  }
  const { header, events } = doc;
  out.events = events.length;
  const plan = planPurge(events, { sinceMs: options.sinceMs });
  out.turns = plan.turns;
  if (plan.remove.length === 0) {
    if (plan.skipped.length > 0) out.notes.push(`skipped=${JSON.stringify(plan.skipped.slice(0, 4))}`);
    return out;
  }
  /* inbox 链条重写：**必须在 excise 之前**应用——rewrites 以「原始 seq」为键，
     而 excise 会重编号；顺序反了就会整体错位（实测：链条看似通过，被删消息
     实际还挂在队列上）。 */
  const inboxRewrite = planInboxRewrite(events, plan.remove);
  const inputEvents = applyInboxRewrite(events, inboxRewrite.rewrites);
  let result;
  try {
    result = excise(header, inputEvents, plan.remove, { expandToWholeTurns: true });
  } catch (error) {
    out.status = 'failed';
    out.notes.push('excise: ' + String(error?.message ?? error).slice(0, 200));
    return out;
  }
  const v = verify(result.header, result.events);
  out.verify = v.ok === true;
  out.removed = events.length - result.events.length;
  if (!v.ok) {
    out.status = 'skipped';
    out.problems = (v.problems ?? []).slice(0, 6).map(String);
    return out;
  }
  /* 后置条件一：inbox 状态机必须能在结果上完整重放（否则宿主打不开会话）。 */
  const inbox = checkInboxSplices(result.events);
  if (inbox.problems.length > 0) {
    out.status = 'skipped';
    out.notes.push('refused: 切除后 inbox 状态机不通过 ' + JSON.stringify(inbox.problems[0]));
    return out;
  }
  /* 后置条件二：被删消息 id 不得在任何存活事件里残留（否则界面上会以
     「排队消息」/标题引用等形态复现）。命中即拒绝，绝不产出半干净的文件。 */
  if (inboxRewrite.deletedIds.size > 0) {
    const blob = JSON.stringify(result.events);
    const residue = [...inboxRewrite.deletedIds].filter((id) => blob.includes(id));
    if (residue.length > 0) {
      out.status = 'skipped';
      out.notes.push('refused: 被删消息 id 仍有 ' + residue.length + ' 个残留在结果里 ' + JSON.stringify(residue.slice(0, 5)));
      return out;
    }
  }
  if (inboxRewrite.stats.rewritten > 0) {
    out.notes.push('inbox-chain rewritten: ' + JSON.stringify(inboxRewrite.stats));
  }
  try {
    if (options.backupDir) {
      mkdirSync(options.backupDir, { recursive: true });
      copyFileSync(file, join(options.backupDir, `${sid}.zstd`));
    }
    writeSession(file, result.header, result.events);
    const back = readSession(file);
    const v2 = verify(back.header, back.events);
    out.verify = v2.ok === true;
    out.status = v2.ok === true ? 'written' : 'failed';
    out.after = back.events.length;
    if (v2.ok !== true) out.problems = (v2.problems ?? []).slice(0, 6).map(String);
  } catch (error) {
    out.status = 'failed';
    out.notes.push(`write: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  return out;
}

/** 待清理台账：记录「有墓碑但当时是 live（不能动文件）」的会话，供下次开机补清。 */
export function readPendingLedger(home) {
  try {
    const j = JSON.parse(readFileSync(join(home, 'dsh-true-delete-pending.json'), 'utf8'));
    if (!j || typeof j !== 'object' || !j.pending || typeof j.pending !== 'object') return { pending: {} };
    return j;
  } catch {
    return { pending: {} };
  }
}

/** 写台账（永不抛）。 */
export function writePendingLedger(home, ledger) {
  try {
    writeFileSync(join(home, 'dsh-true-delete-pending.json'), JSON.stringify(ledger, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}
