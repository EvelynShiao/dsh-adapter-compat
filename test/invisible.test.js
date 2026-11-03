/**
 * 可见性清理单测：不可见会话判定（用户规则：侧栏看不见的不要留）。
 *
 * 覆盖点（写错就是「误删用户可见会话」，必须锁死）：
 *   1. 登记表里的 sessionIds = 可见 → 不删；
 *   2. archivedSessionIds = 归档 → 不删（收起但能展开）；
 *   3. workspace id 本身不是会话 → 不能因为「不在 sessionIds 里」被当残留；
 *   4. 盘上有、登记表没有 = 不可见 → 清理对象；
 *   5. 登记表读不到/结构坏 → **放弃扫描**（ok:false），绝不退化成「全删」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { readRegistryIds, scanInvisibleSessions } from '../index.js'

function writeSession(home, ws, sid) {
  const dir = join(home, 'sessions', ws, sid)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: Date.now(), cwd: home })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(header + '\n', 'utf8')))
}

function writeRegistry(home, doc) {
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify(doc, null, 2), 'utf8')
}

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'cad-inv-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  return home
}

test('可见会话不算残留；不可见才算', () => {
  const home = tempHome()
  const wid = 'ws-uuid-1'
  writeSession(home, 'ws', 's-visible')
  writeSession(home, 'ws', 's-invisible')
  writeRegistry(home, {
    global: { archivedSessionIds: [] },
    tables: { workspaces: { [wid]: { path: home, title: 'w', sessionIds: ['s-visible'] } } },
  })
  const scan = scanInvisibleSessions(home)
  assert.equal(scan.ok, true)
  assert.deepEqual(scan.sessions.map((s) => s.id), ['s-invisible'])
  assert.equal(scan.visibleCount, 1)
})

test('归档会话视为可见（有主，不删）', () => {
  const home = tempHome()
  writeSession(home, 'ws', 's-archived')
  writeRegistry(home, {
    global: { archivedSessionIds: ['s-archived'] },
    tables: { workspaces: { 'ws-uuid-1': { sessionIds: [] } } },
  })
  assert.deepEqual(scanInvisibleSessions(home).sessions, [])
})

test('workspace id 自身不能当会话残留', () => {
  const home = tempHome()
  const wid = '11111111-2222-3333-4444-555555555555'
  writeSession(home, 'ws', wid)   // 同名目录（极端情况）
  writeRegistry(home, {
    global: { archivedSessionIds: [] },
    tables: { workspaces: { [wid]: { sessionIds: [] } } },
  })
  assert.deepEqual(scanInvisibleSessions(home).sessions, [], 'workspace id 命中的目录要跳过')
})

test('登记表缺失或结构坏 → 放弃扫描，绝不退化成全删', () => {
  const home = tempHome()
  writeSession(home, 'ws', 's1')
  // 无 workspace.json
  const r1 = scanInvisibleSessions(home)
  assert.equal(r1.ok, false)
  assert.deepEqual(r1.sessions, [])
  // 结构坏：tables.workspaces 不是对象
  writeRegistry(home, { global: {}, tables: { workspaces: [] } })
  const r2 = scanInvisibleSessions(home)
  assert.equal(r2.ok, false)
  assert.deepEqual(r2.sessions, [])
  assert.equal(readRegistryIds(home), null)
})
