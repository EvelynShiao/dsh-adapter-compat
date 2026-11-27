/**
 * 测试用：把 DSH_HOME 指向一个空临时目录。
 *
 * 为什么需要：apply() 现在要读本插件的偏好文件（adapter-compat-exit.json）来决定
 * 自动压缩放行态。若不隔离，单测会读到真实 home 里的用户设置——用户一旦在设置页
 * 打开「自动压缩」，apply(ctx) 默认开闸的断言就会假失败。
 *
 * 用法：在会调用 apply() 的测试文件里作为**第一条 import** 引入（ESM 按顺序求值）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cad-test-home-'))
