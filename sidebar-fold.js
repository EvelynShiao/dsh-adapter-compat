/**
 * dsh-adapter-compat — 侧边栏四组折叠：存储与路由（9999.9.43）。
 *
 *   GET  /dsh-adapter-compat/sidebar-groups   当前四组折叠状态（四键布尔）
 *   POST /dsh-adapter-compat/sidebar-groups   部分合并写（只认四个布尔键）
 *
 * 存储：~/.dsh/adapter-compat-sidebar.json（与 adapter-compat-exit.json 同模式，
 * readJsonOr 兜默认 + 临时文件原子替换，绝不抛）。
 *
 * 组语义（2026-11-10 Evelyn 定案，「最上层两个三角形 + 最下层两个三角形」）：
 *   foldTop      上方设置 = 新会话大按钮 + 「插件」全局面板 + 上半部外来注入
 *   foldFiles    文件     = 搜索框 + 文件夹/收藏 + 工作区列表（regionArea 全体）
 *   foldCost     费用     = 余额块（cm-footer-stack）
 *   foldSettings 下方设置 = 记忆/任务/归档三入口 + 设置按钮 + 下半部外来注入
 *
 * 折叠 ≠ 彻底隐藏：折叠随时可展开（本模块）；三入口的「彻底隐藏」仍归
 * session-kit 的 sidebar-entries 机制（2026-11-10 守卫已放开，UI 入口在设置卡片）。
 * 状态默认全 false = 全展开；选择器失效的后果只是折不了，不会破坏布局。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const READ_PATH = '/dsh-adapter-compat/sidebar-groups'
const WRITE_PATH = '/dsh-adapter-compat/sidebar-groups'
const MAX_BODY = 4096

/** 四组合法键与默认值（false = 展开）。 */
export const SIDEBAR_GROUP_KEYS = ['foldTop', 'foldFiles', 'foldCost', 'foldSettings']
export const SIDEBAR_GROUPS_DEFAULTS = {
  foldTop: false,
  foldFiles: false,
  foldCost: false,
  foldSettings: false,
}

/** DSH 主目录：与宿主/其他插件同一套推导（DSH_HOME 优先）。 */
function dshHomeDir(env = process.env) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = env?.USERPROFILE ?? env?.HOME
  return home ? `${String(home).replace(/[\\/]+$/u, '')}/.dsh` : '.dsh'
}

/** 落盘日志（永不抛）。前缀 [sidefold] 便于从 adapter-compat 日志里 grep。 */
function foldLog(line, home = dshHomeDir()) {
  try {
    appendFileSync(`${home}/dsh-adapter-compat.log`, `${new Date().toISOString()} [sidefold] ${line}\n`)
  } catch {
    /* 日志失败绝不外抛 */
  }
}

/** 探一个服务：优先 ctx.get，退回属性访问（都不抛）。与 order.js 同款。 */
function serviceOf(ctx, name) {
  try {
    const viaGet = ctx?.get?.(name)
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch {
    /* 未注入时 get 可能抛：退回属性 */
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/** 带 code 的错误（路由按 code 映射 HTTP 状态）。 */
function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

function statusOf(error) {
  if (error?.code === 'BAD_REQUEST') return 400
  return 500
}

/** 读 JSON body（带上限；超限直接抛，别把内存吃爆）。与 order.js 同款。 */
async function readJsonBody(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) throw fail('BAD_REQUEST', 'body too large')
  }
  try {
    return JSON.parse(body || '{}')
  } catch {
    throw fail('BAD_REQUEST', 'bad json')
  }
}

/** 读 JSON 文件，失败/缺失回退默认（绝不抛）。 */
function readJsonOr(file, fallback) {
  try {
    if (!existsSync(file)) return { ...fallback }
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { ...fallback }
    return doc
  } catch {
    return { ...fallback }
  }
}

/** 原子写 JSON（临时文件 + rename；目录自动建）。 */
function writeJsonAtomic(file, doc) {
  const dir = file.replace(/[\\/][^\\/]*$/, '')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
  const tmp = `${file}.tmp-fold-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  try { rmSync(file, { force: true }) } catch { /* 目标不存在 */ }
  renameSync(tmp, file)
}

/** 偏好文件路径：~/.dsh/adapter-compat-sidebar.json。 */
export function sidebarGroupsPath(home = dshHomeDir()) {
  return `${home.replace(/[\\/]+$/u, '')}/adapter-compat-sidebar.json`
}

/** 归一：只认四个布尔键，垃圾值一律当缺省（不透传脏数据）。 */
function normalize(raw) {
  const out = { ...SIDEBAR_GROUPS_DEFAULTS }
  for (const key of SIDEBAR_GROUP_KEYS) {
    if (typeof raw?.[key] === 'boolean') out[key] = raw[key]
  }
  return out
}

/** 读当前四组折叠状态。 */
export function readSidebarGroups(home = dshHomeDir()) {
  return normalize(readJsonOr(sidebarGroupsPath(home), SIDEBAR_GROUPS_DEFAULTS))
}

/**
 * 部分合并写：只改 body 里给出的合法布尔键。
 * @returns {{ok:boolean, value?:object, error?:string}}
 */
export function writeSidebarGroups(patch, home = dshHomeDir()) {
  const errors = []
  const next = readSidebarGroups(home)
  let touched = false
  for (const key of SIDEBAR_GROUP_KEYS) {
    if (patch?.[key] === undefined) continue
    if (typeof patch[key] !== 'boolean') { errors.push(`${key} 应为布尔`); continue }
    if (patch[key] !== next[key]) { next[key] = patch[key]; touched = true }
  }
  if (errors.length > 0) return { ok: false, error: errors.join('; ') }
  if (touched) {
    try { writeJsonAtomic(sidebarGroupsPath(home), next) } catch (error) {
      foldLog(`write FAILED: ${String(error?.message ?? error).slice(0, 160)}`, home)
      return { ok: false, error: 'write-failed' }
    }
  }
  return { ok: true, value: next }
}

/**
 * 装两条路由（GET 读 / POST 写）。webServer 不可用时返回 false，不影响插件其余部分。
 * @param {object} ctx - cordis 上下文。
 * @param {{sidebarGroupsRoute?:boolean}} config - sidebarGroupsRoute:false 可整层关掉。
 * @returns {boolean} 是否装上了。
 */
export function installSidebarFoldRoute(ctx, config = {}) {
  if (config?.sidebarGroupsRoute === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') {
      foldLog(`route: webServer unavailable (web=${typeof web}, register=${typeof web?.register})`)
      return false
    }
    const reply = (res, status, obj) => {
      try {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      } catch {
        /* ignore */
      }
    }
    const route = (method, run) => {
      web.register({
        kind: 'exact',
        path: READ_PATH,
        handler: async (req, res) => {
          if (req.method !== method) return reply(res, 405, { ok: false, error: 'method-not-allowed' })
          try {
            const value = await run(req)
            return reply(res, 200, { ok: true, value })
          } catch (error) {
            const status = statusOf(error)
            const message = String(error?.message ?? error)
            foldLog(`route FAILED(${status}) ${method} ${READ_PATH}: ${message.slice(0, 200)}`)
            return reply(res, status, { ok: false, error: message })
          }
        },
      })
      foldLog(`route registered ${method} ${READ_PATH}`)
    }

    route('GET', async () => readSidebarGroups())
    route('POST', async (req) => {
      const body = await readJsonBody(req)
      const result = writeSidebarGroups(body)
      if (!result.ok) throw fail('BAD_REQUEST', result.error ?? 'invalid')
      return result.value
    })

    return true
  } catch (error) {
    foldLog(`route FAILED: ${String(error?.message ?? error).slice(0, 200)}`)
    return false
  }
}
