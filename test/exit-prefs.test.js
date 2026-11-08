/**
 * 压缩 .txt 出口 + 版本分页器开关：读写逻辑单测。
 *
 * 覆盖点（都是「写错就静默失效」的地方）：
 *   1. 默认值：webin 配置缺失时给 auto/100000，分页器默认隐藏；
 *   2. 合并写：只改给的键，**webin 配置里的其它键一个都不能丢**
 *      （delay/账号/edgeDriver 丢了 = 用户设置被清空）；
 *   3. 非法输入拒绝：模式不在枚举、阈值非正数、布尔非布尔 ⇒ ok:false 且不落盘；
 *   4. 原子写：不留下 .tmp 残骸。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readExitPrefs,
  writeExitPrefs,
  readHealOptions,
  exitPrefsPath,
  webinConfigPath,
  COMPACT_EXIT_DEFAULTS,
} from '../index.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'cad-exit-'))
}

function seedWebinConfig(home, doc) {
  mkdirSync(join(home, 'webin'), { recursive: true })
  writeFileSync(webinConfigPath(home), JSON.stringify(doc, null, 2), 'utf8')
}

test('默认值：webin 配置缺失 ⇒ auto/100000，分页器默认隐藏', () => {
  const home = tempHome()
  const prefs = readExitPrefs(home)
  assert.equal(prefs.compactionFileMode, COMPACT_EXIT_DEFAULTS.compactionFileMode)
  assert.equal(prefs.compactionFileThresholdChars, COMPACT_EXIT_DEFAULTS.compactionFileThresholdChars)
  assert.equal(prefs.hideVersionPager, true)
})

test('合并写：webin 其它键必须原样保留（账号/间隔/edgeDriver）', () => {
  const home = tempHome()
  const original = {
    sendDelayMinMs: 2000,
    enableTools: true,
    edgeDriver: { enabled: true, port: 9411 },
    accounts: { deepseek: { slots: ['evelyn-deepseek'], active: 'evelyn-deepseek' } },
  }
  seedWebinConfig(home, original)
  const r = writeExitPrefs({ compactionFileMode: 'always', compactionFileThresholdChars: 50000 }, home)
  assert.equal(r.ok, true)
  const after = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
  assert.equal(after.compactionFileMode, 'always')
  assert.equal(after.compactionFileThresholdChars, 50000)
  assert.equal(after.sendDelayMinMs, 2000)
  assert.equal(after.enableTools, true)
  assert.deepEqual(after.edgeDriver, { enabled: true, port: 9411 })
  assert.deepEqual(after.accounts.deepseek.slots, ['evelyn-deepseek'])
})

test('分页器开关独立存储，且只改它时不碰 webin 配置', () => {
  const home = tempHome()
  seedWebinConfig(home, { compactionFileMode: 'auto', sendDelayMaxMs: 4000 })
  const before = readFileSync(webinConfigPath(home), 'utf8')
  const r = writeExitPrefs({ hideVersionPager: false }, home)
  assert.equal(r.ok, true)
  assert.equal(readExitPrefs(home).hideVersionPager, false)
  assert.equal(readFileSync(webinConfigPath(home), 'utf8'), before)
  assert.equal(existsSync(exitPrefsPath(home)), true)
})

test('非法输入一律拒绝且不落盘', () => {
  const home = tempHome()
  seedWebinConfig(home, { compactionFileMode: 'never' })
  const r1 = writeExitPrefs({ compactionFileMode: 'sometimes' }, home)
  assert.equal(r1.ok, false)
  assert.match(String(r1.error), /compactionFileMode/)
  const r2 = writeExitPrefs({ compactionFileThresholdChars: -5 }, home)
  assert.equal(r2.ok, false)
  const r3 = writeExitPrefs({ hideVersionPager: 'yes' }, home)
  assert.equal(r3.ok, false)
  // 原值必须保持（拒绝 = 不改）
  assert.equal(readExitPrefs(home).compactionFileMode, 'never')
})

test('原子写：不残留 .tmp 文件', () => {
  const home = tempHome()
  seedWebinConfig(home, { compactionFileMode: 'auto' })
  assert.equal(writeExitPrefs({ compactionFileThresholdChars: 123456 }, home).ok, true)
  const leftovers = readdirSync(join(home, 'webin')).filter((f) => f.includes('.tmp-cad-'))
  assert.deepEqual(leftovers, [])
})

test('2026-11-08 LDW 改绑：UI 开关写 ldw 段；API 通道（读顶层）不受影响；写后缓存仍失效', () => {
  const home = tempHome()
  seedWebinConfig(home, { kbProtocol: false, nlToolProtocol: false, chatOnly: false, zhToolNames: false })
  // 预热：把顶层 kb=false 读进模块级 healOptionsCache（2s TTL）
  const before = readHealOptions(home)
  assert.equal(before.kbProtocol, false)
  assert.equal(before.kbTrim, false)
  // 走 exit-prefs 真实写路径改 kb=true
  const r = writeExitPrefs({ kbProtocol: true }, home)
  assert.equal(r.ok, true)
  assert.equal(r.changed.webin, true)
  // UI/LDW 侧（readExitPrefs = ldw 段 ?? 顶层）立即读到新值
  assert.equal(readExitPrefs(home).kbProtocol, true)
  // 落盘位置：ldw 段；顶层键不被 UI 碰（地盘分离）
  const doc = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
  assert.equal(doc.ldw.kbProtocol, true)
  assert.equal(doc.kbProtocol, false)
  // API 通道（mergeWebinSwitches 读顶层）不受 UI 开关影响——LDW 专属段只喂 ldwCfg()
  const after = readHealOptions(home)
  assert.equal(after.kbProtocol, false)
  assert.equal(after.kbTrim, false)
  // 反向：改回 false 也写 ldw 段（显式布尔，不让顶层兜底污染 UI 态）
  assert.equal(writeExitPrefs({ kbProtocol: false }, home).ok, true)
  assert.equal(readExitPrefs(home).kbProtocol, false)
  const doc2 = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
  assert.equal(doc2.ldw.kbProtocol, false)
  assert.equal(doc2.kbProtocol, false)
})

test('LDW 改绑 GET 回落：ldw 段缺键时回落顶层；ldw 段烂数值不透传', () => {
  const home = tempHome()
  // ldw 段只有 chatOnly，其余键缺省 → 回落顶层归一值（顶层显式给值，避开缺省语义）
  seedWebinConfig(home, { chatOnly: false, kbProtocol: false, nlToolProtocol: false, zhToolNames: false, txtChunkBytes: 10000, ldw: { chatOnly: true } })
  const p = readExitPrefs(home)
  assert.equal(p.chatOnly, true)            // ldw 段在场
  assert.equal(p.zhToolNames, false)        // ldw 缺 → 顶层 false
  assert.equal(p.kbProtocol, false)         // ldw 缺 → 顶层显式 false
  assert.equal(p.txtChunkBytes, 10000)      // ldw 缺 → 顶层 10000
  // ldw 段垃圾 txtChunkBytes（字符串/负数）→ 回落顶层
  seedWebinConfig(home, { txtChunkBytes: 10000, ldw: { txtChunkBytes: 'big' } })
  assert.equal(readExitPrefs(home).txtChunkBytes, 10000)
  // ldw 段合法覆盖
  seedWebinConfig(home, { txtChunkBytes: 10000, ldw: { txtChunkBytes: 4096 } })
  assert.equal(readExitPrefs(home).txtChunkBytes, 4096)
})

test('LDW 改绑五键齐写：保存一次五键全部落 ldw 段（显式布尔），顶层原样', () => {
  const home = tempHome()
  seedWebinConfig(home, { sendDelayMinMs: 2000, chatOnly: false, txtChunkBytes: 409600 })
  const r = writeExitPrefs({ chatOnly: true, zhToolNames: true, nlToolProtocol: true, kbProtocol: false, txtChunkBytes: 8192 }, home)
  assert.equal(r.ok, true)
  const doc = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
  assert.deepEqual(doc.ldw, { kbProtocol: false, nlToolProtocol: true, txtChunkBytes: 8192, chatOnly: true, zhToolNames: true })
  assert.equal(doc.chatOnly, false)         // 顶层保持
  assert.equal(doc.txtChunkBytes, 409600)   // 顶层保持
  assert.equal(doc.sendDelayMinMs, 2000)    // 其它键不丢
  const p = readExitPrefs(home)
  assert.equal(p.chatOnly, true)
  assert.equal(p.zhToolNames, true)
  assert.equal(p.nlToolProtocol, true)
  assert.equal(p.kbProtocol, false)
  assert.equal(p.txtChunkBytes, 8192)
})
