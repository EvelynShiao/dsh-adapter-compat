/**
 * 附件内联单测 v2（2026-10-30，替换语义）。
 *
 * 用户拍板「附件任何模式都应可读」+ 10.A 复验教训：句柄文本里「Read that path
 * with your file tools」会引导无工具模式的模型盲调文件工具 → 被白名单拦截 →
 * 回复只剩拒绝文本（模型没机会用内联内容）。因此内联改为【整段替换】：
 *   - 首个句柄段 → 全文内联块（显式禁止再调文件工具）
 *   - 后续同路径句柄段 → 占位句（防多轮重复注入全文）
 *   - 读失败 → 原段保留（fail-open）
 * 本文件锁死：触发条件、宿主完整段/裸短语两形态、去重占位、截断、冻结安全、
 * needPatch=false 全透传。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { inlineAttachmentsForNoFileTool, inlineAttachmentInMessage, inlineHandlesInText, readAttachmentForInline, patchedStreamFor } from '../index.js'

function makeHome(webin) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-inline-'))
  if (webin !== undefined) {
    mkdirSync(join(home, 'webin'), { recursive: true })
    writeFileSync(join(home, 'webin', 'config.json'), JSON.stringify(webin), 'utf8')
  }
  return home
}

/** 造附件文件 + 宿主完整段形态句柄（[File ... can read it.]，路径字面双反斜杠）。 */
function makeAttachment(home, name, body) {
  const dir = join(home, 'attachments', 'v1', 'files', 'ab', 'abcd1234')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body, 'utf8')
  const segment = `[File "${name}" (${Buffer.byteLength(body)} bytes, sha256:abcd1234ef5678): verbatim read-only copy saved at "${p.replaceAll('\\', '\\\\')}". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
  return { path: p, segment, body }
}

const SENTINEL = '附件哨兵-HEAD-XY7Q\n中间内容行\n附件哨兵-TAIL-END-XY7Q'
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const CATALOG = () => ([
  { name: 'read', description: 'Read a UTF-8 text file.' },
  { name: 'ops_bash', description: 'Run commands.' },
  { name: 'knowledge_search', description: 'KB layer 1.' },
])
async function collect(gen) { const c = []; for await (const x of gen) c.push(x); return c }

/* ==================== 纯函数层 ==================== */

test('readAttachmentForInline：能读、双反斜杠容错、不存在返回 null', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { path, body } = makeAttachment(home, 'a.txt', SENTINEL)
    const ok = readAttachmentForInline(path, 1 << 20)
    assert.ok(ok !== null && ok.includes('附件哨兵-HEAD-XY7Q'))
    const ok2 = readAttachmentForInline(path.replaceAll('\\', '\\\\'), 1 << 20)
    assert.ok(ok2 !== null && ok2.includes('附件哨兵-TAIL-END-XY7Q'), '字面双反斜杠也能读')
    assert.equal(readAttachmentForInline(join(home, 'nope', 'missing.txt'), 1 << 20), null)
    assert.equal(readAttachmentForInline('', 1000), null)
    assert.ok(body.length > 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readAttachmentForInline：超限截断并标注原大小', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const big = 'X'.repeat(5000) + 'TAIL-MARK-9Z'
    const { path } = makeAttachment(home, 'big.txt', big)
    const out = readAttachmentForInline(path, 1000)
    assert.match(out, /已截断/)
    assert.match(out, /5012 字节/)
    assert.doesNotMatch(out, /TAIL-MARK-9Z/, '截断后不含尾部标记')
    assert.match(out, /不要调用文件工具/, '文案显式禁止再调文件工具')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('inlineHandlesInText：宿主完整段被【整段替换】为内联块，无 verbatim 残留', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { segment } = makeAttachment(home, 'a.txt', SENTINEL)
    const out = inlineHandlesInText(`请看附件。${segment}以上就是附件。`, 1 << 20, new Set())
    assert.doesNotMatch(out, /verbatim read-only copy/, '句柄段必须整段消失（防工具引导）')
    assert.doesNotMatch(out, /Read that path/, '引导句不许残留')
    assert.match(out, /请看附件。/, '句柄段之前的正文保留')
    assert.match(out, /以上就是附件。/, '句柄段之后的正文保留')
    assert.match(out, /附件内联/)
    assert.match(out, /附件哨兵-HEAD-XY7Q/)
    assert.match(out, /不要调用文件工具/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('inlineHandlesInText：裸短语形态（无 [File 包裹）兜底，吞掉同行引导句', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { path } = makeAttachment(home, 'a.txt', SENTINEL)
    const fake = `有附件。verbatim read-only copy saved at "${path.replaceAll('\\', '\\\\')}". Read that path with your file tools.`
    const out = inlineHandlesInText(fake, 1 << 20, new Set())
    assert.doesNotMatch(out, /verbatim read-only copy/)
    assert.doesNotMatch(out, /Read that path/)
    assert.match(out, /附件内联/)
    assert.match(out, /附件哨兵-HEAD-XY7Q/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('inlineHandlesInText：路径不存在 → 原段保留（fail-open）', () => {
  const seg = '[File "ghost.txt" (10 bytes, sha256:deadbeef): verbatim read-only copy saved at "C:\\no\\such\\ghost.txt". Read that path with your file tools.]'
  const out = inlineHandlesInText(`前缀${seg}后缀`, 1000, new Set())
  assert.equal(out, `前缀${seg}后缀`, '读不到就一个字不动')
})

test('inlineHandlesInText：无句柄文本原样返回', () => {
  const t = '普通消息，没有任何附件句柄。'
  assert.equal(inlineHandlesInText(t, 1000, new Set()), t)
})

test('inlineAttachmentInMessage：只处理 user 消息；字符串与数组两形态都支持', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { segment } = makeAttachment(home, 'a.txt', SENTINEL)
    const seen = new Set()
    const u1 = inlineAttachmentInMessage(userMsg(segment), 1 << 20, seen)
    assert.match(u1.content[0].text, /附件内联/)
    assert.doesNotMatch(u1.content[0].text, /verbatim read-only copy/)
    const seg2 = makeAttachment(home, 'b.txt', '另一个附件内容-BB').segment
    const u2 = inlineAttachmentInMessage({ role: 'user', content: segment }, 1 << 20, new Set())
    assert.equal(typeof u2.content, 'string')
    assert.match(u2.content, /附件内联/)
    const a1 = inlineAttachmentInMessage({ role: 'assistant', content: [{ type: 'text', text: seg2 }] }, 1 << 20, seen)
    assert.equal(a1.content[0].text, seg2, 'assistant 消息不处理')
    assert.equal(inlineAttachmentInMessage(null, 1000, seen), null)
    assert.equal(inlineAttachmentInMessage({ role: 'user', content: 42 }, 1000, seen).content, 42)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('跨消息去重：首遇全文内联，复现句柄段替换为占位句，且无任何工具引导残留', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { segment } = makeAttachment(home, 'a.txt', SENTINEL)
    /* 现实形态：历史 user 消息的句柄每轮都在 messages 里——模拟三条 user 全带同句柄 */
    const messagesDup = [userMsg(segment), userMsg(segment), userMsg(segment)]
    const { messages: out, inlined } = inlineAttachmentsForNoFileTool(messagesDup, 1 << 20)
    const full = out.filter((m) => Array.isArray(m.content) && m.content[0].text.includes('<<<附件内容开始>>>'))
    assert.equal(full.length, 1, '全文只内联一次')
    const placeholders = out.filter((m) => Array.isArray(m.content) && m.content[0].text.includes('全文已在前文内联提供'))
    assert.equal(placeholders.length, 2, '其余句柄段替换为占位句')
    assert.equal(inlined, 1)
    for (const m of out) assert.doesNotMatch(m.content[0].text, /verbatim read-only copy/, '所有句柄段都不残留（防工具引导）')
    assert.equal(messagesDup[0].content[0].text, segment, '原对象不动')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('原 messages 数组与消息对象一律不动（冻结安全）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { segment } = makeAttachment(home, 'a.txt', SENTINEL)
    const messages = Object.freeze([Object.freeze(userMsg(segment))])
    const { messages: out } = inlineAttachmentsForNoFileTool(messages, 1 << 20)
    assert.notEqual(out, messages)
    assert.equal(messages[0].content[0].text, segment, '原消息文本不动')
    assert.match(out[0].content[0].text, /附件内联/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ==================== patchedStreamFor 集成（spy 捕获 mutable） ==================== */

test('集成·chatOnly（目录无文件工具）：附件句柄整段替换为内联内容', async () => {
  const home = makeHome({ chatOnly: true })
  try {
    const { segment } = makeAttachment(home, 'case.txt', SENTINEL)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: [userMsg(segment)] }
    let mutable = null
    await collect(patchedStreamFor(async function* (o) { mutable = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    assert.equal(mutable.tools.length, 0, 'chatOnly 下游 tools=[]')
    const text = mutable.messages[0].content[0].text
    assert.doesNotMatch(text, /verbatim read-only copy/, '句柄引导整段消失')
    assert.match(text, /附件内联/)
    assert.match(text, /附件哨兵-HEAD-XY7Q/)
    assert.equal(options.messages[0].content[0].text, segment, '原请求消息不动')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('集成·kb 独占（tc=1 无文件工具）：附件内联生效', async () => {
  const home = makeHome({ kbProtocol: true, nlToolProtocol: false })
  try {
    const { segment } = makeAttachment(home, 'case.txt', SENTINEL)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: [userMsg(segment)] }
    let mutable = null
    await collect(patchedStreamFor(async function* (o) { mutable = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    assert.equal(mutable.tools.map((t) => t.name).join(','), 'knowledge_search', 'kb 独占只留知识库工具')
    const text = mutable.messages[0].content[0].text
    assert.doesNotMatch(text, /Read that path/, '无工具引导残留')
    assert.match(text, /附件哨兵-TAIL-END-XY7Q/, '模型可直接看到附件全文')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('集成·全关：needPatch=false 完全透传（原请求引用透传，不内联）', async () => {
  const home = makeHome({ kbProtocol: false, nlToolProtocol: false, chatOnly: false, zhToolNames: false })
  try {
    const { segment } = makeAttachment(home, 'case.txt', SENTINEL)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: Object.freeze([Object.freeze(userMsg(segment))]) }
    let innerOptions = null
    await collect(patchedStreamFor(async function* (o) { innerOptions = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    assert.equal(innerOptions, options, '全关 = 原请求引用透传（目录里有 read，现状已工作）')
    assert.equal(innerOptions.messages[0].content[0].text, segment)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('集成·zh 单开（目录含 read）：不内联', async () => {
  const home = makeHome({ zhToolNames: true })
  try {
    const { segment } = makeAttachment(home, 'case.txt', SENTINEL)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: [userMsg(segment)] }
    let innerOptions = null
    await collect(patchedStreamFor(async function* (o) { innerOptions = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    assert.equal(innerOptions.messages[0].content[0].text, segment, '有文件工具就不内联')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('集成·超限截断：txtChunkBytes=1000 + 1512 字节附件 → 内联块带截断标注', async () => {
  const home = makeHome({ chatOnly: true, txtChunkBytes: 1000 })
  try {
    const big = 'Y'.repeat(1500) + 'END-MARK-QQ9'
    const { segment } = makeAttachment(home, 'big.txt', big)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: [userMsg(segment)] }
    let mutable = null
    await collect(patchedStreamFor(async function* (o) { mutable = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    const text = mutable.messages[0].content[0].text
    assert.match(text, /已截断/)
    assert.doesNotMatch(text, /END-MARK-QQ9/, '截断后不含尾部标记')
    assert.doesNotMatch(text, /verbatim read-only copy/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
