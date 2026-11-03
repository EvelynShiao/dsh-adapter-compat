import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  dshHomeDir,
  scanSessionFiles,
  sessionsFingerprint,
  warmProjectionTitles,
  installSessionWatch,
  installTitleWarm,
  SESSION_WATCH,
  SESSION_POLL_INTERVAL_MS,
  SESSION_WATCH_DEBOUNCE_MS,
  TITLE_WARM_MAX_PER_PASS,
} from '../index.js'

/** 造一个假 DSH_HOME：sessions/<ws>/<id>/session.v4.jsonl.zstd + projcache。 */
function fakeHome({ sessions = [], cached = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'adapter-compat-'))
  for (const [ws, id] of sessions) {
    mkdirSync(join(home, 'sessions', ws, id), { recursive: true })
    writeFileSync(join(home, 'sessions', ws, id, 'session.v4.jsonl.zstd'), Buffer.from('x'))
  }
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  for (const [id, title] of cached) {
    writeFileSync(
      join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
      JSON.stringify({ version: 1, record: { identity: {}, rows: { title: { ver: 1, seq: 1, val: title } } } }),
    )
  }
  return home
}

/** 假 ctx：sessionProjectionCache + sessionPersistence + sessions.refresh。
 *  coldSnapshot 会真的落一份 projcache 文件，这样幂等性可测。
 *  ids 省略时由 home 目录扫描得出（贴近真实 persistence.list()）。 */
function fakeCtx({ home, ids, events = { type: 'session/title' }, coldCalls = [], refreshCalls = [] } = {}) {
  return {
    get(name) {
      if (name === 'sessionProjectionCache') {
        return {
          coldSnapshot: (header, inherited, evs) => {
            coldCalls.push({ id: header.id, inherited, n: evs.length })
            if (home) {
              mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
              writeFileSync(
                join(home, 'storages', 'session_projcache', 'sessions', `${header.id}.json`),
                JSON.stringify({ version: 1, record: { identity: {}, rows: { title: { ver: 1, seq: 1, val: '冷重建标题' } } } }),
              )
            }
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async list() {
            const resolved = ids ?? (home ? scanSessionFiles(home).ids : [])
            return resolved.map((id) => ({ header: { id } }))
          },
          async open(id) {
            return { read: async () => ({ events: [events] }), close: async () => {} }
          },
        }
      }
      if (name === 'sessions') {
        return { async refresh() { refreshCalls.push(1) } }
      }
      return undefined
    },
  }
}

test('dshHomeDir：DSH_HOME 优先，否则退回 ~/.dsh', () => {
  assert.equal(dshHomeDir({ DSH_HOME: 'C:/x/.dsh' }), 'C:/x/.dsh')
  assert.equal(dshHomeDir({ USERPROFILE: 'C:\\Users\\E' }), 'C:\\Users\\E/.dsh')
  assert.equal(dshHomeDir({ HOME: '/home/e/' }), '/home/e/.dsh')
})

test('scanSessionFiles/sessionsFingerprint：扫到全部会话且指纹随 mtime 变化', () => {
  const home = fakeHome({
    sessions: [
      ['--ws1--', 'session-a'],
      ['--ws1--', 'session-b'],
      ['--ws2--', 'session-c'],
    ],
  })
  try {
    const scan = scanSessionFiles(home)
    assert.equal(scan.ids.length, 3)
    assert.deepEqual([...scan.ids].sort(), ['session-a', 'session-b', 'session-c'])
    assert.ok(scan.newest > 0)
    const fp1 = sessionsFingerprint(home)
    assert.equal(fp1.count, 3)
    // 新增一个会话 → 指纹变化
    mkdirSync(join(home, 'sessions', '--ws2--', 'session-d'), { recursive: true })
    writeFileSync(join(home, 'sessions', '--ws2--', 'session-d', 'session.v4.jsonl.zstd'), Buffer.from('y'))
    const fp2 = sessionsFingerprint(home)
    assert.notEqual(fp1.key, fp2.key)
    assert.equal(fp2.count, 4)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('warmProjectionTitles：只补缺失的，已有记录默认跳过', async () => {
  const home = fakeHome({
    sessions: [
      ['--ws--', 'session-a'],
      ['--ws--', 'session-b'],
      ['--ws--', 'session-c'],
    ],
    cached: [['session-a', '已有标题']],
  })
  const coldCalls = []
  const ctx = fakeCtx({ home, ids: ['session-a', 'session-b', 'session-c'], coldCalls })
  try {
    const stats = await warmProjectionTitles(ctx, { home })
    assert.equal(stats.scanned, 3)
    assert.equal(stats.rebuilt, 2) // b、c 缺记录
    assert.equal(stats.cached, 1)
    assert.deepEqual(coldCalls.map((c) => c.id).sort(), ['session-b', 'session-c'])
    // 幂等：再跑一次已无缺失（三条都有记录）
    const again = await warmProjectionTitles(ctx, { home })
    assert.equal(again.rebuilt, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('warmProjectionTitles：标题为空的已有记录会被修（有标题事件才修）', async () => {
  const home = fakeHome({
    sessions: [
      ['--ws--', 'session-a'],
      ['--ws--', 'session-b'],
    ],
    cached: [
      ['session-a', null],
      ['session-b', '有标题'],
    ],
  })
  const coldCalls = []
  const ctx = fakeCtx({ home, ids: ['session-a', 'session-b'], coldCalls })
  try {
    const stats = await warmProjectionTitles(ctx, { home })
    assert.equal(stats.repaired, 1)
    assert.equal(stats.rebuilt, 0)
    assert.deepEqual(coldCalls.map((c) => c.id), ['session-a'])
    // repairUntitled:false 时不修
    coldCalls.length = 0
    const off = await warmProjectionTitles(ctx, { home, repairUntitled: false })
    assert.equal(off.repaired, 0)
    assert.equal(coldCalls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('warmProjectionTitles：日志里没有 session/title 的空标题记录不重建', async () => {
  const home = fakeHome({ sessions: [['--ws--', 'session-a']], cached: [['session-a', null]] })
  const coldCalls = []
  const ctx = fakeCtx({ home, ids: ['session-a'], events: { type: 'user/message' }, coldCalls })
  try {
    const stats = await warmProjectionTitles(ctx, { home })
    assert.equal(stats.repaired, 0)
    assert.equal(coldCalls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('warmProjectionTitles：配额上限生效，且缺 header / 缺服务时安全退出', async () => {
  const home = fakeHome({
    sessions: [
      ['--ws--', 'session-a'],
      ['--ws--', 'session-b'],
      ['--ws--', 'session-c'],
    ],
  })
  const coldCalls = []
  const ctx = fakeCtx({ home, ids: ['session-a', 'session-b', 'session-c'], coldCalls })
  try {
    const stats = await warmProjectionTitles(ctx, { home, max: 1 })
    assert.equal(stats.rebuilt, 1)
    assert.equal(coldCalls.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  // persistence 只有 a 的 header → b 记 missing
  const home2 = fakeHome({ sessions: [['--ws--', 'session-a'], ['--ws--', 'session-b']] })
  try {
    const stats2 = await warmProjectionTitles(fakeCtx({ home: home2, ids: ['session-a'] }), { home: home2 })
    assert.equal(stats2.rebuilt, 1)
    assert.equal(stats2.missing, 1)
  } finally {
    rmSync(home2, { recursive: true, force: true })
  }
  // 无投影服务 → 直接返回零统计，不抛
  const home3 = fakeHome({})
  try {
    const zero = await warmProjectionTitles({ get: () => undefined }, { home: home3 })
    assert.equal(zero.rebuilt, 0)
  } finally {
    rmSync(home3, { recursive: true, force: true })
  }
})

test('installSessionWatch：指纹变化后触发 refresh + 预热，且幂等挂载', async () => {
  const home = fakeHome({ sessions: [['--ws--', 'session-a']] })
  const coldCalls = []
  const refreshCalls = []
  const ctx = fakeCtx({ home, coldCalls, refreshCalls })
  try {
    const state = installSessionWatch(ctx, { home, intervalMs: 20, debounceMs: 20 })
    assert.ok(state[SESSION_WATCH])
    assert.equal(ctx.__adapterCompatSessionWatch, state)
    // 幂等：二次调用返回同一 state
    assert.equal(installSessionWatch(ctx, { home, intervalMs: 20, debounceMs: 20 }), state)
    // 制造一次"外部落盘"
    mkdirSync(join(home, 'sessions', '--ws--', 'session-b'), { recursive: true })
    writeFileSync(join(home, 'sessions', '--ws--', 'session-b', 'session.v4.jsonl.zstd'), Buffer.from('z'))
    // 变化需连续两轮稳定 → 再等预热跑完（每条约 120ms 节流）
    await new Promise((r) => setTimeout(r, 800))
    assert.equal(refreshCalls.length, 1, '应触发一次 refresh')
    assert.ok(coldCalls.some((c) => c.id === 'session-b'), '新会话应被补投影')
    state.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installTitleWarm：config.titleWarm:false 时完全不装', () => {
  const ctx = fakeCtx()
  assert.equal(installTitleWarm(ctx, { titleWarm: false }), undefined)
  assert.equal(ctx.__adapterCompatSessionWatch, undefined)
  const other = fakeCtx()
  const installed = installTitleWarm(other, {})
  assert.ok(installed?.watch)
  assert.ok(other.__adapterCompatSessionWatch)
  installed.watch.dispose()
  for (const t of installed.timers) clearTimeout(t)
})

test('常量与默认值稳定', () => {
  assert.equal(SESSION_POLL_INTERVAL_MS, 60000) // 主路径是 fs.watch，轮询只兜底
  assert.equal(SESSION_WATCH_DEBOUNCE_MS, 1500)
  assert.equal(TITLE_WARM_MAX_PER_PASS, 200)
})

test('rescanAndWarm：先 warm 再 refresh（顺序不能反，否则列表刷到旧标题）', async () => {
  const home = fakeHome({ sessions: [['--ws--', 'session-a']] })
  const order = []
  const ctx = {
    get(name) {
      if (name === 'sessionProjectionCache') {
        return {
          coldSnapshot: () => {
            order.push('warm')
            mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
            writeFileSync(
              join(home, 'storages', 'session_projcache', 'sessions', 'session-a.json'),
              JSON.stringify({ version: 1, record: { rows: { title: { ver: 1, seq: 1, val: 'T' } } } }),
            )
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          async list() { return [{ header: { id: 'session-a' } }] },
          async open() { return { read: async () => ({ events: [{ type: 'session/title' }] }), close: async () => {} } },
        }
      }
      if (name === 'sessions') {
        return {
          async refresh() {
            order.push('refresh')
            // refresh 时标题必须已经在缓存里
            assert.ok(existsSync(join(home, 'storages', 'session_projcache', 'sessions', 'session-a.json')))
          },
        }
      }
      return undefined
    },
  }
  try {
    const rescanAndWarm = (await import('../index.js')).rescanAndWarm
    const result = await rescanAndWarm(ctx, { home })
    assert.deepEqual(order, ['warm', 'refresh'])
    assert.equal(result.warmed.rebuilt, 1)
    assert.equal(result.refreshed, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
