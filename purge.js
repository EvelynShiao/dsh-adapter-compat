/**
 * 真删除（物理切除）门面 —— adapter-compat 第六层的引擎侧。
 *
 * 依赖同目录的 true-delete.js（从 _truedelete/excision.mjs 原样移植，已过 52/52 自测）。
 * 本文件只负责「找哪些会话有可清理墓碑 → 算要删的事件 → 切除 → 校验 → 备份写盘」，
 * 不持有任何 DSH 状态；ctx 由调用方注入（只为拿 live 判定与 projcache 路径）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSession, writeSession, excise, verify, seqsOfTurn, decodeSeqRanges } from './true-delete.js';

/** 会写盘的调用方必须显式传 write:true；默认干跑。 */
export const PURGE_DEFAULTS = Object.freeze({ write: false, only: undefined, home: undefined });

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
    if (!Array.isArray(event.sourceEventSeqs)) return { skip: true, why: 'no-summary-no-sources' };
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
export function planPurge(events) {
  const byseq = new Map(events.map((e) => [e.seq, e]));
  const turnSet = new Set();
  const skipped = [];
  for (const e of events) {
    const c = classifyTombstoneCarrier(e);
    if (!c) continue;
    if (c.skip) { skipped.push({ seq: e.seq, why: c.why }); continue }
    if (c.needsNodeLookup) {
      for (const sq of c.sourcesFor) {
        const node = byseq.get(sq);
        if (node && Number.isSafeInteger(node.data?.turn)) turnSet.add(node.data.turn);
      }
      continue;
    }
    for (const turn of c.turns) turnSet.add(turn);
  }
  const remove = new Set();
  for (const turn of turnSet) for (const sq of seqsOfTurn(events, turn)) remove.add(sq);

  /* 孤立的 agent/inbox/spliced：它记录的 user 消息已经被物理删除，但被问的文本
     还留在这条日志事件里（Timeline/文件都还看得见）。判别用 rpcId 引用次数：
     仍活着的消息其 rpcId 在整份日志里出现 2 次（spliced + user/message），
     被删掉的只剩 1 次 —— 实测已验证（3590 出现 2 次仍在，3606/3609 只剩 1 次）。
     只在本次确实要删轮次时才顺带清理，避免误伤「消息发出但轮次从未运行」的场景。 */
  if (turnSet.size > 0) {
    const rpcCounts = new Map();
    for (const event of events) {
      for (const m of JSON.stringify(event).matchAll(/"rpcId":"([^"]+)"/g)) {
        rpcCounts.set(m[1], (rpcCounts.get(m[1]) ?? 0) + 1);
      }
    }
    for (const event of events) {
      if (event.type !== 'agent/inbox/spliced') continue;
      const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : [];
      if (inserted.length === 0) continue;
      const orphan = inserted.every((ins) => {
        const id = ins?.source?.rpcId;
        return typeof id === 'string' && (rpcCounts.get(id) ?? 0) <= 1;
      });
      if (orphan) remove.add(event.seq);
    }
  }
  return { remove: [...remove].sort((a, b) => a - b), turns: [...turnSet].sort((a, b) => a - b), skipped };
}

/**
 * 处理一个会话文件：算 → 切除 → 校验（可选写盘，带备份 + 读回复核）。
 * @param {string} file - session.v4.jsonl.zstd 绝对路径
 * @param {string} sid
 * @param {object} options - { write, backupDir, onNote }
 * @returns {object} 结果摘要（status: clean|planned|skipped|failed|written）
 */
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
  const plan = planPurge(events);
  out.turns = plan.turns;
  if (plan.remove.length === 0) {
    if (plan.skipped.length > 0) out.notes.push(`skipped=${JSON.stringify(plan.skipped.slice(0, 4))}`);
    return out;
  }
  let result;
  try {
    result = excise(header, events, plan.remove, { expandToWholeTurns: true });
  } catch (error) {
    out.status = 'failed';
    out.notes.push(`excise: ${String(error?.message ?? error).slice(0, 200)}`);
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
  out.status = 'planned';
  if (options.write !== true) return out;
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
    return j && typeof j === 'object' && j.pending && typeof j.pending === 'object' ? j : { pending: {} };
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
