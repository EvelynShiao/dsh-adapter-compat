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

test('2026-11-12 全局真源：UI 五键写顶层，API 车道同步生效，ldw 段不被 UI 碰', () => {
  const home = tempHome()
  seedWebinConfig(home, { kbProtocol: false, nlToolProtocol: false, chatOnly: false, zhToolNames: false, ldw: { replyTimeoutMs: 1800000 } })
  // 预热：把顶层 kb=false 读进模块级 healOptionsCache（2s TTL）
  const before = readHealOptions(home)
  assert.equal(before.kbProtocol, false)
  // 走 exit-prefs 真实写路径改 kb=true
  const r = writeExitPrefs({ kbProtocol: true }, home)
  assert.equal(r.ok, true)
  assert.equal(r.changed.webin, true)
  // UI 读回 = 全局值
  assert.equal(readExitPrefs(home).kbProtocol, true)
  // 落盘位置：顶层键（全局真源）；ldw 段（运行参数地盘）不被 UI 碰
  const doc = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
  assert.equal(doc.kbProtocol, true)
  assert.deepEqual(doc.ldw, { replyTimeoutMs: 1800000 })
  // API 车道（mergeWebinSwitches 只读顶层）同步生效——这就是「全局开关对全局生效」
  const after = readHealOptions(home)
  assert.equal(after.kbProtocol, true)
  assert.equal(after.kbTrim, true)
})

test('2026-11-12 地盘隔离：ldw 段独立值不影响 API 车道（回滚 ec93f9e 实证）', () => {
  const home = tempHome()
  // ldw 段带独立 true，顶层 false —— API 车道必须只认顶层
  seedWebinConfig(home, { chatOnly: false, kbProtocol: false, zhToolNames: false, nlToolProtocol: false, ldw: { followGlobal: false, chatOnly: true, kbProtocol: true } })
  const api = readHealOptions(home)
  assert.equal(api.chatOnly, false)
  assert.equal(api.kbProtocol, false)
  assert.equal(api.kbTrim, false)
  // UI 显示的仍是全局值（独立值只在 ldwCustom 里回显）
  const p = readExitPrefs(home)
  assert.equal(p.chatOnly, false)
  assert.equal(p.ldwFollowGlobal, false)
  assert.equal(p.ldwCustom.chatOnly, true)
  assert.equal(p.ldwCustom.kbProtocol, true)
})

test('LDW 独立模式：ldwCustom 落段+followGlobal=false；切回跟随清段内五键（replyTimeoutMs 保留）', () => {
  const home = tempHome()
  seedWebinConfig(home, { chatOnly: false, txtChunkBytes: 409600, sendDelayMinMs: 2000, ldw: { replyTimeoutMs: 1800000 } })
  // 切独立 + 写独立值（浅合并：未给的键回显全局值落成显式布尔）
  const r = writeExitPrefs({ ldwFollowGlobal: false, ldwCustom: { chatOnly: true, kbProtocol: false, txtChunkBytes: 10000 } }, home)
  assert.equal(r.ok, true)
  let doc = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
  assert.equal(doc.ldw.followGlobal, false)
  assert.equal(doc.ldw.chatOnly, true)
  assert.equal(doc.ldw.kbProtocol, false)
  assert.equal(doc.ldw.txtChunkBytes, 10000)
  assert.equal(doc.ldw.replyTimeoutMs, 1800000)   // 运行参数保留
  assert.equal(doc.chatOnly, false)               // 顶层不被独立值污染
  assert.equal(doc.sendDelayMinMs, 2000)          // 其它键不丢
  const p = readExitPrefs(home)
  assert.equal(p.ldwFollowGlobal, false)
  assert.equal(p.ldwCustom.chatOnly, true)
  assert.equal(p.ldwCustom.zhToolNames, false)    // 段内未设 → 回显全局
  // 非法独立值拒绝且不落盘
  assert.equal(writeExitPrefs({ ldwCustom: { txtChunkBytes: -1 } }, home).ok, false)
  assert.equal(writeExitPrefs({ ldwFollowGlobal: 'yes' }, home).ok, false)
  assert.equal(readExitPrefs(home).ldwFollowGlobal, false)
  // 切回跟随：段内五键+followGlobal 清空，replyTimeoutMs 保留，LDW 回落顶层=全局
  assert.equal(writeExitPrefs({ ldwFollowGlobal: true }, home).ok, true)
  doc = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
  assert.deepEqual(doc.ldw, { replyTimeoutMs: 1800000 })
  assert.equal(readExitPrefs(home).ldwFollowGlobal, true)
})

