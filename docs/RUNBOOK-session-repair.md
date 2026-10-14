# 会话文件损坏修复手册（session.v4.jsonl.zstd）

> 给空上下文 AI 看的自包含文档。不依赖任何前置上下文，按此执行即可。

## 0. 症状与真因速查

| gateway 报错 | 真因 | 本手册第几节 |
|---|---|---|
| `corrupt Zstandard session log: complete frame contains a torn JSONL record` | **seq 中间缺行**（不是 zstd 撕裂，文案误导） | §1 |
| `format v4 developer/message must omit headerSeq without tool additions` | 擦除后 content 空但 headerSeq 残留 | §2 |
| `seed assistant/attempt at index N has invalid settlement fields` | attempt/message 缺 `stream` 数组（或 turn/step 非整数） | §3 |
| `replacement sourceEventSeqs omit a shadowed surface node` | 嵌套区间 `[a,b]` 未展开就喂给校验器 | §4 |
| `tool_use ids were found without tool_result blocks` | tool 结果 content 为空数组 | §3 |

**铁律（血泪换来的）**：
1. **校验器必须用宿主的，不许自造门禁。** 自造门禁 = 过了我却打不开。
2. **先 dry-run 后落盘**，写盘前探活（live 就停），写后回读复核。
3. **改动范围收敛**：只修点名的那个会话，别顺手动插件。
4. **每次写盘前备份**，备份放 `backup-*-<日期>/`。

## 1. §1：seq 缺行（torn JSONL record）

### 1.1 确诊：是缺行还是真撕裂

```bash
node -e "
const fs=require('fs'),z=require('zlib');
const buf=fs.readFileSync(process.argv[1]);
let off=0,frames=0,prev=null,bad=[];
while(off<buf.length){
  let r; try{ r=z.zstdDecompressSync(buf.subarray(off),{info:true}) }
  catch(e){ bad.push('帧'+frames+' 解压失败: '+e.message); break }
  const txt=r.buffer.toString('utf8');
  const raw=txt.split('\n').filter(Boolean);
  const last=[...raw].reverse().find(l=>l.trim()!=='')||'';
  let lastSeq=null,ok=true;
  try{ lastSeq=JSON.parse(last).seq }catch(e){ ok=false }
  const first=raw[0]; let firstSeq=null;
  try{ firstSeq=JSON.parse(first).seq }catch(e){}
  if(!ok) bad.push('帧'+frames+' 末行 JSON 不完整: '+last.slice(0,80));
  if(prev!==null&&firstSeq!==null&&firstSeq!==prev+1)
    bad.push('帧'+frames+' seq 跳变: 前帧尾 '+prev+' 本帧首 '+firstSeq+' 缺'+(firstSeq-prev-1)+' 行');
  prev=lastSeq!==null?lastSeq:prev;
  off+=r.engine.bytesWritten; frames++;
}
console.log('帧数='+frames+' 已扫 '+off+'/'+buf.length);
console.log(bad.length?bad.join('\n'):'结构完整');
" <SESSION_FILE>
```

- 报"解压失败/末行不完整" → 真撕裂，见 §1.4
- 报"seq 跳变" → **缺行**，见 §1.2
- 报"结构完整" → 文件没坏，问题在别处（§2-§4）

### 1.2 缺行修复（补行，不重编号）

**不要重编号**——重编号会连锁破坏 surfaceOp/sourceEventSeqs/title 引用。只**补**缺失的行，让 seq 自然连续。

缺行数 = `gap_first_seq - prev_seq - 1`。补什么要从上下文反推：

```
若 seq(N-1) 是 tool/call(callA)，且 seq(N+gap) 是 step/end(同 turn/step)
  → 缺的是 tool/result(callA) [+ step/end]
若 seq(N+gap) 是 tool/result(callB) 且它的 sourceEventSeqs 指向 [N+gap-1]
  → 缺的末尾一行就是 tool/call(callB)，其宣告在更早的 assistant/message
若 seq(N+gap) 是 assistant/message
  → 缺的是它的 assistant/attempt 或前一个 step 边界
```

**合成行模板**（字段必须齐，少一个宿主就拒）：

```js
// tool/result（占位正文）
{ type:'tool/result', seq:N, time: prevTime+1, data:{
    turn:T, step:S,
    message:{ role:'tool', source:{kind:'tool', callId:CALL}, toolCallId:CALL,
              content:[{type:'text',text:'[NaN]'}], isError:false, id:uuid() } },
  sourceEventSeqs:[N-1], surfaceOp:'append' }

// tool/call —— 注意：不能带 surfaceOp / sourceEventSeqs（非表层事件）
{ type:'tool/call', seq:N, time: prevTime+1,
  data:{ turn:T, step:S, callId:CALL, name:'pwsh', arguments:'{"command":"[NaN]"}' } }

// assistant/message —— 必须有 stream（settlement 校验）
{ type:'assistant/message', seq:N, time: prevTime+1,
  data:{ turn:T, step:S, stream:[],
    message:{ role:'assistant', content:[{type:'text',text:'[NaN]'}],
              source:{kind:'model',provider:'our-free-model',model:'longcat-2.5-preview-free'},
              id:uuid() } }, surfaceOp:'append' }

// assistant/attempt —— 必须有 stream
{ type:'assistant/attempt', seq:N, time: prevTime+1, data:{ turn:T, step:S, stream:[] } }

// step/start、step/end
{ type:'step/start', seq:N, time: prevTime+1, data:{ turn:T, step:S } }
{ type:'step/end',   seq:N, time: prevTime+1, data:{ turn:T, step:S } }
```

> `arguments` 用 `'{"command":"[NaN]"}'`（合法 JSON）而不是空串——空串会被判非法。

### 1.3 大缺口（missing ≥ 3）：插件自动重建结构

≥3 行的缺口几乎只有一种成因：**整段 zstd 帧丢了**（实测 session-8420e924 缺 10 行 = 2509-2518，正好跨 3 个 step）。帧边界是物理事实，帧里写了什么已经没了 —— 所以只重建**能确定的结构**，正文一律 `[NaN]`：

- **能确定**：turn/step 坐标链。断口处的 open turn/step 与下一跳的 `data.turn/step` 之间坐标只能前进，只能经 `step/end + step/start`、`turn/end + turn/start` 走过去，每一步是确定的行数。下一跳若在等一个 call（`tool/result` 要它 started、`tool/call` 要它 declared 未 started），callId 已知 → 补 `assistant/message`（声明）+ `tool/call`（发起），声明里的工具名抄断口前最近一次真实 `tool/call`。
- **不能确定**：正文。填充优先 `assistant/attempt`（**非表层事件**，界面上不会多出假消息）；`tool/result` 用 `[NaN]`；未 started 的 call 用宿主自己的 `TOOL_NOT_STARTED` 收尾形态（`dsh-session/lib/index.js openTurnClosers` 原文措辞）。

规划器 `repair.js planGapRows`：0-1 BFS 在「open 状态 × 已用行数」上找**恰好 missing 行**、且落点满足下一跳硬约束的最省结构路径（结构行越少 ⇒ 不可见填充越多）。找不到就报 unsupported，**绝不硬凑**；找到了也要过 `verify` + `assertRowsDense` + 宿主 `Session.fromRestore` 三道门才许落盘。

**明确拒绝的形态**（不是 bug，是不敢猜）：

| 形态 | 为什么拒绝 |
|---|---|
| `missing ≤ 2` 且不是「紧邻 tool/call 的 result（± step/end）」 | 形态学上还有别的可能，宁可报告（§1.2 人工判断） |
| `turn/end → step/start` 这类：结构上只需 1~2 行，但缺的行数更多 | 多出来的多半是**不挂 turn 的真实内容**（user/message、todo/write、插件事件），假造等于伪造用户输入 |
| 缺口需要补 `assistant/message`（下一跳在等一个未声明的 call），但断口前没有真实 `assistant/message` | 合成消息必须带真实 provider/model，宿主 `assertMessageEventShape` 会拒载（只要不需要合成消息，就没有这个限制） |
| `missing > 240` | 太大，交人工按 §1.2 构造 |

被拒时 `repairScanAll` / `repairSessionFile` 会带出 `describeGapReport`：seq 区间、前后行坐标、`autoRepairable`、`hints`（拒绝原因），照着人工构造即可。

> 反例教训（2026-10-14）：物化函数里把动作 `turn-start` 写成了 `turn/start`，结果**所有跨 turn 的缺口**都在物化时静默返回 null，看上去像「规划器无解」。给规划器加 `trace` 参数（`planGapRows(gap, events, { trace: [] })`）能直接看到断在哪一步。

## 2. §2：headerSeq 残留

```js
// 规则：有 tool-addition 块 ⟺ 带 headerSeq。content 空 = 没有 tool-addition → 必须删键
for (const e of events) {
  if (e.type !== 'developer/message') continue
  const c = e.data?.message?.content
  const hasAdd = Array.isArray(c) && c.some(b => b && b.type === 'tool-addition')
  if (!hasAdd && e.data && Object.hasOwn(e.data, 'headerSeq')) delete e.data.headerSeq
}
```

## 3. §3：settlement / 空 tool 结果

```js
// attempt & message 必须：turn/step 是非负安全整数 + stream 是数组
const isBad = d => !Number.isSafeInteger(d?.turn) || d.turn < 0
  || !Number.isSafeInteger(d?.step) || d.step < 0 || !Array.isArray(d?.stream)
for (const e of events) {
  if ((e.type==='assistant/attempt'||e.type==='assistant/message') && isBad(e.data)) {
    if (!Array.isArray(e.data.stream)) e.data.stream = []   // 空数组即合法
  }
  // tool 结果空 content → 占位（否则 provider 拒收整轮）
  if (e.type==='tool/result' && Array.isArray(e.data?.message?.content)) {
    const c = e.data.message.content
    const hasText = c.some(b=>b?.type==='text' && typeof b.text==='string' && b.text.length>0)
    if (!hasText) e.data.message.content = [{ type:'text', text:'[NaN]' }]
  }
}
```

## 4. §4：嵌套区间假警报

`sourceEventSeqs` 允许 `[a,b]` 嵌套区间（磁盘合法编码），但**喂给校验器前必须展开**，否则 `includes(seq)` 永远匹配不上 → 误报 `omit a shadowed surface node`。这不是数据问题，是**校验脚本管线错了**：先 `releasedV4SessionFormatCodec.decodeRow()`（内部 `decodeSeqRanges` 展开），再交 `restoreReleasedV4Artifact`。

## 5. 宿主真校验器（唯一权威判据）

**必须 import 宿主包，路径有两层 `@deepseek-ai`**（外层是 dsh 主包）：

```js
const { Session, SessionId, adoptSessionEvent } = await import(
  pathToFileURL('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js').href)
const { releasedV4SessionFormatCodec } = await import(
  pathToFileURL('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js').href)

const lines = dec(F)                      // 多帧 zstd 逐帧解压后 split
const headerRow = JSON.parse(lines[0])
const raw = lines.slice(1).map(l => JSON.parse(l))
const dec2 = releasedV4SessionFormatCodec.createDecoder({ ...headerRow, type: 'session' },
              { emitRun: () => {}, emitEvent: () => {} })
const decoded = []
for (const row of raw) { let c=null; dec2.decodeRow(row, { emitRun:()=>{}, emitEvent:x=>{c=x} }); decoded.push(c ?? row) }
for (const [i,e] of decoded.entries()) decoded[i] = adoptSessionEvent(e)
const seeds = decoded.filter(e => e.type==='session/end-seed' && e.data?.inherited === true)
const inh = seeds.length ? seeds[seeds.length-1].seq : 0
Session.fromRestore(SessionId(headerRow.id), decoded, headerRow, inh, 'detached',
  [{ type:'image/offload', project(){ return new Map() } }])
```

**注意**：
- `decoded` 必须先过 `adoptSessionEvent`（等价于 `validateStoredEvents`）
- `inheritedEventCount` = 最后一个 `data.inherited===true` 的 `session/end-seed` 的 seq
- Windows 下 import 必须 `pathToFileURL`（裸 `C:\...` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）
- **verify 绿 ≠ 宿主能开**。插件的 `verify()`（true-delete.js）只是子集，必须再过上面这段

## 6. 通用落盘流程

```js
// 1. 探活：409=live 立即停（宿主内存会覆盖你的改动，还会造成 seq 断口）
//    POST /dsh-adapter-compat/move-session  {"sessionId":sid,"target":"__probe__"}
//    返回 "session is live" → 停，让用户关掉该会话或重启 DSH
// 2. 备份: copyFileSync(F, F + '.bak-<desc>-' + Date.now())
// 3. 改 events → 过宿主校验器（§5）
// 4. 写 tmp → 回读 tmp 再过一遍校验器
// 5. renameSync(tmp, F)（原子替换）
// 6. 删 projcache: storages/session_projcache/sessions/<sid>.json
// 7. 终验：再读 F 过一遍校验器
```

多帧 zstd 写法（保持宿主格式：**头一帧、事件一帧**）：

```js
Buffer.concat([
  zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'),
                   { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
  zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8'),
                   { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
])
```

## 7. 占位符统一为 `[NaN]`

`slim.js` / `repair.js` / `purge.js` / `wire-tap.js` 的 WIRE_PLACEHOLDER 全部是 `'[NaN]'`（ASCII，CJK 计费贵；结构合法、正文确实没了、一眼可辨是修复占位而非真实输出）。**别再用中文占位**（历史遗留的 `'[内容已清除]'` 见到就改）。

## 8. 常见误诊

| 症状 | 错误归因 | 正确归因 |
|---|---|---|
| 文件比云端大/小几行 | "本地未入库改动" | **CRLF 行尾差异** → 比对前先 `tr -d '\r'` |
| 加载失败说是插件改坏 | 某次写操作 | 先看 mtime + 日志时间线：该操作发生时那些 seq 存在吗？ |
| 校验报 omit a shadowed node | 数据坏了 | 校验脚本没展开嵌套区间（§4） |
| 修完 verify 绿但宿主打不开 | 没修好 | 只跑了子集校验（§5） |
| 别的插件"造成的" | 顺手改它 | **只报告，不动手**（改动范围收敛红线） |
