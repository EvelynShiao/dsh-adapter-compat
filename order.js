/**
 * dsh-adapter-compat — 第八层：侧栏排序（工作区 / 会话手动顺序，durable）。
 *
 * 为什么需要它：手机端侧边栏收成竖栏，官方那条「工作区 / 会话树」的拖动排序
 * 在手机上够不着；会话与提示词设置页里也没有一份能拖动、能记住折叠顺序的面板。
 *
 * 关键设计（2026-10-11 定案）：
 *   - 顺序的真源是宿主的 workspace.json：
 *       global.workspaceIds                      = 工作区顺序
 *       tables.workspaces[id].sessionIds         = 该工作区内会话顺序（数组序=显示序）
 *   - 一切写入都走**宿主 registry API**：
 *       ctx.workspaceRegistry.insertBefore(id, beforeId)          → 工作区
 *       workspace.insertSessionBefore(sessionId, beforeSessionId) → 会话
 *     宿主自己负责校验、落盘、发 follow 增量（工作区顺序改完侧边栏会活体重排）。
 *     本模块**绝不直接读写 workspace.json 文件**。
 *   - anchor 语义与宿主一致：beforeId 为 null/''/undefined 都表示「移到末尾」。
 *
 * 路由：
 *   GET  /dsh-adapter-compat/order            当前顺序（工作区 + 每个工作区的会话）
 *   POST /dsh-adapter-compat/order/workspace  { workspaceId, beforeWorkspaceId }  → { workspaceIds }
 *   POST /dsh-adapter-compat/order/session    { workspaceId, sessionId, beforeSessionId } → { sessionIds }
 */

import { appendFileSync } from 'node:fs'

const READ_PATH = '/dsh-adapter-compat/order'
const MOVE_WORKSPACE_PATH = '/dsh-adapter-compat/order/workspace'
const MOVE_SESSION_PATH = '/dsh-adapter-compat/order/session'
const MAX_BODY = 65536

/** DSH 主目录：与宿主/其他插件同一套推导（DSH_HOME 优先）。 */
function dshHomeDir(env = process.env) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = env?.USERPROFILE ?? env?.HOME
  return home ? `${String(home).replace(/[\\/]+$/u, '')}/.dsh` : '.dsh'
}

/** 落盘日志（永不抛）。前缀 [order] 便于从 adapter-compat 日志里 grep。 */
function orderLog(line, home = dshHomeDir()) {
  try {
    appendFileSync(`${home}/dsh-adapter-compat.log`, `${new Date().toISOString()} [order] ${line}\n`)
  } catch {
    /* 日志失败绝不外抛 */
  }
}

/** 探一个服务：优先 ctx.get，退回属性访问（都不抛）。 */
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

/** 归一化 anchor：null / '' / undefined 一律表示「移到末尾」。 */
function anchorOf(value) {
  if (value === null || value === undefined) return undefined
  const text = String(value)
  return text === '' ? undefined : text
}

/** 带 code 的错误（路由按 code 映射 HTTP 状态）。 */
function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

/** 确认 registry 可用（拿不到就是宿主没装 workspace 注册表，回 503 而不是瞎猜）。 */
function registryOf(ctx) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') {
    throw fail('REGISTRY_UNAVAILABLE', 'workspace registry is not available in this host')
  }
  return registry
}

/** 会话标题：拿宿主 sessions 投影里的 displayTitle，取不到就留空（前端退化成 id 前缀）。 */
function sessionTitles(ctx) {
  try {
    const byId = serviceOf(ctx, 'sessions')?.list?.getSnapshot?.()?.byId ?? {}
    return byId
  } catch {
    return {}
  }
}

/**
 * 读当前顺序：工作区按 registry 顺序，每个工作区的会话按 record.sessionIds 顺序。
 * 只读，不落盘，不改任何状态。
 * @param {object} ctx - cordis 上下文。
 * @returns {{workspaces: Array<{id:string,title:string,path:string,sessionIds:string[],sessions:Array<{id:string,title:string}>}>}}
 */
export function orderSnapshot(ctx) {
  const registry = registryOf(ctx)
  const byId = sessionTitles(ctx)
  const list = registry.list() ?? []
  return {
    workspaces: list.map((workspace) => {
      const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.map(String) : []
      return {
        id: String(workspace?.id ?? ''),
        title: String(workspace?.title ?? ''),
        path: String(workspace?.path ?? ''),
        sessionIds: ids,
        sessions: ids.map((id) => {
          const title = byId?.[id]?.displayTitle
          return { id, title: typeof title === 'string' && title.trim() !== '' ? title : '' }
        }),
      }
    }),
  }
}

/**
 * 移动一个工作区：落到 beforeWorkspaceId 之前；anchor 为空 = 移到末尾。
 * 走宿主 registry —— 宿主负责写 workspace.json 并广播 follow 增量。
 * @param {object} ctx - cordis 上下文。
 * @param {{workspaceId?:string, beforeWorkspaceId?:string|null}} body - 请求体。
 * @returns {Promise<{workspaceIds:string[]}>} 落定后的完整工作区顺序。
 */
export async function orderMoveWorkspace(ctx, body = {}) {
  const registry = registryOf(ctx)
  if (typeof registry.insertBefore !== 'function') {
    throw fail('REGISTRY_UNAVAILABLE', 'workspace registry does not expose insertBefore')
  }
  const workspaceId = String(body?.workspaceId ?? '')
  if (workspaceId === '') throw fail('BAD_REQUEST', 'workspaceId is required')
  const beforeWorkspaceId = anchorOf(body?.beforeWorkspaceId)
  const workspaceIds = await registry.insertBefore(workspaceId, beforeWorkspaceId)
  return { workspaceIds: [...workspaceIds].map(String) }
}

/**
 * 移动一个会话：所在工作区内，落到 beforeSessionId 之前；anchor 为空 = 移到末尾。
 * 走宿主 workspace 实体 —— 宿主负责写 sessionIds 并裁决「未记账」的非法移动。
 * @param {object} ctx - cordis 上下文。
 * @param {{workspaceId?:string, sessionId?:string, beforeSessionId?:string|null}} body - 请求体。
 * @returns {Promise<{workspaceId:string, sessionIds:string[]}>} 落定后的本工作区会话顺序。
 */
export async function orderMoveSession(ctx, body = {}) {
  const registry = registryOf(ctx)
  const workspaceId = String(body?.workspaceId ?? '')
  const sessionId = String(body?.sessionId ?? '')
  if (workspaceId === '' || sessionId === '') {
    throw fail('BAD_REQUEST', 'workspaceId and sessionId are required')
  }
  const workspace = (registry.list() ?? []).find((candidate) => String(candidate?.id) === workspaceId)
  if (!workspace) throw fail('NOT_FOUND', `workspace '${workspaceId}' not found`)
  if (typeof workspace.insertSessionBefore !== 'function') {
    throw fail('REGISTRY_UNAVAILABLE', 'workspace entity does not expose insertSessionBefore')
  }
  const beforeSessionId = anchorOf(body?.beforeSessionId)
  await workspace.insertSessionBefore(sessionId, beforeSessionId)
  return {
    workspaceId,
    sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
  }
}

/** 错误 → HTTP 状态：注册表不可用 503，参数错 400，找不到锚点/工作区 404，其余 500。 */
function statusOf(error) {
  const code = error?.code
  if (code === 'REGISTRY_UNAVAILABLE') return 503
  if (code === 'BAD_REQUEST') return 400
  if (code === 'NOT_FOUND') return 404
  const name = String(error?.name ?? '')
  if (name === 'WorkspaceOrderInvalidError' || name === 'WorkspaceMoveInvalidError') return 404
  if (name === 'WorkspaceUnknownSessionError') return 404
  return 500
}

/** 读 JSON body（带上限；超限直接抛，别把内存吃爆）。 */
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

/**
 * 注册三条排序路由（读 / 移工作区 / 移会话）。
 * 与 installMoveRoute 同款防御：拿不到 webServer 就安静返回 false，绝不拖垮 apply。
 * @param {object} ctx - cordis 上下文。
 * @param {{orderRoute?:boolean}} config - orderRoute:false 可整层关掉。
 * @returns {boolean} 是否装上了。
 */
export function installOrderRoute(ctx, config = {}) {
  if (config?.orderRoute === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') {
      orderLog(`route: webServer unavailable (web=${typeof web}, register=${typeof web?.register})`)
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
    /** 路由外壳：统一 method 闸 + 错误映射 + 落盘日志。 */
    const route = (path, method, run) => {
      web.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (req.method !== method) return reply(res, 405, { ok: false, error: 'method-not-allowed' })
          try {
            const value = await run(req)
            return reply(res, 200, { ok: true, value })
          } catch (error) {
            const status = statusOf(error)
            const message = String(error?.message ?? error)
            orderLog(`route FAILED(${status}) ${path}: ${message.slice(0, 200)}`)
            return reply(res, status, { ok: false, error: message })
          }
        },
      })
      orderLog(`route registered ${method} ${path}`)
    }

    route(READ_PATH, 'GET', async () => orderSnapshot(ctx))
    route(MOVE_WORKSPACE_PATH, 'POST', async (req) => {
      const body = await readJsonBody(req)
      const result = await orderMoveWorkspace(ctx, body)
      orderLog(`move-workspace ${String(body?.workspaceId).slice(0, 20)} before ${String(body?.beforeWorkspaceId ?? '(end)').slice(0, 20)}`)
      return result
    })
    route(MOVE_SESSION_PATH, 'POST', async (req) => {
      const body = await readJsonBody(req)
      const result = await orderMoveSession(ctx, body)
      orderLog(`move-session ${String(body?.sessionId).slice(0, 20)} before ${String(body?.beforeSessionId ?? '(end)').slice(0, 20)} in ${String(body?.workspaceId).slice(0, 20)}`)
      return result
    })

    return true
  } catch (error) {
    orderLog(`route FAILED: ${String(error?.message ?? error).slice(0, 200)}`)
    return false
  }
}
