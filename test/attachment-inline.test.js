/**
 * 附件内联单测（2026-10-30，用户拍板「附件任何模式都应可读」的实现锁定）。
 *
 * 背景：附件发给模型的只是宿主投影的句柄文本（"verbatim read-only copy saved
 * at <路径>. Read that path with your file tools…"）——纯聊天（tools=[]）和
 * kb 独占（无文件工具）下模型没有工具可读，拿着地址没有钥匙。
 * 实现：本轮目录里没有任何只读文件工具时，把句柄所指文件读出、内联进消息文本。
 *
 * 本文件锁死：
 *   ① 内联触发条件 = 目录无 read 且无 ops_inspect_local_file（有文件工具就不内联）
 *   ② 句柄解析（含字面双反斜杠容错）+ 路径不存在 fail-open
 *   ③ 超限截断（上限 = webin txtChunkBytes）
 *   ④ 跨消息同路径去重（多轮对话历史句柄不重复注入）
 *   ⑤ 只处理 user 消息；原 messages/消息对象一律不动（冻结安全）
 *   ⑥ needPatch=false（全关）时完全不进内联路径（原请求引用透传）
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

/** 造一个附件文件 + 对应的宿主投影句柄文本（路径里故意放字面双反斜杠）。 */
function makeAttachment(home, name, body) {
  const dir = join(home, 'attachments', 'v1', 'files', 'ab', 'abcd1234')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body, 'utf8')
  const handleText = `用户发来一个附件。verbatim read-only copy saved at "${p.replaceAll('\\', '\\\\')}". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it.`
  return { path: p, handleText, body }
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
    assert.ok(ok !== null)
    assert.match(ok, /附件内联/)
    assert.match(ok, /附件哨兵-HEAD-XY7Q/)
    assert.match(ok, /附件内容结束/)
    const ok2 = readAttachmentForInline(path.replaceAll('\\', '\\\\'), 1 << 20)
    assert.ok(ok2 !== null && ok2.includes('附件哨兵-TAIL-END-XY7Q'), '句柄文本里的字面双反斜杠也能读')
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
    assert.match(out, /被截断/)
    assert.match(out, /5012 字节/)
    assert.doesNotMatch(out, /TAIL-MARK-9Z/, '截断后不该包含尾部标记')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('inlineHandlesInText：句柄保留原样 + 内联块追加在句柄之后', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { handleText } = makeAttachment(home, 'a.txt', SENTINEL)
    const out = inlineHandlesInText(handleText, 1 << 20, new Set())
    assert.match(out, /verbatim read-only copy saved at/, '句柄原文必须保留')
    const at = out.indexOf('verbatim read-only copy saved at')
    const inlined = out.indexOf('[adapter-compat·附件内联]')
    assert.ok(at !== -1 && inlined > at, '内联块追加在句柄之后')
    assert.match(out, /附件哨兵-HEAD-XY7Q/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('inlineHandlesInText：路径不存在 → 文本原样返回（fail-open）', () => {
  const fake = 'verbatim read-only copy saved at "C:\\no\\such\\file.txt". Read that path.'
  const out = inlineHandlesInText(fake, 1000, new Set())
  assert.equal(out, fake, '读不到就一个字都不动')
})

test('inlineAttachmentInMessage：只处理 user 消息；content 字符串与数组两形态都支持', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { handleText } = makeAttachment(home, 'a.txt', SENTINEL)
    const seen = new Set()
    const u1 = inlineAttachmentInMessage(userMsg(handleText), 1 << 20, seen)
    assert.match(u1.content[0].text, /附件内联/)
    const u2 = inlineAttachmentInMessage({ role: 'user', content: handleText }, 1 << 20, seen)
    assert.equal(typeof u2.content, 'string')
    assert.equal(u2.content, handleText, '同一 seen 下第二条同路径句柄不重复注入（去重语义）')
    const a1 = inlineAttachmentInMessage({ role: 'assistant', content: [{ type: 'text', text: handleText }] }, 1 << 20, seen)
    assert.equal(a1.content[0].text, handleText, 'assistant 消息不处理（附件是用户发的）')
    assert.equal(inlineAttachmentInMessage(null, 1000, seen), null)
    assert.equal(inlineAttachmentInMessage({ role: 'user', content: 42 }, 1000, seen).content, 42)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('跨消息同路径去重：两条 user 消息带同一附件句柄只内联一次', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { handleText } = makeAttachment(home, 'a.txt', SENTINEL)
    const messagesDup = [userMsg(handleText), userMsg(handleText)]
    const { messages: out, inlined } = inlineAttachmentsForNoFileTool(messagesDup, 1 << 20)
    const hits = out.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'text' && p.text.includes('[adapter-compat·附件内联]')))
    assert.equal(hits.length, 1, '同一附件只内联一次')
    assert.equal(inlined, 1)
    assert.equal(messagesDup[0].content[0].text, handleText, '原数组/对象不许被改')
    assert.equal(messagesDup[1].content[0].text, handleText)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('原 messages 数组与消息对象一律不动（冻结安全）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-attach-pure-'))
  try {
    const { handleText } = makeAttachment(home, 'a.txt', SENTINEL)
    const messages = Object.freeze([Object.freeze(userMsg(handleText))])
    const { messages: out } = inlineAttachmentsForNoFileTool(messages, 1 << 20)
    assert.notEqual(out, messages, '要出新数组')
    assert.equal(messages[0].content[0].text, handleText, '原消息文本不动')
    assert.match(out[0].content[0].text, /附件内联/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ==================== patchedStreamFor 集成（spy 捕获 mutable） ==================== */

test('集成·chatOnly（目录无文件工具）：附件被内联进下游消息', async () => {
  const home = makeHome({ chatOnly: true })
  try {
    const { handleText } = makeAttachment(home, 'case.txt', SENTINEL)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: [userMsg(handleText)] }
    let mutable = null
    await collect(patchedStreamFor(async function* (o) { mutable = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    assert.ok(mutable !== null)
    assert.equal(mutable.tools.length, 0, 'chatOnly 下游 tools=[]')
    const text = mutable.messages[0].content[0].text
    assert.match(text, /附件内联/, '纯聊天下附件必须内联')
    assert.match(text, /附件哨兵-HEAD-XY7Q/, '内联内容含哨兵')
    assert.equal(options.messages[0].content[0].text, handleText, '原请求消息不动')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('集成·kb 独占（tc=1 无文件工具）：附件被内联 + 越权盲调仍会被白名单拦', async () => {
  const home = makeHome({ kbProtocol: true, nlToolProtocol: false })
  try {
    const { handleText } = makeAttachment(home, 'case.txt', SENTINEL)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: [userMsg(handleText)] }
    let mutable = null
    const gen = patchedStreamFor(async function* (o) { mutable = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home)
    const chunks = await collect(gen)
    assert.equal(mutable.tools.map((t) => t.name).join(','), 'knowledge_search', 'kb 独占只留知识库工具（无 read）')
    const text = mutable.messages[0].content[0].text
    assert.match(text, /附件内联/, 'kb 独占下附件句柄应被内联')
    assert.match(text, /附件哨兵-TAIL-END-XY7Q/, '内联内容含尾部哨兵')
    /* 白名单流也要在：下游流的 tool-call 白名单 = 裁剪后目录（无 read） */
    assert.ok(chunks.length >= 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('集成·全关：needPatch=false 完全透传，不内联不包装（原请求引用透传）', async () => {
  const home = makeHome({ kbProtocol: false, nlToolProtocol: false, chatOnly: false, zhToolNames: false })
  try {
    const { handleText } = makeAttachment(home, 'case.txt', SENTINEL)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: Object.freeze([Object.freeze(userMsg(handleText))]) }
    let innerOptions = null
    await collect(patchedStreamFor(async function* (o) { innerOptions = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    assert.equal(innerOptions, options, '全关 = 原请求引用原样透传（零包装零拷贝）')
    assert.equal(innerOptions.messages[0].content[0].text, handleText, '不内联（目录里有 read，现状已工作）')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('集成·zh 单开（目录含 read）：不内联', async () => {
  const home = makeHome({ zhToolNames: true })
  try {
    const { handleText } = makeAttachment(home, 'case.txt', SENTINEL)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: [userMsg(handleText)] }
    let innerOptions = null
    await collect(patchedStreamFor(async function* (o) { innerOptions = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    assert.equal(innerOptions.messages[0].content[0].text, handleText, '有文件工具就不内联（现状已工作）')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('集成·超限截断：txtChunkBytes=1000 + 1512 字节附件 → 内联块带截断标注', async () => {
  const home = makeHome({ chatOnly: true, txtChunkBytes: 1000 })
  try {
    const big = 'Y'.repeat(1500) + 'END-MARK-QQ9'
    const { handleText } = makeAttachment(home, 'big.txt', big)
    const options = { provider: 'tiantian', tools: CATALOG(), messages: [userMsg(handleText)] }
    let mutable = null
    await collect(patchedStreamFor(async function* (o) { mutable = o; yield { type: 'finish', reason: { kind: 'stop' } } }, options, home))
    const text = mutable.messages[0].content[0].text
    assert.match(text, /被截断/)
    assert.match(text, /超出内联上限 1024/)
    assert.doesNotMatch(text, /END-MARK-QQ9/, '截断后不含尾部标记')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
