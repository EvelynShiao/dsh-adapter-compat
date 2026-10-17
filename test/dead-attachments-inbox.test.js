import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healDeadAttachments } from '../attachments.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-inbox-'))
const good = 'd'.repeat(64)
const dead = 'e'.repeat(64)
mkdirSync(join(home, 'attachments', 'v1', 'objects', good.slice(0, 2)), { recursive: true })
writeFileSync(join(home, 'attachments', 'v1', 'objects', good.slice(0, 2), good), Buffer.from([1]))

const image = (id) => ({ type: 'image', attachment: { attachmentId: `sha256:${id}`, mediaType: 'image/png', width: 4, height: 4, bytes: 1, name: 'image.png' } })

test('agent/inbox/spliced 的 inserted[].content 里的失效图也被替换（结构不动）', () => {
  const event = {
    seq: 3822, type: 'agent/inbox/spliced',
    data: {
      target: 'next-turn', start: 0,
      inserted: [
        { role: 'user', id: 'u1', source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: '看图' }, image(dead)] },
        { role: 'user', id: 'u2', source: { kind: 'user', rpcId: 'r2' }, content: [image(good)] },
      ],
    },
  }
  const plan = healDeadAttachments([event], { home })
  assert.equal(plan.healed.length, 1)
  assert.equal(plan.healed[0].seq, 3822)
  const inserted = plan.events[0].data.inserted
  assert.equal(inserted.length, 2, '长度不变')
  assert.equal(inserted[0].id, 'u1')
  assert.deepEqual(inserted[0].source, { kind: 'user', rpcId: 'r1' })
  assert.equal(inserted[0].content[0].text, '看图')
  assert.equal(inserted[0].content[1].type, 'text')
  assert.equal(inserted[1].content[0].type, 'image', '好图不动')
  assert.equal(inserted[1], event.data.inserted[1], '未变的条目原对象透传')
})

test('session/title-llm-request 的 messages[].content 同样处理', () => {
  const event = { seq: 14, type: 'session/title-llm-request', data: { titleProvider: 'x', messages: [{ role: 'user', content: [image(dead)] }] } }
  const plan = healDeadAttachments([event], { home })
  assert.equal(plan.healed.length, 1)
  assert.equal(plan.events[0].data.messages[0].content[0].type, 'text')
  assert.equal(plan.events[0].data.titleProvider, 'x')
})

test('没有失效附件时原事件对象透传（不产生写盘 diff）', () => {
  const event = { seq: 1, type: 'agent/inbox/spliced', data: { inserted: [{ role: 'user', id: 'u', content: [image(good)] }] } }
  const plan = healDeadAttachments([event], { home })
  assert.equal(plan.events[0], event)
  assert.equal(plan.alreadyHealthy, true)
})

test('cleanup', () => { rmSync(home, { recursive: true, force: true }) })
