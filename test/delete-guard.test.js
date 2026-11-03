/**
 * 删除守卫单测（2026-10-16 事故后新增）。
 *
 * 事故：一次 /versions/purge 用 API 删掉 11 个会话，而它们在侧栏里是**用户看得见**的，
 * 其中 6 个再也找不回来。守卫要保证「可见会话永不真删」是硬拒绝，而不是提示。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { guardDeletion, BULK_DELETE_LIMIT } from '../index.js'

/** 造一个 workspace.json：workspaces 表 + 归档列表。 */
function seedRegistry(home, { visible = [], archived = [] } = {}) {
  mkdirSync(join(home, 'storages'), { recursive: true })
  const doc = {
    version: 1,
    tables: {
      workspaces: {
        ws1: { id: 'ws1', name: '默认', sessionIds: visible },
        ws2: { id: 'ws2', name: '其他', sessionIds: [] },
      },
    },
    global: { archivedSessionIds: archived, order: [] },
  }
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2), 'utf8')
}

const tmp = () => mkdtempSync(join(tmpdir(), 'cad-guard-'))

test('可见会话硬拒绝（哪怕是单个、哪怕 confirmBulk）', () => {
  const home = tmp()
  seedRegistry(home, { visible: ['keep-me', 'also-keep'] })
  const single = guardDeletion(home, ['keep-me'], { confirmBulk: true })
  assert.equal(single.ok, false)
  assert.match(single.error, /可见/)
  assert.deepEqual(single.details.visible, ['keep-me'])
})

test('归档会话同样保护（收起 ≠ 可删）', () => {
  const home = tmp()
  seedRegistry(home, { archived: ['archived-one'] })
  const r = guardDeletion(home, ['archived-one'], { confirmBulk: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /可见/)
})

test('不可见 + 少量 ⇒ 放行', () => {
  const home = tmp()
  seedRegistry(home, { visible: ['v1'] })
  const r = guardDeletion(home, ['ghost-1', 'ghost-2'], {})
  assert.equal(r.ok, true)
})

test('超过批量上限必须 confirmBulk（防脚本一次删一堆）', () => {
  const home = tmp()
  seedRegistry(home)
  const ids = Array.from({ length: BULK_DELETE_LIMIT + 1 }, (_, i) => `ghost-${i}`)
  const no = guardDeletion(home, ids, {})
  assert.equal(no.ok, false)
  assert.match(no.error, /confirmBulk/)
  assert.equal(guardDeletion(home, ids, { confirmBulk: true }).ok, true)
})

test('登记表不可用（无文件）时不阻断，但批量上限仍然生效', () => {
  const home = tmp() // 没有 workspace.json
  assert.equal(guardDeletion(home, ['a', 'b'], {}).ok, true)
  const many = Array.from({ length: BULK_DELETE_LIMIT + 2 }, (_, i) => `g${i}`)
  assert.equal(guardDeletion(home, many, {}).ok, false)
})

test('登记表形状坏掉（workspaces 是数组）时按不可用处理，不放行成"全删"', () => {
  const home = tmp()
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: [] }, global: {} }), 'utf8')
  /* readRegistryIds 会返回 null ⇒ 守卫不阻断；批量上限兜底。 */
  assert.equal(guardDeletion(home, ['x'], {}).ok, true)
  assert.equal(guardDeletion(home, ['x', 'y', 'z', 'w'], {}).ok, false)
})

test('空列表与非法输入一律拒绝', () => {
  const home = tmp()
  assert.equal(guardDeletion(home, [], {}).ok, false)
  assert.equal(guardDeletion(home, [null, 123], {}).ok, false)
})
