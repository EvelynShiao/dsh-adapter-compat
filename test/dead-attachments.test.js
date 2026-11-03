import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentAvailability, attachmentObjectName, fallbackHostPath, healDeadAttachments } from '../attachments.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
const sha = 'a'.repeat(64)
const goneSha = 'b'.repeat(64)
mkdirSync(join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2)), { recursive: true })
writeFileSync(join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha), Buffer.from([1, 2, 3]))

const image = (id) => ({ type: 'image', attachment: { attachmentId: `sha256:${id}`, mediaType: 'image/png', width: 4, height: 4, bytes: 3, name: 'image.png' } })
const userEvent = (seq, content) => ({ seq, type: 'user/message', data: { content, message: { role: 'user', id: 'm' + seq, source: { kind: 'user' }, content } } })

test('attachmentObjectName：剥 sha256: 前缀', () => {
  assert.equal(attachmentObjectName({ attachmentId: 'sha256:' + sha }), sha)
  assert.equal(attachmentObjectName({ attachmentId: 'url:https://x/y.png' }), 'url:https://x/y.png')
  assert.equal(attachmentObjectName({}), '')
})

test('fallbackHostPath：按本地附件库布局定位（图 objects / 文件 files）', () => {
  const p = fallbackHostPath({ home, block: image(sha), ref: image(sha).attachment })
  assert.equal(p, join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha))
  const f = fallbackHostPath({ home, block: { type: 'file' }, ref: { attachmentId: 'sha256:' + sha, name: 'a.txt' } })
  assert.equal(f, join(home, 'attachments', 'v1', 'files', sha.slice(0, 2), sha, 'a.txt'))
})

test('attachmentAvailability：无服务时用 home 布局兜底判定', () => {
  assert.equal(attachmentAvailability({ home, block: image(sha) }).ok, true)
  const bad = attachmentAvailability({ home, block: image(goneSha) })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'missing')
})

test('attachmentAvailability：structuralOnly 只查结构（不误杀）', () => {
  assert.equal(attachmentAvailability({ home, block: image(goneSha), structuralOnly: true }).ok, true)
})

test('healDeadAttachments：只替换失效块，正文与好块原样保留', () => {
  const events = [
    userEvent(10, [{ type: 'text', text: '看图' }, image(goneSha), image(sha)]),
    { seq: 11, type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [image(goneSha)] } } },
    { seq: 12, type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
  ]
  const before = structuredClone(events)
  const plan = healDeadAttachments(events, { home })
  assert.deepEqual(events, before, '不改输入')
  assert.equal(plan.healed.length, 2)
  assert.deepEqual(plan.healed.map((h) => [h.seq, h.blockType, h.reason]), [[10, 'image', 'missing'], [11, 'image', 'missing']])
  const first = plan.events[0].data.content
  assert.equal(first[0].text, '看图')
  assert.equal(first[1].type, 'text')
  assert.equal(first[2].type, 'image', '可用的图片不动')
  assert.equal(plan.events[1].data.message.content[0].type, 'text')
  assert.equal(plan.events[2], events[2], '无附件的消息原对象透传')
  assert.equal(healDeadAttachments(plan.events, { home }).alreadyHealthy, true)
})

test('cleanup', () => { rmSync(home, { recursive: true, force: true }) })
