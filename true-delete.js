/**
 * excision.mjs —— DSH 会话文件「物理切除」引擎（纯函数 + 可单测，无副作用）
 *
 * 目标：把指定 seq 的事件从会话日志里真正删除（不是 replace 遮蔽），并让结果
 *       仍然满足 DSH V4 会话的全部运行时约束。
 *
 * 权威来源：
 *   - 伪造对话规则.txt（附件）
 *   - @deepseek-ai/dsh-session/lib/types/surface.js（foldSurface / validateSurfaceMetadata / decodeSeqRanges）
 *   - @deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs（restoreReleasedV4Artifact /
 *     assertReleasedV4Relationships / Relationships 状态机 / decodeSeqRanges 两版）
 *   规则文件与官方源码冲突处一律以官方运行时约束为准，差异见 REPORT.md。
 *
 * 契约（三个导出）：
 *   readSession(path)                    -> {header, events, frames, warnings}
 *   writeSession(path, header, events, o)-> {frames, bytes}          （唯一写盘入口，调用方负责只在副本上用）
 *   excise(header, events, removeSeqs,o) -> {header, events, report} （纯函数，不碰盘）
 *   verify(header, events, opts?)        -> {ok, problems, stats}
 *
 * 所有函数都不修改入参（内部深拷贝）。
 */
import fs from "node:fs";
import { zstdDecompressSync, zstdCompressSync, constants } from "node:zlib";

// ───────────────────────────── 常量（全部来自官方运行时） ─────────────────────────────

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const ZSTD_SKIPPABLE = 0x184d2a50; // 0x184D2A50..0x184D2A5F
/** 试解一帧时的窗口上限：zstd 解压器不需要「精确到帧尾」的输入（读满一帧即停下，不会去啃后面的垃圾） */
const FRAME_WINDOW = 8 * 1024 * 1024;
const CHECKSUM = Object.freeze({ params: { [constants.ZSTD_c_checksumFlag]: 1 } });

/** 表层（model-visible）事件类型 —— surface.js SURFACE_EVENT_TYPES */
export const SURFACE_TYPES = new Set([
  "system/message",
  "developer/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

/**
 * Relationships.accept 里「必须先落在开启的 step 内」的类型 —— worker.cjs STEP_EVENT_TYPES。
 * 注意：它只有这三种；assistant/message、tool/call、tool/result 走 tool() 分支。
 */
export const STEP_EVENT_TYPES = new Set([
  "system/message",
  "developer/message",
  "assistant/attempt",
]);

/** worker.cjs RELATIONSHIP_TYPES：会被状态机检查的类型 */
export const RELATIONSHIP_TYPES = new Set([
  ...SURFACE_TYPES,
  ...STEP_EVENT_TYPES,
  "turn/start", "turn/end", "step/start", "step/end",
  "tool/call", "request/header", "request/context",
  "tool/ptc-dispatch-start", "tool/ptc-dispatch",
  "llm/retry", "llm/retry-started",
  "session/title", "session/title-llm-request",
  "command/run", "command/done",
  "compaction/start", "compaction/summary", "compaction/end", "compaction/prune",
  "session/end-seed",
]);

/** known-event-types.js KNOWN_SESSION_EVENT_TYPES（本机 DSH 构建的词汇表） */
export const KNOWN_EVENT_TYPES = new Set([
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided",
  "approval/policy", "assistant/attempt", "assistant/message", "command/done", "command/run",
  "compaction/end", "compaction/prune", "compaction/start", "compaction/summary",
  "deliverables/presented", "developer/message", "feedback/message-delete", "feedback/message-put",
  "feedback/record", "goal/change", "hook/invoked", "hook/result", "image/offload",
  "llm/retry", "llm/retry-started", "model/selection", "permission/preset", "plan/mode",
  "request/context", "request/header", "sandbox/mode", "schedule/change",
  "session-log-deepseek/delivery-accepted", "session/end-seed", "session/title",
  "session/title-llm-request", "step/end", "step/start", "subagent/catalog", "subagent/descriptor",
  "subagent/model-selection-policy", "system/message", "team/member", "team/message/delivered",
  "team/message/queued", "team/task", "todo/write", "tool-workflow/agent-end",
  "tool-workflow/agent-start", "tool-workflow/run-end", "tool-workflow/run-start", "tool/call",
  "tool/ptc-dispatch", "tool/ptc-dispatch-start", "tool/result", "turn/end", "turn/start",
  "user/message", "web/deepseek-search-llm-request", "workspace/changes",
]);

/** worker.cjs MESSAGE_PROJECTION_EVENT_TYPES：需要插件提供投影解释器的类型 */
export const MESSAGE_PROJECTION_EVENT_TYPES = new Set(["image/offload"]);

const ENVELOPE_KEYS = new Set(["type", "seq", "time", "data", "surfaceOp", "sourceEventSeqs", "ignorable"]);

export const HEADER_REQUIRED = Object.freeze(["version", "id", "createdAt", "isSeeded", "delegationDepth"]);
export const HEADER_ALLOWED = Object.freeze([
  ...HEADER_REQUIRED, "cwd", "parentSession", "origin", "agentPreset",
]);

// ───────────────────────────── 小工具 ─────────────────────────────

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isSeq = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);

/** 与 seq-ranges.js encodeSeqRanges 等价（相邻 3 个以上折成 [start,end]） */
export function encodeSeqRanges(values) {
  const strictlyIncreasing = values.every((v, i) => i === 0 || v > values[i - 1]);
  if (!strictlyIncreasing) return [...values];
  const out = [];
  for (let start = 0; start < values.length;) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end += 1;
    if (end - start >= 2) out.push([values[start], values[end]]);
    else for (let i = start; i <= end; i += 1) out.push(values[i]);
    start = end + 1;
  }
  return out;
}

/** 与 seq-ranges.js decodeSeqRanges 等价（宽松版：不强制单元素 < maxEntries） */
export function decodeSeqRanges(value) {
  if (!Array.isArray(value)) throw new TypeError("sourceEventSeqs must be an array");
  const out = [];
  let hasRange = false;
  for (const entry of value) {
    if (typeof entry === "number") {
      if (!isSeq(entry)) throw new TypeError("sourceEventSeqs members must be non-negative safe integers");
      out.push(entry);
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError("sourceEventSeqs range must be a [start, end] pair");
    const [start, end] = entry;
    if (!isSeq(start) || !isSeq(end) || end < start) throw new TypeError("sourceEventSeqs range is invalid");
    for (let s = start; s <= end; s += 1) out.push(s);
    hasRange = true;
  }
  if (hasRange) {
    const inc = out.every((v, i) => i === 0 || v > out[i - 1]);
    if (!inc) throw new TypeError("sourceEventSeqs ranges must be strictly increasing");
  }
  return out;
}

// ───────────────────────────── 读 / 写 ─────────────────────────────

/**
 * 判定 buf[at] 处是否像一个 zstd 数据帧开头。
 * bit0-1 = Dictionary_ID_flag，bit2 = Content_Checksum_flag，bit3 = Reserved（必须 0），
 * bit4 = Unused，bit5 = Single_Segment_flag，bit6-7 = Frame_Content_Size_flag。
 * 注意：bit7 属于 FCS flag，**不是**保留位（踩过：把它当保留位会把 FCS=2 的帧全判成非法）。
 */
function looksLikeFrame(buf, at) {
  if (at + 5 > buf.length) return false;
  if (!buf.subarray(at, at + 4).equals(MAGIC)) return false;
  if ((buf[at + 4] & 0x08) !== 0) return false; // Reserved 位
  return true;
}

const RLE_BLOCK = 1, COMPRESSED_BLOCK = 2;

/**
 * 按 zstd 帧结构算出某一帧的精确字节长度。
 *
 * 为什么必须自己算：Node 的 zstdDecompressSync 只解到该帧结束就返回，
 * **不会核对尾部垃圾**（实测把 [帧0 + 帧1 + …] 整段喂进去，它只吐帧0 的 250 字节且不报错），
 * 所以「多给一点、等它报错」这种找边界的方法在这里是错的、会静默漏帧。
 *
 * zstd 规格 §3.1.1 Frame_Header_Descriptor 位域（bit0 = LSB）：
 *   bit0-1 Dictionary_ID_flag，bit2 Content_Checksum_flag，bit3 Reserved(0)，
 *   bit4 Unused，bit5 Single_Segment_flag，bit6-7 Frame_Content_Size_flag。
 *
 * @returns {number|null} 帧总字节数（含 magic 与 checksum），解析不了返回 null
 */
export function zstdFrameLength(buf, at) {
  if (!looksLikeFrame(buf, at)) return null;
  const fhd = buf[at + 4];
  const didFlag = fhd & 0x03;
  const checksum = (fhd & 0x04) !== 0;
  const singleSegment = (fhd & 0x20) !== 0;
  const fcsFlag = (fhd >> 6) & 0x03;

  let p = at + 5;
  if (!singleSegment) p += 1;                    // Window_Descriptor
  const didBytes = [0, 1, 2, 4][didFlag];
  p += didBytes;                                 // Dictionary_ID
  // Frame_Content_Size：fcsFlag=0 时单段帧占 1 字节、非单段帧 0 字节
  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  if (p + fcsBytes > buf.length) return null;
  let contentSize = null;
  if (fcsBytes === 1) contentSize = buf[p];
  else if (fcsBytes === 2) contentSize = buf.readUInt16LE(p) + 256;
  else if (fcsBytes === 4) contentSize = buf.readUInt32LE(p);
  else if (fcsBytes === 8) contentSize = Number(buf.readBigUInt64LE(p));
  p += fcsBytes;

  // block 区：每个 block 3 字节头（Last_Block 1bit / Block_Type 2bit / Block_Size 21bit）
  let q = p;
  let produced = 0;
  let blocks = 0;
  for (;;) {
    if (q + 3 > buf.length) return null;
    const h = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16);
    const last = (h & 0x01) !== 0;
    const btype = (h >> 1) & 0x03;
    const bsize = h >> 3;
    q += 3;
    if (btype === RLE_BLOCK) { produced += bsize; q += 1; }
    else if (btype === COMPRESSED_BLOCK) q += bsize;
    else if (btype === 0) { produced += bsize; q += bsize; }
    else return null; // Block_Type 3 是保留值
    blocks += 1;
    if (q > buf.length) return null;
    if (last) break;
    if (contentSize !== null && produced >= contentSize) break;
    if (blocks > 5_000_000) return null;
  }
  const end = q + (checksum ? 4 : 0);           // 帧尾绝对偏移
  const length = end - at;                       // 帧总字节数
  return end <= buf.length ? length : null;
}

/**
 * 顺序切帧：从 0（或给定起点）开始逐帧按结构长度前进。
 * 容错：任一帧解析失败就退化成「从下一个 magic 起重试」并记 warning。
 * @returns {{cuts:number[], warnings:string[]}}
 */
function readFrames(buf, startAt = 0) {
  const cuts = [];
  const warnings = [];
  let at = startAt;
  while (at < buf.length) {
    const len = zstdFrameLength(buf, at);
    if (len !== null && len > 0) { cuts.push(at); at += len; continue; }
    const next = buf.indexOf(MAGIC, at + 1);
    if (next === -1) break;
    if (looksLikeFrame(buf, next)) {
      cuts.push(next);
      const l2 = zstdFrameLength(buf, next);
      if (l2 !== null && l2 > 0) { at = next + l2; continue; }
    }
    at = next;
  }
  return { cuts, warnings };
}

/**
 * 逐帧扫描 + 解压 + 解析。容错：magic 随机命中跳过；坏帧跳过并记 warning。
 * @param {string} path 会话文件（.../session.v4.jsonl.zstd）
 * @returns {{header:object|null, events:object[], frames:{index:number,offset:number,bytes:number,plain:string}[], warnings:string[], headerLine:string|null}}
 */
export function readSession(path) {
  const buf = fs.readFileSync(path);
  const warnings = [];
  const scan = readFrames(buf);
  warnings.push(...scan.warnings);
  const cuts = scan.cuts;
  if (cuts.length === 0) throw new Error("没有找到任何 zstd 帧（magic 28 B5 2F FD）");

  const frames = [];
  for (let k = 0; k < cuts.length; k += 1) {
    const start = cuts[k];
    const end = k + 1 < cuts.length ? cuts[k + 1] : buf.length;
    const bytes = buf.subarray(start, end);
    let plain;
    try { plain = zstdDecompressSync(bytes).toString("utf8"); }
    catch (e) { warnings.push(`帧 ${k} 解压失败（已跳过）：${e.message}`); continue; }
    frames.push({ index: frames.length, offset: start, bytes: end - start, plain });
  }
  if (frames.length === 0) throw new Error("所有帧都解不开");

  let header = null;
  let headerLine = null;
  let bodyStart = 0;
  const first = frames[0].plain;
  const nl = first.indexOf("\n");
  if (nl >= 0 && first.indexOf("\n", nl + 1) === -1) {
    headerLine = first;
    try { header = JSON.parse(first.slice(0, nl)); }
    catch (e) { warnings.push(`帧0 不是合法 JSON 头：${e.message}`); }
    bodyStart = 1;
  } else {
    // 老式单帧/多帧混排：把所有明文按顺序拼起来，第一行是头
    warnings.push("帧0 不是「仅头一行」形态，按拼接流解析（旧格式/被压扁过的文件）");
    const all = frames.map((f) => f.plain).join("");
    const i2 = all.indexOf("\n");
    if (i2 < 0) throw new Error("拼接明文里没有换行，无法定位头部");
    headerLine = all.slice(0, i2 + 1);
    header = JSON.parse(all.slice(0, i2));
    frames.length = 0;
    frames.push({ index: 0, offset: 0, bytes: buf.length, plain: all });
    bodyStart = 0;
  }

  const events = [];
  for (let k = bodyStart; k < frames.length; k += 1) {
    const lines = frames[k].plain.split("\n");
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      if (line.trim() === "") continue;
      try { events.push(JSON.parse(line)); }
      catch (e) {
        warnings.push(`帧 ${frames[k].index} 第 ${li + 1} 行不是合法 JSON（已跳过）：${String(line).slice(0, 120)}`);
      }
    }
  }
  return { header, events, frames, warnings, headerLine };
}

/**
 * 按格式重写：帧0 仅头一行 + 后续帧（每帧明文以 \n 结尾，绝不断在 JSON 行中间），每帧带 checksum。
 * @param {string} path
 * @param {object} header
 * @param {object[]} events
 * @param {{bytesPerFrame?:number, singleEventFrames?:boolean}} [opts]
 */
export function writeSession(path, header, events, opts = {}) {
  const bytesPerFrame = opts.bytesPerFrame ?? 65536;
  const single = opts.singleEventFrames === true;
  const headerLine = JSON.stringify(header) + "\n";
  const parts = [zstdCompressSync(Buffer.from(headerLine, "utf8"), CHECKSUM)];

  const groups = [];
  let cur = [];
  let curBytes = 0;
  for (const e of events) {
    const line = JSON.stringify(e) + "\n";
    const size = Buffer.byteLength(line, "utf8");
    if (single || (cur.length > 0 && curBytes + size > bytesPerFrame)) { groups.push(cur); cur = []; curBytes = 0; }
    cur.push(line);
    curBytes += size;
  }
  if (cur.length > 0) groups.push(cur);

  for (const g of groups) parts.push(zstdCompressSync(Buffer.from(g.join(""), "utf8"), CHECKSUM));
  const out = Buffer.concat(parts);
  fs.writeFileSync(path, out);
  return { frames: parts.length, bytes: out.length, groups: groups.map((g) => g.length) };
}

// ───────────────────────────── 表层 fold（只用于读数，不做强校验） ─────────────────────────────

/**
 * 顺序扫描表层，返回每个事件被遮蔽的表层节点集合。
 * @returns {{nodes:number[], replaceShadows:Map<number,number[]>, protectedHead:number|undefined, notes:string[]}}
 */
export function foldSurfaceLoose(events) {
  const nodes = [];
  const replaceShadows = new Map();
  const notes = [];
  let protectedHead;
  for (const e of events) {
    if (e.type === "system/message" && nodes.length > 0 && protectedHead === undefined) {
      notes.push(`system/message@${e.seq} 出现在表层非首位且此前没有受保护头`);
    }
    if (!SURFACE_TYPES.has(e.type)) {
      if (e.surfaceOp !== undefined || e.sourceEventSeqs !== undefined) {
        notes.push(`非表层事件 ${e.type}@${e.seq} 带了 surfaceOp/sourceEventSeqs`);
      }
      continue;
    }
    if (e.surfaceOp === "append" || e.surfaceOp === undefined) {
      if (e.surfaceOp === undefined) notes.push(`表层事件 ${e.type}@${e.seq} 缺 surfaceOp`);
      if (e.type === "system/message" && nodes.length === 0) protectedHead = e.seq;
      nodes.push(e.seq);
      continue;
    }
    const op = e.surfaceOp;
    const first = nodes.indexOf(op.startSeq);
    const last = nodes.indexOf(op.endSeq);
    if (first < 0 || last < first) {
      notes.push(`replace@${e.seq} 范围 [${op.startSeq},${op.endSeq}] 不在当前表层上`);
      continue;
    }
    const shadowed = nodes.slice(first, last + 1);
    replaceShadows.set(e.seq, shadowed);
    if (protectedHead !== undefined && shadowed.includes(protectedHead)) {
      if (e.type !== "system/message" || shadowed.length !== 1) notes.push(`replace@${e.seq} 遮蔽了受保护系统头`);
      else protectedHead = e.seq;
    }
    nodes.splice(first, shadowed.length, e.seq);
  }
  return { nodes, replaceShadows, protectedHead, notes };
}

// ───────────────────────────── 核心：excise ─────────────────────────────

/** seq 引用字段登记表：key = 路径，value = 处理方式 */
export const SEQ_REF_RULES = Object.freeze({
  "surfaceOp.startSeq": { kind: "surface-anchor" },
  "surfaceOp.endSeq": { kind: "surface-anchor" },
  "sourceEventSeqs": { kind: "ranges" },
  "data.headerSeq": { kind: "headerSeq" },
  "data.messageSeqs": { kind: "list", note: "session/title" },
  "data.throughSeq": { kind: "throughSeq", note: "delivery 水位线" },
  "data.shadowedRange.start": { kind: "compaction" },
  "data.shadowedRange.end": { kind: "compaction" },
  "data.shadowedSeqs": { kind: "compaction" },
  "data.sourceEventSeq": { kind: "plain", note: "command/done 溯源" },
});

const RULE_BY_PATH = new Map(Object.entries(SEQ_REF_RULES));

/** 收集事件里所有「值落在事件 seq 空间内」的数字字段路径（用于悬空引用体检） */
function numericRefPaths(value, prefix, seqSpace, out) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (typeof v === "number") { if (isSeq(v)) out.push({ path: `${prefix}[i]`, value: v }); }
      else numericRefPaths(v, `${prefix}[]`, seqSpace, out);
    });
    return;
  }
  if (!isObj(value)) return;
  for (const [k, v] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number") { if (isSeq(v)) out.push({ path: p, value: v }); }
    else numericRefPaths(v, p, seqSpace, out);
  }
}

/** 建 turn 表：turn 号 -> {startSeq, endSeq, seqs} */
function turnTable(events) {
  const table = new Map();
  let cur = null;
  const put = (t, field, seq, e) => {
    let rec = table.get(t);
    if (!rec) { rec = { turn: t, startSeq: undefined, endSeq: undefined, seqs: [], opens: [], closes: [] }; table.set(t, rec); }
    if (field === "start") { rec.startSeq ??= seq; rec.opens.push(seq); }
    if (field === "end") { rec.endSeq = seq; rec.closes.push(seq); }
    rec.seqs.push(seq);
    rec.startEvent ??= e;
  };
  for (const e of events) {
    if (e.type === "turn/start") { cur = e.data?.turn; put(cur, "start", e.seq, e); }
    else if (e.type === "turn/end") { put(e.data?.turn, "end", e.seq, e); cur = null; }
    else if (cur !== null && cur !== undefined && e.data && typeof e.data === "object" && typeof e.data.turn === "number") {
      put(e.data.turn, "body", e.seq, e);
    }
  }
  return table;
}

/**
 * 物理切除事件。
 *
 * @param {object} header 会话头（不会被改）
 * @param {object[]} events 事件数组（不会被改）
 * @param {Iterable<number>} removeSeqs 要删除的 seq 集合
 * @param {object} [options]
 * @param {boolean} [options.expandToWholeTurns] true 时把与删除集相交的整个 turn（turn/start..turn/end）纳入删除
 * @param {boolean} [options.keepShrunkCarriers] true 时，遮蔽区间被删掉一部分的 replace 载体不剔除、改为改锚到幸存的节点（默认 false＝保守剔除）
 * @returns {{header:object, events:object[], report:object}}
 */
export function excise(header, events, removeSeqs, options = {}) {
  const headerOut = clone(header) ?? header;
  const src = clone(events) ?? [];
  const report = {
    input: { events: src.length, header: headerOut?.id ?? null },
    removed: { requested: 0, effective: 0, seqs: [], byType: {} },
    remap: { size: 0, deletedSeqs: [] },
    refs: {},                        // 字段路径 -> 重映射次数
    dropped: [],                     // 被整体移除的事件（载体）
    reanchored: [],                  // 重算过 replace 锚点的事件
    dangling: [],                    // 指向已删事件、未能重映射的引用
    turnRenumber: [],                // [old,new]
    conflicts: [],                   // 需要人工判断的问题
    notes: [],                       // 体检信息
    verify: null,
  };

  const orig = new Map(src.map((e) => [e.seq, e]));
  /** 被整体剔除的载体（先声明：gone() 需要在候选计算前就能看到它） */
  const droppedCarriers = new Set();

  // ── 1. 删除集 ──
  const remove = new Set();
  for (const s of removeSeqs) {
    if (!Number.isSafeInteger(s) || s < 0) { report.conflicts.push({ kind: "bad-remove-seq", seq: s }); continue; }
    if (!orig.has(s)) { report.conflicts.push({ kind: "remove-seq-not-found", seq: s }); continue; }
    remove.add(s);
  }
  report.removed.requested = remove.size;

  if (options.expandToWholeTurns) {
    const tt = turnTable(src);
    for (const rec of tt.values()) {
      if (rec.startSeq === undefined || rec.endSeq === undefined || rec.endSeq < rec.startSeq) continue;
      let hit = false;
      for (let s = rec.startSeq; s <= rec.endSeq; s += 1) if (remove.has(s)) { hit = true; break; }
      if (hit) for (let s = rec.startSeq; s <= rec.endSeq; s += 1) if (orig.has(s)) remove.add(s);
    }
    report.removed.requested = remove.size;
  }

  // ── 2. 原表层 fold（重算 replace 锚点的唯一依据）──
  const oldFold = foldSurfaceLoose(src);
  for (const n of oldFold.notes) report.notes.push("原文件：" + n);
  // ── 3. turn 重编号（只对「完整存活」的 turn 生效）──
  const tt = turnTable(src);
  const turnMap = new Map();
  let nextTurn = 1;
  for (const t of [...tt.keys()].sort((a, b) => a - b)) {
    const rec = tt.get(t);
    const complete = rec.startSeq !== undefined && rec.endSeq !== undefined && rec.endSeq > rec.startSeq;
    if (!complete) { report.conflicts.push({ kind: "incomplete-turn", turn: t, startSeq: rec.startSeq, endSeq: rec.endSeq }); continue; }
    let removedInside = 0;
    for (let s = rec.startSeq; s <= rec.endSeq; s += 1) if (remove.has(s)) removedInside += 1;
    if (removedInside === 0) turnMap.set(t, nextTurn++);
    else if (removedInside === rec.endSeq - rec.startSeq + 1) {
      // 整轮删除：正常，不需要重编号，剩下的轮按顺序前移
      report.turnRenumber.push([t, null]);
    } else {
      report.conflicts.push({
        kind: "partially-removed-turn", turn: t, startSeq: rec.startSeq, endSeq: rec.endSeq,
        removedInside, total: rec.endSeq - rec.startSeq + 1,
        hint: "该 turn 只被删掉一部分：要么整轮删（推荐用 opts.expandToWholeTurns:true，会自动补上 turn/start 与 turn/end），要么别删",
      });
    }
  }
  for (const [o, n] of turnMap) if (n !== null && o !== n) report.turnRenumber.push([o, n]);

  // ── 4. 建立 old -> new 映射（只含存活事件）──
  const survivors = src.filter((e) => !remove.has(e.seq));
  const map = new Map();
  survivors.forEach((e, i) => map.set(e.seq, i));
  report.remap.size = map.size;
  report.remap.deletedSeqs = [...remove].sort((a, b) => a - b);
  report.removed.effective = remove.size;
  report.removed.seqs = [...remove].sort((a, b) => a - b);
  for (const s of report.removed.seqs) {
    const t = orig.get(s)?.type ?? "?";
    report.removed.byType[t] = (report.removed.byType[t] ?? 0) + 1;
  }

  // ── 5. 载体候选（replace / compaction）──
  const candidates = [];
  for (const e of src) {
    if (remove.has(e.seq)) continue;
    const isReplace = e.surfaceOp !== undefined && e.surfaceOp !== "append";
    const isCompact = e.type === "compaction/prune" || e.type === "compaction/summary";
    if (!isReplace && !isCompact) continue;
    const shadowed = isReplace
      ? (oldFold.replaceShadows.get(e.seq) ?? [])
      : (Array.isArray(e.data?.shadowedSeqs) ? e.data.shadowedSeqs : []);
    candidates.push({ seq: e.seq, type: e.type, isReplace, shadowed, op: isReplace ? e.surfaceOp : null });
  }
  // 官方 assertSystemHeadRewrite：表层 0 号节点是 system/message 时受保护。
  // 删除受保护头「之前/之外」的东西不会动摇它；但如果删除动作让某个 replace 载体
  // 变成会遮蔽它，就必须剔除该载体（否则原文里合法、产物里非法）。
  const ORIGINAL_HEAD = oldFold.protectedHead;

  /** seq -> 剔除原因（"orphaned" | "narrowed" | "protected-head"） */
  const dropReason = new Map();

  // ── 6+7. 一次定点迭代定下所有要剔除的载体 ──
  // 判定依据（任一命中即剔除）：
  //   narrowed       : 该 replace 原本遮蔽 N 个表层节点，其中一部分被物理删除 → 改锚会让原文复活、
  //                    并让「删了几条」的台账失真（默认保守剔除，可用 keepShrunkCarriers 改成改锚）
  //   orphaned       : 全部遮蔽节点都不存在了
  //   protected-head : 剔除后会遮蔽受保护系统头（官方 assertSystemHeadRewrite 禁止）
  // 必须在这里一次定完：7c 半路剔除会把已经算好的 old→new 编号打出空洞。
  let plan = null;
  for (let iter = 0; iter < candidates.length + 3; iter += 1) {
    plan = buildPlan({ src, remove, candidates, droppedCarriers });
    let changed = false;
    for (const rec of plan.carriers.values()) {
      if (droppedCarriers.has(rec.seq)) continue;
      let reason = null;
      if (rec.shadowedNew.length === 0) reason = "orphaned";
      else if (rec.shadowedOld.length > rec.shadowedNew.length && options.keepShrunkCarriers !== true) reason = "narrowed";
      else if (ORIGINAL_HEAD !== undefined && rec.isReplace
        && rec.shadowedNew.includes(ORIGINAL_HEAD)
        && !(rec.shadowedNew.length === 1 && rec.type === "system/message")) reason = "protected-head";
      if (reason === null) continue;
      droppedCarriers.add(rec.seq);
      dropReason.set(rec.seq, { reason, rec });
      changed = true;
    }
    if (!changed) break;
  }
  plan = buildPlan({ src, remove, candidates, droppedCarriers });

  // 统一汇报载体去向，分三类，别让它们「凭空消失」
  // 注意：调用方点名删除的载体（remove 命中）不算「引擎剔除」，report.dropped 只记后者，
  //       report.removed.byType 里有它们的删除计数。
  for (const c of candidates) {
    if (remove.has(c.seq)) continue;
    const hit = dropReason.get(c.seq);
    if (!hit) continue;
    const lostCount = hit.rec.shadowedOld.length - hit.rec.shadowedNew.length;
    report.dropped.push({
      seq: c.seq, newSeq: null, type: c.type,
      mode: hit.reason === "narrowed" ? "carrier-narrowed" : "carrier-orphaned",
      reason: hit.reason === "narrowed"
        ? `replace 原本遮蔽 ${hit.rec.shadowedOld.length} 个表层节点（旧 seq ${JSON.stringify(hit.rec.shadowedOld)}），其中 ${lostCount} 个已被物理删除；改锚会让原文复活并让删除台账失真，故整条剔除`
        : hit.reason === "orphaned"
          ? "该载体的全部遮蔽节点都已不存在（被删除或被剔除），保留会遮蔽无关内容"
          : `剔除它会遮蔽受保护系统头 #${ORIGINAL_HEAD}（官方 assertSystemHeadRewrite 禁止）`,
      oldShadowed: hit.rec.shadowedOld,
      survivors: hit.rec.shadowedNew,
    });
    report.conflicts.push({
      kind: hit.reason === "narrowed" ? "replace-carrier-narrowed"
        : hit.reason === "orphaned" ? "replace-carrier-orphaned" : "carrier-would-shadow-protected-head",
      seq: c.seq, type: c.type, oldShadowed: hit.rec.shadowedOld, survivors: hit.rec.shadowedNew,
      hint: "已按保守策略整条剔除该载体（等价于撤销这次 replace），请人工确认语义",
    });
  }

  // 第 5.9 步：统一重编号（剔除载体后 old→new 位置映射）
  const finalEvents = plan.survivors
    .filter((e) => !droppedCarriers.has(e.seq))
    .map((e) => clone(e));
  const finalMap = new Map();
  finalEvents.forEach((e, i) => finalMap.set(e.seq, i));
  const resolve = (oldSeq) => finalMap.get(oldSeq);

  // ── 6. 重映射引用 ──
  const bump = (path) => { report.refs[path] = (report.refs[path] ?? 0) + 1; };
  const newEvents = [];
  /** 归属轮没能重编号的事件按轮聚合，避免刷屏 */
  const badTurnEvents = new Map();
  for (const e of finalEvents) {
    const oldSeq = e.seq;
    const ev = clone(e);
    ev.seq = finalMap.get(oldSeq);

    // 7-pre. delivery throughSeq（session-log-deepseek 等插件的水位线）：宿主校验
    // 「delivery throughSeq must precede its marker」。重映射到存活映射；目标已被
    // 删除的夹到新 seq-1（水位线语义：宁可少承诺不越界）。2026-10-10 bee75240 实证：
    // 漏了这步会致 throughSeq 恒 +82 越界、整个会话打不开。
    if (ev.data && typeof ev.data === "object") {
      const fixThroughSeq = (node) => {
        if (!node || typeof node !== "object") return;
        for (const [k, v] of Object.entries(node)) {
          if (k === "throughSeq" && typeof v === "number") {
            const mapped = finalMap.get(v);
            const nv = mapped !== undefined && mapped < ev.seq ? mapped : ev.seq - 1;
            if (nv !== v) { node[k] = nv; bump("throughSeq"); }
          } else if (v && typeof v === "object") fixThroughSeq(v);
        }
      };
      fixThroughSeq(ev.data);
    }

    // 7a. turn 号
    if (ev.data && typeof ev.data === "object" && Object.hasOwn(ev.data, "turn") && typeof ev.data.turn === "number") {
      const nt = turnMap.get(ev.data.turn);
      if (nt === undefined) {
        const k = ev.data.turn;
        const agg = badTurnEvents.get(k) ?? { turn: k, count: 0, firstSeq: oldSeq, newSeq: ev.seq };
        agg.count += 1;
        badTurnEvents.set(k, agg);
      } else if (nt !== ev.data.turn) { ev.data.turn = nt; bump("data.turn"); }
    }

    // 7b. sourceEventSeqs（范围编码）
    if (ev.sourceEventSeqs !== undefined) {
      let flat;
      try { flat = decodeSeqRanges(ev.sourceEventSeqs); }
      catch (err) {
        report.conflicts.push({ kind: "undecodable-sourceEventSeqs", seq: oldSeq, message: err.message });
        flat = [];
      }
      const mapped = [];
      let lost = 0;
      for (const s of flat) {
        const n = resolve(s);
        if (n === undefined) { lost += 1; continue; }
        mapped.push(n);
      }
      if (lost > 0) report.dangling.push({ seq: oldSeq, newSeq: ev.seq, type: ev.type, field: "sourceEventSeqs", lost, of: flat.length });
      const uniq = [...new Set(mapped)].sort((a, b) => a - b);
      if (uniq.length === 0) {
        delete ev.sourceEventSeqs;
        bump("sourceEventSeqs.emptied");
        report.notes.push(`#${oldSeq} 的 sourceEventSeqs 重映射后为空，字段已移除`);
      } else {
        const encoded = encodeSeqRanges(uniq);
        if (JSON.stringify(encoded) !== JSON.stringify(ev.sourceEventSeqs)) bump("sourceEventSeqs");
        ev.sourceEventSeqs = encoded;
      }
    }

    // 7c. surfaceOp 锚点 —— 用新表层顺序重算（绝不按裸 seq 映射）
    //
    // 关键坑：buildPlan 的 fold 全程用「旧 seq」当节点身份（surface 坐标就是事件身份）。
    // rec.shadowedNew 是「剔除后仍然存活、原载体仍该遮蔽的旧 seq 列表」；
    // 要写回文件必须再过一道 finalMap → 新 seq，然后取首尾。
    // 会缩小遮蔽区间的载体已在第 5.5 步统一剔除，所以走到这里的载体遮蔽集都是完整的。
    if (ev.surfaceOp !== undefined && ev.surfaceOp !== "append") {
      const rec = plan.carriers.get(oldSeq);
      if (!rec || rec.shadowedNew.length === 0) {
        report.conflicts.push({ kind: "replace-carrier-without-shadow", seq: oldSeq, newSeq: ev.seq, type: ev.type });
        delete ev.surfaceOp;
        if (ev.sourceEventSeqs !== undefined) delete ev.sourceEventSeqs;
        report.notes.push(`#${oldSeq}（${ev.type}）不再有可遮蔽的节点，replace 标记与 sourceEventSeqs 已摘除`);
      } else {
        const mapped = rec.shadowedNew.map((s) => resolve(s)).filter((x) => x !== undefined);
        const lost = rec.shadowedOld.length - mapped.length;
        if (lost > 0) report.dangling.push({ seq: oldSeq, newSeq: ev.seq, type: ev.type, field: "surfaceOp.shadowed", lost, of: rec.shadowedOld.length });
        const a = mapped[0];
        const b = mapped[mapped.length - 1];
        const changed = rec.op.startSeq !== a || rec.op.endSeq !== b;
        ev.surfaceOp = { op: "replace", startSeq: a, endSeq: b };
        if (changed) {
          report.reanchored.push({ seq: oldSeq, newSeq: ev.seq, type: ev.type, from: [rec.op.startSeq, rec.op.endSeq], to: [a, b] });
          bump("surfaceOp.anchor");
        }
        // 新遮蔽集必须被 sourceEventSeqs 完整覆盖（官方 assertSourceEventReferences）
        if (ev.type === "assistant/message" && ev.sourceEventSeqs === undefined) {
          // 无 sourceEventSeqs 的 assistant 载体：官方禁止它携带，只能保持遮蔽范围不变
        } else {
          const need = new Set(mapped);
          const have = new Set(ev.sourceEventSeqs === undefined ? [] : decodeSeqRanges(ev.sourceEventSeqs));
          const missing = [...need].filter((s) => !have.has(s));
          if (missing.length > 0) {
            for (const s of missing) have.add(s);
            const merged = [...have].filter((s) => s < ev.seq).sort((x, y) => x - y);
            if (merged.length === 0) {
              delete ev.sourceEventSeqs;
              report.conflicts.push({ kind: "replace-carrier-needs-sources-but-none-addable", seq: oldSeq, newSeq: ev.seq, missing });
            } else {
              ev.sourceEventSeqs = encodeSeqRanges(merged);
              bump("sourceEventSeqs.patched");
            }
          }
        }
      }
    }
    // 兜底：定点迭代/7c 里被判定剔除的载体一律不得进入产物
    if (droppedCarriers.has(oldSeq)) continue;

    // 7d. compaction 的 shadowedSeqs / shadowedRange
    if (ev.data && typeof ev.data === "object") {
      if (Array.isArray(ev.data.shadowedSeqs)) {
        const mapped = ev.data.shadowedSeqs.map(resolve);
        const lost = mapped.filter((x) => x === undefined).length;
        const kept = mapped.filter((x) => x !== undefined);
        if (lost > 0) report.dangling.push({ seq: oldSeq, newSeq: ev.seq, type: ev.type, field: "data.shadowedSeqs", lost, of: mapped.length });
        ev.data.shadowedSeqs = kept;
        if (kept.length !== mapped.length) bump("data.shadowedSeqs");
      }
      if (isObj(ev.data.shadowedRange)) {
        for (const key of ["start", "end"]) {
          if (typeof ev.data.shadowedRange[key] !== "number") continue;
          const n = resolve(ev.data.shadowedRange[key]);
          if (n === undefined) report.dangling.push({ seq: oldSeq, newSeq: ev.seq, type: ev.type, field: `data.shadowedRange.${key}`, old: ev.data.shadowedRange[key] });
          else if (n !== ev.data.shadowedRange[key]) { ev.data.shadowedRange[key] = n; bump("data.shadowedRange"); }
        }
      }
      // headerSeq
      if (typeof ev.data.headerSeq === "number") {
        let n = resolve(ev.data.headerSeq);
        if (n === undefined) {
          const replacementHeader = findEarlierHeader(orig, oldSeq, remove, droppedSet);
          if (replacementHeader !== undefined) {
            n = resolve(replacementHeader);
            report.notes.push(`#${oldSeq} 的 headerSeq 原指向已删的 request/header #${ev.data.headerSeq}，改指 #${replacementHeader}`);
          }
        }
        if (n === undefined || n >= ev.seq) {
          report.conflicts.push({ kind: "headerSeq-unresolvable", seq: oldSeq, newSeq: ev.seq, old: ev.data.headerSeq, hint: "tool-addition 需要更早的 request/header，删掉它就必须同步删掉该 developer/message" });
          delete ev.data.headerSeq;
          bump("data.headerSeq.dropped");
        } else { if (n !== ev.data.headerSeq) bump("data.headerSeq"); ev.data.headerSeq = n; }
      }
      // messageSeqs（session/title）
      if (Array.isArray(ev.data.messageSeqs)) {
        const mapped = ev.data.messageSeqs.map(resolve);
        const lost = mapped.filter((x) => x === undefined).length;
        const kept = mapped.filter((x) => x !== undefined);
        if (lost > 0) report.dangling.push({ seq: oldSeq, newSeq: ev.seq, type: ev.type, field: "data.messageSeqs", lost, of: mapped.length });
        if (kept.length !== mapped.length) bump("data.messageSeqs");
        ev.data.messageSeqs = kept;
        const isUser = ev.data.source?.kind === "user";
        if (isUser && kept.length === 0) {
          report.conflicts.push({ kind: "user-title-lost-all-references", seq: oldSeq, newSeq: ev.seq, hint: "source.kind==='user' 的 session/title 必须至少引用一条 user/message" });
        }
      }
      // delivery 水位线
      if (typeof ev.data.throughSeq === "number" && ev.data.sessionFormatVersion === 4) {
        const oldW = ev.data.throughSeq;
        const count = survivors.filter((s) => s.seq < oldW).length;
        const n = count - 1;
        if (n < 0 || n >= ev.seq) {
          report.conflicts.push({ kind: "throughSeq-unresolvable", seq: oldSeq, newSeq: ev.seq, old: oldW, computed: n, hint: "delivery throughSeq 必须早于自身 seq；删除早期事件后需要人工判断该水位线是否还有意义" });
        } else if (n !== oldW) { ev.data.throughSeq = n; bump("data.throughSeq"); }
      }
      // command/done 的 sourceEventSeq
      if (typeof ev.data.sourceEventSeq === "number") {
        const n = resolve(ev.data.sourceEventSeq);
        if (n === undefined) report.dangling.push({ seq: oldSeq, newSeq: ev.seq, type: ev.type, field: "data.sourceEventSeq", old: ev.data.sourceEventSeq });
        else if (n !== ev.data.sourceEventSeq) { ev.data.sourceEventSeq = n; bump("data.sourceEventSeq"); }
      }
    }

    newEvents.push(ev);
  }


  // ── 8. 体检：未登记但值落在 seq 空间、且位置发生前移的数值字段 ──
  const seenPaths = new Set();
  for (const e of newEvents) {
    const out = [];
    numericRefPaths(e.data, "data", survivors.length, out);
    if (e.surfaceOp && typeof e.surfaceOp === "object") numericRefPaths(e.surfaceOp, "surfaceOp", survivors.length, out);
    for (const { path } of out) {
      const norm = path.replace(/\[\d+\]/g, "[]").replace(/\[\]$/, "");
      if (RULE_BY_PATH.has(norm)) continue;
      if (seenPaths.has(norm)) continue;
      seenPaths.add(norm);
    }
  }
  report.notes.push(`未登记但值落在 seq 空间的数值字段路径 ${seenPaths.size} 个（非引用，已人工核对）：${[...seenPaths].slice(0, 20).join(", ")}`);

  // 归属轮没重编号的事件（按轮聚合）
  for (const agg of badTurnEvents.values()) {
    report.conflicts.push({ kind: "turn-not-renumberable", ...agg, hint: "该事件所属 turn 未完整存活（被删了一部分），它仍然指向已经不存在的轮号" });
  }

  // ── 9. 自校验 ──
  const v = verify(headerOut, newEvents);
  report.verify = { ok: v.ok, problems: v.problems, stats: v.stats };
  if (!v.ok) report.conflicts.push({ kind: "verify-failed", problems: v.problems.slice(0, 20) });

  headerOut.id ??= header?.id;
  return { header: headerOut, events: newEvents, report };
}

function dropField(ev, key) { delete ev[key]; }

function findEarlierHeader(orig, beforeSeq, remove, droppedSet) {
  let best;
  for (const [s, e] of [...orig.entries()].sort((a, b) => a[0] - b[0])) {
    if (s >= beforeSeq) break;
    if (remove.has(s) || droppedSet.has(s)) continue;
    if (e.type === "request/header") best = s;
  }
  return best;
}

/**
 * 按「原事件顺序 + 删除集 + 已剔除载体」重建表层，并给出每个载体的新遮蔽集。
 * 严格忠于官方 foldSurface：走不到 startSeq 的 replace 直接判为其遮蔽节点已消失。
 */
function buildPlan({ src, remove, candidates, droppedCarriers }) {
  const nodes = [];
  const alive = new Set();
  /** seq -> 载体记录。必须是 Map：buildPlan 会被跑多次，用数组 append 会留下陈旧重影 */
  const carriers = new Map();
  const bySeq = new Map(candidates.map((c) => [c.seq, c]));
  const survivors = src.filter((e) => !remove.has(e.seq) && !droppedCarriers.has(e.seq));
  for (const e of survivors) {
    const rec = bySeq.get(e.seq);
    if (!rec) {
      if (SURFACE_TYPES.has(e.type)) { nodes.push(e.seq); alive.add(e.seq); }
      continue;
    }
    if (rec.isReplace) {
      const first = nodes.indexOf(rec.op.startSeq);
      const last = nodes.indexOf(rec.op.endSeq);
      let shadowedOld;
      if (first >= 0 && last >= first) shadowedOld = nodes.slice(first, last + 1);
      else shadowedOld = rec.shadowed.filter((s) => !remove.has(s) && !droppedCarriers.has(s));
      const shadowedNew = shadowedOld.filter((s) => !remove.has(s) && !droppedCarriers.has(s));
      // 过滤掉已不在新表层上的（防御性：理论上不会发生）
      const onSurface = shadowedNew.filter((s) => alive.has(s));
      const finalShadowed = onSurface.length > 0 ? onSurface : shadowedNew;
      // 关键：shadowedOld 是「原始 fold 中该载体遮蔽的全部节点」，必须用真正未被过滤的原集
      // （如果只用当前 fold 里还活着的节点算，就无法区分「区间被削掉一部分」和「区间完整」）
      const trueShadow = rec.shadowed;
      carriers.set(e.seq, {
        seq: e.seq, type: e.type, isReplace: true, op: rec.op,
        shadowedOld: trueShadow,
        shadowedSurviving: shadowedOld.filter((s) => !remove.has(s) && !droppedCarriers.has(s)),
        shadowedNew: finalShadowed,
      });
      if (first >= 0 && last >= first) nodes.splice(first, last - first + 1, e.seq);
      else nodes.push(e.seq);
      alive.add(e.seq);
      continue;
    }
    // compaction 载体：只记录，不改表层
    const shadowedNew = rec.shadowed.filter((s) => !remove.has(s) && !droppedCarriers.has(s));
    carriers.set(e.seq, { seq: e.seq, type: e.type, isReplace: false, op: null, shadowedOld: rec.shadowed, shadowedSurviving: shadowedNew, shadowedNew });
    if (SURFACE_TYPES.has(e.type)) { nodes.push(e.seq); alive.add(e.seq); }
  }
  return { survivors, carriers, nodes };
}

// ───────────────────────────── 校验器 ─────────────────────────────

/**
 * 移植 DSH 读取路径的校验（restoreReleasedV4Artifact + assertReleasedV4Relationships + Relationships 状态机）。
 * @param {object} header
 * @param {object[]} events
 * @param {{id?:string, strictTurnState?:boolean}} [opts]
 * @returns {{ok:boolean, problems:string[], stats:object}}
 */
export function verify(header, events, opts = {}) {
  const problems = [];
  const P = (m) => problems.push(m);
  const stats = { events: events.length, turns: 0, surfaceNodes: 0, replaces: 0, systemHead: null, carriers: 0 };

  // —— 头 ——
  // 物理头（磁盘上的那一行）多一个 type:"session"，官方 decodePhysicalHeader 就是按它认的；
  // 逻辑头（assertReleasedV4Header）的白名单里没有 type。两者都放行。
  if (!isObj(header)) P("header 不是对象");
  else {
    for (const k of HEADER_REQUIRED) if (!Object.hasOwn(header, k)) P(`头缺必需字段 ${k}`);
    for (const k of Object.keys(header)) {
      if (HEADER_ALLOWED.includes(k)) continue;
      if (k === "type" && header.type === "session") continue;
      P(`头出现非白名单字段 ${k}`);
    }
    if (header.version !== 4) P(`头 version≠4（${header.version}）`);
    if (typeof header.id !== "string" || !header.id) P("头 id 必须是非空字符串");
    if (!isSeq(header.createdAt)) P("头 createdAt 必须是安全整数");
    if (!isSeq(header.delegationDepth)) P("头 delegationDepth 必须是安全整数");
    if (typeof header.isSeeded !== "boolean") P("头 isSeeded 必须是 boolean");
    if (header.cwd !== undefined && typeof header.cwd !== "string") P("头 cwd 必须是字符串");
    for (const k of ["parentSession", "agentPreset"]) if (header[k] !== undefined && typeof header[k] !== "string") P(`头 ${k} 必须是字符串`);
    if (header.origin !== undefined && header.origin !== "subagent") P('头 origin 只能是 "subagent"');
    if (opts.id !== undefined && header.id !== opts.id) P(`头 id 与目录名不符：${header.id} ≠ ${opts.id}`);
  }

  // —— 状态机 ——
  let turn = null, step = null, nextTurn = 1, nextStep = 1;
  let protectedHead;
  const surface = [];
  const tools = new Map();
  let provider;
  const retries = [];
  const startedRetries = new Set();
  const commands = new Set();
  let compaction = null;
  const orphanCompactions = new Set();

  // 预热 orphanCompactions（与官方构造函数一致）
  {
    let start;
    for (const event of events) {
      if (!KNOWN_EVENT_TYPES.has(event.type)) continue;
      if (event.type === "compaction/start") start = event.seq;
      if (event.type === "compaction/end") start = undefined;
      if (event.type === "session/end-seed") { if (start !== undefined) orphanCompactions.add(start); start = undefined; }
    }
  }

  const requireTurn = (type, seq) => { if (turn === null) P(`${type}@${seq} 在没有任何开启 turn 的情况下出现`); };
  const requireStep = (type, seq, d) => {
    if (turn === null || step === null || d?.turn !== turn || d?.step !== step) P(`${type}@${seq} 与开启的 turn/step 不匹配（turn=${turn} step=${step} data.turn=${d?.turn} data.step=${d?.step}）`);
  };
  const closeTools = (type, seq) => {
    if (tools.size !== 0) { P(`${type}@${seq} 留下未结算的 tool call ${[...tools.keys()][0]}`); tools.clear(); }
  };

  events.forEach((event, index) => {
    // 信封
    if (!isObj(event)) { P(`事件 ${index} 不是对象`); return; }
    if (event.seq !== index) P(`seq 不 dense：第 ${index} 行 seq=${event.seq}`);
    if (typeof event.type !== "string") P(`事件 ${index} 缺 type`);
    if (!isSeq(event.time)) P(`事件 ${index}（${event.type}）缺合法 time`);
    // throughSeq 通用规则（宿主 gateway：delivery throughSeq must precede its marker）——
    // 对插件事件（session-log-deepseek 等）同样生效，放在类型早退之前。
    if (isObj(event.data)) {
      const chkTs = (node) => {
        if (!isObj(node)) return;
        for (const [k, v] of Object.entries(node)) {
          if (k === "throughSeq" && typeof v === "number" && v >= event.seq) P(`事件 ${index}（${event.type}@${event.seq}）throughSeq ${v} 不早于自身`);
          else if (isObj(v)) chkTs(v);
        }
      };
      chkTs(event.data);
    }
    for (const k of Object.keys(event)) if (!ENVELOPE_KEYS.has(k)) P(`事件 ${index}（${event.type}）信封出现多余键 ${k}`);
    if (event.ignorable !== undefined && event.ignorable !== true) P(`事件 ${index} ignorable 只能是 true`);
    if (!KNOWN_EVENT_TYPES.has(event.type) && event.ignorable !== true) P(`事件 ${index} 类型 ${event.type} 不在词汇表内且未标 ignorable`);
    if (MESSAGE_PROJECTION_EVENT_TYPES.has(event.type)) P(`事件 ${index} 类型 ${event.type} 需要插件消息投影，本校验器无法覆盖`);

    if (!KNOWN_EVENT_TYPES.has(event.type)) return;
    const d = isObj(event.data) ? event.data : undefined;

    // 表层元数据（surface.js surfaceOpOf / validateSurfaceMetadata）
    const eligible = SURFACE_TYPES.has(event.type);
    const op = event.surfaceOp;
    if (!eligible) {
      if (op !== undefined) P(`非表层事件 ${event.type}@${event.seq} 不能带 surfaceOp`);
      if (event.sourceEventSeqs !== undefined) P(`非表层事件 ${event.type}@${event.seq} 不能带 sourceEventSeqs`);
    } else {
      if (op === undefined) P(`表层事件 ${event.type}@${event.seq} 缺 surfaceOp`);
      else if (op !== "append") {
        if (!isObj(op)) P(`${event.type}@${event.seq} surfaceOp 非法`);
        else {
          const keys = Object.keys(op);
          if (keys.length !== 3 || !["op", "startSeq", "endSeq"].every((k) => Object.hasOwn(op, k)) || op.op !== "replace" || !isSeq(op.startSeq) || !isSeq(op.endSeq)) {
            P(`${event.type}@${event.seq} replace surfaceOp 形状非法：${JSON.stringify(op)}`);
          } else if (op.startSeq >= event.seq || op.endSeq >= event.seq) {
            P(`${event.type}@${event.seq} replace 锚点必须早于自身：${op.startSeq}/${op.endSeq}`);
          }
        }
      }
    }
    // sourceEventSeqs 本地规则（surface.js assertSourceEventReferences）
    const raw = event.sourceEventSeqs;
    if (raw !== undefined) {
      if (event.type === "assistant/message") P(`assistant/message@${event.seq} 禁止携带 sourceEventSeqs`);
      if (!Array.isArray(raw)) P(`${event.type}@${event.seq} sourceEventSeqs 必须是数组`);
      else if (raw.length === 0) P(`${event.type}@${event.seq} sourceEventSeqs 不能为空数组`);
      else {
        let flat;
        try {
          flat = decodeSeqRanges(raw);
          if (new Set(flat).size !== flat.length) P(`${event.type}@${event.seq} sourceEventSeqs 有重复`);
          for (const m of raw) {
            if (typeof m === "number" && m >= event.seq) P(`${event.type}@${event.seq} sourceEventSeqs 裸元素 ${m} 不早于自身`);
            if (Array.isArray(m) && m[1] >= event.seq) P(`${event.type}@${event.seq} sourceEventSeqs 范围末端 ${m[1]} 不早于自身（官方严格要求）`);
          }
          if (flat.some((s) => s >= event.seq)) P(`${event.type}@${event.seq} sourceEventSeqs 含不早于自身的引用`);
        } catch (e) { P(`${event.type}@${event.seq} sourceEventSeqs 解码失败：${e.message}`); }
      }
    }

    // developer 数据
    if (event.type === "developer/message") {
      if (!isObj(d)) P(`developer/message@${event.seq} data 必须是对象`);
      else {
        const m = d.message;
        if (!isObj(m) || m.role !== "developer") P(`developer/message@${event.seq} 需要 developer 消息`);
        for (const f of ["turn", "step"]) if (!isSeq(d[f]) || d[f] === 0) P(`developer/message@${event.seq} ${f} 必须是正数`);
        if (isObj(m)) {
          if (typeof m.id !== "string" || !m.id || !Array.isArray(m.content) || !isObj(m.source) || typeof m.source.kind !== "string" || !m.source.kind || m.source.kind === "plugin") {
            P(`developer/message@${event.seq} 消息缺 id/content/生产者 source`);
          }
          const hasAdd = Array.isArray(m.content) && m.content.some((b) => isObj(b) && b.type === "tool-addition");
          if (hasAdd && !isSeq(d.headerSeq)) P(`developer/message@${event.seq} 有 tool-addition 就必须有 headerSeq`);
          if (!hasAdd && Object.hasOwn(d, "headerSeq")) P(`developer/message@${event.seq} 没有 tool-addition 就不能有 headerSeq`);
          if (isSeq(d.headerSeq)) {
            if (d.headerSeq >= event.seq) P(`developer/message@${event.seq} headerSeq 必须更早`);
            else if (events[d.headerSeq]?.type !== "request/header") P(`developer/message@${event.seq} headerSeq 未指向 request/header`);
          }
        }
      }
    }

    // system 消息字段
    if (event.type === "system/message") {
      if (!isObj(d)) P(`system/message@${event.seq} data 必须是对象`);
      else {
        if (!isSeq(d.turn) || d.turn === 0) P(`system/message@${event.seq} turn 必须为正`);
        if (!isSeq(d.step) || d.step === 0) P(`system/message@${event.seq} step 必须为正`);
        const m = d.message;
        if (!isObj(m)) P(`system/message@${event.seq} 缺 message`);
        else {
          if (typeof m.id !== "string" || !m.id) P(`system/message@${event.seq} message.id 必须非空`);
          if (m.role !== "system") P(`system/message@${event.seq} role 必须是 system`);
          if (!Array.isArray(m.content)) P(`system/message@${event.seq} content 必须是数组`);
          else for (const b of m.content) {
            if (!isObj(b) || typeof b.type !== "string" || !b.type) { P(`system/message@${event.seq} content 块非法`); continue; }
            if ((b.type === "text" || b.type === "reasoning") && typeof b.text !== "string") P(`system/message@${event.seq} ${b.type} 块缺 text`);
            if (b.type === "tool-result") P(`system/message@${event.seq} content 不能有 tool-result 包装`);
          }
        }
      }
    }

    // tool/result 字段
    if (event.type === "tool/result") {
      const m = d?.message;
      if (!isObj(d)) P(`tool/result@${event.seq} data 必须是对象`);
      else if (!isObj(m)) P(`tool/result@${event.seq} 缺 message`);
      else {
        if (typeof m.id !== "string" || !m.id) P(`tool/result@${event.seq} message.id 必须非空`);
        if (m.role !== "tool") P(`tool/result@${event.seq} role 必须是 tool`);
        if (typeof m.toolCallId !== "string" || !m.toolCallId) P(`tool/result@${event.seq} 缺 toolCallId`);
        if (!isObj(m.source) || m.source.kind !== "tool") P(`tool/result@${event.seq} source.kind 必须是 tool`);
        else if (m.source.callId !== m.toolCallId) P(`tool/result@${event.seq} source.callId 与 toolCallId 不一致`);
        if (!Array.isArray(m.content)) P(`tool/result@${event.seq} content 必须是数组`);
        if (d.error !== undefined && m.isError !== true) P(`tool/result@${event.seq} 有 error 但 isError≠true`);
        // fork 结果身份
        if (isObj(d.error) && d.error.code === "TOOL_NOT_STARTED" && typeof m.id === "string" && m.id.startsWith("forked-tool-result-")) {
          const callId = isObj(m.source) ? m.source.callId : undefined;
          const prefix = `forked-tool-result-${String(callId)}-`;
          const suffix = m.id.slice(prefix.length);
          const sequence = Number(suffix);
          const replacement = isObj(event.surfaceOp) && event.surfaceOp.op === "replace";
          if (!m.id.startsWith(prefix) || !/^(0|[1-9]\d*)$/.test(suffix) || !Number.isSafeInteger(sequence)) P(`tool/result@${event.seq} fork 结果 id 不合法`);
          else if (replacement && !(sequence < event.seq)) P(`tool/result@${event.seq} replace 型 fork 结果的 id 序号必须早于自身`);
          else if (!replacement && sequence !== event.seq) P(`tool/result@${event.seq} append 型 fork 结果的 id 序号必须等于自身 seq`);
          if (replacement && !(Array.isArray(raw) && raw.length === 1 && raw[0] === sequence)) P(`tool/result@${event.seq} replace 型 fork 结果的 sourceEventSeqs 必须恰好是 [${sequence}]`);
        }
      }
    }

    // —— foldSurface（strict）——
    if (SURFACE_TYPES.has(event.type)) {
      if (event.type === "system/message" && surface.length > 0 && protectedHead === undefined) P(`system/message@${event.seq} 之前没有受保护系统头`);
      if (event.surfaceOp === "append") {
        if (event.type === "system/message" && surface.length === 0) protectedHead = event.seq;
        surface.push(event.seq);
      } else if (isObj(event.surfaceOp) && event.surfaceOp.op === "replace") {
        const first = surface.indexOf(event.surfaceOp.startSeq);
        const last = surface.indexOf(event.surfaceOp.endSeq);
        if (first < 0) P(`replace@${event.seq} startSeq ${event.surfaceOp.startSeq} 不在当前表层上`);
        else if (last < 0) P(`replace@${event.seq} endSeq ${event.surfaceOp.endSeq} 不在当前表层上`);
        else if (last < first) P(`replace@${event.seq} startSeq 在 endSeq 之后`);
        else {
          const removed = surface.slice(first, last + 1);
          let src = new Set();
          if (Array.isArray(raw)) { try { src = new Set(decodeSeqRanges(raw)); } catch { /* 上面已报 */ } }
          const missing = removed.filter((s) => !src.has(s));
          if (missing.length > 0) P(`replace@${event.seq} 的 sourceEventSeqs 漏掉被遮蔽节点 [${missing.join(",")}]`);
          if (protectedHead !== undefined && removed.includes(protectedHead)) {
            if (event.type !== "system/message" || removed.length !== 1) P(`replace@${event.seq} 非法遮蔽受保护系统头`);
            else protectedHead = event.seq;
          }
          surface.splice(first, removed.length, event.seq);
        }
        stats.replaces += 1;
      }
    }

    // —— Relationships 状态机 ——
    if (event.type.startsWith("turn/") && compaction !== null && !orphanCompactions.has(compaction.seq)) {
      P(`${event.type}@${event.seq} 跨过了未闭合的 compaction`);
    }
    if (STEP_EVENT_TYPES.has(event.type)) requireStep(event.type, event.seq, d);
    switch (event.type) {
      case "turn/start":
        if (turn !== null || d?.turn !== nextTurn) P(`turn/start@${event.seq} 没有开启期望的轮（期望 ${nextTurn}，data.turn=${d?.turn}，当前 ${turn}）`);
        turn = nextTurn; nextStep = 1; tools.clear(); break;
      case "turn/end":
        if (turn === null || d?.turn !== turn || step !== null) P(`turn/end@${event.seq} 与开启的轮/步不匹配（turn=${turn} step=${step} data.turn=${d?.turn}）`);
        else { closeTools("turn/end", event.seq); turn = null; nextTurn += 1; stats.turns += 1; }
        break;
      case "step/start":
        if (turn === null || d?.turn !== turn || step !== null || d?.step !== nextStep) P(`step/start@${event.seq} 与开启的轮/下一步不匹配`);
        else step = nextStep;
        break;
      case "step/end":
        if (turn === null || step === null || d?.turn !== turn || d?.step !== step) P(`step/end@${event.seq} 与开启的轮/步不匹配`);
        else { closeTools("step/end", event.seq); step = null; nextStep += 1; }
        break;
      case "assistant/message": {
        if (turn === null || step === null || d?.turn !== turn || d?.step !== step) P(`assistant/message@${event.seq} 与开启的轮/步不匹配`);
        const m = d?.message;
        if (isObj(m) && Array.isArray(m.content)) for (const b of m.content) {
          if (isObj(b) && b.type === "tool-call") {
            if (typeof b.id !== "string" || !b.id) P(`assistant/message@${event.seq} tool-call 缺 id`);
            else if (tools.has(b.id)) P(`assistant/message@${event.seq} 重复宣告 tool call ${b.id}`);
            else tools.set(b.id, { name: b.name, arguments: b.arguments, started: false });
          }
        }
        break;
      }
      case "tool/call": {
        requireStep(event.type, event.seq, d);
        const id = d?.callId;
        const pending = tools.get(id);
        if (pending === undefined) P(`tool/call@${event.seq} ${id} 没有对应的 tool 生命周期`);
        else if (pending.started || pending.name !== d?.name || pending.arguments !== d?.arguments) P(`tool/call@${event.seq} ${id} 与宣告的 tool call 不符`);
        else pending.started = true;
        break;
      }
      case "tool/result": {
        if (event.surfaceOp !== "append") { requireTurn(event.type, event.seq); break; }
        requireStep(event.type, event.seq, d);
        const id = d?.message?.toolCallId;
        const pending = tools.get(id);
        if (pending === undefined) P(`tool/result@${event.seq} ${id} 没有对应的 tool 生命周期`);
        else tools.delete(id);
        break;
      }
      case "request/header":
        requireTurn(event.type, event.seq);
        provider = d?.header?.config?.provider;
        break;
      case "request/context":
        requireTurn(event.type, event.seq);
        break;
      case "session/title":
      case "session/title-llm-request": {
        const refs = d?.messageSeqs;
        if (!Array.isArray(refs)) { P(`${event.type}@${event.seq} messageSeqs 必须是数组`); break; }
        if ((refs.length === 0) !== (d?.source?.kind === "user")) P(`${event.type}@${event.seq} messageSeqs 必须恰好对 user 标题非空`);
        const seen = new Set();
        for (const r of refs) {
          if (!isSeq(r)) { P(`${event.type}@${event.seq} messageSeqs 成员非法`); continue; }
          const srcEv = events[r];
          if (r >= event.seq || seen.has(r) || srcEv?.type !== "user/message" || srcEv?.data?.source?.kind !== "user") {
            P(`${event.type}@${event.seq} messageSeqs 引用了非更早的人类 user/message：#${r}`);
          }
          seen.add(r);
        }
        break;
      }
      case "command/run":
        if (commands.has(d?.commandId)) P(`command/run@${event.seq} 重复 commandId`);
        commands.add(d?.commandId);
        break;
      case "command/done": {
        if (!commands.has(d?.commandId)) P(`command/done@${event.seq} 没有对应的 command/run`);
        if (d?.sourceEventSeq !== undefined) {
          const srcEv = events[d.sourceEventSeq];
          if (!isSeq(d.sourceEventSeq) || d.sourceEventSeq >= event.seq || d.kind !== "success" || srcEv?.type === "command/run" || srcEv?.type === "command/done") {
            P(`command/done@${event.seq} 的 sourceEventSeq 非法`);
          }
        }
        break;
      }
      case "llm/retry":
      case "llm/retry-started":
        if (event.type === "llm/retry-started") {
          const scheduled = retries.find((r) => r.retryId === d?.retryId && r.retry === d?.retry);
          if (scheduled === undefined) P(`llm/retry-started@${event.seq} 没有配对的已排程重试`);
          else if (scheduled.turn !== d?.turn || scheduled.step !== d?.step) P(`llm/retry-started@${event.seq} 改动了排程坐标`);
          startedRetries.add(JSON.stringify([d?.retryId, d?.retry]));
        } else {
          if (turn === null || d?.turn !== turn || d?.step !== (step ?? nextStep - 1)) P(`llm/retry@${event.seq} 与当前轮/步不匹配`);
          const prior = [...retries].reverse().find((r) => ["turn", "step", "provider", "policyKey"].every((k) => r[k] === d?.[k]));
          if (d?.retry !== (prior === undefined ? 1 : prior.retry + 1)) P(`llm/retry@${event.seq} 跳过了策略重试序号`);
          retries.push(d);
        }
        break;
      case "compaction/start": {
        if (compaction !== null) P(`compaction/start@${event.seq} 与未闭合的 compaction 重叠`);
        const owner = d?.turn === null ? null : d?.turn;
        if (owner !== turn) P(`compaction/start@${event.seq} 与开启的轮不匹配`);
        compaction = { id: d?.compactionId, command: d?.sourceCommandId, turn: owner, seq: event.seq, summarized: false };
        break;
      }
      case "compaction/prune":
      case "compaction/summary":
      case "compaction/end": {
        if (event.type === "compaction/prune" || event.type === "compaction/summary") {
          const range = d?.shadowedRange;
          const seqs = d?.shadowedSeqs;
          if (isObj(range) && Array.isArray(seqs)) {
            const start = surface.indexOf(range.start);
            const end = surface.indexOf(range.end);
            if (start < 0 || end < start || JSON.stringify(surface.slice(start, end + 1)) !== JSON.stringify(seqs)) {
              P(`${event.type}@${event.seq} shadowedSeqs 与当前表层区间不一致`);
            }
            if (protectedHead !== undefined && seqs.includes(protectedHead)) P(`${event.type}@${event.seq} 遮蔽了受保护系统头`);
          } else P(`${event.type}@${event.seq} 缺 shadowedRange/shadowedSeqs`);
        }
        if (event.type === "compaction/prune") break;
        if (compaction === null || compaction.id !== d?.compactionId || compaction.command !== d?.sourceCommandId) {
          P(`${event.type}@${event.seq} 没有配对的 compaction/start`);
          break;
        }
        if (event.type === "compaction/summary") {
          if (compaction.summarized) P(`compaction/summary@${event.seq} 重复`);
          compaction.summarized = true;
        } else {
          if (d?.turn !== compaction.turn) P(`compaction/end@${event.seq} 改变了归属轮`);
          if (d?.error === undefined && !compaction.summarized) P(`compaction/end@${event.seq} 成功结束但缺少 summary`);
          compaction = null;
        }
        break;
      }
      case "session/end-seed":
        compaction = null;
        break;
      case "user/message": {
        if (event.surfaceOp !== "append" && d?.source?.kind === "compact-checkpoint") {
          if (compaction === null || compaction.id !== d?.source?.compactionId) P(`user/message@${event.seq} compaction checkpoint 没有配对 owner`);
        }
        break;
      }
      default: break;
    }
    if (SURFACE_TYPES.has(event.type)) stats.carriers += 1;
  });

  if (turn !== null) P(`末尾 turn 未关闭（turn ${turn}）`);
  if (step !== null) P(`末尾 step 未关闭（step ${step}）`);
  if (protectedHead === undefined) P("没有任何受保护系统头（第一条表层事件必须是 system/message）");
  if (stats.replaces === 0) { /* 合法：没有 replace 的会话 */ }
  stats.systemHead = protectedHead ?? null;
  stats.surfaceNodes = surface.length;

  // 消息 source 体检（assertV4MessageSources）
  for (const e of events) {
    const slots = [];
    if (e.type === "user/message") slots.push(e.data);
    else if (["system/message", "assistant/message", "tool/result", "developer/message"].includes(e.type)) slots.push(e.data?.message);
    for (const m of slots) {
      if (!isObj(m) || !isObj(m.source)) continue;
      if (m.source.kind === "plugin") P(`${e.type}@${e.seq} source.kind=plugin 被拒`);
    }
  }

  return { ok: problems.length === 0, problems, stats };
}

// ───────────────────────────── 便利工具 ─────────────────────────────

/** 取某个 turn 号对应的全部事件 seq（含 turn/start..turn/end 之间的所有事件） */
export function seqsOfTurn(events, turn) {
  const out = [];
  let inside = false;
  for (const e of events) {
    if (e.type === "turn/start" && e.data?.turn === turn) { inside = true; out.push(e.seq); continue; }
    if (inside) out.push(e.seq);
    if (e.type === "turn/end" && e.data?.turn === turn) { inside = false; break; }
  }
  return out;
}

/** 找第 n 个「完整 turn」的区间，用于测试挑选素材 */
export function turnRanges(events) {
  const ranges = [];
  let cur = null;
  for (const e of events) {
    if (e.type === "turn/start") cur = { turn: e.data?.turn, start: e.seq, end: undefined };
    if (e.type === "turn/end" && cur) { cur.end = e.seq; ranges.push(cur); cur = null; }
  }
  return ranges;
}

export default { readSession, writeSession, excise, verify, foldSurfaceLoose, seqsOfTurn, turnRanges, encodeSeqRanges, decodeSeqRanges };
