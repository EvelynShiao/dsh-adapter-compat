/**
 * 扫描与校准频率选项单测（2026-10-16 用户要求「做成开关」）。
 *
 * 关注点：
 *   1. 默认值 = 长期以来的既有行为（不能因为加开关就悄悄改变默认扫描强度）；
 *   2. 数值越界要**夹到区间**而不是丢掉或炸掉；
 *   3. 非法类型回退默认（布尔字段收到字符串、数值字段收到乱码）；
 *   4. 写入-读回一致（设置页保存后宿主能读到同样的值）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readHealOptions, writeHealOptions } from '../index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'cad-cadence-'))

test('默认值 = 既有行为（变化后三项都做、开机三项都做、校准开、防抖 1.5s、轮询 60s、校准不重试）', () => {
  const home = tmp()
  const o = readHealOptions(home)
  assert.equal(o.changeRescan, true)
  assert.equal(o.changePurge, true)
  assert.equal(o.changeHeadGuard, true)
  assert.equal(o.bootTitleWarm, true)
  assert.equal(o.bootHeadGuard, true)
  assert.equal(o.bootTrueDelete, true)
  assert.equal(o.pressureCalibration, true)
  assert.equal(o.watchDebounceMs, 1500)
  assert.equal(o.watchPollMs, 60000)
  assert.equal(o.pressureCalibrationIntervalMs, 0)
})

test('数值越界夹到区间（不是丢弃、不是报错）', () => {
  const home = tmp()
  const o = writeHealOptions({ watchDebounceMs: 99999999, watchPollMs: 1, pressureCalibrationIntervalMs: -100 }, home)
  assert.equal(o.watchDebounceMs, 600000, '防抖上限 10 分钟')
  assert.equal(o.watchPollMs, 5000, '轮询下限 5 秒')
  assert.equal(o.pressureCalibrationIntervalMs, 0, '校准间隔下限 0')
})

test('非法类型回退默认（布尔收到字符串、数值收到乱码）', () => {
  const home = tmp()
  const o = writeHealOptions({ changePurge: 'yes', watchDebounceMs: 'abc', pressureCalibration: 0 }, home)
  assert.equal(o.changePurge, true, '字符串不是布尔 → 回默认')
  assert.equal(o.watchDebounceMs, 1500, '乱码 → 回默认')
  assert.equal(o.pressureCalibration, true, '0 不是布尔 → 回默认')
})

test('关掉三项变化后动作 + 关掉开机三件事 ⇒ 写入读回一致', () => {
  const home = tmp()
  const saved = writeHealOptions({
    changeRescan: false, changePurge: false, changeHeadGuard: false,
    bootTitleWarm: false, bootHeadGuard: false, bootTrueDelete: false,
    watchDebounceMs: 10000, watchPollMs: 120000, pressureCalibrationIntervalMs: 300000,
  }, home)
  assert.equal(saved.changeRescan, false)
  const again = readHealOptions(home)
  for (const k of ['changeRescan', 'changePurge', 'changeHeadGuard', 'bootTitleWarm', 'bootHeadGuard', 'bootTrueDelete']) {
    assert.equal(again[k], false, `${k} 应保持 false`)
  }
  assert.equal(again.watchDebounceMs, 10000)
  assert.equal(again.watchPollMs, 120000)
  assert.equal(again.pressureCalibrationIntervalMs, 300000)
  /* 落盘文件里也必须是这些值（换进程/重启后仍生效） */
  const onDisk = JSON.parse(readFileSync(join(home, 'adapter-compat-heal.json'), 'utf8'))
  assert.equal(onDisk.watchDebounceMs, 10000)
  assert.equal(onDisk.bootTrueDelete, false)
})

test('部分字段写入不清空其它字段', () => {
  const home = tmp()
  writeHealOptions({ watchDebounceMs: 5000, bootScan: true }, home)
  const o = writeHealOptions({ changePurge: false }, home)
  assert.equal(o.watchDebounceMs, 5000, '上一次设的频率应保留')
  assert.equal(o.bootScan, true, '上一次设的开关应保留')
  assert.equal(o.changePurge, false)
})
