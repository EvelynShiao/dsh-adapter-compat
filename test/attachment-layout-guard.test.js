import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentAvailability, fallbackHostPath } from '../attachments.js'

const sha = 'c'.repeat(64)
const image = { type: 'image', attachment: { attachmentId: `sha256:${sha}`, mediaType: 'image/png', width: 4, height: 4, bytes: 3 } }

test('库根不存在时不做布局推断（防止宿主换后端后把好图误杀）', () => {
  const bare = mkdtempSync(join(tmpdir(), 'dsh-bare-'))
  assert.equal(fallbackHostPath({ home: bare, block: image, ref: image.attachment }), undefined)
  assert.equal(attachmentAvailability({ home: bare, block: image }).ok, true)
  rmSync(bare, { recursive: true, force: true })
})

test('库根存在但对象缺失 → missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lib-'))
  mkdirSync(join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2)), { recursive: true })
  assert.equal(attachmentAvailability({ home, block: image }).reason, 'missing')
  writeFileSync(join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha), Buffer.from([1]))
  assert.equal(attachmentAvailability({ home, block: image }).ok, true)
  rmSync(home, { recursive: true, force: true })
})
