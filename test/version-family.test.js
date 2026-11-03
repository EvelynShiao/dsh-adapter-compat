/**
 * 版本家族扫描单测：分叉血缘与体积统计。
 *
 * 覆盖点（都是「写错就静默失效」的）：
 *   1. parentSession 在 header **顶层**（不是 data 里）——第一版读错，扫描全 0；
 *   2. 家族按最顶层祖先聚合（多层分叉都算同一个家族）；
 *   3. 孤儿分叉（父会话已被删）仍要算进家族、仍要被保护、体积不能漏；
 *   4. 单会话且非分叉 → 不算家族（避免把普通会话列出来）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { readSessionHeader, scanVersionFamilies, versionFamilyIds } from '../index.js'

/** 写一个最小会话文件：header 一帧 + 若干事件帧（模拟真实多帧结构）。 */
function writeSession(home, ws, sid, { parent = null, extraEvents = 0 } = {}) {
  const dir = join(home, 'sessions', ws, sid)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session',
    version: 4,
    id: sid,
    createdAt: Date.now(),
    cwd: home,
    ...(parent === null ? {} : { parentSession: parent }),
    isSeeded: parent !== null,
  })
  const frames = [zstdCompressSync(Buffer.from(header + '\n', 'utf8'))]
  for (let i = 0; i < extraEvents; i++) {
    frames.push(zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/start', seq: i + 1 }) + '\n', 'utf8')))
  }
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return dir
}

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'cad-fam-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  return home
}

test('readSessionHeader：parentSession 读顶层字段', () => {
  const home = tempHome()
  const dir = writeSession(home, 'ws', 'child', { parent: 'root' })
  const h = readSessionHeader(join(dir, 'session.v4.jsonl.zstd'))
  assert.equal(h.parent, 'root')
})

test('家族聚合：root + 子 + 孙 = 一个家族', () => {
  const home = tempHome()
  writeSession(home, 'ws', 'root', { extraEvents: 3 })
  writeSession(home, 'ws', 'child', { parent: 'root' })
  writeSession(home, 'ws', 'grand', { parent: 'child' })
  const scan = scanVersionFamilies(home)
  assert.equal(scan.familyCount, 1)
  assert.equal(scan.families[0].root, 'root')
  assert.equal(scan.families[0].members.length, 3)
  assert.equal(scan.forkCount, 2)
})

test('孤儿分叉（父已删）仍算家族、仍受保护、体积不漏', () => {
  const home = tempHome()
  writeSession(home, 'ws', 'orphanChild', { parent: 'gone-parent', extraEvents: 2 })
  const scan = scanVersionFamilies(home)
  assert.equal(scan.familyCount, 1, '孤儿分叉要单独成家族')
  assert.equal(scan.forkCount, 1)
  assert.equal(scan.families[0].members[0].orphanFork, true)
  /* 体积断言用字节原值：MB 字段四舍五入会把小合成会话压成 0。 */
  assert.ok(scan.totalForkBytes > 0, '分叉体积（字节）不能是 0')
})

test('单会话且非分叉 → 不算家族', () => {
  const home = tempHome()
  writeSession(home, 'ws', 'plain')
  const scan = scanVersionFamilies(home)
  assert.equal(scan.familyCount, 0)
  assert.equal(scan.forkCount, 0)
})

test('versionFamilyIds：根与子都在保护集合里', () => {
  const home = tempHome()
  writeSession(home, 'ws', 'r2', {})
  writeSession(home, 'ws', 'c2', { parent: 'r2' })
  const ids = versionFamilyIds(home, { ttlMs: 0 })
  assert.equal(ids.has('r2'), true)
  assert.equal(ids.has('c2'), true)
})
