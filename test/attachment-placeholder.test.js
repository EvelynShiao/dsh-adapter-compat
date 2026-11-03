import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentAvailability, placeholderForBlock } from '../attachments.js'
import { guardRequestMessages, WIRE_PLACEHOLDER } from '../wire-tap.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-attach-'))
const present = join(dir, 'present.png')
writeFileSync(present, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

const attachments = {
  imageHostPath(ref) { return ref.attachmentId === 'sha256:ok' ? present : join(dir, 'gone-' + String(ref.attachmentId).replace(/[^a-z0-9]/gi, '')) },
  fileHostPath(ref) { return ref.attachmentId === 'sha256:ok' ? present : join(dir, 'gone-file') },
}

const imageBlock = (id) => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', width: 10, height: 10, bytes: 4, name: 'image.png' } })

test('结构残缺：attachment / attachmentId 缺失即不可用', () => {
  assert.equal(attachmentAvailability({ attachments, block: { type: 'image' } }).ok, false)
  assert.equal(attachmentAvailability({ attachments, block: { type: 'image', attachment: {} } }).ok, false)
  assert.equal(attachmentAvailability({ attachments, block: imageBlock('sha256:ok') }).ok, true)
})

test('字节失效：结构完好但对象不在盘上 → 不可用', () => {
  const r = attachmentAvailability({ attachments, block: imageBlock('sha256:0f7034b2bd08') })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'missing')
})

test('不传 attachments 时退回结构校验（安装时机拿不到服务也不误杀）', () => {
  assert.equal(attachmentAvailability({ block: imageBlock('sha256:whatever') }).ok, true)
})

test('guardRequestMessages：失效图片被占位文本替换，可用的原样保留', () => {
  const options = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看这张图' }, imageBlock('sha256:0f7034b2bd08')] },
      { role: 'user', content: [imageBlock('sha256:ok')] },
    ],
  }
  const guarded = guardRequestMessages(options, { attachments })
  assert.ok(guarded, '应当报告修补')
  assert.equal(guarded.placeholderBlobs, 1)
  const first = guarded.request.messages[0].content
  assert.equal(first[0].text, '看这张图')
  assert.equal(first[1].type, 'text')
  assert.ok(first[1].text.includes(WIRE_PLACEHOLDER))
  assert.ok(first[1].text.includes('image unavailable'))
  assert.equal(guarded.request.messages[1].content[0].type, 'image')
})

test('guardRequestMessages：tool 结果里的失效图片同样被替换', () => {
  const options = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: [imageBlock('sha256:deadbeef')] },
    ],
  }
  const guarded = guardRequestMessages(options, { attachments })
  assert.equal(guarded.placeholderBlobs, 1)
  assert.equal(guarded.droppedCalls, 0, '正常 tool-call 不能被当成残缺丢掉')
  assert.equal(guarded.request.messages[0].content[0].type, 'tool-call')
  assert.equal(guarded.request.messages[1].content[0].type, 'text')
})

test('structural:false 时只做失效附件占位，不碰 tool-call / 孤儿', () => {
  const options = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: 'not-json' }] },
      { role: 'tool', toolCallId: 'c9', content: [imageBlock('sha256:deadbeef')] },
    ],
  }
  const guarded = guardRequestMessages(options, { attachments, structural: false })
  assert.equal(guarded.placeholderBlobs, 1)
  assert.equal(guarded.fixedCalls, 0)
  assert.equal(guarded.droppedOrphans, 0)
  assert.equal(guarded.request.messages.length, 2)
})

test('占位符沿用 WIRE_PLACEHOLDER（全插件统一）', () => {
  const block = placeholderForBlock({ type: 'file', attachment: { attachmentId: 'sha256:x', name: 'a.txt' } }, WIRE_PLACEHOLDER)
  assert.equal(block.type, 'text')
  assert.equal(block.text, `[${WIRE_PLACEHOLDER}] [file unavailable]`)
})

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }) })
