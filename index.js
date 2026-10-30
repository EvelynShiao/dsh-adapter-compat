/**
 * dsh-adapter-compat — LLM adapter 兼容垫片 + 自动压缩硬闸。
 *
 * ============ 第一层：adapter 方法回填 ===========
 * 根因（详见 README）：
 *   @deepseek-ai/dsh-llm 的 LlmRuntime 在计价/压缩路径上无条件调用
 *   `adapter.imageRequestPricing(...)`；`?.` 只保护 adapter 不存在，不保护
 *   方法不存在。官方 adapter 都 `extends LlmAdapter`（基类带默认实现），
 *   而第三方裸类 adapter（如 dsh-our-free-model ≤1.3.1）没继承基类、
 *   漏实现该方法 → 抛 "imageRequestPricing is not a function" →
 *   /compact 与自动压缩静默失败。
 *
 *   修法：运行时垫片，不 import、不修改任何被保护插件的文件。
 *   1. 包装 ctx.llm.registerAdapter：注册前回填缺失的基类默认方法
 *      （只补缺、绝不覆盖）。校验发生在 registerAdapter 内部，
 *      所以必须在调用原始方法之前回填。
 *   2. apply 时扫描 ctx.llm.adapters，补先于本插件加载的注册。
 *   3. 监听 llm/adapters-updated 再扫一遍（覆盖热重载/晚注册）。
 *
 * ============ 第二层：自动压缩硬闸（v1.1.0） ===========
 *   宿主自动压缩的唯一咽喉是 BasicCompactionEngine.compactIfNeeded()：
 *   - agent/pre-step   → compactIfNeeded(agent, "pressure")        （每步压力）
 *   - agent/request-error → compactIfNeeded(agent, "context-overflow")（溢出恢复）
 *   两条都在 `if (this.config.auto)` 的构造期门之后；手动 /compact 走的是
 *   另一条完全独立的 compactNow()，从不经过 compactIfNeeded。
 *
 *   本层把 compactIfNeeded 替换为恒返回 null（宿主语义：无需压缩）：
 *   - 与配置无关——就算 cordis.patch.yml 被 sync 整文件盖掉、auto 回到
 *     默认 true、监听器照常注册，事件触发时调到的也是这道闸；
 *   - 与进程内实例无关——instance + prototype 双层打标，preset 作用域的
 *     引擎在首次 agent/pre-step 时补闸；
 *   - 手动 /compact（compactNow）一概不碰，完全不受影响。
 *
 *   溢出路径的行为变化（这是"不要自动压缩"的必然代价）：窗口真到爆时
 *   不再自动压缩救场，而是原样报 context-overflow 错——手动 /compact 兜底。
 *
 *   恢复官方行为：cordis.patch.yml 本插件行 config 设 autoGate: false 并重启。
 *
 *   需要重启 DSH 才加载本层（插件代码在 composition 构建时读取一次）。
 *
 * ============ 第三层：settings null-Config 防崩守卫（9999.9.9） ===========
 *   根因（2026-10-06/08 两度实锤）：插件加载期竞态（dsh-sync require schemastery
 *   撞 cosmokit 动态 import）会让 module.exports.Config 停在 null，cordis 注册期
 *   把它固化进 runtime.Config；宿主 dsh-settings 的 schema() 只判 `!== undefined`
 *   不防 null → `('toJSON' in null)` 抛 TypeError → describe()/write() 遍历全体
 *   插件条目时一崩全崩。三个症状同源：
 *     ✗ 模型页「加载提供商目录失败」
 *     ✗ 代码工作工具保存失败（write 收尾的 describe 被炸）
 *     ✗ Agent 预设切换器不可用（developerTools 镜像读不出 → 开关视为关）
 *
 *   修法（只补缺不覆盖，任何已有 schema 一律不动）：
 *     1. normalizeRuntimeConfigs：扫 cordis registry，把 Config===null 归一成
 *        undefined —— 宿主对 undefined 的语义就是「无 Config，安全跳过该条目」；
 *     2. guardSettingsSchema：给 settings 服务实例的 schema() 套一层，每次调用
 *        先把该条目 runtime 的 null 归一 —— 兜住晚于本插件注册的条目
 *        （bundles 顺序里 dsh-sync 排在本插件之后，apply 时它还没注册）；
 *     3. 1s/3s/8s 延迟补扫双保险。
 *   与 dsh-sync 版本完全解耦：pnpm install 把 sync-plugin 装回旧版也照样生效。
 *   dsh-sync 自身设置面板走 writeProfileFileSync 直写兜底，不受影响。
 *
 * ============ 第四层：上下文占用中文化校准（9999.9.9） ===========
 *   症状：仪表盘显示「还剩 10%+」，一发消息却报超过 contextWindow（1M）上限。
 *   根因：官方 contextPressure 用启发式增量外推真实占用，而启发式对中文大约
 *   少算一半（实测倍率 2.15），于是显示远低于真实请求规模。
 *   修法：按实测倍率校正 projectedTokens，只改 view 输出值。详见下方
 *   calibratePressureView / calibrateContextPressure 的说明。
 *
 * ============ 第五层：会话盘监视 + 全盘标题投影预热（9999.9.9） ===========
 *   症状：dsh-sync「下载」之后标题集体变成工作区名，要重启才看得到；重启后
 *   也只有手动点开过的会话有标题。
 *   根因：列表标题走 projcache；下载用远端 storages 覆盖本地 → projcache 大批
 *   消失；而预热只在启动后 12 秒跑一次，下载发生在启动之后 → 没人再补。
 *   实测 2026-10-08：磁盘 95 个会话，projcache 只剩 39 条。
 *   修法：轮询 sessions 目录指纹，外部落盘稳定后 → sessions.refresh() 重扫 +
 *   按**磁盘扫描**（不只信注册表）全盘补齐 projcache。详见下方
 *   warmProjectionTitles / installSessionWatch 的说明。
 *
 * ============ 第六层：压缩摘要跟随「当前选中模型」（9999.9.22） ===========
 *   症状：在 UI 里把模型切成一个能用的，再点 /compact，报的还是旧模型的错
 *   （实测 2026-10-14 16:36：切成 dsh/deepseek-v4.1-flash 之后压缩仍打
 *   deepseek-official，拿到 Insufficient Balance 402）。
 *   根因：摘要请求的模型解析链是 `configured ?? latest ?? agentTarget`，其中
 *   latest = session.requestHeader()?.config，而 request/header 事件只在请求
 *   真正被派发时写入 → 「切了模型但没发消息」时 latest 仍是旧模型。
 *   修法：包装 BasicCompactionEngine.summarize()，调用期间把 this.config 的摘要
 *   目标钉到 modelSelection 投影的 pending ?? lastUsed（与 UI 上「下一个请求会用
 *   谁」一致）。不碰核心文件、不改 cordis.patch.yml，DSH 升级后依然生效；
 *   与 autoGate 解耦；finally 无条件还原；拿不到投影就静默回退。
 *   详见下方 selectedRoute / wrapSummarize / armSummarizerSelection 的说明。
 */

export const name = 'adapter-compat'

import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, constants as zstdConstants, zstdDecompressSync } from 'node:zlib'
import { purgeSessionFile, readPendingLedger, writePendingLedger, assertRowsDense } from './purge.js'
import { redactEventPayload, redactSessionFile } from './purge.js'
import { readSession, writeSession, verify as verifySessionEvents } from './true-delete.js'
import { guardSessionFile, probeProtectedHead } from './head-guard.js'
import { installWireTap, recordWireRequest, healBlankToolResults } from './wire-tap.js'
import { healDeadAttachments } from './attachments.js'
import { slimSession } from './slim.js'
import { repairEvents, scanFile, describeGap, healStructure, healToolOrphans, scanToolOrphans } from './repair.js'
import { installOrderRoute } from './order.js'
import {
  installEgressNormalizer as installEgressNormalizerImpl,
  stripLeadingThinking as stripLeadingThinkingPure,
  isWebRoute,
  egressStats,
  EGRESS_NORMALIZER,
  normalizeEgressOptions,
  resolveToolTrimMode,
  filterToolCatalogByMode,
} from './egress.js'
import * as zhNames from './tool-names.js'

/* 出口规范化的纯函数与判定再导出（单测/排查直接 import 本插件即可）。 */
export {
  stripLeadingThinking as stripLeadingThinkingPure,
  parseXmlToolCalls,
  stripXmlToolMarkers,
  pushEgressDelta,
  finalizeEgressText,
  createEgressState,
  isWebRoute,
} from './egress.js'

/* 与其他层一致地再导出（单测/排查直接 import 用）。 */
export { installOrderRoute }

export const inject = ['llm', 'webServer']

/** 标记已包装，防止热重载后二次包装。 */
const WRAPPED = Symbol.for('dsh-adapter-compat.wrapped')

/** 历史标记名：旧版只装了 thinking 剥离，热重载时靠它判重。 */
const THINK_FILTER = Symbol.for('dsh-adapter-compat.thinking-tag-filter')

/** 自动压缩硬闸标记：挂在替换后的 compactIfNeeded 上。 */
export const GATED = Symbol.for('dsh-adapter-compat.compaction-gate')

/** settings schema 守卫标记：防止热重载后二次包装。 */
export const SCHEMA_GUARDED = Symbol.for('dsh-adapter-compat.settings-schema-guard')

/**
 * 镜像自 @deepseek-ai/dsh-llm `LlmAdapter` 基类的默认实现（lib/index.js）。
 * 语义与基类逐一对齐：能同步就同步，基类返回 Promise 的这里也返回 Promise。
 * `prepareCall` 依赖 this.resolveModel / this.stream，与基类一致——
 * 没有 stream 的 adapter 本来也无法服务调用。
 */
export const BASE_DEFAULTS = {
  providerInfo(provider) {
    return { id: provider, name: provider }
  },
  providerRetryPolicy() {
    return undefined
  },
  imageRequestPricing() {
    return undefined
  },
  listModels() {
    return Promise.resolve([])
  },
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  },
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => patchedStreamFor((o) => this.stream(o), options),
    }
  },
}

/**
 * 给一个 adapter 实例回填缺失的基类默认方法。
 * 只在 `typeof adapter[key] !== 'function'` 时写入，已有实现一律不动。
 * ⚠️ prepareCall 例外（2026-10-26）：即使 adapter 自带 prepareCall，
 * 也要【包装】它——这是冻结请求三件套（教学/中文名/纯聊天）唯一的生效位
 * （agent-loop 把 request 深冻结后才调用，瀑布层物理上改不动）。
 * 包装方式：调用原实现拿到 prepared，再把 prepared.stream 换成我们的
 * 补丁流（解冻副本上做三件套再调原 stream）。原 prepareCall 的 model
 * 解析逻辑原样保留。
 * @returns {string[]} 实际补上的方法名（幂等调用返回空数组）。
 */
export function backfillAdapter(adapter) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return []
  const added = []
  for (const [key, impl] of Object.entries(BASE_DEFAULTS)) {
    if (key === 'prepareCall') continue
    if (typeof adapter[key] === 'function') continue
    try {
      adapter[key] = impl
      added.push(key)
    } catch {
      // 冻结/只读对象：跳过，保持与宿主同样的失败面
    }
  }
  /* prepareCall：一律包装（自带或回填都走同一条包装路）。PREPARE_PATCHED 防重。 */
  if (typeof adapter.prepareCall === 'function'
    && adapter.prepareCall !== BASE_DEFAULTS.prepareCall
    && adapter.prepareCall[PREPARE_PATCHED] !== true) {
    const original = adapter.prepareCall
    const patched = async function (...args) {
      const prepared = await original.apply(this, args)
      const innerStream = typeof prepared?.stream === 'function' ? prepared.stream.bind(prepared) : null
      if (innerStream === null || prepared === null || typeof prepared !== 'object') return prepared
      const stream = (options) => patchedStreamFor(innerStream, options)
      try {
        prepared.stream = stream
        return prepared
      } catch {
        try { return { ...prepared, stream } } catch { return prepared }
      }
    }
    try {
      Object.defineProperty(patched, PREPARE_PATCHED, { value: true })
      adapter.prepareCall = patched
      added.push('prepareCall*')
    } catch {
      // 冻结 adapter 无法包装——跳过
    }
  } else if (typeof adapter.prepareCall !== 'function') {
    try {
      adapter.prepareCall = BASE_DEFAULTS.prepareCall
      added.push('prepareCall')
    } catch { /* 同上 */ }
  }
  return added
}

/** prepareCall 包装标记（防热重载/多次 sweep 重复包装）。 */
const PREPARE_PATCHED = Symbol.for('dsh-adapter-compat.prepare-call-patched')

/**
 * 冻结请求三件套补丁流（2026-10-26 晚定案的真正生效位）：
 * request 被 agent-loop Object.freeze 深冻结——瀑布层改不动（物理限制）。
 * 这里在【调用底层 stream 前】用顶层浅副本做三件套：
 * 工具数组和信号数组只复制容器，AbortSignal 实例保持原引用。
 * 底层 adapter 收到的是改写后的副本，原件不碰（宿主安全）。
 */
export function patchedStreamFor(innerStream, options, home) {
  try {
    /* home 仅供单测注入临时目录；生产路径调用方不传 ⇒ 落回 dshHomeDir() 默认。 */
    const heal = readHealOptions(home)
    const eo = normalizeEgressOptions(heal)
    /* needPatch 必须含目录裁剪标志：nl 开 + kb 显式关时 nlTeach/zh/chatOnly 全 false，
     * 漏了这条会让 no-kb 裁剪静默失效（首轮单测抓到过）。 */
    const needPatch = options !== null && typeof options === 'object'
      && (eo.nlTeach === true || eo.zhToolNames === true || eo.chatOnly === true
        || eo.kbTrim === true || eo.noKbTrim === true)
    if (!needPatch) {
      recordWireRequest(options, home, 'adapter-dispatch')
      return innerStream(options)
    }
    const purpose = String(options.purpose ?? '')
    const mutable = {
      ...options,
      ...(Array.isArray(options.signals) ? { signals: options.signals.slice() } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }
    if (eo.chatOnly === true && purpose !== 'compaction' && purpose !== 'session-title'
      && Array.isArray(mutable.tools) && mutable.tools.length > 0) {
      mutable.tools = []
      egressStats.chatOnlyStripped = (egressStats.chatOnlyStripped ?? 0) + 1
    }
    /* [2026-10-29 按钮优先级·目录裁剪]（冻结请求的真正生效位）：裁剪放在中文名标注之前，
     * 幸存集合才拿得到中文描述。mutable 是顶层浅副本，换数组绝不碰宿主原对象。 */
    const trimMode = resolveToolTrimMode(eo)
    if (trimMode !== 'none' && purpose !== 'compaction' && purpose !== 'session-title'
      && Array.isArray(mutable.tools) && mutable.tools.length > 0) {
      const before = mutable.tools.length
      mutable.tools = filterToolCatalogByMode(mutable.tools, trimMode)
      if (mutable.tools.length !== before) {
        egressStats.catalogTrimmed = (egressStats.catalogTrimmed ?? 0) + 1
      }
    }
    if (eo.nlTeach === true && purpose !== 'compaction' && purpose !== 'session-title') {
      const teach = [
        '',
        '【自然语言调用知识库】当你需要检索跨会话记忆时，不要调用工具——直接用自然语言说出这句话（整条回复只有这一句）：',
        '「我要调动第一层知识库，搜索XX」（结论卡片）或「我要调动第二层知识库，搜索XX」（原始对话原文）。',
        '宿主会自动把它翻译成真正的检索调用。',
      ].join('\n')
      const sys = String(mutable.system ?? '')
      if (sys === '' || !sys.includes('我要调动第一层知识库')) {
        mutable.system = sys + (sys === '' ? '' : '\n\n') + teach
        egressStats.nlTaught = (egressStats.nlTaught ?? 0) + 1
      }
    }
    if (eo.zhToolNames === true && Array.isArray(mutable.tools) && mutable.tools.length > 0) {
      try {
        const { ZH_TOOL_DESCRIPTIONS } = zhNames
        mutable.tools = mutable.tools.map((t) => {
          if (t === null || typeof t !== 'object') return t
          const zhDesc = ZH_TOOL_DESCRIPTIONS[t.name]
          if (typeof zhDesc !== 'string' || zhDesc === '') return t
          return { ...t, description: zhDesc }
        })
        egressStats.zhLocalized = (egressStats.zhLocalized ?? 0) + 1
      } catch { /* 替换失败不阻断 */ }
    }
    recordWireRequest(mutable, home, 'adapter-dispatch')
    return innerStream(mutable)
  } catch {
    /* fail-open：补丁失败退回原请求，绝不炸轮次 */
    return innerStream(options)
  }
}

/** 扫描 llm.adapters 注册表（value 形如 { adapter, provider }），回填所有 adapter。 */
function sweep(llm) {
  try {
    const map = llm.adapters
    if (!map || typeof map.values !== 'function') return
    for (const registration of map.values()) {
      backfillAdapter(registration?.adapter ?? registration)
    }
  } catch {
    // 注册表形态随内核演进可能变化：垫片绝不能反过来弄挂宿主
  }
}

/**
 * 给任意持有 compactIfNeeded 的对象（引擎实例或其 prototype）装闸。
 * 已装过（GATED 标记）则跳过；幂等。
 * @returns {boolean} 本次是否实际装闸。
 */
export function gateTarget(obj) {
  if (!obj || typeof obj.compactIfNeeded !== 'function') return false
  if (obj.compactIfNeeded[GATED]) return false
  const gated = function () {
    // 宿主语义：compactIfNeeded(...) → null = 无需压缩，调用方静默跳过。
    // 手动 /compact 走 compactNow，不经这里。
    return null
  }
  gated[GATED] = true
  gated.original = obj.compactIfNeeded
  try {
    Object.defineProperty(obj, 'compactIfNeeded', {
      value: gated, configurable: true, writable: true, enumerable: false,
    })
    return true
  } catch {
    try {
      obj.compactIfNeeded = gated
      return true
    } catch {
      // 只读对象：不弄挂宿主，交给另一层（instance/prototype/事件补闸）
      return false
    }
  }
}

/**
 * 给一个引擎实例装闸：instance 打标 + prototype 打标（覆盖同类未来实例）。
 * @returns {boolean} 是否有实际动作。
 */
export function armEngine(engine) {
  if (!engine || typeof engine.compactIfNeeded !== 'function') return false
  let armed = gateTarget(engine)
  try {
    const proto = Object.getPrototypeOf(engine)
    if (proto && proto !== Object.prototype && typeof proto.compactIfNeeded === 'function') {
      armed = gateTarget(proto) || armed
    }
  } catch {
    /* 无原型可打就只打实例 */
  }
  return armed
}

/** 按 agent 解析其自动压缩引擎（镜像 session-kit 的查找顺序）。 */
function engineForAgent(ctx, agent) {
  try {
    const scoped = ctx.get?.('agentPresets')?.serviceFor?.(agent, 'compaction')
    if (scoped !== undefined) return scoped
  } catch {
    /* 无 preset 面则回落根引擎 */
  }
  try {
    return ctx.get?.('compaction')
  } catch {
    return undefined
  }
}

/**
 * 布防自动压缩硬闸：
 *   1. 立即武装根引擎（instance + prototype）。
 *   2. prepend 监听 agent/pre-step：每个 agent 首步前武装它的引擎
 *      （preset 作用域实例、热重载换类后的新实例都在这里兜住）。
 *      prepend 保证在 compaction-basic 自己的 pre-step 监听之前执行。
 * 任何异常都静默——闸是加法，绝不能反过来弄挂宿主。
 */
export function armGate(ctx) {
  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[adapter-compat] ${msg}`)
    } catch {
      /* 无日志面 */
    }
  }
  let root
  try {
    root = ctx.get?.('compaction')
  } catch {
    root = undefined
  }
  if (armEngine(root)) log('auto-compaction gate armed (root engine: compactIfNeeded → null)')
  try {
    ctx.on?.(
      'agent/pre-step',
      ({ agent }, next) => {
        try {
          const engine = engineForAgent(ctx, agent)
          if (engine && typeof engine.compactIfNeeded === 'function' && !engine.compactIfNeeded[GATED]) {
            if (armEngine(engine)) log('auto-compaction gate armed (agent-scoped engine)')
          }
        } catch {
          /* 闸失败不能影响 step */
        }
        return next()
      },
      { prepend: true },
    )
  } catch {
    /* 内核无该事件面：根引擎闸已足够覆盖单一引擎拓扑 */
  }
}

/* ============ 第六层：压缩摘要跟随「当前选中模型」（9999.9.22） ===========
 *   症状：在 UI 里把模型切成一个能用的，再点 /compact，报的还是旧模型的错
 *   （实测 2026-10-14 16:36：切成 dsh/deepseek-v4.1-flash 之后压缩仍打
 *   deepseek-official，拿到 Insufficient Balance 402）。
 *
 *   根因：压缩摘要那一次请求的模型解析链是
 *     const target = configured ?? latest ?? agentTarget
 *   其中
 *     latest = agent.session.requestHeader()?.config
 *   而 requestHeader() 只 fold request/header 事件，该事件仅在请求被「准备」
 *   （真正派发）时写入（dsh-agent-loop）。所以「在 UI 里切了模型、但还没有
 *   一条消息真正路由出去」时，latest 仍是旧模型 —— 切模型等于没切。
 *
 *   修法：包装 BasicCompactionEngine.summarize()，在调用期间把 this.config 的
 *   摘要目标临时钉到「当前选中模型」，让 configured 分支赢。选择意图取自宿主
 *   的 modelSelection 投影：
 *     pending  = UI 里选了、还没有任何已派发请求消费掉的选择
 *     lastUsed = 上一次真正派发过的请求用的路由
 *   取 pending ?? lastUsed，与 UI 上「下一个请求会用谁」语义完全一致。
 *
 *   要点：
 *   - 不碰任何核心文件，不改 cordis.patch.yml，DSH 升级后依然生效；
 *   - 与 autoGate 解耦：关掉自动压缩硬闸时手动 /compact 照样跟随当前选中模型；
 *   - config 是 deepFreeze 过的对象，所以换的是实例上的引用，不是改对象本身；
 *   - finally 无条件还原，异常/取消/超时路径都覆盖；
 *   - 任何一步拿不到投影就静默回退到宿主原逻辑，垫片绝不反过来弄挂宿主。
 */

/** 摘要包装标记：防止热重载后二次包装。 */
export const SUMMARIZER_ARMED = Symbol.for('dsh-adapter-compat.summarizer-selected-model')

/**
 * 读会话「当前选中模型」。
 * @returns {{provider: string, model: string} | undefined} 拿不到就返回 undefined。
 */
export function selectedRoute(ctx, agent) {
  let projections
  try {
    projections = ctx?.get?.('sessionProjections')
  } catch {
    return undefined
  }
  if (!projections || typeof projections.stateOf !== 'function') return undefined
  let state
  try {
    state = projections.stateOf(agent?.session, 'modelSelection')
  } catch {
    return undefined
  }
  const pick = state?.pending ?? state?.lastUsed
  if (!pick) return undefined
  if (typeof pick.provider !== 'string' || pick.provider.length === 0) return undefined
  if (typeof pick.model !== 'string' || pick.model.length === 0) return undefined
  return { provider: pick.provider, model: pick.model }
}

/**
 * 包装一个对象的 summarize()：调用期间把 this.config 的摘要目标钉到当前选中模型。
 * 幂等（SUMMARIZER_ARMED 标记）；任何异常静默返回 false。
 * @returns {boolean} 本次是否实际包装。
 */
export function wrapSummarize(ctx, obj) {
  if (!obj || typeof obj.summarize !== 'function') return false
  if (obj.summarize[SUMMARIZER_ARMED]) return false
  const original = obj.summarize
  const wrapped = async function (...args) {
    const agent = args[1]
    let picked
    try {
      picked = selectedRoute(ctx, agent)
    } catch {
      picked = undefined
    }
    const previous = this?.config
    let swapped = false
    if (picked && previous && typeof previous === 'object') {
      try {
        // config 已 deepFreeze，换引用而不是改对象
        this.config = Object.freeze({
          ...previous,
          summarizationProvider: picked.provider,
          summarizationModel: picked.model,
        })
        swapped = true
      } catch {
        swapped = false
      }
    }
    try {
      return await original.apply(this, args)
    } finally {
      if (swapped) {
        try {
          this.config = previous
        } catch {
          /* 只读实例：保持原样，绝不弄挂宿主 */
        }
      }
    }
  }
  wrapped[SUMMARIZER_ARMED] = true
  wrapped.original = original
  try {
    Object.defineProperty(obj, 'summarize', {
      value: wrapped, configurable: true, writable: true, enumerable: false,
    })
    return true
  } catch {
    try {
      obj.summarize = wrapped
      return true
    } catch {
      return false
    }
  }
}

/**
 * 给引擎装摘要包装：prototype 优先（一次覆盖同类全部实例，含已存在的），
 * 实例自身持有 summarize 时再补一次。幂等；异常静默。
 * @returns {boolean} 是否有实际动作。
 */
export function armSummarizer(ctx, engine) {
  if (!engine || typeof engine.summarize !== 'function') return false
  let armed = false
  try {
    const proto = Object.getPrototypeOf(engine)
    if (proto && proto !== Object.prototype && typeof proto.summarize === 'function') {
      armed = wrapSummarize(ctx, proto) || armed
    }
  } catch {
    /* 无原型可打就只打实例 */
  }
  armed = wrapSummarize(ctx, engine) || armed
  return armed
}

/**
 * 布防摘要模型跟随：
 *   1. 立即武装根引擎；
 *   2. prepend 监听 agent/pre-step，按 agent 补装 preset 作用域引擎
 *      （热重载换类后的新实例也在这一步兜住，与硬闸同源）。
 * 与 autoGate 解耦：关掉自动压缩硬闸时，手动 /compact 照常跟随当前选中模型。
 */
export function armSummarizerSelection(ctx) {
  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[adapter-compat] ${msg}`)
    } catch {
      /* 无日志面 */
    }
  }
  let root
  try {
    root = ctx.get?.('compaction')
  } catch {
    root = undefined
  }
  if (armSummarizer(ctx, root)) log('compaction summarizer follows selected model (root engine)')
  try {
    ctx.on?.(
      'agent/pre-step',
      ({ agent }, next) => {
        try {
          const engine = engineForAgent(ctx, agent)
          if (engine && typeof engine.summarize === 'function' && !engine.summarize[SUMMARIZER_ARMED]) {
            if (armSummarizer(ctx, engine)) log('compaction summarizer follows selected model (agent-scoped engine)')
          }
        } catch {
          /* 包装失败不能影响 step */
        }
        return next()
      },
      { prepend: true },
    )
  } catch {
    /* 内核无该事件面：根引擎包装已足够覆盖单一引擎拓扑 */
  }
}


/**
 * 把一个 cordis runtime 上被固化为 null 的 Config 归一成 undefined。
 * 宿主 dsh-settings 的 schema() 对 undefined 的语义 = 「无 Config，跳过该条目」；
 * 对 null 则是 `('toJSON' in null)` 直接抛崩。只补缺：undefined/真 schema 一律不动。
 * @returns {boolean} 本次是否实际归一。
 */
export function normalizeRuntime(runtime) {
  try {
    if (runtime && runtime.Config === null) {
      runtime.Config = undefined
      return true
    }
  } catch {
    // 冻结/只读对象：跳过，垫片绝不能反过来弄挂宿主
  }
  return false
}

/**
 * 扫全部 runtime 记录，归一 null Config。三个来源依次兜底（任一可用即可，
 * 与宿主 describe() 访问的是同一批 fiber.runtime 对象）：
 *   1. registry —— cordis 的 runtime 记录册（内部就用 ctx.registry.values() 遍历）；
 *   2. configEditor.entries() —— 宿主 describe/write 的原始访问路径；
 *   3. loader.entries()。
 * 幂等：已归一/本就健康的条目返回不动，重复调用返回 0。
 * @returns {number} 实际归一条数。
 */
export function normalizeRuntimeConfigs(ctx) {
  let fixed = 0
  const visit = (runtime) => {
    if (normalizeRuntime(runtime)) fixed++
  }
  const eachEntry = (holder) => {
    for (const entry of holder.entries()) visit(entry?.fiber?.runtime)
  }
  // 源1：registry（cordis runtime 记录册）
  try {
    const reg = ctx.registry ?? ctx.get?.('registry')
    if (reg && typeof reg.values === 'function') {
      for (const runtime of reg.values()) visit(runtime)
    }
  } catch {
    /* 无 registry 面：走回落 */
  }
  if (fixed > 0) return fixed
  // 源2：configEditor —— 与宿主 describe()/write() 同一条路径
  try {
    const ce = ctx.configEditor ?? ctx.get?.('configEditor')
    if (ce && typeof ce.entries === 'function') eachEntry(ce)
  } catch {
    /* 走回落 */
  }
  if (fixed > 0) return fixed
  // 源3：loader
  try {
    const ld = ctx.loader ?? ctx.get?.('loader')
    if (ld && typeof ld.entries === 'function') eachEntry(ld)
  } catch {
    /* 全部不可用：垫片静默，schema 守卫与延迟补扫仍兜底 */
  }
  return fixed
}

/**
 * 给 settings 服务实例的 schema() 套一层（own-property 遮蔽原型方法）：
 * 每次宿主调用 schema(entry) 前，先把该条目 runtime 的 null 归一。
 * 这样就算条目晚于本插件注册（bundles 里 dsh-sync 在后），describe/write
 * 第一次碰到它时也已被修好。幂等（SCHEMA_GUARDED 打标）。
 * @returns {boolean} 是否成功装上（已装过也返回 true）。
 */
export function guardSettingsSchema(ctx) {
  try {
    const settings = ctx.settings ?? ctx.get?.('settings')
    if (!settings || typeof settings.schema !== 'function') return false
    if (settings.schema[SCHEMA_GUARDED]) return true
    const original = settings.schema
    const wrapped = function (entry) {
      try {
        normalizeRuntime(entry?.fiber?.runtime)
      } catch {
        /* 单条失败不拖垮整次 describe */
      }
      return original.call(this, entry)
    }
    wrapped[SCHEMA_GUARDED] = true
    wrapped.original = original
    settings.schema = wrapped
    return true
  } catch {
    // 实例不可扩展等极端形态：只剩 registry 归一 + 延迟补扫两层
    return false
  }
}

/* ============ 第四层：上下文占用中文化校准 ===========
 *
 * 症状：仪表盘显示「还剩 10%+」，一发消息就报超过 contextWindow（1M）上限。
 *
 * 根因（官方 dsh-token-meter 的 contextPressure 外推公式）：
 *   projectedTokens = pressureTokens + surfaceTokens - sampledSurfaceTokens
 * 这里两个数不是一回事：
 *   - pressureTokens        = 提供方真实报告的 prompt 规模（真数）
 *   - surfaceTokens         = 按字符的启发式估算（假数）
 *   - sampledSurfaceTokens  = 上一次真实采样那一刻的启发式值
 * 于是「采样之后的增长」只按启发式增量往上加。而启发式对中文大约少算一半——
 * 实测某会话启发式 215111 对真实 462816，倍率 2.15。结果：真实请求已经越过
 * contextWindow，仪表盘还按半个身位在加，看着还剩一大截。
 *
 * 修法：用「实测倍率」校正启发式增量，其余一律不动：
 *   ratio = pressureTokens / sampledSurfaceTokens
 *   projectedTokens = pressureTokens + (surfaceTokens - sampledSurfaceTokens) * ratio
 * 只改 view 的输出值——不动 state 机、不动 apply、不动 surfaceTokens 本身，
 * 因此 projcache 里已存的 state 不需要失效，stateVersion 不变。
 * 样本不足（sampledSurfaceTokens 太小）或倍率异常（<=0 或 >8）时原样退回官方值，
 * 绝不比官方更离谱。
 *
 * 挂接点：sessionProjections.register() 会把 wire 对象按引用捕获
 * （`view: state => wire.view(state)`），所以包裹 def.wire.view 即可生效；
 * 无论 token-meter 早于还是晚于本插件注册，两条路径都覆盖。
 */

/** 占用校准标记：防止热重载后二次包装。 */
export const PRESSURE_CALIBRATED = Symbol.for('dsh-adapter-compat.pressure-calibration')

/** 输出预留（token，固定值）：默认 0。设为非 0 会把该 token 数直接加到显示占用上。
 *  ⚠️ 2026-10-12 实测教训：这里原本写死 256000（当时为了预演「messages + max_tokens
 *  ≤ contextWindow」会不会被提供方拒），结果它是个**绝对值**，在小会话上把占用抬成
 *  实际的 4~6 倍——真实提示词 52,088，仪表盘显示 308,088（30%）；提示词涨到 79,465
 *  时显示 335,465（32%）。倍数还不固定，无法据此判断真实用量。
 *  现改为下方的**相对余量**（PRESSURE_MARGIN_RATIO，默认 5%），保证显示值略大于
 *  实际值。想恢复旧的「预留预演」行为：插件 config 里 contextReserveTokens。
 */
export const pressureReserve = { tokens: 0 }

/** 相对余量：显示值 = 校准值 × (1 + 该比例)。用户要求「留 5% 余量」。 */
export const PRESSURE_MARGIN_RATIO = 0.05

/** fallback 增量的保守修正系数（仅作用于「无实测倍率」时的 surface 增量）。
 *  宿主 dsh-token-meter 的 CHARS_PER_TOKEN = 4（≈0.25 token/字符，英文口径）；
 *  DeepSeek 官方换算（api-docs.deepseek.com/zh-cn/quick_start/token_usage）：
 *  1 英文字符 ≈ 0.3 token、**1 中文字符 ≈ 0.6 token** —— 官方中文口径 1.67 字符/token，
 *  宿主口径对中文会话低估 4 × 0.6 = 2.4 倍。实测倍率分支靠真实 usage 自然修正，
 *  但 fallback（样本不足/倍率异常）没有实测兜底，直接用官方 4 字符/token 的增量
 *  在中文会话里会低估到爆窗。按官方中文口径回算取 2.4：英文会话 fallback 略虚高，
 *  属短暂冷启动态——用户要求「常数保守、宁高勿爆」。
 */
export const PRESSURE_FALLBACK_FACTOR = 2.4

/** 设置固定预留（apply 时按插件 config 注入；不设则保持 0）。 */
export function setPressureReserveTokens(value) {
  const n = Number(value)
  if (Number.isFinite(n) && n >= 0) pressureReserve.tokens = Math.round(n)
}

export const PRESSURE_MIN_SAMPLE = 2000
export const PRESSURE_MAX_RATIO = 8

/**
 * 纯函数：把官方 view 的输出按实测倍率校正 projectedTokens。
 * @param {object|undefined} state - 投影单元 state（含 pressureTokens/surfaceTokens/sampledSurfaceTokens）。
 * @param {object|undefined} out - 官方 view 的产物。
 * @returns {object|undefined} 校正后的产物；不满足条件时原样返回。
 */
export function calibratePressureView(state, out) {
  try {
    if (!out || typeof out !== 'object') return out
    /* 余量一律并入：无论倍率校准走哪条分支，出口值都要略大于本次请求的真实规模。 */
    const withReserve = (value) =>
      Number.isFinite(value) ? Math.round(value * (1 + PRESSURE_MARGIN_RATIO)) + pressureReserve.tokens : value
    const pressure = state?.pressureTokens
    const total = state?.surfaceTokens
    const sampled = state?.sampledSurfaceTokens
    /* fallback：官方 projected = pressure + (surface - sampled)，增量按 4 字符/token（英文口径）估。
     * pressure 是提供方真数不动；只把**正的** surface 增量按官方中文口径 ×PRESSURE_FALLBACK_FACTOR
     * 回算（负增量不放大，防绝对值放大反成低估）。state 缺字段时保持官方值。 */
    const official = out.projectedTokens
    let fallbackValue = official
    if (Number.isFinite(official) && Number.isFinite(pressure) && Number.isFinite(total) && Number.isFinite(sampled)) {
      const delta = total - sampled
      if (delta > 0) fallbackValue = Math.max(0, Math.round(pressure + delta * PRESSURE_FALLBACK_FACTOR))
    }
    const fallback = Number.isFinite(fallbackValue)
      ? { ...out, projectedTokens: withReserve(fallbackValue) }
      : out
    if (!Number.isFinite(pressure) || !Number.isFinite(total) || !Number.isFinite(sampled)) return fallback
    if (pressure <= 0 || sampled < PRESSURE_MIN_SAMPLE) return fallback
    const ratio = pressure / sampled
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > PRESSURE_MAX_RATIO) return fallback
    const projected = withReserve(Math.max(0, Math.round(pressure + (total - sampled) * ratio)))
    return { ...out, projectedTokens: projected }
  } catch {
    // 校准失败必须退回官方值，垫片绝不能反过来弄坏占用显示
    return out
  }
}

/**
 * 给 contextPressure 投影单元的 wire.view 套一层校准（幂等）。
 * @param {object} projections - ctx.sessionProjections 服务实例。
 * @returns {number} 本次新包装的单元数。
 */
export function calibrateContextPressure(projections) {
  if (!projections || typeof projections !== 'object') return 0
  let patched = 0
  const patchWire = (wire) => {
    if (!wire || typeof wire.view !== 'function' || wire.view[PRESSURE_CALIBRATED]) return false
    const original = wire.view
    const wrapped = function (state) {
      return calibratePressureView(state, original.call(this, state))
    }
    wrapped[PRESSURE_CALIBRATED] = true
    wrapped.original = original
    try {
      wire.view = wrapped
      return true
    } catch {
      return false
    }
  }
  const patchDef = (def) => {
    if (!def || def.key !== 'contextPressure') return false
    return patchWire(def.wire)
  }
  // a) 已经注册的单元（token-meter 早于本插件加载时走这条）
  try {
    for (const registration of projections.registrations?.values?.() ?? []) {
      if (patchDef(registration?.def)) patched += 1
    }
  } catch {
    /* 无 registrations 面：只靠 register 包装 */
  }
  // b) 不包装 projections.register。原因（2026-10-29 实测）：
  //    sessionProjections.register() 的 disposer 绑定在「调用方 Fiber」上，ref-count 归零即删键。
  //    Adapter 一旦替换 register，其它插件（permission / modelSelection）的注册就多背一层
  //    Adapter 的闭包：停用 Adapter 期间这些键被读成 undefined，弹出
  //    「permissions session projection is not registered」，模型选择也写不进去。
  //    校准只需覆盖已在册的 contextPressure 单元（上面 a 路径），晚注册单元由
  //    installPressureCalibration 的定时重试补齐（1s/3s/8s + 可配周期）。
  return patched
}

/* ============ 第五层：会话盘变化监视 + 全盘标题投影预热 ===========
 *
 * 症状：跑 dsh-sync「下载」之后，侧边栏标题集体变成工作区名，要重启才能看；
 *       而重启后也只有「手动点开过的」那些会话有标题。
 *
 * 根因：列表标题走 projcache 的零 I/O 读（storages/session_projcache/sessions/<id>.json）。
 *   - 同步下载会用远端 storages 覆盖本地 → projcache 大批消失；
 *   - 标题于是回落到工作区名（DSH 对无标题会话的默认显示）；
 *   - 点开会话会冷重建该会话的投影 → 只有点过的那些有标题；
 *   - 既有预热只在「启动后 12 秒」跑一次；下载发生在启动之后 → 没人再补。
 *   实测（2026-10-08）：磁盘 95 个会话，projcache 只剩 39 条。
 *
 * 修法：把预热从一次性改成事件驱动——
 *   1. 递归 fs.watch 监听 $DSH_HOME/sessions（Windows 走 ReadDirectoryChangesW，
 *      事件驱动、几乎零成本），事件后延迟 1.5 秒复核一次指纹，确认落盘已稳定；
 *   2. 另加 60 秒慢轮询兜底，防止 watch 漏事件；
 *   3. 稳定后：先按**磁盘扫描**全盘补齐 projcache，再 sessions.refresh() 让列表
 *      重读——顺序不能反，先刷新会把「还没标题」的状态刷进列表；
 *   4. 补齐来源是磁盘扫描而不是工作区注册表：注册表可能还没收录刚下载的会话，
 *      只信它会漏掉它们（这正是旧实现只补到一部分的原因）；
 *   5. 顺带修「记录在但标题为空」的会话（repairUntitled，默认开，有配额上限）。
 *
 * 全程 fail-soft：任何一步失败只写日志，绝不影响 DSH 本体。
 * 落盘日志：$DSH_HOME/dsh-adapter-compat.log。关掉：config.titleWarm: false。
 */

/** 关闭本层的 config 键。 */
export const TITLE_WARM_DISABLED_KEY = 'titleWarm'
/** 慢轮询兜底间隔（ms）。主路径是递归 fs.watch，事件驱动、几乎零成本。 */
export const SESSION_POLL_INTERVAL_MS = 60000
/** 检测到变化后，再等多久复核一次才算稳定（避开同步写到一半）。 */
export const SESSION_WATCH_DEBOUNCE_MS = 1500
/** 每轮最多重建多少条（防止一次下载后长时间占满 I/O）。 */
export const TITLE_WARM_MAX_PER_PASS = 200
/** 会话监视标记。 */
export const SESSION_WATCH = Symbol.for('dsh-adapter-compat.session-watch')

/** DSH 主目录：与宿主/其他插件同一套推导（DSH_HOME 优先）。 */
export function dshHomeDir(env = process.env) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = env?.USERPROFILE ?? env?.HOME
  return home ? `${String(home).replace(/[\\/]+$/u, '')}/.dsh` : '.dsh'
}

/** 追加一行到本插件的落盘日志（永不抛）。 */
export function appendCompatLog(line, home = dshHomeDir()) {
  try {
    appendFileSync(`${home}/dsh-adapter-compat.log`, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 日志失败绝不外抛 */
  }
}

/**
 * 扫描 $DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd。
 * @returns {{ids: string[], newest: number}} 会话 id 列表与最新 mtimeMs。
 */
export function scanSessionFiles(home = dshHomeDir()) {
  const ids = []
  let newest = 0
  try {
    const root = `${home}/sessions`
    for (const workspace of readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const wsDir = `${root}/${workspace.name}`
      let sessions = []
      try {
        sessions = readdirSync(wsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const file = `${wsDir}/${session.name}/session.v4.jsonl.zstd`
        try {
          if (!existsSync(file)) continue
          const stat = statSync(file)
          if (stat.mtimeMs > newest) newest = stat.mtimeMs
          ids.push(session.name)
        } catch {
          /* 单个会话读不到就跳过 */
        }
      }
    }
  } catch {
    /* 根目录不可读：空快照 */
  }
  return { ids, newest }
}

/** 廉价指纹：会话文件数 + 最新 mtime。变化即意味着有外部落盘。 */
export function sessionsFingerprint(home = dshHomeDir()) {
  const { ids, newest } = scanSessionFiles(home)
  return { count: ids.length, newest, key: `${ids.length}:${newest}` }
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

/** 附件服务（失效附件判定用）。拿不到 = 退回「按磁盘布局推断」，见 attachments.js。 */
function attachmentsService(ctx) {
  const svc = serviceOf(ctx, 'attachments')
  return svc && typeof svc === 'object' ? svc : undefined
}

/** 读一份持久化会话的完整事件（复刻宿主的 handle 风格读取）。 */
async function readPersistedEvents(persistence, sessionId) {
  if (typeof persistence?.open === 'function') {
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
      return await handle.read(0, Number.MAX_SAFE_INTEGER)
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          /* close 失败不掩盖读取结果 */
        }
      }
    }
  }
  if (typeof persistence?.readFrom === 'function') return persistence.readFrom(sessionId, 0)
  return undefined
}

/**
 * 全盘补齐标题投影（幂等）。只重建「projcache 缺失」以及（可选）「标题为空」的会话。
 * @param {object} ctx - cordis 上下文。
 * @param {object} [options] - { max, repairUntitled, verbose, home }
 * @returns {Promise<object>} 统计。
 */
export async function warmProjectionTitles(ctx, options = {}) {
  const stats = { scanned: 0, cached: 0, rebuilt: 0, repaired: 0, missing: 0, failed: 0 }
  const home = options.home ?? dshHomeDir()
  try {
    const cache = serviceOf(ctx, 'sessionProjectionCache')
    const persistence = serviceOf(ctx, 'sessionPersistence')
    if (typeof cache?.coldSnapshot !== 'function') return stats
    const byId = new Map()
    if (typeof persistence?.list === 'function') {
      const entries = (await persistence.list().catch(() => [])) ?? []
      for (const entry of entries) {
        const header = entry?.header ?? entry
        if (header?.id) byId.set(header.id, entry)
      }
    }
    const projDir = `${home}/storages/session_projcache/sessions`
    const { ids } = scanSessionFiles(home)
    stats.scanned = ids.length
    const budget = Number.isFinite(options.max) ? options.max : TITLE_WARM_MAX_PER_PASS
    const repairUntitled = options.repairUntitled !== false
    for (const sid of ids) {
      if (stats.rebuilt + stats.repaired >= budget) break
      const file = `${projDir}/${sid}.json`
      const exists = existsSync(file)
      if (exists) {
        stats.cached += 1
        if (!repairUntitled) continue
        try {
          const record = JSON.parse(readFileSync(file, 'utf8'))
          const title = (record?.record ?? record)?.rows?.title?.val
          if (typeof title === 'string' && title.length > 0) continue
        } catch {
          /* 记录损坏：当作需要重建 */
        }
      }
      try {
        const entry = byId.get(sid)
        const header = entry?.header ?? entry
        if (header?.id !== sid) {
          stats.missing += 1
          continue
        }
        const read = await readPersistedEvents(persistence, sid)
        const events = read?.events
        if (!Array.isArray(events) || events.length === 0) {
          stats.missing += 1
          continue
        }
        if (exists) {
          // 已存在的记录只在日志里真有标题事件时才重建，避免无谓 I/O
          if (!events.some((event) => event?.type === 'session/title')) continue
          const inheritedRepair = Number(entry?.inheritedEventCount ?? header?.inheritedEventCount ?? 0) || 0
          cache.coldSnapshot(header, inheritedRepair, events)
          stats.repaired += 1
        } else {
          const inherited = Number(entry?.inheritedEventCount ?? header?.inheritedEventCount ?? 0) || 0
          cache.coldSnapshot(header, inherited, events)
          stats.rebuilt += 1
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
      } catch {
        stats.failed += 1
      }
    }
    if (stats.rebuilt > 0 || stats.repaired > 0 || options.verbose) {
      appendCompatLog(
        `title-warm scanned=${stats.scanned} cached=${stats.cached} rebuilt=${stats.rebuilt} repaired=${stats.repaired} missing=${stats.missing} failed=${stats.failed}`,
        home,
      )
      ctx.logger?.info?.(
        `[adapter-compat] title warm: rebuilt ${stats.rebuilt}, repaired ${stats.repaired} / scanned ${stats.scanned}`,
      )
    }
  } catch (error) {
    stats.failed += 1
    appendCompatLog(`title-warm FAILED: ${String(error?.message ?? error).slice(0, 200)}`, home)
  }
  return stats
}

/** 一次「外部落盘」响应：先全盘补标题投影，再让列表重读。
 *  顺序很关键——先 refresh 会把「还没有标题」的状态刷进列表，等于白刷。 */
export async function rescanAndWarm(ctx, options = {}) {
  const result = { refreshed: false, warmed: null }
  result.warmed = await warmProjectionTitles(ctx, options)
  try {
    const sessions = serviceOf(ctx, 'sessions')
    if (typeof sessions?.refresh === 'function') {
      await sessions.refresh()
      result.refreshed = true
    }
  } catch (error) {
    appendCompatLog(`rescan refresh FAILED: ${String(error?.message ?? error).slice(0, 160)}`)
  }
  return result
}

/** 安装会话盘监视：轮询指纹，变化且稳定后触发重扫 + 预热。幂等。 */
export function installSessionWatch(ctx, options = {}) {
  const home = options.home ?? dshHomeDir()
  try {
    if (ctx?.__adapterCompatSessionWatch?.[SESSION_WATCH]) return ctx.__adapterCompatSessionWatch
  } catch {
    /* ctx 不可读则继续安装 */
  }
  const pollMs = Number.isFinite(options.pollIntervalMs)
    ? options.pollIntervalMs
    : (Number.isFinite(options.intervalMs) ? options.intervalMs : SESSION_POLL_INTERVAL_MS)
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : SESSION_WATCH_DEBOUNCE_MS
  /* 变化后要做哪些事：默认全做（2026-10-16 前的行为）；设置页可逐项关掉，
     这正是用户抱怨的「每次会话变化都全盘扫 94 个会话」的三个动作。 */
  const on = options.toggles ?? readHealOptions(home)
  const state = { last: sessionsFingerprint(home).key, pendingKey: null, busy: false, timer: null, watcher: null }
  let check
  const schedule = (delay) => {
    if (state.timer !== null) return
    state.timer = setTimeout(() => {
      state.timer = null
      check()
    }, delay)
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }
  check = () => {
    if (state.busy) return
    let key
    try {
      key = sessionsFingerprint(home).key
    } catch {
      return
    }
    if (key === state.last) {
      state.pendingKey = null
      return
    }
    // 第一次看到变化 → 只记下并延后再核一次（避开下载写到一半）
    if (key !== state.pendingKey) {
      state.pendingKey = key
      schedule(debounceMs)
      return
    }
    // 稳定了：动手。先 warm 后 refresh（顺序不能反，见 rescanAndWarm 注释）
    state.pendingKey = null
    state.last = key
    state.busy = true
    const acts = []
    if (on.changeRescan !== false) acts.push('warm+rescan')
    if (on.changePurge !== false) acts.push('purge')
    if (on.changeHeadGuard !== false) acts.push('head-guard')
    appendCompatLog(`sessions changed (${key}) -> ${acts.length > 0 ? acts.join(' + ') : '（动作全部关闭，仅记录）'}`, home)
    Promise.resolve()
      .then(() => (on.changeRescan !== false ? rescanAndWarm(ctx, options) : undefined))
      .catch(() => {})
      // 目录变化 → 真删除扫描（line 854 注释本该有的调用点，此前丢失 → pending 永不重试）。
      // purge 幂等，写盘会再触发一轮 watcher，收敛后自然停（多跑一轮空扫）。
      .then(() => { try { if (on.changePurge !== false && typeof compatHooks.purge === 'function') compatHooks.purge() } catch { /* ignore */ } })
      // 目录变化同样可能是「外面下载/搬运进来一份无头会话」→ 补头守卫跟上
      .then(() => { try { if (on.changeHeadGuard !== false && typeof compatHooks.headGuard === 'function') compatHooks.headGuard() } catch { /* ignore */ } })
      .finally(() => {
        state.busy = false
        try {
          state.last = sessionsFingerprint(home).key
        } catch {
          /* ignore */
        }
      })
  }
  // 主路径：递归 fs.watch（Windows 走 ReadDirectoryChangesW，事件驱动、几乎零成本）
  try {
    const watcher = watch(`${home}/sessions`, { recursive: true }, () => schedule(debounceMs))
    if (typeof watcher.unref === 'function') watcher.unref()
    state.watcher = watcher
  } catch {
    // 平台不支持递归 watch：只剩下面的慢轮询兜底
  }
  // 兜底：慢轮询（默认 60s），防止 watch 漏事件/权限受限
  const timer = setInterval(check, pollMs)
  if (typeof timer.unref === 'function') timer.unref()
  state[SESSION_WATCH] = true
  state.dispose = () => {
    clearInterval(timer)
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
    try {
      state.watcher?.close()
    } catch {
      /* ignore */
    }
  }
  try {
    Object.defineProperty(ctx, '__adapterCompatSessionWatch', { value: state, configurable: true })
  } catch {
    /* ctx 不可写时仍保留 interval（进程级） */
  }
  try {
    ctx.effect?.(() => state.dispose, 'adapter-compat: session watch')
  } catch {
    /* 无 effect 面：交给进程退出回收 */
  }
  return state
}

/** 装配本层：监视 + 启动补跑（一次性预热不够，故启动后多补几轮）。 */
export function installTitleWarm(ctx, config = {}) {
  if (config?.[TITLE_WARM_DISABLED_KEY] === false) return undefined
  const on = readHealOptions()
  const options = {
    repairUntitled: config?.titleWarmRepairUntitled !== false,
    max: Number.isFinite(config?.titleWarmMax) ? config.titleWarmMax : undefined,
    /* 频率与「变化后动作」都交给用户选项（设置页「扫描与校准频率」）。 */
    toggles: on,
    pollIntervalMs: on.watchPollMs,
    debounceMs: on.watchDebounceMs,
  }
  const watch = installSessionWatch(ctx, options)
  // 启动补跑：12s 全盘补齐；60s 再补一次（覆盖启动后立刻发生的下载）
  const timers = []
  const at = (ms, fn) => {
    const t = setTimeout(() => {
      Promise.resolve()
        .then(fn)
        .catch(() => {})
    }, ms)
    if (typeof t.unref === 'function') t.unref()
    timers.push(t)
  }
  if (on.bootTitleWarm !== false) {
    at(12000, () => warmProjectionTitles(ctx, options))
    at(60000, () => rescanAndWarm(ctx, options))
  } else {
    appendCompatLog('title warm: 开机预热已关闭（设置页可开）')
  }
  return { watch, timers }
}

/**
 * 立刻跑一次标题预热 + 重扫（设置页「立即重扫」按钮用；不受开机开关影响）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function runTitleWarmNow(ctx) {
  try {
    await warmProjectionTitles(ctx, { repairUntitled: true })
    await rescanAndWarm(ctx, { repairUntitled: true })
    appendCompatLog('title warm: 手动触发完成')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/* ============ 第六层：真删除（物理切除墓碑） ===========
 *
 * 症状（用户长期诉求）：删掉的东西 Timeline 还在、被删轮次的「思考过程」残留、
 * 界面上还留一个「已删除」占位行。根因是删除只遮蔽表层节点，原始事件一行没少，
 * 而 Timeline（块索引）直读原始事件。
 *
 * 本层把 _truedelete/excision.mjs（52/52 自测通过、真实副本 verify.ok）接进来：
 *   1. 扫全部会话，只认插件自己的真删除墓碑（regeneration 载体会跳过——那种轮次
 *      还活着，整轮删会毁掉新回答）；
 *   2. 算整轮事件集 → excise（物理切除 + seq 重编号 + 引用重映射）→ verify；
 *   3. verify 通过才写盘：先备份到 backup-true-delete/，写完读回再 verify；
 *   4. 删 projcache（投影会冷重建；文件物理身份变化也让块索引自动重建 → Timeline 跟上）。
 *
 * **live 会话绝不写文件**：内存里的事件数组与文件必须对齐，只改文件不重编号会让
 * 下一次 flush 把内容写回并把 seq 写错 → 日志损坏。live 的记进待清理台账
 * dsh-true-delete-pending.json，开机早期（会话还没被激活）自动补清。
 *
 * 关掉：cordis.patch.yml 本插件行 config.trueDelete: false。
 */

/** 模块内共享钩子：会话目录变化时用来触发一次真删除扫描（由 installTrueDelete 装）。 */
const compatHooks = { purge: null }

/** 待清理台账文件名（$DSH_HOME 下）。 */
export const TRUE_DELETE_PENDING_FILE = 'dsh-true-delete-pending.json'
/** 真删除备份目录名（$DSH_HOME 下）。 */
export const TRUE_DELETE_BACKUP_DIR = 'backup-true-delete'

/** 列出全部会话文件 [{id, file}]。 */
export function listSessionFiles(home = dshHomeDir()) {
  const out = []
  try {
    for (const workspace of readdirSync(home + '/sessions', { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const wsDir = home + '/sessions/' + workspace.name
      let sessions = []
      try { sessions = readdirSync(wsDir, { withFileTypes: true }) } catch { continue }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const file = wsDir + '/' + session.name + '/session.v4.jsonl.zstd'
        try { if (existsSync(file)) out.push({ id: session.name, file }) } catch { /* skip */ }
      }
    }
  } catch { /* 根目录不可读 */ }
  return out
}

/**
 * 该会话此刻是不是 live。**判定不了就返回 true**（当作 live = 拒绝写文件）：
 * 这个方向的错误只是「晚点再清」，反方向的错误是把日志写坏。
 */
export function isSessionLive(ctx, sessionId) {
  try {
    const sessions = serviceOf(ctx, 'sessions')
    if (!sessions || typeof sessions.get !== 'function') return true
    return sessions.get(sessionId) !== undefined
  } catch {
    return true
  }
}

/**
 * 扫描并清理真删除墓碑。默认干跑；write:true 才写盘（带备份 + 读回复核）。
 * @param {object} ctx - cordis 上下文（只用于 live 判定）。
 * @param {object} [options] - { write, only, home, onResult }
 * @returns {Promise<{write:boolean, results:object[], pending:number}>}
 */
export async function purgeTombstones(ctx, options = {}) {
  const home = options.home ?? dshHomeDir()
  const write = options.write === true
  const backupDir = home + '/' + TRUE_DELETE_BACKUP_DIR
  const ledger = readPendingLedger(home)
  /* 审计用：扫描前记下每个会话的事件数，收尾时对账。
     对不上的（没被本插件写过却变了）= 外部改动（同步下载 / 别的插件 / 手工拷贝），
     记一行日志，避免再出现"莫名其妙就好了/坏了"。 */
  const seenBefore = Object.assign({}, ledger.seen)
  const writtenIds = new Set()
  /* 只清「上一次扫描之后新增的」墓碑；首次运行把窗口起点设成现在，
     于是历史墓碑（很久以前删的）永远不会被动到。 */
  const sinceMs = Number.isFinite(options.sinceMs)
    ? options.sinceMs
    : (Number.isFinite(ledger.lastScanMs) ? ledger.lastScanMs : Date.now())
  const results = []
  /* 版本家族保护（2026-10-16）：分叉/版本切换出来的会话默认**不动刀**——
     切版本会往另一个分支写墓碑，真删会把那个版本的内容物理切除，用户就回不去了。
     想真删走 /versions/purge（显式传 forceFamilies）。 */
  const protectFamilies = options.protectFamilies !== false
  const familyIds = protectFamilies ? versionFamilyIds(home) : new Set()
  for (const entry of listSessionFiles(home)) {
    if (options.only !== undefined && options.only !== entry.id) continue
    if (options.pendingOnly === true && !ledger.pending[entry.id]) continue   // 重试只碰待清项
    if (protectFamilies && familyIds.has(entry.id)) {
      /* 只记账、不落刀：这里的 skip 不写 pending（避免每次重试都重扫重试）。 */
      results.push({ id: entry.id, status: 'family-protected' })
      continue
    }
    if (isSessionLive(ctx, entry.id)) {
      /* live 会话不能整轮切除（内存事件数组会与文件错位），改走**就地擦文本**：
         清掉被删轮次里用户自己的消息正文，Timeline 立刻不再显示；seq/事件数不变，
         内存与文件保持对齐。assistant 回复与思考过程等非 live 时再由 excise 彻底拔。 */
      const red = redactSessionFile(entry.file, entry.id, { sinceMs, write, backupDir, purgeRegenerate: options.purgeRegenerate })
      if (red.status === 'redacted') {
        writtenIds.add(entry.id)
        try { rmSync(home + '/storages/session_projcache/sessions/' + entry.id + '.json', { force: true }) } catch { /* ignore */ }
        results.push(red)
      } else if (red.status === 'planned' || red.status === 'skipped') {
        results.push({ ...red, status: 'live-skipped' })
      } else if (red.status === 'blocked') {
        /* 断口门拦下（2026-10-10 手机端缺口事故）：文件 seq 已断口/settlement 不全，
           绝不碰它；台账亮红灯（why: seq-gap）等待人工修，同时跳过下面的 probe
           （probe 会把这条记录覆盖成 why:'live'，丢失报警语义）。 */
        ledger.pending[entry.id] = { at: new Date().toISOString(), why: 'seq-gap', note: red.notes[0] }
        results.push(red)
        continue
      }
      /* 2026-10-10 死锁修复：live 轻擦后必须保留 pending（待整轮切除）——
         此前 redact 成功即删台账 → 60s 重试认为完工 → 整轮切除永远排不上；
         而重启后会话又是最先活过来的（自动恢复）→ 永远只有轻擦 →
         Timeline 里留下 [图片或文件] 空壳墓碑。现在只要 plan 还有活就记账，
         等首个非 live 窗口（60s 重试 / 下次开机前 5s 黄金窗）物理切除。 */
      try {
        const probe = planPurge(readSession(entry.file).events, { sinceMs: 0, purgeRegenerate: options.purgeRegenerate })
        if (probe.remove.length > 0) {
          ledger.pending[entry.id] = { turns: probe.turns, removed: probe.remove.length, at: new Date().toISOString(), why: 'live', note: 'redact 已做，待非 live 整轮切除' }
        }
      } catch { /* 读不了就不动台账 */ }
      continue
    }
    const r = purgeSessionFile(entry.file, entry.id, { write, backupDir, sinceMs, purgeRegenerate: options.purgeRegenerate })
    if (r.status === 'written') {
      writtenIds.add(entry.id)
      delete ledger.pending[entry.id]
      try { rmSync(home + '/storages/session_projcache/sessions/' + entry.id + '.json', { force: true }) } catch { /* ignore */ }
    } else if (r.status === 'clean' || r.status === undefined) {
      delete ledger.pending[entry.id]   // 无事可清 → 销账，重试链终止
    } else if (r.status === 'planned') {
      ledger.pending[entry.id] = { turns: r.turns, removed: r.removed, at: new Date().toISOString(), why: 'dry-run' }
    } else if (r.status === 'blocked') {
      /* 断口门拦下（2026-10-10 手机端缺口事故）：坏文件不动，台账亮红灯等人工修 */
      ledger.pending[entry.id] = { at: new Date().toISOString(), why: 'seq-gap', note: r.notes[0] }
    }
    results.push(r)
    if (typeof options.onResult === 'function') {
      try { options.onResult(r) } catch { /* ignore */ }
    }
  }
  /* 外部改动审计：把当前事件数与扫描前对比。 */
  try {
    const seen = {}
    const changed = []
    for (const info of listSessionFiles(home)) {
      let count = -1
      try { count = readSession(info.file).events.length } catch { count = -1 }
      seen[info.id] = count
      const before = seenBefore[info.id]
      if (typeof before === 'number' && before >= 0 && count >= 0 && before !== count && !writtenIds.has(info.id)) {
        changed.push(info.id.slice(0, 18) + '(' + before + '->' + count + ')')
      }
    }
    ledger.seen = seen
    if (changed.length > 0) appendCompatLog('external-change detected: ' + changed.join(' '), home)
  } catch { /* 审计失败不影响清理 */ }
  ledger.lastScanMs = Date.now()
  if (write) writePendingLedger(home, ledger)
  // 顺手清 Timeline 孤儿索引（文件已删的会话）——零墓碑第三条腿，幂等
  try { pruneBlockOrphans(home) } catch { /* ignore */ }
  return { write, results, pending: Object.keys(ledger.pending).length, sinceMs }
}

/** 装配本层：开机早期多轮补清 + 待清理台账每 60 秒重试一次。 */
export function installTrueDelete(ctx, config = {}) {
  if (config?.trueDelete === false) return undefined
  const home = dshHomeDir()
  const summarise = (tag, r) => {
    const written = r.results.filter((x) => x.status === 'written')
    const redacted = r.results.filter((x) => x.status === 'redacted')
    const liveSkipped = r.results.filter((x) => x.status === 'live-skipped')
    const failed = r.results.filter((x) => x.status === 'failed')
    if (written.length === 0 && redacted.length === 0 && liveSkipped.length === 0 && failed.length === 0) return
    try { if (typeof compatHooks.afterPurge === 'function') compatHooks.afterPurge(written.map((x) => x.sid)) } catch { /* ignore */ }
    appendCompatLog(
      'true-delete[' + tag + '] written=' + written.length + ' liveSkipped=' + liveSkipped.length
        + ' failed=' + failed.length + ' pending=' + r.pending
        + (written.length > 0 ? ' ids=' + written.map((x) => x.sid.slice(0, 16) + '(' + x.events + '->' + x.after + ')').join(' ') : '')
        + (failed.length > 0 ? ' failedIds=' + failed.map((x) => x.sid.slice(0, 16)).join(' ') : ''),
      home,
    )
  }
  /* sinceMs=0 → 全量积压清理（把所有能映射的墓碑都处理掉）。
     钩子（目录变化）走增量：用台账里的 lastScanMs 只处理刚新增的。 */
  let inflight = false
  const run = (tag, options = {}) => {
    if (inflight) return   // 防重入：目录钩子/定时器/开机可能交叠，绝不并发写盘
    inflight = true
    Promise.resolve()
      /* purgeRegenerate 默认**开**（2026-10-11 用户要求「全部真删除、不准留墓碑」）：
         带 regeneration 的墓碑（删除并重新生成）此前默认跳过 → 墓碑永远留在文件里。
         轮次推导已改用 surfaceOp 反推（见 purge.js turnOfSeq），不再采信会漂移的
         summary.turn，因此整轮切不会误伤用户还活着的轮次。显式 config.purgeRegenerate=false 可关回。 */
      .then(() => purgeTombstones(ctx, { home, write: true, purgeRegenerate: config?.purgeRegenerate !== false, ...options }))
      .then((r) => summarise(tag, r))
      .catch((e) => appendCompatLog('true-delete[' + tag + '] FAILED: ' + String(e?.message ?? e).slice(0, 160), home))
      .finally(() => { inflight = false })
  }
  /* 开机黄金窗：越早越好。客户端一连上就会把上次的会话恢复成 live，而 live 会话不能
     整轮物理切除（内存/文件错位）→ 墓碑只能干等下次开机。2026-10-11 用户实证：
     原来只有 5s/30s，已经晚于客户端恢复，于是「重启也清不掉残留」。
     加两轮更早的（1.2s / 2.5s），赶在会话被激活之前把能清的清掉。 */
  const timers = []
  const on = readHealOptions(home)
  if (on.bootTrueDelete !== false) {
    for (const ms of [1200, 2500, 5000, 30000]) {
      const t = setTimeout(() => run('boot+' + (ms / 1000) + 's', { sinceMs: 0 }), ms)
      if (typeof t.unref === 'function') t.unref()
      timers.push(t)
    }
  } else {
    appendCompatLog('true-delete: 开机补清已关闭（设置页可开）')
  }
  /* 触发时机收敛：开机两次 + 会话目录变化后一次（见 rescanAndWarm 的钩子）。
     不再常驻轮询——用户明确要求「开机、下载后扫一下就差不多」。 */
  compatHooks.purge = () => run('hook')
  /* 真删除写过的会话，立刻补一次头：切除最容易把 system 头拔掉（旧版会顺手删光全部
     system/message，见 true-delete.js 的系统头级联）。定向补扫，不做全盘读。 */
  compatHooks.afterPurge = (ids) => {
    try { if (typeof compatHooks.headGuard === 'function' && ids !== undefined && ids.length > 0) compatHooks.headGuard(ids, true) } catch { /* ignore */ }
  }
  /* 台账非空 → 60s 定点重试：清完即停，只在有待清项时存在（非常驻轮询）。
     解决「开机时活体、窗口又错过 → 老墓碑永远等下次开机」的死角。 */
  const retryTimer = setInterval(() => {
    try {
      const l = readPendingLedger(home)
      if (l && l.pending && Object.keys(l.pending).length > 0) run('pending-retry', { sinceMs: 0, pendingOnly: true })
    } catch { /* ignore */ }
  }, 60000)
  if (typeof retryTimer.unref === 'function') retryTimer.unref()
  /* 会话被释放（关掉对话 / agent 结束）的那一刻定向补扫一次：
     这是**唯一**能安全做整轮物理切除的窗口——内存事件数组已经不在，文件改写不会错位。
     此前只有「开机 5s/30s + 60s 重试」，而重启后会话往往先被客户端自动恢复成 live，
     黄金窗被错过 → 老墓碑只能一直等。现在关掉对话即触发（1.5s 后，留给释放收尾）。 */
  try {
    ctx.effect(function* () {
      yield ctx.on('agent/disposed', (payload) => {
        const sid = String(payload?.agent?.session?.id ?? payload?.agent?.id ?? payload?.sessionId ?? '')
        if (!sid) return
        const t = setTimeout(() => run('disposed', { sinceMs: 0, only: sid }), 1500)
        if (typeof t.unref === 'function') t.unref()
      })
    }, `${PLUGIN_NAME}: true-delete on dispose`)
  } catch { /* 挂不上钩子不影响其它触发路径 */ }
  return { run, timers, retryTimer }
}

/** 受保护系统头守卫的备份目录名（$DSH_HOME 下）。 */
export const HEAD_GUARD_BACKUP_DIR = 'backup-head-guard'

/**
 * 受保护系统头守卫：给「缺受保护头」的会话补一条空 system/message 占位头。
 *
 * 为什么非补不可：宿主 agent-loop 的 SystemPromptProjection 在「表层没有 system 节点」
 * 时会把渲染好的系统提示词 append 成一条新的 system/message。若此刻表层非空、又没有
 * 受保护头，宿主落盘的就是一份再也读不回来的日志：
 *   system/message requires a protected first surface head
 * 缺头状态本身还能读（这是 excise 旧"头序自愈"删光 system 的依据），但它是个哑弹——
 * 下一次提示词变化（换模型/工具集/新会话系列）就炸。所以这里主动补头。
 *
 * 成本：默认先 probeProtectedHead 只解前几帧预筛（首个表面节点永远在最前面几帧里），
 * 只有确实缺头才整读整写；deep:true 时逐个整读 + verify，连「同段写了两遍导致 seq 断口」
 * 的下载/写盘事故也一并治（代价是整库读一遍，只在开机那一次做）。
 * live 会话绝不碰（内存事件数组与文件必须对齐）。
 * @param {object} ctx - cordis 上下文（只用于 live 判定）
 * @param {object} [options] - { home, write, only, backupDir, deep }
 */
export async function guardProtectedHeads(ctx, options = {}) {
  const home = options.home ?? dshHomeDir()
  const write = options.write === true
  const deep = options.deep === true
  const backupDir = options.backupDir ?? `${home}/${HEAD_GUARD_BACKUP_DIR}`
  const only = options.only instanceof Set ? options.only : undefined
  /* [D线 2026-10-24] 指纹缓存：同 (size,mtime) 的会话两轮浅扫/深扫都跳过。
     缓存落盘（head-guard-fingerprints.json），重启也在；守卫写过盘或会话被
     外部改动（mtime 变）都会自然失效。指纹不匹配就照旧全流程——宁可多扫
     也绝不漏扫。hook 定向补扫（only 给了明确 id 集合）不走缓存，保证真删除
     后的补扫永远新鲜。 */
  const fpFile = `${home}/storages/head-guard-fingerprints.json`
  const useCache = only === undefined
  let fingerprints = {}
  if (useCache) {
    try { fingerprints = JSON.parse(readFileSync(fpFile, 'utf8')) } catch { /* 首次无缓存 */ }
  }
  const fpOf = (entry) => {
    try { const st = statSync(entry.file); return `${st.size}:${st.mtimeMs}` } catch { return null }
  }
  const out = { write, deep, scanned: 0, headless: 0, written: 0, liveSkipped: 0, failed: 0, deduped: 0, cachedSkipped: 0, results: [] }
  const dirtyFingerprints = {}
  for (const entry of listSessionFiles(home)) {
    if (only !== undefined && !only.has(entry.id)) continue
    out.scanned += 1
    if (isSessionLive(ctx, entry.id)) { out.liveSkipped += 1; continue }
    const fp = fpOf(entry)
    if (useCache && deep && fp !== null && fingerprints[entry.id] === fp) {
      out.cachedSkipped += 1
      dirtyFingerprints[entry.id] = fp /* 原样续期：写回时保留 */
      continue
    }
    if (!deep) {
      let probe
      try {
        probe = probeProtectedHead(entry.file)
      } catch {
        probe = undefined
      }
      if (probe === undefined || probe.ok) {
        /* 浅扫通过 → 记指纹：深扫若在浅扫之后跑且文件没再变，可整条跳过。 */
        if (useCache && fp !== null) dirtyFingerprints[entry.id] = fp
        continue
      }
      out.headless += 1
    }
    const result = guardSessionFile(entry.file, { write, backupDir, deep })
    if (result.status === 'clean') {
      if (useCache && fp !== null) dirtyFingerprints[entry.id] = fp
      continue
    }
    if (result.status === 'unreadable') { out.failed += 1; out.results.push({ id: entry.id, ...result }); continue }
    if (result.diagnosis !== undefined) out.headless += 1
    if (result.deduped !== undefined) out.deduped += 1
    out.results.push({ id: entry.id, ...result })
    if (result.status === 'written') {
      out.written += 1
      /* 写过盘 → 文件已变，重取新指纹（下次深扫跳过，本次改动闭环）。 */
      if (useCache) { const nf = fpOf(entry); if (nf !== null) dirtyFingerprints[entry.id] = nf }
    } else if (result.status !== 'planned') out.failed += 1
  }
  if (useCache) {
    try {
      /* storages 目录一定存在（宿主启动即建）；dirname 未 import，这里用
         正则剥文件名（writeJsonAtomic 同款思路），零新增依赖。 */
      mkdirSync(fpFile.replace(/[\\/][^\\/]*$/, ''), { recursive: true })
      writeFileSync(fpFile, JSON.stringify(dirtyFingerprints, null, 1))
    } catch { /* 缓存写失败不影响守卫结果 */ }
  }
  return out
}

/** 安装受保护头守卫：开机两次全扫 + 真删除写盘后定向补扫。 */
export function installHeadGuard(ctx, config = {}) {
  if (config?.headGuard === false) return undefined
  const home = dshHomeDir()
  let inflight = false
  const run = (tag, options = {}) => {
    if (inflight) return // 防重入：守卫写盘期间绝不并发
    inflight = true
    Promise.resolve()
      .then(() => guardProtectedHeads(ctx, { home, write: true, ...options }))
      .then((r) => {
        /* 开机那次一定留一行：否则「守卫在不在跑」只能靠猜（没伤病就一个字不打）。 */
        if (r.written === 0 && r.failed === 0 && options.deep !== true) return
        appendCompatLog(
          'head-guard[' + tag + '] scanned=' + r.scanned + ' written=' + r.written + ' headless=' + r.headless
            + ' deduped=' + r.deduped + ' liveSkipped=' + r.liveSkipped + ' failed=' + r.failed
            + (r.written > 0 ? ' ids=' + r.results.filter((x) => x.status === 'written').map((x) => String(x.id).slice(0, 16)).join(' ') : ''),
          home,
        )
        if (r.written > 0) ctx.logger?.info?.(`[adapter-compat] protected system head restored on ${r.written} session(s)`)
      })
      .catch((e) => appendCompatLog('head-guard[' + tag + '] FAILED: ' + String(e?.message ?? e).slice(0, 160), home))
      .finally(() => { inflight = false })
  }
  const timers = []
  /* 4s：便宜的缺头预筛全扫。45s：深扫一遍（整读 + verify），连下载/写盘留下的
     「同段两遍 → seq 断口」也治掉——这类伤不在前缀里，预筛看不见。 */
  /* 开机三窗口可用设置页「扫描与校准频率 → 开机头保护」关闭（2026-10-16 加）。 */
  const onHead = readHealOptions(home)
  if (onHead.bootHeadGuard !== false) {
  for (const ms of [4000, 25000]) {
    const t = setTimeout(() => run('boot+' + (ms / 1000) + 's'), ms)
    if (typeof t.unref === 'function') t.unref()
    timers.push(t)
  }
  {
    const t = setTimeout(() => run('boot-deep+45s', { deep: true }), 45000)
    if (typeof t.unref === 'function') t.unref()
    timers.push(t)
  }
  } else {
    appendCompatLog('head-guard: 开机扫描已关闭（设置页可开）')
  }
  compatHooks.headGuard = (ids, deep) => run('hook', { ...(ids === undefined ? {} : { only: ids instanceof Set ? ids : new Set(ids) }), ...(deep === true ? { deep: true } : {}) })
  return { run, timers }
}

/* Timeline 块索引孤儿清理（三插件零墓碑的第三条腿）：
   session-kit/easyrewrite 删掉整个会话后 session-blocks.db 里该会话的块还留着
   → 右栏永远显示墓碑。文件消失即索引孤儿——每次真删除扫描顺手清（幂等）。
   实证：手机端曾积 37 个孤儿（2026-10-09 手动清过），此前插件层无人清。 */
export function pruneBlockOrphans(home) {
  try {
    const dbPath = home + '/session-blocks.db'
    if (!existsSync(dbPath)) return 0
    const { DatabaseSync } = require('node:sqlite')
    const files = new Set(listSessionFiles(home).map((e) => e.id))
    const db = new DatabaseSync(dbPath)
    try {
      try { db.exec('PRAGMA journal_mode=WAL') } catch { /* ignore */ }
      const orphanIds = db.prepare('SELECT id FROM indexed_sessions').all().map((r) => r.id).filter((id) => !files.has(id))
      if (orphanIds.length === 0) return 0
      const run = (sql, args) => { try { db.prepare(sql).run(...args) } catch { /* 表可能不存在 */ } }
      for (const id of orphanIds) {
        // FTS 虚表须按 block_meta.fts_rowid 删（SQLite 标准删除法），先于 meta
        let ftsRows = []
        try { ftsRows = db.prepare('SELECT fts_rowid FROM block_meta WHERE session_id = ?').all(id).map((r) => r.fts_rowid) } catch {}
        for (let i = 0; i < ftsRows.length; i += 400) {
          const chunk = ftsRows.slice(i, i + 400)
          run(`DELETE FROM block_fts WHERE rowid IN (${chunk.map(() => '?').join(',')})`, chunk)
        }
        let blockIds = []
        try { blockIds = db.prepare('SELECT block_id FROM block_meta WHERE session_id = ?').all(id).map((r) => r.block_id) } catch {}
        for (let i = 0; i < blockIds.length; i += 400) {
          const chunk = blockIds.slice(i, i + 400)
          run(`DELETE FROM block_text WHERE block_id IN (${chunk.map(() => '?').join(',')})`, chunk)
        }
        run('DELETE FROM attribute WHERE session_id = ?', [id])
        run('DELETE FROM block_meta WHERE session_id = ?', [id])
        run('DELETE FROM indexed_sessions WHERE id = ?', [id])
      }
      try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run() } catch {}
      try {
        require('node:fs').appendFileSync(home + '/dsh-adapter-compat.log',
          new Date().toISOString() + ' block-orphans pruned: ' + orphanIds.length + ' 个已删会话的索引\n')
      } catch {}
      return orphanIds.length
    } finally { db.close() }
  } catch { return 0 }
}

/* ============ 第七层：会话改工作区（move-session） ===========
 *
 * 诉求：把一条会话从当前工作区挪到另一个工作区（例如把抢救来的对话搬回 Evelyn）。
 * 会话的可见性由三处联动决定，缺一不可：
 *   1. 文件目录名 = projectKey(header.cwd)（宿主编码：非 ASCII→~XXXX、':'剔除、'\'→'-'）；
 *   2. header.cwd 指向目标工作区路径；
 *   3. workspace.json 注册表把 id 放进目标工作区的 sessionIds。
 * 缺任何一处 = 会话在列表里凭空消失或出现在错误位置。
 *
 * 流程：活体守卫（live 拒动，防内存/文件错位）→ 改头帧 cwd（体帧原字节）→
 * 写入目标目录并读回校验 → 注册表迁移（备份 workspace.json）→ 删旧目录 →
 * 废弃投影（cwd 身份变化必须冷重建）→ sessions.refresh() 通知列表。
 *
 * 路由：POST /dsh-adapter-compat/move-session  {sessionId, target:<工作区标题>}
 * 关掉：config.moveSession === false。
 */

/** 宿主 projectKey 编码——与 dsh-session-persistence-jsonl:875 及 dsh-sync
 *  encodeWorkspaceDir 逐字符对齐（分隔符连跑折叠单 '-'、非安全字符 ~XXXX、
 *  去前导杠后 `--…--` 包边、251 截断）。冒烟基准：
 *  work\学习 → --C-Users-Evelyn-AppData-Local-DeepSeekHarness-.dsh-work-~5B66~4E60-- */
export function projectKeyOf(workspacePath) {
  const cwd = String(workspacePath)
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 帧扫描（zstd magic）。 */
function scanFramesZstd(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const idx = []
  let i = -1
  while ((i = buf.indexOf(magic, i + 1)) !== -1) idx.push(i)
  idx.push(buf.length)
  return idx
}

/**
 * 把一条会话挪到目标工作区（纯函数式主体，可独立测试）。
 * @param {object} options - {sessionId, targetTitle, home, workspaces（注册表数组快照）}
 *   workspaces: [{title, path, sessionIds}] 由调用方提供（读写 workspace.json 也在调用方），
 *   便于测试注入。返回 {from, to, file, newFile}，由调用方做注册表迁移与清理。
 * @returns {{fromTitle, toTitle, targetPath, targetDir, file, newFile, header}}
 */
export function planMoveSession(options) {
  const { sessionId, targetTitle, home = dshHomeDir(), workspaces } = options || {}
  if (typeof sessionId !== 'string' || !sessionId.startsWith('session-')) throw new Error('invalid-session-id')
  const target = (workspaces || []).find((w) => w?.title === targetTitle)
  if (!target) throw new Error(`target workspace not found: ${targetTitle}`)
  const from = (workspaces || []).find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId))
  const located = listSessionFiles(home).find((x) => x.id === sessionId)
  if (!located) throw new Error('session file not found')
  const b = readFileSync(located.file)
  const idx = scanFramesZstd(b)
  if (idx.length < 2) throw new Error('session log has no complete frame')
  const header = JSON.parse(zstdDecompressSync(b.subarray(0, idx[1])).toString('utf8'))
  if (header.id !== sessionId) throw new Error('header id mismatch')
  const targetPath = target.path
  const key = projectKeyOf(targetPath)
  const targetDir = `${home}/sessions/${key}/${sessionId}`
  const newFile = `${targetDir}/session.v4.jsonl.zstd`
  // 重写头帧（体帧原字节保留，cwd 是唯一变化）
  header.cwd = targetPath
  const newHeader = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), {
    params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 },
  })
  const movedBuf = Buffer.concat([newHeader, b.subarray(idx[1])])
  return {
    fromTitle: from?.title ?? '(未注册)',
    toTitle: target.title,
    targetPath,
    targetDir,
    file: located.file,
    movedBuf,
    header,
  }
}

/**
 * 执行搬家：文件 → 注册表 → 清理（全部成功才返回 ok）。
 * @param {object} ctx - cordis 上下文。
 * @param {object} options - {sessionId, targetTitle, home}
 */
export async function moveSessionToWorkspace(ctx, options = {}) {
  const home = options.home ?? dshHomeDir()
  const { sessionId } = options || {}
  /* 字段名兼容：三个客户端发送点（session-kit 批量面板 / 会话菜单、本插件搬家面板）
     发的都是 `target`，而这里一直只解构 `targetTitle` → undefined →
     planMoveSession 抛 "target workspace not found: undefined"，界面显示「工作区未定义」。
     2026-10-11：两个名字都收，值都是工作区**标题**（客户端取自 workspace.title）。 */
  const targetTitle = options?.targetTitle ?? options?.target
  const wsPath = `${home}/storages/workspace.json`
  if (!existsSync(wsPath)) throw new Error('workspace.json not found')
  // 活体守卫：live 会话挪家会让内存 cwd/文件路径错位
  if (isSessionLive(ctx, sessionId)) throw Object.assign(new Error('session is live'), { code: 'SESSION_LIVE' })
  const doc = JSON.parse(readFileSync(wsPath, 'utf8'))
  const workspaces = Object.values(doc?.tables?.workspaces ?? {})
  const plan = planMoveSession({ sessionId, targetTitle, home, workspaces })
  plan.srcDir = plan.file.replace(/\/session\.v4\.jsonl\.zstd$/, '')
  plan.sameDir = plan.srcDir === plan.targetDir
  return await finishMove(ctx, { plan, doc, wsPath, sessionId, home })
}

/** 实际写盘 + 注册表迁移 + 清理。 */
async function finishMove(ctx, { plan, doc, wsPath, sessionId, home }) {
  // 1) 写目标（同目录=已在目标，跳过文件动作，只对齐注册表）
  if (!plan.sameDir) {
    try { rmSync(plan.targetDir, { recursive: true, force: true }) } catch { /* ignore */ }
    mkdirSync(plan.targetDir, { recursive: true })
    writeFileSync(`${plan.targetDir}/session.v4.jsonl.zstd`, plan.movedBuf)
    const back = readFileSync(`${plan.targetDir}/session.v4.jsonl.zstd`)
    const bidx = scanFramesZstd(back)
    if (bidx.length < 2) throw new Error('verify failed: no frame')
    const hdr2 = JSON.parse(zstdDecompressSync(back.subarray(0, bidx[1])).toString('utf8'))
    if (hdr2.id !== sessionId || hdr2.cwd !== plan.targetPath) {
      try { rmSync(plan.targetDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new Error('verify failed after write')
    }
  }
  // 2) 注册表迁移（带备份）
  copyFileSync(wsPath, `${wsPath}.bak-move`)
  let from = plan.fromTitle
  for (const w of Object.values(doc.tables.workspaces)) {
    if (Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId)) {
      w.sessionIds = w.sessionIds.filter((x) => x !== sessionId)
      from = w.title
    }
  }
  const target = Object.values(doc.tables.workspaces).find((w) => w.title === plan.toTitle)
  if (!target) throw new Error('target workspace vanished')
  if (!target.sessionIds.includes(sessionId)) target.sessionIds.unshift(sessionId)
  target.updatedAt = new Date().toISOString()
  writeFileSync(wsPath, JSON.stringify(doc, null, 2))
  // 3) 删旧目录（仅当确实跨目录）
  if (!plan.sameDir) {
    try { rmSync(plan.srcDir, { recursive: true, force: true }) } catch { /* 源删失败不致命：注册表已迁，最多留孤目录 */ }
  }
  // 4) 废弃投影（cwd 身份变化必须冷重建）
  try { rmSync(`${home}/storages/session_projcache/sessions/${sessionId}.json`, { force: true }) } catch { /* ignore */ }
  // 5) 通知列表
  let refreshed = false
  try {
    const sessions = serviceOf(ctx, 'sessions')
    if (typeof sessions?.refresh === 'function') { await sessions.refresh(); refreshed = true }
  } catch { /* 列表刷新失败：文件与注册表已就位 */ }
  appendCompatLog(`move-session ${sessionId.slice(0, 18)}: ${from} -> ${plan.toTitle} (sameDir=${plan.sameDir}, refreshed=${refreshed})`)
  return { ok: true, from, to: plan.toTitle, sameDir: plan.sameDir, refreshed }
}

/** 注册 move 路由（POST JSON）。 */
export function installMoveRoute(ctx, config = {}) {
  if (config?.moveSession === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') return false
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/move-session',
      handler: async (req, res) => {
        const reply = (status, obj) => {
          try {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') return reply(405, { ok: false, error: 'method-not-allowed' })
        let body = ''
        try {
          for await (const chunk of req) {
            body += chunk
            if (body.length > 65536) throw new Error('body too large')
          }
          const parsed = JSON.parse(body || '{}')
          const result = await moveSessionToWorkspace(ctx, parsed)
          appendCompatLog(`move-session route ok: ${JSON.stringify(result).slice(0, 200)}`)
          return reply(200, result)
        } catch (error) {
          const msg = String(error?.message ?? error)
          const code = error?.code === 'SESSION_LIVE' ? 409 : /not found/i.test(msg) ? 404 : 400
          appendCompatLog(`move-session route FAILED(${code}): ${msg.slice(0, 200)}`)
          return reply(code, { ok: false, error: msg })
        }
      },
    })
    appendCompatLog('move-session route registered')
    return true
  } catch {
    return false
  }
}

/**
 * 瘦身一个会话：定位 → live 判定 → 瘦身 → verify → 备份 → 写 → 读回复核 → 清 projcache → 刷新。
 * live 会话拒写（内存事件数组与文件错位，下次 flush 把原文写回 + seq 错乱）——照 session-kit
 * repairCurrentSession 的权威范式：409 让用户切走再操作。
 * @param {object} ctx - cordis 上下文（只用于 live 判定与列表刷新）。
 * @param {string} sessionId - 目标会话 id。
 * @param {{write?:boolean, home?:string, keepTurns?:number, digest?:boolean}} options
 *   write:true 才落盘（默认干跑）；keepTurns/digest 透传 slimSession（A线 2026-10-24）。
 */
export async function slimSessionFile(ctx, sessionId, options = {}) {
  const home = options.home ?? dshHomeDir()
  const write = options.write === true
  const located = listSessionFiles(home).find((x) => x.id === sessionId)
  if (!located) throw Object.assign(new Error('session file not found'), { code: 'NOT_FOUND' })
  if (isSessionLive(ctx, sessionId)) {
    throw Object.assign(new Error('session is open in the host; switch to another conversation first'), { code: 'SESSION_LIVE' })
  }
  const r = slimSession(located.file, { keepTurns: options.keepTurns, digest: options.digest })
  if (!r.ok) {
    throw Object.assign(new Error('slim verify failed: ' + (r.problems?.[0] ?? '')), { code: 'VERIFY_FAILED', problems: r.problems })
  }
  const result = { ok: true, write, id: sessionId, before: r.before, after: r.after, saved: r.saved, events: r.events, keptTurns: r.keptTurns ?? 0 }
  if (!write) return result
  // 备份（独立目录，别和真删除墓碑清理的备份混一起）
  const backupDir = home + '/' + TRUE_DELETE_BACKUP_DIR + '-slim'
  let backupPath = null
  try { mkdirSync(backupDir, { recursive: true }); backupPath = backupDir + '/' + sessionId + '.jsonl.zstd'; copyFileSync(located.file, backupPath); result.backup = true } catch { result.backup = false }
  // 写 + 读回复核（不过就回滚）
  writeSession(located.file, r.header, r.slimmed)
  const back = readSession(located.file)
  const v2 = verifySessionEvents(back.header, back.events)
  if (!v2.ok) {
    try { if (backupPath) copyFileSync(backupPath, located.file) } catch { /* 尽力回滚 */ }
    throw Object.assign(new Error('post-write verify failed; rolled back'), { code: 'VERIFY_FAILED' })
  }
  // 内容变了 → 投影要冷重建
  try { rmSync(home + '/storages/session_projcache/sessions/' + sessionId + '.json', { force: true }) } catch { /* ignore */ }
  // 刷新列表
  try { const sessions = serviceOf(ctx, 'sessions'); if (typeof sessions?.refresh === 'function') await sessions.refresh() } catch { /* ignore */ }
  try { result.bytes = statSync(located.file).size } catch { /* ignore */ }
  appendCompatLog(`slim ${sessionId.slice(0, 18)}: ${r.before} -> ${r.after} (saved ${r.saved}, events ${r.events})`)
  return result
}

/** 列出会话供瘦身面板挑选：照桌面 UI 的结构与顺序分组（工作区→会话），带标题与体积。
 *  顺序取 workspace.json 的 global.workspaceIds（工作区）与 sessionIds（会话），与侧边栏一致。 */
export function slimListSessions(home = dshHomeDir()) {
  // id -> {file, sizeBytes}
  const fileById = new Map()
  for (const entry of listSessionFiles(home)) {
    let size = 0
    try { size = statSync(entry.file).size } catch { /* ignore */ }
    fileById.set(entry.id, { file: entry.file, sizeBytes: size })
  }
  const readTitle = (id) => {
    try {
      const pc = JSON.parse(readFileSync(home + '/storages/session_projcache/sessions/' + id + '.json', 'utf8'))
      // projcache 真实结构：record.rows.title = {ver, seq, val}，正文在 .val
      const t = pc?.record?.rows?.title
      if (typeof t === 'string' && t) return t
      if (t && typeof t === 'object' && typeof t.val === 'string' && t.val) return t.val
      return null
    } catch { return null }
  }
  let doc = null
  try { doc = JSON.parse(readFileSync(home + '/storages/workspace.json', 'utf8')) } catch { /* ignore */ }
  const table = doc?.tables?.workspaces
  const wsIds = Array.isArray(doc?.global?.workspaceIds) ? doc.global.workspaceIds : []
  const groups = []
  const seenIds = new Set()
  const pushWs = (id) => {
    const w = table?.[id]
    if (!w || typeof w !== 'object') return
    const sessions = []
    for (const sid of (Array.isArray(w.sessionIds) ? w.sessionIds : [])) {
      const f = fileById.get(sid)
      if (!f) continue
      seenIds.add(sid)
      sessions.push({ id: sid, title: readTitle(sid), sizeBytes: f.sizeBytes })
    }
    if (sessions.length) groups.push({ workspaceTitle: w.title ?? '(未命名)', workspacePath: w.path ?? '', sessions })
  }
  for (const id of wsIds) pushWs(id)
  // 表里有、但不在 workspaceIds 的悬空工作区也带上
  for (const id of Object.keys(table ?? {})) if (!wsIds.includes(id)) pushWs(id)
  // 完全没被 workspace.json 覆盖的孤儿会话兜底（避免漏）
  const orphans = []
  for (const [sid, f] of fileById) {
    if (seenIds.has(sid)) continue
    orphans.push({ id: sid, title: readTitle(sid), sizeBytes: f.sizeBytes })
  }
  if (orphans.length) groups.push({ workspaceTitle: '(未分组)', workspacePath: '', sessions: orphans })
  return groups
}

/** 注册瘦身路由（POST JSON {sessionId, write}）+ 瘦身列表路由（GET）。 */
export function installSlimRoute(ctx, config = {}) {
  if (config?.slimSession === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') {
      appendCompatLog('slim route: webServer unavailable (web=' + typeof web + ', register=' + typeof web?.register + ')')
      return false
    }
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/slim',
      handler: async (req, res) => {
        const reply = (status, obj) => {
          try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
        }
        if (req.method !== 'POST') return reply(405, { ok: false, error: 'method-not-allowed' })
        let body = ''
        try {
          for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('body too large') }
          const parsed = JSON.parse(body || '{}')
          if (typeof parsed?.sessionId !== 'string' || !parsed.sessionId) return reply(400, { ok: false, error: 'sessionId required' })
          const result = await slimSessionFile(ctx, parsed.sessionId, { write: parsed.write === true })
          appendCompatLog(`slim route ok: ${JSON.stringify(result).slice(0, 200)}`)
          return reply(200, result)
        } catch (error) {
          const msg = String(error?.message ?? error)
          const code = error?.code === 'SESSION_LIVE' ? 409 : error?.code === 'NOT_FOUND' ? 404 : 400
          appendCompatLog(`slim route FAILED(${code}): ${msg.slice(0, 200)}`)
          return reply(code, { ok: false, error: msg, problems: error?.problems })
        }
      },
    })
    appendCompatLog('slim route registered')
    // 瘦身列表（GET）：供设置页面板挑选会话
    try {
      web.register({
        kind: 'exact',
        path: '/dsh-adapter-compat/slim-list',
        handler: async (req, res) => {
          const reply = (status, obj) => {
            try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
          }
          if (req.method !== 'GET') return reply(405, { ok: false, error: 'method-not-allowed' })
          try { return reply(200, { ok: true, value: slimListSessions() }) }
          catch (e) { return reply(500, { ok: false, error: String(e?.message ?? e) }) }
        },
      })
      appendCompatLog('slim-list route registered')
    } catch { /* 列表路由失败不影响瘦身路由 */ }
    /* A线（2026-10-24）：自动瘦身选项读写。GET 拿当前四项；POST 改并落盘。
       独立文件 adapter-compat-slim.json——与 heal-options 解耦，互不污染。 */
    try {
      web.register({
        kind: 'exact',
        path: '/dsh-adapter-compat/slim-options',
        handler: async (req, res) => {
          const reply = (status, obj) => {
            try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
          }
          if (req.method === 'GET') return reply(200, { ok: true, options: readSlimOptions() })
          if (req.method !== 'POST') return reply(405, { ok: false, error: 'method-not-allowed' })
          let raw = ''
          try {
            for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('body too large') }
            const parsed = JSON.parse(raw || '{}')
            const next = applySlimPatch(parsed)
            if (next.error) return reply(400, { ok: false, error: next.error })
            appendCompatLog(`slim-options saved: ${JSON.stringify(next.value)}`)
            return reply(200, { ok: true, options: next.value })
          } catch (e) { return reply(400, { ok: false, error: String(e?.message ?? e) }) }
        },
      })
      appendCompatLog('slim-options route registered')
    } catch { /* 选项路由失败不影响手动瘦身 */ }
    return true
  } catch (e) {
    appendCompatLog('slim route FAILED: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
}

/* ── A线：自动瘦身选项（2026-10-24）──────────────────────────
   用户定案：默认关 + 保留最近 N 轮可调 + 摘要占位。独立开关——关掉时
   开机完全零成本（连定时器都不挂）；开启时也只动「非 live 且超过事件阈值」
   的会话，逐个走 slimSessionFile 的全套门禁（verify/备份/回滚/projcache）。 */
const SLIM_OPTIONS_FILE = 'adapter-compat-slim.json'
const SLIM_DEFAULTS = { autoSlim: false, keepTurns: 10, digest: true, minEvents: 2000 }

export function readSlimOptions(home = dshHomeDir()) {
  try {
    const raw = JSON.parse(readFileSync(home + '/' + SLIM_OPTIONS_FILE, 'utf8'))
    return {
      autoSlim: raw.autoSlim === true,
      keepTurns: Number.isFinite(raw.keepTurns) && raw.keepTurns >= 0 ? Math.floor(raw.keepTurns) : SLIM_DEFAULTS.keepTurns,
      digest: raw.digest !== false,
      minEvents: Number.isFinite(raw.minEvents) && raw.minEvents >= 100 ? Math.floor(raw.minEvents) : SLIM_DEFAULTS.minEvents,
    }
  } catch {
    return { ...SLIM_DEFAULTS }
  }
}

function applySlimPatch(patch) {
  const next = readSlimOptions()
  const errors = []
  if (patch?.autoSlim !== undefined) {
    if (typeof patch.autoSlim !== 'boolean') errors.push('autoSlim 应为布尔')
    else next.autoSlim = patch.autoSlim
  }
  if (patch?.keepTurns !== undefined) {
    const n = Number(patch.keepTurns)
    if (!Number.isFinite(n) || n < 0 || n > 500) errors.push('keepTurns 应为 0~500')
    else next.keepTurns = Math.floor(n)
  }
  if (patch?.digest !== undefined) {
    if (typeof patch.digest !== 'boolean') errors.push('digest 应为布尔')
    else next.digest = patch.digest
  }
  if (patch?.minEvents !== undefined) {
    const n = Number(patch.minEvents)
    if (!Number.isFinite(n) || n < 100 || n > 100000) errors.push('minEvents 应为 100~100000')
    else next.minEvents = Math.floor(n)
  }
  if (errors.length > 0) return { error: errors.join('；') }
  try { writeFileSync(dshHomeDir() + '/' + SLIM_OPTIONS_FILE, JSON.stringify(next, null, 1), 'utf8') } catch (e) {
    return { error: '写入失败: ' + String(e?.message ?? e) }
  }
  return { value: next }
}

/**
 * A线：开机自动瘦身（用户开了 autoSlim 才挂；默认关 = 零成本）。
 * 规则：只动「非 live 且事件数 ≥ minEvents」的会话，keepTurns/digest 从设置读；
 * 逐个走 slimSessionFile 全套门禁（verify/备份/写后复核），单个失败不影响其余。
 */
export function installAutoSlim(ctx) {
  const opts = readSlimOptions()
  if (opts.autoSlim !== true) return undefined
  const t = setTimeout(async () => {
    try {
      const home = dshHomeDir()
      const done = []
      for (const entry of listSessionFiles(home)) {
        try {
          /* 便宜预筛：文件太小没必要动（<1MB 压缩后约 < 2k 事件），省一次整读。 */
          const st = statSync(entry.file)
          if (st.size < 1024 * 1024) continue
          const r = await slimSessionFile(ctx, entry.id, { write: true, keepTurns: opts.keepTurns, digest: opts.digest })
          if (r.saved > 0) done.push({ id: entry.id, saved: r.saved })
        } catch (e) {
          const code = e?.code
          if (code === 'SESSION_LIVE' || code === 'NOT_FOUND') continue
          appendCompatLog(`auto-slim ${entry.id.slice(0, 18)} failed: ` + String(e?.message ?? e).slice(0, 120))
        }
      }
      if (done.length > 0) appendCompatLog(`auto-slim: ${done.length} 个会话瘦身，共省 ${done.reduce((a, b) => a + b.saved, 0)} 字符`)
    } catch (e) {
      appendCompatLog('auto-slim run FAILED: ' + String(e?.message ?? e).slice(0, 160))
    }
  }, 90 * 1000) /* 90s：避开启动高峰（head-guard 4/25/45s 都在前面跑完） */
  if (typeof t.unref === 'function') t.unref()
  return t
}

/* ============ 第八层：断号修复（seq-gap repair） ===========
 *
 * 症状（2026-10-12 session-790e9a59 实证）：强退丢掉一次未落盘的追加批次，
 * 重启后宿主按内存续写 → 文件中间 seq 断号，历史加载报
 * "complete frame contains a torn JSONL record"（误导文案，实际不是 zstd 撕裂）。
 * 宿主自愈只覆盖尾部撕裂，中间断号只能靠本层补行。
 *
 * 流程照 slimSessionFile 的权威范式：定位 → live 拒写(409) → 读 → 按上下文补行
 * （repair.js，只认 tool/call 后缺 result/step-end 两种可确定推断的形态）→ verify
 * 全绿 → 备份 → 写 → 读回复核（不过回滚）→ 清 projcache → 刷新列表。
 * 干跑（write:false）只报告不落盘；无法识别的断号形态一律报告不动手。
 *
 * 关掉：cordis.patch.yml 本插件行 config.repairSession: false。
 */

/**
 * 检查/修复一个会话的 seq 断号。
 * @param {object} ctx - cordis 上下文（live 判定 + 修复后刷新列表）。
 * @param {string} sessionId - 目标会话 id。
 * @param {{write?:boolean, home?:string}} options - write:true 才落盘（默认干跑）。
 */
export async function repairSessionFile(ctx, sessionId, options = {}) {
  const home = options.home ?? dshHomeDir()
  const write = options.write === true
  const located = listSessionFiles(home).find((x) => x.id === sessionId)
  if (!located) throw Object.assign(new Error('session file not found'), { code: 'NOT_FOUND' })
  if (isSessionLive(ctx, sessionId)) {
    throw Object.assign(new Error('session is open in the host; switch to another conversation first'), { code: 'SESSION_LIVE' })
  }
  const scan = scanFile(located.file)
  if (scan.error) throw Object.assign(new Error('session unreadable: ' + scan.error), { code: 'READ_FAILED' })
  /* 三步走：① 工具孤儿修复（空 content 从幸存 stream 重组，2026-10-23 新增，
     session-f3bc4fd2 实证伤型：真删除把 content 清空、stream 幸存 → 108 个 tool/call
     变「无宣告孤儿」→ 宿主拒载）
     ② 结构字段自愈（白名单式擦除吃掉的必填标量 / 失效的 headerSeq）
     ③ seq 断号补行。后一步在前一步的结果上做，三者共用同一条 verify 门。 */
  const orphanFix = healToolOrphans(scan.events)
  const eventsAfterOrphans = orphanFix.events ?? scan.events
  const heal = healStructure(scan.header, eventsAfterOrphans)
  const plan = repairEvents(scan.header, heal.events)
  const base = {
    ok: plan.ok,
    write,
    id: sessionId,
    gaps: plan.gaps.map(describeGap),
    gapDetails: plan.gaps,
    warnings: scan.warnings,
    unsupported: plan.unsupported,
    wouldInsert: plan.inserted.length,
    orphanHealed: orphanFix.healed,
    orphanUnrepairable: orphanFix.unrepairable,
    healed: heal.healed,
    wouldHeal: heal.healed.length,
    healProblems: heal.problems,
    verifyProblems: plan.problems,
  }
  /* 「只有孤儿伤、没有断号伤」：plan.ok 会是 alreadyHealthy=true，gaps 空——这条路径合法。 */
  const orphanHealthy = orphanFix.healed.length === 0
  if (plan.alreadyHealthy && heal.healed.length === 0 && orphanHealthy) return { ...base, ok: true, alreadyHealthy: true, wouldInsert: 0 }
  if (!plan.ok) {
    throw Object.assign(new Error('repair plan rejected: ' + (plan.problems[0] ?? 'unsupported gap shape')), { code: 'PLAN_REJECTED', plan: base })
  }
  /* 孤儿修复路径：plan.fixed 为 undefined（没有断号要补）——用 heal.events（含重组结果）。 */
  const finalEvents = plan.fixed ?? heal.events
  /* 落盘前先验：补出来的结构字段必须真的让宿主校验全绿，否则宁可不修。 */
  const v0 = verifySessionEvents(scan.header, finalEvents)
  if (!v0.ok) {
    throw Object.assign(new Error('healed log still fails verify: ' + (v0.problems[0] ?? 'unknown')), {
      code: 'PLAN_REJECTED',
      plan: { ...base, ok: false, verifyProblems: (v0.problems ?? []).slice(0, 8) },
    })
  }
  if (!write) return { ...base, ok: true }

  // 备份失败就拒写：修复是可选项，不值得冒没备份的险
  const backupDir = home + '/' + TRUE_DELETE_BACKUP_DIR + '-repair'
  let backupPath = null
  try {
    mkdirSync(backupDir, { recursive: true })
    backupPath = backupDir + '/' + sessionId + '.jsonl.zstd'
    copyFileSync(located.file, backupPath)
  } catch { backupPath = null }
  if (!backupPath) throw Object.assign(new Error('backup failed; refusing to write'), { code: 'BACKUP_FAILED' })

  writeSession(located.file, scan.header, finalEvents)
  const back = readSession(located.file)
  const v2 = verifySessionEvents(back.header, back.events)
  if (!v2.ok) {
    try { copyFileSync(backupPath, located.file) } catch { /* 尽力回滚 */ }
    throw Object.assign(new Error('post-write verify failed; rolled back'), { code: 'VERIFY_FAILED', problems: v2.problems })
  }
  const result = { ...base, ok: true, inserted: plan.inserted.length, healedCount: heal.healed.length, backup: true }
  // 内容变了 → 投影要冷重建
  try { rmSync(home + '/storages/session_projcache/sessions/' + sessionId + '.json', { force: true }) } catch { /* ignore */ }
  try { const sessions = serviceOf(ctx, 'sessions'); if (typeof sessions?.refresh === 'function') await sessions.refresh() } catch { /* ignore */ }
  try { result.bytes = statSync(located.file).size } catch { /* ignore */ }
  appendCompatLog(`repair ${sessionId.slice(0, 18)}: gaps=${plan.gaps.length} inserted=${plan.inserted.length} healed=${heal.healed.length}`)
  return result
}

/**
 * 全盘扫描（只读巡检）：列出所有断号会话与不可读会话。
 * @param {string} [home]
 * @returns {{ok:boolean, scanned:number, healthy:number, bad:object[], warned:object[], unreadable:object[]}}
 */
export function repairScanAll(home = dshHomeDir()) {
  const out = { ok: true, scanned: 0, healthy: 0, bad: [], warned: [], unreadable: [] }
  for (const entry of listSessionFiles(home)) {
    out.scanned += 1
    try {
      const scan = scanFile(entry.file)
      if (scan.error) { out.unreadable.push({ id: entry.id, error: scan.error }); out.ok = false; continue }
      /* 工具孤儿巡检（2026-10-23 新增）：无 seq 断号、无结构伤，但 content 被清空
         → tool/call 全变孤儿 → 宿主拒载。这种伤 verify 报「没有对应的 tool 生命周期」。 */
      const orphanScan = scanToolOrphans(scan.events)
      const structHeal = healStructure(scan.header, scan.events)
      const orphanFix = healToolOrphans(scan.events)
      if (scan.gaps.length > 0) {
        const plan = repairEvents(scan.header, structHeal.events)
        out.bad.push({
          id: entry.id,
          gaps: scan.gaps.map(describeGap),
          gapDetails: scan.gaps,
          warnings: scan.warnings,
          repairable: plan.ok,
          unsupported: plan.unsupported,
          healed: structHeal.healed,
          healProblems: structHeal.problems,
          orphan: orphanScan.orphans > 0 ? { count: orphanScan.orphans, emptyAssistant: orphanScan.emptyAssistant, repairable: orphanFix.events !== null } : null,
        })
        out.ok = false
      } else if (structHeal.healed.length > 0 || structHeal.problems.length > 0) {
        const v = verifySessionEvents(scan.header, structHeal.events)
        out.bad.push({
          id: entry.id,
          gaps: [],
          warnings: scan.warnings,
          repairable: v.ok,
          unsupported: [],
          healed: structHeal.healed,
          healProblems: structHeal.problems,
          verifyProblems: (v.problems ?? []).slice(0, 8),
          orphan: orphanScan.orphans > 0 ? { count: orphanScan.orphans, emptyAssistant: orphanScan.emptyAssistant, repairable: orphanFix.events !== null } : null,
        })
        out.ok = false
      } else if (orphanScan.orphans > 0) {
        /* 只有孤儿伤：单列一类（orphanRepairable 标明重组能不能救）。 */
        out.bad.push({
          id: entry.id,
          gaps: [],
          warnings: scan.warnings,
          repairable: orphanFix.events !== null,
          unsupported: [],
          healed: [],
          healProblems: [],
          orphan: { count: orphanScan.orphans, emptyAssistant: orphanScan.emptyAssistant, repairable: orphanFix.events !== null, unrepairable: orphanFix.unrepairable.slice(0, 5) },
        })
        out.ok = false
      } else {
        out.healthy += 1
        if (scan.warnings.length > 0) out.warned.push({ id: entry.id, warnings: scan.warnings })
      }
    } catch (error) {
      out.unreadable.push({ id: entry.id, error: String(error?.message ?? error) })
      out.ok = false
    }
  }
  return out
}

/**
 * 文本层根治（2026-10-13）：把某会话盘上「正文全空的 tool 结果」修成 [内容已清除]。
 *
 * 设计取舍（用户明确要求「不要频繁扫盘吃内存」）：
 *   - **不做定时器、不做启动全盘扫** —— 出口守卫（wire-guard v3）在发送前逐请求兜底，
 *     纯内存零磁盘 IO，实时流量已安全；
 *   - 本函数只在**手动路由**（POST heal-tools）触发时跑一次，修完即止；
 *     历史残缺是有限的（首次修复后新增极少），一次性清理足够。
 *   - 只改 message.content，meta 留档/isError/id/source 原样保留。
 *
 * 门禁与 repairSessionFile 同规格：live 拒动 → 备份失败拒写 → verify 全绿才落盘
 * → 回读复核不过回滚 → 清 projcache + refresh。
 */
export async function healSessionFile(ctx, sessionId, options = {}) {
  const home = options.home ?? dshHomeDir()
  const write = options.write === true
  const located = listSessionFiles(home).find((x) => x.id === sessionId)
  if (!located) throw Object.assign(new Error('session file not found'), { code: 'NOT_FOUND' })
  if (isSessionLive(ctx, sessionId)) {
    throw Object.assign(new Error('session is open in the host; switch to another conversation first'), { code: 'SESSION_LIVE' })
  }
  const scan = scanFile(located.file)
  if (scan.error) throw Object.assign(new Error('session unreadable: ' + scan.error), { code: 'READ_FAILED' })
  /* 门禁（2026-10-14 用户实证）：readSession 会**静默跳行/跳帧**——
     帧解压失败丢整帧（true-delete.js L261 `catch{warnings.push(...); continue}`）、
     单行 JSON 坏丢该行（L293-295）。heal 是「读进来→写回去」，被跳的行写不回去，
     缺行就此固化（实测：同一会话两次 heal 后缺行位置不同：00:11 缺 2314-2328、
     02:14 缺 2509-2518）；而 true-delete 的 verify 没有 seq 连续性检查，写回照过。
     修法与 purgeSessionFile 同款：有跳行警告直接拒写，seq 断口/settlement 也不放行。 */
  if (Array.isArray(scan.warnings) && scan.warnings.length > 0) {
    throw Object.assign(
      new Error('文件有无法解析的帧/行（readSession 会跳过它们，写回会造成缺行），拒绝修复：' + scan.warnings[0]),
      { code: 'READ_WARNINGS', warnings: scan.warnings })
  }
  const dense = assertRowsDense(scan.events)
  if (!dense.ok) {
    throw Object.assign(
      new Error('输入文件 seq 断口或 settlement 不全，拒绝动它（防扩散）：' + dense.problems[0]),
      { code: 'INPUT_DENSE_FAILED', problems: dense.problems })
  }
  const plan = healBlankToolResults(scan.events)
  /* 失效附件（2026-10-17）：结构完好但字节不在盘上的 image/file 引用 → 占位。
     和空 tool 结果一起修，理由相同：盘上的坏引用会在下一次压缩/分叉/换路由时
     重新变成整轮拒收（官方 DeepSeek 走 readImageRequest → ENOENT）。 */
  const attPlan = healDeadAttachments(plan.events, { attachments: attachmentsService(ctx), home })
  const healedEvents = attPlan.events
  const alreadyHealthy = plan.alreadyHealthy && attPlan.alreadyHealthy
  const base = {
    ok: true, write, id: sessionId,
    alreadyHealthy,
    wouldHeal: plan.healed.length + attPlan.healed.length,
    healed: plan.healed.slice(0, 20),
    deadAttachments: attPlan.healed.slice(0, 20),
    wouldHealAttachments: attPlan.healed.length,
    warnings: scan.warnings,
  }
  if (alreadyHealthy) return { ...base }
  if (!write) return base

  const backupDir = home + '/' + TRUE_DELETE_BACKUP_DIR + '-heal'
  let backupPath = null
  try {
    mkdirSync(backupDir, { recursive: true })
    backupPath = backupDir + '/' + sessionId + '.jsonl.zstd'
    copyFileSync(located.file, backupPath)
  } catch { backupPath = null }
  if (!backupPath) throw Object.assign(new Error('backup failed; refusing to write'), { code: 'BACKUP_FAILED' })

  writeSession(located.file, scan.header, healedEvents)
  const back = readSession(located.file)
  const dense2 = assertRowsDense(back.events)
  const v2 = verifySessionEvents(back.header, back.events)
  if (!v2.ok || !dense2.ok) {
    try { copyFileSync(backupPath, located.file) } catch { /* 尽力回滚 */ }
    throw Object.assign(new Error('post-write verify failed; rolled back'),
      { code: 'VERIFY_FAILED', problems: [...(v2.problems ?? []), ...(dense2.ok ? [] : dense2.problems)] })
  }
  try { rmSync(home + '/storages/session_projcache/sessions/' + sessionId + '.json', { force: true }) } catch { /* ignore */ }
  try { const sessions = serviceOf(ctx, 'sessions'); if (typeof sessions?.refresh === 'function') await sessions.refresh() } catch { /* ignore */ }
  /* 记指纹：skipUnchanged 开着时，下次直接 stat 跳过（heal 后文件 mtime 已变，指纹=新值） */
  try {
    const fp = fileFingerprint(located.file)
    if (fp) { const st = readHealState(home); st[sessionId] = fp; writeHealState(st, home) }
  } catch { /* ignore */ }
  appendCompatLog(`heal ${sessionId.slice(0, 18)}: blank tool results=${plan.healed.length} dead attachments=${attPlan.healed.length}`)
  return { ...base, healedCount: plan.healed.length, healedAttachments: attPlan.healed.length, backup: true }
}

/* ── 会话日志修复：用户选项与指纹（2026-10-13 用户定案）──────────────────
   三个开关存 .dsh/adapter-compat-heal.json（默认全关，设置页可勾选保存）：
     bootScan     开机自动扫（一次性；不加定时器 —— 用户明确不要频繁扫盘吃内存）
     sendScan     发送前扫（出口守卫的结构修；关掉 = 内存零成本兜底也省，
                  代价是 DeepSeek 可能重新拒收残缺载荷，UI 上有提示）
     skipUnchanged 无变化对话不扫（按 文件大小+mtime 指纹跳过，只 stat 不读盘）
   指纹存同目录 .heal-state.json，heal 后记录 → 下次直接跳过。
   读缓存 2s：sendScan 每次发消息都会读，不能每次 IO。 */
const HEAL_OPTIONS_FILE = 'adapter-compat-heal.json'
const HEAL_STATE_FILE = 'adapter-compat-heal-state.json'
/**
 * 用户选项（默认值 = 2026-10-16 之前的既有行为，改这里就是改出厂）。
 *
 * 布尔：
 *   bootScan / sendScan / skipUnchanged —— 会话日志修复三项（2026-10-13 定案）
 *   changeRescan  目录变化后自动「标题预热 + 重扫列表」（含 dsh-sync 落盘）
 *   changePurge   目录变化后跟一次真删除扫描
 *   changeHeadGuard 目录变化后跟一次头保护扫描
 *   bootTitleWarm 开机自动预热标题（12s 补一轮、60s 再补一轮）
 *   bootHeadGuard 开机自动头保护（4s/25s 预筛 + 45s 深扫）
 *   bootTrueDelete 开机真删除补清（1.2s/2.5s/5s/30s 四个黄金窗）
 *   pressureCalibration contextPressure 显示校准
 * 数值：
 *   watchDebounceMs 会话盘变化后的稳定防抖（越小越灵敏、越费 IO）
 *   watchPollMs     兜底轮询间隔（fs.watch 漏事件时用它发现变化）
 *   pressureCalibrationIntervalMs 校准重试间隔（0 = 只在启动那几轮跑一次）
 * 枚举（字符串，只认白名单内的值，其余回默认）：
 *   egressScope    出口规范化作用域：'all' 全局 | 'web' 只对网页端路由 | 'off' 关
 *   egressXmlTools XML 式工具调用处理：'strip' 只剥标记（默认，安全）| 'convert' 转成真调用 | 'off' 不管
 * 布尔：
 *   egressThinking 是否剥正文开头的 <thinking> 段
 *
 * ⚠️ 这些值在**安装器启动时读一次** ⇒ 改完要重启 DSH 才生效（UI 上已注明）。
 *    例外：egress* 三项是**每个请求现读**（走 llm/stream 瀑布时读），改完即生效。
 */
const HEAL_DEFAULTS = {
  bootScan: false,
  sendScan: false,
  skipUnchanged: false,
  changeRescan: true,
  changePurge: true,
  changeHeadGuard: true,
  bootTitleWarm: true,
  bootHeadGuard: true,
  bootTrueDelete: true,
  pressureCalibration: true,
  watchDebounceMs: 1500,
  watchPollMs: 60000,
  pressureCalibrationIntervalMs: 0,
  egressScope: 'all',
  egressThinking: true,
  egressXmlTools: 'strip',
}
/** 枚举选项的白名单（不在表内 = 非法，回 base 值）。 */
const HEAL_ENUMS = {
  egressScope: ['all', 'web', 'off'],
  egressXmlTools: ['strip', 'convert', 'off'],
}
/** 数值选项的上下限（越界回退默认并记 problem）。 */
const HEAL_NUMBER_LIMITS = {
  watchDebounceMs: { min: 200, max: 600000 },
  watchPollMs: { min: 5000, max: 3600000 },
  pressureCalibrationIntervalMs: { min: 0, max: 3600000 },
}
let healOptionsCache = { at: 0, home: null, value: null }

/** 归一化一份用户选项（布尔只认布尔、数值夹到区间内，非法一律回默认）。 */
function normalizeHealOptions(raw) {
  return applyHealPatch({ ...HEAL_DEFAULTS }, raw)
}

/**
 * 把 patch 应用到 base 上（**patch 语义**：只改给出的键，其它保留）。
 *
 * 为什么要 patch 而不是整表替换：设置页之外若有别处（或未来的脚本）只写一个字段，
 * 整表替换会把用户其它设置悄悄重置成默认（单测抓到过）。非法值回退 **base 的值**
 * 而不是出厂默认，语义才是「这一项没改成功」。
 */
function applyHealPatch(base, raw) {
  const value = { ...base }
  if (!raw || typeof raw !== 'object') return value
  for (const k of Object.keys(HEAL_DEFAULTS)) {
    if (!(k in raw)) continue
    const def = HEAL_DEFAULTS[k]
    const v = raw[k]
    if (typeof def === 'boolean') {
      if (typeof v === 'boolean') value[k] = v
      continue
    }
    if (typeof def === 'number') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n)) continue
      const lim = HEAL_NUMBER_LIMITS[k]
      value[k] = lim === undefined ? n : Math.min(lim.max, Math.max(lim.min, Math.round(n)))
      continue
    }
    /* 枚举（字符串）：只认白名单内的值。大小写不敏感、去空白；非法一律保留 base 值。 */
    const allowed = HEAL_ENUMS[k]
    if (allowed !== undefined) {
      const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
      if (allowed.includes(s)) value[k] = s
    }
  }
  return value
}

/**
 * [2026-10-24 入口三件套 → 2026-10-29 目录优先级] webin config 是真源，读/写后统一合并：
 * chatOnly/中文工具名/NL 键 + 目录裁剪标志（heal 文件不管这些键）。
 * kbTrim/noKbTrim 只在 webin config【存在且给出显式布尔】时才可能为 true——
 * 缺省/文件缺失/损坏一律不裁（防默认态把模型工具全丢）。
 */
function mergeWebinSwitches(value, home) {
  try {
    const webin = JSON.parse(readFileSync(webinConfigPath(home), 'utf8'))
    if (webin !== null && typeof webin === 'object') {
      value.chatOnly = webin.chatOnly === true
      value.zhToolNames = webin.zhToolNames === true
      value.kbProtocol = webin.kbProtocol !== false
      value.nlToolProtocol = webin.nlToolProtocol === true
      value.kbTrim = webin.kbProtocol === true && webin.nlToolProtocol !== true
      value.noKbTrim = webin.nlToolProtocol === true && webin.kbProtocol === false
    }
  } catch { /* webin config 不存在/损坏：保持原值（kbTrim/noKbTrim 未定义 ⇒ 不裁） */ }
  return value
}

export function readHealOptions(home = dshHomeDir()) {
  const now = Date.now()
  /* 缓存必须认 home：否则单测往临时目录写配置会被上一份缓存吃掉（只按时间判会串目录）。 */
  if (healOptionsCache.value && healOptionsCache.home === home && now - healOptionsCache.at < 2000) {
    return healOptionsCache.value
  }
  let value = { ...HEAL_DEFAULTS }
  try {
    value = normalizeHealOptions(JSON.parse(readFileSync(home + '/' + HEAL_OPTIONS_FILE, 'utf8')))
  } catch { /* 无文件 = 出厂默认 */ }
  value = mergeWebinSwitches(value, home)
  healOptionsCache = { at: now, home, value }
  return value
}

export function writeHealOptions(next, home = dshHomeDir()) {
  /* patch 语义：以「当前生效值」为底再应用本次改动，只写到盘上的那几个键会变。 */
  const current = (() => {
    try { return applyHealPatch({ ...HEAL_DEFAULTS }, JSON.parse(readFileSync(home + '/' + HEAL_OPTIONS_FILE, 'utf8'))) }
    catch { return { ...HEAL_DEFAULTS } }
  })()
  const value = applyHealPatch(current, next)
  writeFileSync(home + '/' + HEAL_OPTIONS_FILE, JSON.stringify(value, null, 1), 'utf8')
  /* 写后缓存也必须合并 webin 真源——否则 2 秒缓存窗口内 readHealOptions 会拿到
   * 没有 chatOnly/kbProtocol/裁剪标志的旧值（写后立刻读的静默回退，隐性 bug）。 */
  mergeWebinSwitches(value, home)
  healOptionsCache = { at: Date.now(), home, value }
  return value
}

/** 读指纹表（sessionId -> {size, mtimeMs}）。文件损坏/不存在都当空表。 */
function readHealState(home) {
  try {
    const raw = JSON.parse(readFileSync(home + '/' + HEAL_STATE_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

function writeHealState(state, home) {
  try { writeFileSync(home + '/' + HEAL_STATE_FILE, JSON.stringify(state), 'utf8') } catch { /* 指纹写失败不影响修复 */ }
}

/** 文件指纹（只 stat，零读盘）：skipUnchanged 的判据。 */
function fileFingerprint(file) {
  try { const st = statSync(file); return { size: st.size, mtimeMs: Math.floor(st.mtimeMs) } } catch { return null }
}

/** 只读巡检：统计每个会话的空 tool 结果数 + 失效附件数（不修）。供 heal-scan 面板显示。 */
export function healScanAll(home = dshHomeDir(), options = {}) {
  const skipUnchanged = options.skipUnchanged === true
  const state = skipUnchanged ? readHealState(home) : {}
  const out = { ok: true, scanned: 0, withBlanks: 0, totalBlanks: 0, withDeadAttachments: 0, totalDeadAttachments: 0, skippedUnchanged: 0, sessions: [], unreadable: [] }
  for (const entry of listSessionFiles(home)) {
    out.scanned += 1
    try {
      if (skipUnchanged) {
        const fp = fileFingerprint(entry.file)
        const prev = state[entry.id]
        if (fp && prev && prev.size === fp.size && prev.mtimeMs === fp.mtimeMs) { out.skippedUnchanged += 1; continue }
      }
      const scan = scanFile(entry.file)
      if (scan.error) { out.unreadable.push({ id: entry.id, error: scan.error }); continue }
      const plan = healBlankToolResults(scan.events)
      /* 失效附件（2026-10-17）：只读检查，不动文件。这一项以前完全没有，
         所以「所有对话正常」是假阴性 —— 结构完好、字节没了的图片块没人看得见。 */
      const attPlan = healDeadAttachments(scan.events, { attachments: options.attachments, home })
      const row = { id: entry.id }
      let hit = false
      if (plan.healed.length > 0) {
        out.withBlanks += 1
        out.totalBlanks += plan.healed.length
        row.blanks = plan.healed.length
        row.sample = plan.healed.slice(0, 3)
        hit = true
      }
      if (attPlan.healed.length > 0) {
        out.withDeadAttachments += 1
        out.totalDeadAttachments += attPlan.healed.length
        row.deadAttachments = attPlan.healed.length
        row.deadSample = attPlan.healed.slice(0, 5)
        hit = true
      }
      if (hit) out.sessions.push(row)
    } catch (error) {
      out.unreadable.push({ id: entry.id, error: String(error?.message ?? error) })
    }
  }
  return out
}

/** 注册断号修复路由（POST repair-session {sessionId, write} + GET repair-scan）。 */
export function installRepairRoute(ctx, config = {}) {
  if (config?.repairSession === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') return false
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/repair-session',
      handler: async (req, res) => {
        const reply = (status, obj) => {
          try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
        }
        if (req.method !== 'POST') return reply(405, { ok: false, error: 'method-not-allowed' })
        let body = ''
        try {
          for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('body too large') }
          const parsed = JSON.parse(body || '{}')
          if (typeof parsed?.sessionId !== 'string' || !parsed.sessionId) return reply(400, { ok: false, error: 'sessionId required' })
          const result = await repairSessionFile(ctx, parsed.sessionId, { write: parsed.write === true })
          appendCompatLog(`repair-session route ok: ${JSON.stringify(result).slice(0, 200)}`)
          return reply(200, result)
        } catch (error) {
          const msg = String(error?.message ?? error)
          const code = error?.code === 'SESSION_LIVE' ? 409 : error?.code === 'NOT_FOUND' ? 404 : 400
          appendCompatLog(`repair-session route FAILED(${code}): ${msg.slice(0, 200)}`)
          return reply(code, { ok: false, error: msg, plan: error?.plan, problems: error?.problems })
        }
      },
    })
    try {
      web.register({
        kind: 'exact',
        path: '/dsh-adapter-compat/repair-scan',
        handler: async (req, res) => {
          const reply = (status, obj) => {
            try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
          }
          if (req.method !== 'GET') return reply(405, { ok: false, error: 'method-not-allowed' })
          try {
            const report = repairScanAll()
            appendCompatLog(`repair-scan: scanned=${report.scanned} bad=${report.bad.length} unreadable=${report.unreadable.length}`)
            return reply(200, { ok: true, report })
          } catch (e) { return reply(500, { ok: false, error: String(e?.message ?? e) }) }
        },
      })
    } catch { /* 扫描路由失败不影响修复路由 */ }
    /* 文本层根治路由（2026-10-13，手动触发，无定时器/无启动扫盘 —— 出口守卫已兜实时流量）：
       POST heal-tools {sessionId, write}  修某会话的空 tool 结果 → [内容已清除]
       POST heal-tools {write:true}        修全部（逐个过 live/备份/verify 门禁）
       GET  heal-scan                      只读统计，不写 */
    try {
      web.register({
        kind: 'exact',
        path: '/dsh-adapter-compat/heal-tools',
        handler: async (req, res) => {
          const reply = (status, obj) => {
            try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
          }
          if (req.method !== 'POST') return reply(405, { ok: false, error: 'method-not-allowed' })
          let raw = ''
          try {
            for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error('body too large') }
            const parsed = JSON.parse(raw || '{}')
            const write = parsed.write === true
            if (parsed.sessionId) {
              const result = await healSessionFile(ctx, String(parsed.sessionId), { write, home: parsed.home })
              appendCompatLog(`heal-tools(${String(parsed.sessionId).slice(0, 18)}): healed=${result.healedCount ?? result.wouldHeal} write=${write}`)
              return reply(200, { ok: true, result })
            }
            const all = listSessionFiles(parsed.home ?? dshHomeDir())
            const done = [], skipped = [], failed = []
            const skipUnchanged = parsed.skipUnchanged === true || readHealOptions(parsed.home).skipUnchanged === true
            const state = skipUnchanged ? readHealState(parsed.home ?? dshHomeDir()) : {}
            let unchanged = 0
            for (const entry of all) {
              try {
                /* skipUnchanged：只 stat 比对指纹，未变化的连文件都不读 */
                if (skipUnchanged) {
                  const fp = fileFingerprint(entry.file)
                  const prev = state[entry.id]
                  if (fp && prev && prev.size === fp.size && prev.mtimeMs === fp.mtimeMs) { unchanged += 1; continue }
                }
                const r = await healSessionFile(ctx, entry.id, { write, home: parsed.home })
                if (r.alreadyHealthy) continue
                done.push({ id: entry.id, healed: r.healedCount ?? r.wouldHeal })
              } catch (e) {
                const code = e?.code
                if (code === 'SESSION_LIVE') skipped.push({ id: entry.id, why: 'live' })
                else if (code === 'NOT_FOUND') { /* ignore */ }
                else failed.push({ id: entry.id, error: String(e?.message ?? e).slice(0, 120) })
              }
            }
            appendCompatLog(`heal-tools(all): healed=${done.length} live-skipped=${skipped.length} unchanged=${unchanged} failed=${failed.length} write=${write}`)
            return reply(200, { ok: true, result: { done, skipped, failed, unchanged } })
          } catch (e) {
            const msg = String(e?.message ?? e)
            const code = e?.code === 'SESSION_LIVE' ? 409 : e?.code === 'NOT_FOUND' ? 404 : 400
            return reply(code, { ok: false, error: msg })
          }
        },
      })
      web.register({
        kind: 'exact',
        path: '/dsh-adapter-compat/heal-scan',
        handler: async (req, res) => {
          const reply = (status, obj) => {
            try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
          }
          if (req.method !== 'GET') return reply(405, { ok: false, error: 'method-not-allowed' })
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            const skipUnchanged = url.searchParams.get('skipUnchanged') === '1' || readHealOptions().skipUnchanged === true
            const report = healScanAll(undefined, { skipUnchanged, attachments: attachmentsService(ctx) })
            appendCompatLog(`heal-scan: scanned=${report.scanned} withBlanks=${report.withBlanks} totalBlanks=${report.totalBlanks} withDeadAttachments=${report.withDeadAttachments} totalDeadAttachments=${report.totalDeadAttachments} unchanged=${report.skippedUnchanged}`)
            return reply(200, { ok: true, report })
          } catch (e) { return reply(500, { ok: false, error: String(e?.message ?? e) }) }
        },
      })
      /* 选项读写（GET 读当前三个开关；POST 存，供设置页勾选保存）。 */
      try {
        web.register({
          kind: 'exact',
          path: '/dsh-adapter-compat/heal-options',
          handler: async (req, res) => {
            const reply = (status, obj) => {
              try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
            }
            if (req.method === 'GET') return reply(200, { ok: true, options: readHealOptions() })
            if (req.method !== 'POST') return reply(405, { ok: false, error: 'method-not-allowed' })
            let raw = ''
            try {
              for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('body too large') }
              const parsed = JSON.parse(raw || '{}')
              const saved = writeHealOptions(parsed)
              appendCompatLog(`heal-options saved: ${JSON.stringify(saved)}`)
              return reply(200, { ok: true, options: saved })
            } catch (e) { return reply(400, { ok: false, error: String(e?.message ?? e) }) }
          },
        })
      } catch { /* ignore */ }
    } catch { /* heal 路由失败不影响修复路由 */ }
    appendCompatLog('repair routes registered')
    return true
  } catch (e) {
    appendCompatLog('repair route FAILED: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
}

/* ============ 第九层：压缩 .txt 出口 + 版本分页器开关（9999.9.24） ============
 *
 * 用户要求（2026-10-16）：
 *   ①「点了分叉会话/修改过对话后下面总有『版本切换』按钮」→ 禁掉。
 *      该按钮是 dsh-easyrewrite 的版本分页器（DOM 标记 data-dsh-easyrewrite="version-pager"）。
 *      **不改 easyrewrite 的文件**：由本插件客户端半身注入 CSS 隐藏，开关存本插件。
 *   ②「.txt 出口设置改到 Adapter 插件上」→ 设置入口放本插件，
 *      值写真源仍是 ~/.dsh/webin/config.json 的 compactionFileMode /
 *      compactionFileThresholdChars（webin 每请求 readConfig() 现读，改完即生效，不用重启）。
 *
 * 为什么值写真源放 webin 配置而不是本插件配置：出口行为（何时打包 .txt、上传还是直发）
 * 由 webin 执行；本插件只当「设置面板」，避免两套配置打架。
 */

/** .txt 出口模式合法值（与 webin DEFAULT_CONFIG 的压缩出口一致）。 */
export const COMPACT_EXIT_MODES = ['never', 'auto', 'always']
/** 出口设置默认值：与 webin 出厂默认一致。 */
export const COMPACT_EXIT_DEFAULTS = { compactionFileMode: 'auto', compactionFileThresholdChars: 100000 }
/** 版本分页器开关的默认值：true = 隐藏（用户要「禁了」）。 */
export const EXIT_PREFS_DEFAULTS = { hideVersionPager: true, renderFx: false }

/** 本插件出口偏好文件（只存「与 webin 无关」的开关，如隐藏分页器）。 */
export function exitPrefsPath(home = dshHomeDir()) {
  return `${home.replace(/[\\/]+$/u, '')}/adapter-compat-exit.json`
}

/** webin 配置文件路径（与 webin 的 configPath() 同址）。 */
export function webinConfigPath(home = dshHomeDir()) {
  return `${home.replace(/[\\/]+$/u, '')}/webin/config.json`
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
  const tmp = `${file}.tmp-cad-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
  try { rmSync(file, { force: true }) } catch { /* 目标不存在 */ }
  renameSync(tmp, file)
}

/** 读取当前出口设置（webin 配置 + 本插件偏好合并）。 */
export function readExitPrefs(home = dshHomeDir()) {
  const webin = readJsonOr(webinConfigPath(home), COMPACT_EXIT_DEFAULTS)
  const own = readJsonOr(exitPrefsPath(home), EXIT_PREFS_DEFAULTS)
  const mode = COMPACT_EXIT_MODES.includes(webin.compactionFileMode) ? webin.compactionFileMode : COMPACT_EXIT_DEFAULTS.compactionFileMode
  const rawThreshold = Number(webin.compactionFileThresholdChars)
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? Math.round(rawThreshold) : COMPACT_EXIT_DEFAULTS.compactionFileThresholdChars
  return {
    compactionFileMode: mode,
    compactionFileThresholdChars: threshold,
    hideVersionPager: own.hideVersionPager !== false,
    /* [B线 2026-10-24] 消息流懒渲染开关：默认关（用户刚被闪退惊过，不替他做默认决定）。
     *  开启后客户端给消息项注入 content-visibility:auto，屏幕外跳过布局绘制。 */
    renderFx: own.renderFx === true,
    /* 知识库自然语言协议全局开关（2026-10-19）：真源同放 webin config.json
       （webin 每请求现读），默认开。 */
    kbProtocol: webin.kbProtocol !== false,
    /* 自然语言工具调用（通用，2026-10-19）：默认关（保守）。 */
    nlToolProtocol: webin.nlToolProtocol === true,
    /* 标题 LDW 前缀（2026-10-19）：默认开。 */
    titlePrefix: webin.titlePrefix !== false,
    /* 全局 .txt 三件套（2026-10-21 用户定案「都要弄上」）：同源 webin config。
     *  API 通道不实际用附件（HTTP JSON 直传），但全局入口一律完整呈现；
     *  LDW 侧优先生效，除非 LDW 覆盖键留空（跟随全局）。 */
    directSendThresholdChars: Number(webin.directSendThresholdChars) > 0 ? Math.round(Number(webin.directSendThresholdChars)) : 6000,
    txtChunkBytes: Number(webin.txtChunkBytes) > 0 ? Math.round(Number(webin.txtChunkBytes)) : 409600,
    chatOnly: webin.chatOnly === true,
    /* 中文工具名（2026-10-24 用户点名「调用时用汉字代替」）：真源 webin config，默认关（独立开关，铁律）。 */
    zhToolNames: webin.zhToolNames === true,
  }
}

/**
 * 写出口设置：只改给出的键。
 * @returns {{ok: boolean, value?: object, error?: string}}
 */
export function writeExitPrefs(patch, home = dshHomeDir()) {
  const errors = []
  const next = readExitPrefs(home)
  /* 只有真的动了 webin 侧的两个键，才去写 webin 配置文件 ——
     用户只勾「隐藏分页器」时，webin 的 config.json 不该被动（少写少险）。 */
  let touchWebin = false
  let touchOwn = false
  if (patch?.compactionFileMode !== undefined) {
    if (!COMPACT_EXIT_MODES.includes(patch.compactionFileMode)) errors.push(`compactionFileMode 应为 ${COMPACT_EXIT_MODES.join('/')}`)
    else if (patch.compactionFileMode !== next.compactionFileMode) { next.compactionFileMode = patch.compactionFileMode; touchWebin = true }
  }
  if (patch?.compactionFileThresholdChars !== undefined) {
    const n = Number(patch.compactionFileThresholdChars)
    if (!Number.isFinite(n) || n <= 0) errors.push('compactionFileThresholdChars 应为正数')
    else if (Math.round(n) !== next.compactionFileThresholdChars) { next.compactionFileThresholdChars = Math.round(n); touchWebin = true }
  }
  if (patch?.hideVersionPager !== undefined) {
    if (typeof patch.hideVersionPager !== 'boolean') errors.push('hideVersionPager 应为布尔')
    else if (patch.hideVersionPager !== next.hideVersionPager) { next.hideVersionPager = patch.hideVersionPager; touchOwn = true }
  }
  /* [B线 2026-10-24] 消息流懒渲染：只存开关（客户端读后注入 content-visibility CSS）。
     与 hideVersionPager 同一张自己的偏好表（adapter-compat-heal.json 的伴文件），
     不碰 webin 配置——纯渲染优化，与出口/协议无关。 */
  if (patch?.renderFx !== undefined) {
    if (typeof patch.renderFx !== 'boolean') errors.push('renderFx 应为布尔')
    else if (patch.renderFx !== next.renderFx) { next.renderFx = patch.renderFx; touchOwn = true }
  }
  if (patch?.kbProtocol !== undefined) {
    if (typeof patch.kbProtocol !== 'boolean') errors.push('kbProtocol 应为布尔')
    else if (patch.kbProtocol !== next.kbProtocol) { next.kbProtocol = patch.kbProtocol; touchWebin = true }
  }
  if (patch?.nlToolProtocol !== undefined) {
    if (typeof patch.nlToolProtocol !== 'boolean') errors.push('nlToolProtocol 应为布尔')
    else if (patch.nlToolProtocol !== next.nlToolProtocol) { next.nlToolProtocol = patch.nlToolProtocol; touchWebin = true }
  }
  if (patch?.titlePrefix !== undefined) {
    if (typeof patch.titlePrefix !== 'boolean') errors.push('titlePrefix 应为布尔')
    else if (patch.titlePrefix !== next.titlePrefix) { next.titlePrefix = patch.titlePrefix; touchWebin = true }
  }
  /* 全局 .txt 三件套（2026-10-21）：直接透传 webin config（数字宽松校验）。 */
  if (patch?.directSendThresholdChars !== undefined) {
    const n = Number(patch.directSendThresholdChars)
    if (!Number.isFinite(n) || n < 0) errors.push('directSendThresholdChars 应为非负数')
    else if (Math.round(n) !== next.directSendThresholdChars) { next.directSendThresholdChars = Math.round(n); touchWebin = true }
  }
  if (patch?.txtChunkBytes !== undefined) {
    const n = Number(patch.txtChunkBytes)
    if (!Number.isFinite(n) || n < 0) errors.push('txtChunkBytes 应为非负数')
    else if (Math.round(n) !== next.txtChunkBytes) { next.txtChunkBytes = Math.round(n); touchWebin = true }
  }
  if (patch?.chatOnly !== undefined) {
    if (typeof patch.chatOnly !== 'boolean') errors.push('chatOnly 应为布尔')
    else if (patch.chatOnly !== next.chatOnly) { next.chatOnly = patch.chatOnly; touchWebin = true }
  }
  if (patch?.zhToolNames !== undefined) {
    if (typeof patch.zhToolNames !== 'boolean') errors.push('zhToolNames 应为布尔')
    else if (patch.zhToolNames !== next.zhToolNames) { next.zhToolNames = patch.zhToolNames; touchWebin = true }
  }
  if (errors.length > 0) return { ok: false, error: errors.join('；') }

  try {
    if (touchWebin) {
      // webin 侧：合并写，保留它的全部其它键（delay/账号/edgeDriver…）
      const webinPath = webinConfigPath(home)
      const webin = readJsonOr(webinPath, {})
      webin.compactionFileMode = next.compactionFileMode
      webin.compactionFileThresholdChars = next.compactionFileThresholdChars
      webin.kbProtocol = next.kbProtocol
      webin.nlToolProtocol = next.nlToolProtocol
      webin.titlePrefix = next.titlePrefix
      webin.directSendThresholdChars = next.directSendThresholdChars
      webin.txtChunkBytes = next.txtChunkBytes
      webin.chatOnly = next.chatOnly
      webin.zhToolNames = next.zhToolNames
      writeJsonAtomic(webinPath, webin)
      /* [2026-10-30 重测 4.E 竞态修复] 写完 webin config 必须立刻失效 healOptionsCache：
         readHealOptions 有 2s TTL 缓存，写盘后 ≤2s 内的请求会命中旧开关值——
         4.E 实锤（memory-distill 后台请求恰好在其 setSwitches 前 1.65s 刷新过缓存，
         首轮 dispatch tc=54 未裁剪，续轮 6.2s 后才 tc=9）。置空强制下一次重读文件。 */
      healOptionsCache = { at: 0, home: null, value: null }
    }
    if (touchOwn) writeJsonAtomic(exitPrefsPath(home), { hideVersionPager: next.hideVersionPager, renderFx: next.renderFx === true })
    if (touchWebin || touchOwn) {
      appendCompatLog(`exit-prefs saved: mode=${next.compactionFileMode} threshold=${next.compactionFileThresholdChars} hidePager=${next.hideVersionPager} kbProtocol=${next.kbProtocol} nlTool=${next.nlToolProtocol} titlePrefix=${next.titlePrefix}`)
    }
    return { ok: true, value: next, changed: { webin: touchWebin, own: touchOwn } }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 客户端半身是否已经报过到（只记第一行，避免刷日志）。 */
let clientHalfBootLogged = false

/** 出口设置路由：GET 读取 / POST 保存。注册失败不抛（与其它路由同约定）。 */
export function installExitRoute(ctx, config = {}) {
  if (config?.exitPrefs === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') {
      appendCompatLog('exit route: webServer unavailable')
      return false
    }
    const reply = (res, status, obj) => {
      try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
    }
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/exit-prefs',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          /* 诊断（2026-10-16）：客户端半身加载新代码时第一件事就是 GET 这个路由。
             只在首次记一行 —— 用来区分「浏览器跑的是缓存旧版」与「代码没注册」。 */
          if (!clientHalfBootLogged) {
            clientHalfBootLogged = true
            appendCompatLog('client half GET exit-prefs -> 新客户端已加载（含 exit/versions 分区）')
          }
          try { return reply(res, 200, { ok: true, value: readExitPrefs() }) }
          catch (e) { return reply(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        let body = ''
        try {
          for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('body too large') }
          const parsed = JSON.parse(body || '{}')
          const result = writeExitPrefs(parsed)
          return reply(res, result.ok ? 200 : 400, result)
        } catch (error) {
          return reply(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    appendCompatLog('exit-prefs route registered')
    return true
  } catch (e) {
    appendCompatLog('exit route FAILED: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
}

/* ============ 第十层：版本家族保护 + 磁盘清理（9999.9.25） ============
 *
 * 用户实测（2026-10-16）：
 *   ①「分叉/版本切换占磁盘吗」→ **占**。DSH 分叉走 dsh-session/fork 的
 *      buildForkSeed：把父会话的事件前缀**复制**进新会话，header 记
 *      `parentSession`。实测 102 个会话里 17 个是分叉产物，合计 21.96 MB；
 *      其中从 session-43c4199d 分叉出来的 session-72185b36 单条 4.63 MB。
 *   ②「版本切换会触发其他插件的真删除」→ 版本家族里的会话一旦被标墓碑，
 *      本插件的 true-delete 会真的把内容 excise 掉，旧版本就没了。
 *
 * 本层做两件事：
 *   A. **保护**：purgeTombstones 默认跳过「版本家族成员」（有 parentSession
 *      或被子会话引用的会话）——只记账不动刀，除非显式 forceFamilies。
 *   B. **清理**：提供家族清单 + 体积，用户想省空间时手动清（真删，不留副本）。
 */

/** 会话头读取：只解压第一帧（header 所在帧），不做整文件解压。 */
export function readSessionHeader(file) {
  try {
    const buf = readFileSync(file)
    if (buf.length < 5 || !(buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd)) return null
    let out = null
    let end = Math.min(buf.length, 4096)
    let step = 4096
    for (;;) {
      try { out = zstdDecompressSync(buf.subarray(0, end)); break } catch { /* 未到帧尾 */ }
      if (end >= buf.length) break
      end = Math.min(buf.length, end + step)
      step *= 2
    }
    if (out === null) {
      let lo = 5, hi = buf.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        let ok = false
        try { zstdDecompressSync(buf.subarray(0, mid)); ok = true } catch { ok = false }
        if (ok) hi = mid; else lo = mid + 1
      }
      try { out = zstdDecompressSync(buf.subarray(0, lo)) } catch { return null }
    }
    const line = out.toString('utf8').split('\n').filter(Boolean)[0]
    if (!line) return null
    const parsed = JSON.parse(line)
    /* ⚠️ header 的字段在**顶层**（实测 session-72185b36）：
       {"type":"session","version":4,"id":…,"cwd":…,"parentSession":…,"isSeeded":true}。
       不是嵌在 data 里——第一版读 data.parentSession 于是家族扫描全 0。 */
    const data = parsed?.data ?? {}
    const parent = typeof parsed?.parentSession === 'string'
      ? parsed.parentSession
      : (typeof data.parentSession === 'string' ? data.parentSession : null)
    return {
      parent,
      cwd: typeof parsed?.cwd === 'string' ? parsed.cwd : (typeof data.cwd === 'string' ? data.cwd : ''),
      createdAt: typeof parsed?.createdAt === 'number' ? parsed.createdAt : (typeof data.createdAt === 'number' ? data.createdAt : 0),
      /* F线（2026-10-24）：origin/delegationDepth——子代理判据就靠它们。
         历史会话可能没有 origin 字段（旧格式），undefined 是正常值。 */
      origin: typeof parsed?.origin === 'string' ? parsed.origin : (typeof data.origin === 'string' ? data.origin : undefined),
      delegationDepth: typeof parsed?.delegationDepth === 'number' ? parsed.delegationDepth : (typeof data.delegationDepth === 'number' ? data.delegationDepth : 0),
    }
  } catch {
    return null
  }
}

/** 会话目录（含工作区层）定位：返回 sid → { dir, file, sizeBytes, mtimeMs }。 */
function sessionDirs(home = dshHomeDir()) {
  const out = new Map()
  const root = `${home}/sessions`
  let wsDirs = []
  try { wsDirs = readdirSync(root) } catch { return out }
  for (const ws of wsDirs) {
    const wsDir = `${root}/${ws}`
    let ids = []
    try { if (!statSync(wsDir).isDirectory()) continue; ids = readdirSync(wsDir) } catch { continue }
    for (const sid of ids) {
      const dir = `${wsDir}/${sid}`
      const file = `${dir}/session.v4.jsonl.zstd`
      try {
        if (!existsSync(file)) continue
        const st = statSync(file)
        out.set(sid, { dir, file, sizeBytes: st.size, mtimeMs: st.mtimeMs })
      } catch { /* skip */ }
    }
  }
  return out
}

/**
 * 扫描版本家族：返回 { families, members, totalForkMB, scannedAt }。
 * family = 一个根会话 + 它的全部后代（多层分叉一并算进来）。
 */
export function scanVersionFamilies(home = dshHomeDir()) {
  const dirs = sessionDirs(home)
  const parentOf = new Map()
  const headerInfo = new Map()
  for (const [sid, info] of dirs) {
    const h = readSessionHeader(info.file)
    headerInfo.set(sid, h)
    if (h?.parent) parentOf.set(sid, h.parent)
  }
  /* 根：顺着 parent 上溯到最顶层（父可能已删，那就以当前最深可达为根）。 */
  const rootOf = (sid) => {
    let cur = sid
    const seen = new Set([sid])
    for (;;) {
      const p = parentOf.get(cur)
      if (!p || !dirs.has(p) || seen.has(p)) return cur
      seen.add(p)
      cur = p
    }
  }
  const families = new Map()
  for (const sid of dirs.keys()) {
    const root = rootOf(sid)
    if (!families.has(root)) families.set(root, [])
    families.get(root).push(sid)
  }
  const list = []
  /* 分叉体积按「所有有 parent 的会话」统计——父会话可能已被删，
     那种孤儿分叉仍占盘、也仍要保护，不能因为家族只剩一条就漏掉。 */
  let totalForkMB = 0
  for (const sid of parentOf.keys()) {
    const info = dirs.get(sid)
    if (info) totalForkMB += info.sizeBytes / 1048576
  }
  for (const [root, ids] of families) {
    const anyFork = ids.some((sid) => parentOf.has(sid))
    if (ids.length < 2 && !anyFork) continue   // 单会话且非分叉 → 不算家族
    const members = ids.map((sid) => {
      const info = dirs.get(sid)
      const isFork = parentOf.has(sid)
      return {
        id: sid,
        parent: parentOf.get(sid) ?? null,
        isRoot: sid === root,
        isFork,
        orphanFork: isFork && !dirs.has(String(parentOf.get(sid))),
        /* 2026-10-22 用户要求：家族列表要认得出谁是谁。标题走 sessionTitleLite
           （projcache → 日志 session/title，读不到回退首条用户消息前 24 字）。 */
        title: sessionTitleLite(home, sid, info) ?? firstUserTextLite(info?.file) ?? null,
        sizeMB: +(info.sizeBytes / 1048576).toFixed(2),
        mtime: new Date(info.mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
      }
    }).sort((a, b) => b.sizeMB - a.sizeMB)
    list.push({ root, title: sessionTitleLite(home, root, dirs.get(root)) ?? null, members, sizeMB: +members.reduce((a, b) => a + b.sizeMB, 0).toFixed(2) })
  }
  list.sort((a, b) => b.sizeMB - a.sizeMB)
  const totalForkBytes = [...parentOf.keys()].reduce((a, sid) => a + (dirs.get(sid)?.sizeBytes ?? 0), 0)
  const totalAllBytes = [...dirs.values()].reduce((a, b) => a + b.sizeBytes, 0)
  return {
    families: list,
    familyCount: list.length,
    forkCount: [...parentOf.keys()].filter((sid) => dirs.has(sid)).length,
    totalForkMB: +totalForkMB.toFixed(2),
    totalAllMB: +[...dirs.values()].reduce((a, b) => a + b.sizeBytes, 0) / 1048576,
    /* 字节级原值：MB 会四舍五入成 0，测试与精确统计用这个。 */
    totalForkBytes,
    totalAllBytes,
    scannedAt: new Date().toISOString(),
  }
}

/* 家族索引缓存（30s）：purgeTombstones 每 60s 跑一次，不能每次都全盘读头。 */
let familyCache = { at: 0, ids: new Set() }

/** 版本家族成员 id 集合（含父、含子）。保护判据用。 */
export function versionFamilyIds(home = dshHomeDir(), { ttlMs = 30000 } = {}) {
  if (Date.now() - familyCache.at < ttlMs) return familyCache.ids
  const ids = new Set()
  try {
    const scan = scanVersionFamilies(home)
    for (const fam of scan.families) for (const m of fam.members) ids.add(m.id)
  } catch { /* 扫不动就不保护（宁可不拦，也不要卡住清理链） */ }
  familyCache = { at: Date.now(), ids }
  return ids
}

/* ── 不可见会话标题（2026-10-22 用户要求「列表要显示标题」）──────────────
   scanInvisibleSessions 以前只回 id/体积/时间，面板上一排光秃秃的 id，认不出谁是谁。
   标题按「便宜优先」两处来源依次试：
     ① 宿主投影缓存 projcache（纯 JSON 读，最便宜）；
     ② 会话日志——session/title 事件紧跟第一轮对话，实测都落在前 5 帧以内。
        小文件（≤2MB）直接复用 true-delete 的 readSession 整读（现成工具，最准）；
        大文件只 open 读头 1MB、逐帧解压到找到标题为止，**绝不整读**——
        不可见会话里可能有 GB 级巨型日志，整读会把面板拖死。
   都拿不到 → null，前端回退显示 id 前 8 位（不报错）。结果按 (mtimeMs,sizeBytes)
   记忆化：面板反复刷新不会重复解压，文件变了才重读。 */
const TITLE_FULL_READ_MAX = 2 << 20
const TITLE_HEAD_BYTES = 1 << 20
const TITLE_PLAIN_BUDGET = 4 << 20
const TITLE_FRAME_BUDGET = 300
const titleCache = new Map()

/** 会话日志里的标题：小文件整读（复用 readSession），大文件只啃头部。 */
function titleFromLog(file) {
  try {
    if (statSync(file).size <= TITLE_FULL_READ_MAX) {
      const { events } = readSession(file)
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev?.type === 'session/title' && typeof ev.data?.title === 'string' && ev.data.title.trim()) {
          return ev.data.title.trim().slice(0, 120)
        }
      }
      return null
    }
  } catch {
    /* 坏文件/旧格式：再走下面那道「只读头部」的兜底 */
  }
  return titleFromLogHead(file)
}

/** projcache 里的标题（同 slimListSessions 的读法：record.rows.title = {ver, seq, val}）。 */
function projectionTitleOf(home, id) {
  try {
    const pc = JSON.parse(readFileSync(home + '/storages/session_projcache/sessions/' + id + '.json', 'utf8'))
    const t = pc?.record?.rows?.title
    if (typeof t === 'string' && t) return t
    if (t && typeof t === 'object' && typeof t.val === 'string' && t.val) return t.val
    return null
  } catch {
    return null
  }
}

/** 从会话日志头部找标题：只读前 1MB，逐帧解压，找到 session/title 就停。
 *  @returns {string|null} */
function titleFromLogHead(file) {
  if (!file) return null
  let fd = null
  try {
    const size = statSync(file).size
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(TITLE_HEAD_BYTES, size))
    const read = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, read)
    const cuts = scanFramesZstd(head)
    if (cuts.length < 2) return null
    let plainBytes = 0
    for (let k = 0; k + 2 < cuts.length; k++) {
      if (k >= TITLE_FRAME_BUDGET || plainBytes > TITLE_PLAIN_BUDGET) break
      let plain = ''
      try { plain = zstdDecompressSync(head.subarray(cuts[k], cuts[k + 1])).toString('utf8') } catch { continue }
      plainBytes += plain.length
      if (!plain.includes('session/title')) continue
      const lines = plain.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i] || !lines[i].includes('session/title')) continue
        try {
          const ev = JSON.parse(lines[i])
          if (ev?.type === 'session/title' && typeof ev.data?.title === 'string' && ev.data.title.trim()) {
            return ev.data.title.trim().slice(0, 120)
          }
        } catch { /* 半行（帧尾截断）：继续往上找 */ }
      }
    }
    return null
  } catch {
    return null
  } finally {
    try { if (fd !== null) closeSync(fd) } catch { /* ignore */ }
  }
}

/** 标题读取（projcache → 日志头），带记忆化。读不到返回 null。 */
export function sessionTitleLite(home, id, info) {
  const stamp = `${info?.mtimeMs ?? 0}:${info?.sizeBytes ?? 0}`
  const hit = titleCache.get(id)
  if (hit && hit.stamp === stamp) return hit.title
  let title = projectionTitleOf(home, id)
  if (!title) title = titleFromLog(info?.file)
  const text = typeof title === 'string' && title.trim() ? title.trim() : null
  if (titleCache.size > 4096) titleCache.clear()
  titleCache.set(id, { stamp, title: text })
  return text
}

/* 首条用户消息兜底（2026-10-22 用户要求「至少取会话前几个字让我知道有什么」）：
   projcache 与 session/title 都没有的会话（分叉刚出生还没对话、旧文件被清过），
   取日志里第一条人类 user/message 的前 24 个字。只啃头部 1MB，绝不整读大文件。 */
const FIRST_USER_MAX_CHARS = 24
function firstUserTextLite(file) {
  if (!file) return null
  try {
    if (statSync(file).size <= TITLE_FULL_READ_MAX) {
      const { events } = readSession(file)
      for (const ev of events) {
        if (ev?.type !== 'user/message') continue
        if (ev.data?.source?.kind !== 'user') continue
        const text = (ev.data?.content ?? [])
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (text) return text.slice(0, FIRST_USER_MAX_CHARS) + (text.length > FIRST_USER_MAX_CHARS ? '…' : '')
      }
      return null
    }
  } catch { /* 坏文件/读不了 → 再走头部兜底 */ }
  return firstUserTextFromHead(file)
}

/** 大文件版：只啃头部 1MB，找第一条 source.kind=user 的 user/message。 */
function firstUserTextFromHead(file) {
  let fd = null
  try {
    const size = statSync(file).size
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(TITLE_HEAD_BYTES, size))
    const read = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, read)
    const cuts = scanFramesZstd(head)
    let plainBytes = 0
    for (let k = 0; k + 2 < cuts.length; k++) {
      if (k >= TITLE_FRAME_BUDGET || plainBytes > TITLE_PLAIN_BUDGET) break
      let plain = ''
      try { plain = zstdDecompressSync(head.subarray(cuts[k], cuts[k + 1])).toString('utf8') } catch { continue }
      plainBytes += plain.length
      if (!plain.includes('"user/message"')) continue
      for (const line of plain.split('\n')) {
        if (!line.includes('"user/message"')) continue
        try {
          const ev = JSON.parse(line)
          if (ev?.type !== 'user/message' || ev.data?.source?.kind !== 'user') continue
          const text = (ev.data?.content ?? [])
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
          if (text) return text.slice(0, FIRST_USER_MAX_CHARS) + (text.length > FIRST_USER_MAX_CHARS ? '…' : '')
        } catch { /* 半行：继续 */ }
      }
    }
    return null
  } catch {
    return null
  } finally {
    try { if (fd !== null) closeSync(fd) } catch { /* ignore */ }
  }
}

/**
 * 扫描不可见会话（盘上有文件、宿主登记表里任何列表都没有）。
 * @param {string} home
 * @param {{force?:boolean, withFamily?:boolean}} [options]
 *   force：放行「登记表疑似异常」这道保险（清单照样给，但整批标 registryAnomaly，由调用方
 *          在响应里显式回报——用户勾了强制才允许走到这一步）。
 *   withFamily：逐条标注「版本家族成员」（要全盘读头，30s 缓存；只有面板要看时才付这份钱）。
 */
export function scanInvisibleSessions(home = dshHomeDir(), options = {}) {
  const reg = readRegistryIds(home)
  if (reg === null) {
    return { ok: false, reason: 'workspace.json 读不到或结构异常 —— 放弃扫描（避免误删可见会话）', sessions: [], totalMB: 0, visibleCount: 0 }
  }
  const dirs = sessionDirs(home)
  const familyIds = options.withFamily === true ? versionFamilyIds(home) : null
  const out = []
  let totalBytes = 0
  let familyCount = 0
  for (const [sid, info] of dirs) {
    if (reg.visible.has(sid) || reg.archived.has(sid) || reg.workspaceIds.has(sid)) continue
    totalBytes += info.sizeBytes
    const family = familyIds !== null && familyIds.has(sid)
    if (family) familyCount += 1
    /* 会话目录结构是 sessions/<工作区编码目录>/<sessionId>/：取「倒数第二段」当所属工作区。 */
    const cut = info.dir.lastIndexOf('/')
    const segments = info.dir.split('/')
    out.push({
      id: sid,
      title: sessionTitleLite(home, sid, info),
      sizeMB: +(info.sizeBytes / 1048576).toFixed(2),
      sizeBytes: info.sizeBytes,
      mtimeMs: info.mtimeMs,
      mtime: new Date(info.mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
      ageMinutes: Math.round((Date.now() - info.mtimeMs) / 60000),
      dir: info.dir,
      workspaceDir: cut > 0 ? info.dir.slice(0, cut) : '',
      workspaceKey: segments.length >= 2 ? segments[segments.length - 2] : '',
      /* 家族成员 = 默认不动刀（见 purge 路由）；前端据此显示「受影响 + 原因」。 */
      family,
      reasons: family ? ['family-protected'] : [],
    })
  }
  out.sort((a, b) => b.sizeMB - a.sizeMB)
  /* 安全闸：可见数为 0 而盘上却有会话 —— 只可能是登记表被重置/损坏。
     这时「一切皆残留」的判断不可信，拒绝清理（否则一次就把所有会话扫光）。
     force 例外：仍然只出清单、不自动删；删必须由用户再点一次（见 purge 路由）。 */
  if (reg.visible.size === 0 && out.length > 0) {
    if (options.force !== true) {
      return {
        ok: false,
        reason: `登记表里一条可见会话都没有，但盘上有 ${out.length} 条 —— 疑似登记表异常，拒绝清理（确认登记表真出事、就是要清：勾选「强制清理」）`,
        registryAnomaly: true,
        anomalyCount: out.length,
        anomalyIds: out.map((s) => s.id),
        sessions: [],
        totalMB: 0,
        visibleCount: 0,
      }
    }
    return {
      ok: true,
      registryAnomaly: true,
      reason: `登记表里一条可见会话都没有，但盘上有 ${out.length} 条 —— 疑似登记表异常（已按你的强制勾选放行，这批清单的可信度自负）`,
      sessions: out,
      totalMB: +(totalBytes / 1048576).toFixed(2),
      totalBytes,
      visibleCount: 0,
      familyCount,
      scannedAt: new Date().toISOString(),
    }
  }
  return {
    ok: true,
    registryAnomaly: false,
    sessions: out,
    totalMB: +(totalBytes / 1048576).toFixed(2),
    totalBytes,
    visibleCount: reg.visible.size,
    familyCount,
    scannedAt: new Date().toISOString(),
  }
}

/* ── F线（2026-10-24）：子代理对话管理 ──────────────────────────
   用户定位：subagent 会话（workflow/subagent 工具派生的子任务）对他「无意义/不可见」
   ——侧栏从不显示、任务完成后就是死数据。权威判据 = 头帧 origin==='subagent'
   （目录名不带 session- 前缀只是伴生特征，不作为判据）。
   清理策略：独立扫描 + 独立清理路由（live 拒删、身份双检、逐个备份后真删）；
   不并进 invisible 的保险链——那是「登记表缺失」的世界，这是「明确身份」的世界。 */
export function scanSubagentSessions(home = dshHomeDir(), options = {}) {
  const ctxHint = options.ctx
  const dirs = sessionDirs(home)
  const out = []
  let totalBytes = 0
  for (const [sid, info] of dirs) {
    const h = readSessionHeader(info.file)
    if (h?.origin !== 'subagent' && !(typeof h?.delegationDepth === 'number' && h.delegationDepth > 0)) continue
    const live = ctxHint ? isSessionLive(ctxHint, sid) : false
    totalBytes += info.sizeBytes
    out.push({
      id: sid,
      title: sessionTitleLite(home, sid, info) ?? null,
      sizeMB: +(info.sizeBytes / 1048576).toFixed(2),
      sizeBytes: info.sizeBytes,
      mtime: new Date(info.mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
      live,
      depth: h?.delegationDepth ?? null,
    })
  }
  out.sort((a, b) => b.sizeMB - a.sizeMB)
  return { ok: true, sessions: out, totalMB: +(totalBytes / 1048576).toFixed(2), count: out.length, scannedAt: new Date().toISOString() }
}

/** F线：子代理会话路由：GET 清单 / POST 清理（ids 显式 + live 双检 + 备份 + 真删）。 */
export function installSubagentRoute(ctx, config = {}) {
  if (config?.invisiblePanel === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') return false
    const reply = (res, status, obj) => {
      try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
    }
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/subagent',
      handler: async (req, res) => {
        if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        try { return reply(res, 200, { ok: true, value: scanSubagentSessions(dshHomeDir(), { ctx }) }) }
        catch (e) { return reply(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    })
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/subagent/purge',
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          let body = ''
          for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('body too large') }
          const parsed = JSON.parse(body || '{}')
          if (!Array.isArray(parsed?.ids) || parsed.ids.length === 0) return reply(res, 400, { ok: false, error: 'ids required' })
          const home = dshHomeDir()
          const results = []
          let freedBytes = 0
          for (const rawId of parsed.ids) {
            const sid = String(rawId)
            try {
              if (isSessionLive(ctx, sid)) { results.push({ id: sid, status: 'live-refused' }); continue }
              const info = sessionDirs(home).get(sid)
              if (!info) { results.push({ id: sid, status: 'not-found' }); continue }
              const h = readSessionHeader(info.file)
              /* 身份双检：只删真 subagent（防 id 伪造端掉普通会话）。 */
              if (h?.origin !== 'subagent' && !(typeof h?.delegationDepth === 'number' && h.delegationDepth > 0)) {
                results.push({ id: sid, status: 'not-subagent' }); continue
              }
              const backupDir = home + '/' + TRUE_DELETE_BACKUP_DIR + '-subagent'
              try {
                mkdirSync(backupDir, { recursive: true })
                copyFileSync(info.file, backupDir + '/' + sid + '.jsonl.zstd')
              } catch { /* 备份尽力而为：用户已确认，subagent 本就是可弃数据 */ }
              rmSync(info.file, { force: true })
              try { rmSync(join(info.dir, 'session.lock'), { force: true }) } catch { /* 无锁正常 */ }
              try { const left = readdirSync(info.dir); if (left.length === 0) rmSync(info.dir, { recursive: true, force: true }) } catch { /* ignore */ }
              freedBytes += info.sizeBytes
              results.push({ id: sid, status: 'deleted' })
            } catch (e) { results.push({ id: sid, status: 'failed', error: String(e?.message ?? e).slice(0, 120) }) }
          }
          const deletedCount = results.filter((r) => r.status === 'deleted').length
          appendCompatLog(`subagent purge: deleted=${deletedCount} refused=${results.filter((r) => r.status === 'live-refused').length} freedMB=${(freedBytes / 1048576).toFixed(2)}`)
          return reply(res, 200, { ok: true, deletedCount, freedMB: +(freedBytes / 1048576).toFixed(2), results })
        } catch (e) { return reply(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    })
    appendCompatLog('subagent routes registered')
    return true
  } catch (e) {
    appendCompatLog('subagent route FAILED: ' + String(e?.message ?? e).slice(0, 160))
    return false
  }
}

/** 不可见会话路由：GET 清单 / POST 删除（不带 write 即干跑）。 */

export function installInvisibleRoute(ctx, config = {}) {
  if (config?.invisiblePanel === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') {
      appendCompatLog('invisible route: webServer unavailable')
      return false
    }
    const reply = (res, status, obj) => {
      try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
    }
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/invisible',
      handler: async (req, res) => {
        if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          /* force=1：连「登记表疑似异常」这道保险也放行——只为把清单给出来（真要删还得 POST 里再带 force）。
             family=0：不算「版本家族成员」标注（省一次全盘读头，30s 缓存）。默认算，面板要显示谁受保护。 */
          const url = new URL(req.url, 'http://127.0.0.1')
          const force = url.searchParams.get('force') === '1'
          const withFamily = url.searchParams.get('family') !== '0'
          return reply(res, 200, { ok: true, value: scanInvisibleSessions(dshHomeDir(), { force, withFamily }) })
        } catch (e) { return reply(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    })
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/invisible/purge',
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        let body = ''
        try {
          for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('body too large') }
          const parsed = JSON.parse(body || '{}')
          /* force:true = 用户在面板上勾了「我已确认，强制清理」并再次确认过。
             它放行的是两道**保险**，不是红线：
               · 版本家族保护（默认只记账不动刀）→ 放行；
               · 登记表疑似异常的整批拒绝 → 放行（清单仍带 registryAnomaly 标记回报）；
               · 批量确认（guardDeletion 的 confirmBulk）→ 由 force 代签。
             仍然硬拒绝：登记表里可见/归档的会话、正在使用的当前会话。 */
          const force = parsed?.force === true
          const home = dshHomeDir()
          const scan = scanInvisibleSessions(home, { force, withFamily: true })
          if (scan.ok !== true) {
            return reply(res, 409, {
              ok: false,
              error: scan.reason,
              registryAnomaly: scan.registryAnomaly === true,
              /* 保险拦下的原因清单：前端据此显示「因为有保险所以没删」，而不是只给一句错。 */
              blocked: scan.registryAnomaly === true
                ? [{ reason: 'registry-anomaly', count: scan.anomalyCount ?? 0, ids: (scan.anomalyIds ?? []).slice(0, 50) }]
                : [],
            })
          }
          const wanted = Array.isArray(parsed?.ids) && parsed.ids.length > 0
            ? scan.sessions.filter((s) => parsed.ids.includes(s.id))
            : scan.sessions
          if (wanted.length === 0) return reply(res, 200, { ok: true, results: [], skipped: [], freedMB: 0, note: '没有不可见会话' })
          /* 家族保护：默认逐条跳过并记账（与 purgeTombstones 同一套规矩），skipped 里回报原因。 */
          const targets = force ? wanted : wanted.filter((s) => s.family !== true)
          const skipped = (force ? [] : wanted.filter((s) => s.family === true)).map((s) => ({
            id: s.id,
            title: s.title ?? null,
            sizeMB: s.sizeMB,
            reasons: ['family-protected'],
            note: '版本家族成员（有 parentSession 或被子会话引用）：切版本还要用到，默认不动刀',
          }))
          /* 全被保险跳过时**不能**去调 guardDeletion —— 空名单会得到一句「没有指定要删除的会话」，
             看起来像坏了。直接回报「一条都没删 + 原因清单」，用户勾强制再来一次。 */
          if (targets.length === 0) {
            return reply(res, 200, {
              ok: true,
              forced: force,
              registryAnomaly: scan.registryAnomaly === true,
              results: [],
              skipped,
              freedMB: 0,
              deletedCount: 0,
              skippedCount: skipped.length,
              note: '全部被保险跳过：勾选「我已确认，强制清理」并再次确认才会删',
            })
          }
          /* 删除守卫（可见会话硬拒绝 + 批量需 confirmBulk）——见 guardDeletion 注释。
             force 代签 confirmBulk（用户已经二次确认过要全清），其余规则一条不放。 */
          const guard = guardDeletion(home, targets.map((s) => s.id), { ...parsed, confirmBulk: parsed.confirmBulk === true || force })
          if (guard.ok !== true) {
            /* 整批被保险拒绝时，把原因结构化回报（前端要显示「是保险挡的，不是坏了」）。 */
            const blocked = []
            if (Array.isArray(guard.details?.visible)) {
              blocked.push({ reason: 'visible-refused', count: guard.details.visible.length, ids: guard.details.visible.slice(0, 50) })
            }
            if (Number.isFinite(guard.details?.count)) {
              blocked.push({ reason: 'bulk-limit', count: guard.details.count, ids: (guard.details.ids ?? []).slice(0, 50), limit: BULK_DELETE_LIMIT })
            } else if (Array.isArray(guard.details?.ids)) {
              blocked.push({ reason: 'self-session', count: guard.details.ids.length, ids: guard.details.ids.slice(0, 50) })
            }
            return reply(res, 409, { ok: false, error: guard.error, details: guard.details, blocked })
          }
          if (parsed.write !== true) {
            return reply(res, 200, {
              ok: true,
              dryRun: true,
              forced: force,
              registryAnomaly: scan.registryAnomaly === true,
              skipped,
              results: targets.map((s) => ({ id: s.id, status: 'planned', sizeMB: s.sizeMB })),
            })
          }
          const results = targets.map((s) => deleteSessionDir(ctx, home, s.id))
          /* 没删掉的（运行中/文件不在/出错）也进原因清单，别再静默跳过。 */
          for (const r of results) {
            if (r.status === 'deleted') continue
            const s = targets.find((x) => x.id === r.id)
            skipped.push({ id: r.id, title: s?.title ?? null, sizeMB: s?.sizeMB ?? 0, reasons: [r.status], note: r.error ?? '' })
          }
          const freedMB = +results.reduce((a, b) => a + (b.freedMB ?? 0), 0).toFixed(2)
          const deletedCount = results.filter((r) => r.status === 'deleted').length
          appendCompatLog(`invisible purge: freed ${freedMB}MB of ${targets.length} (${deletedCount} deleted)${force ? ' [FORCE]' : ''}${skipped.length ? ` skipped ${skipped.length}` : ''}`)
          return reply(res, 200, {
            ok: true,
            forced: force,
            registryAnomaly: scan.registryAnomaly === true,
            results,
            skipped,
            freedMB,
            deletedCount,
            skippedCount: skipped.length,
          })
        } catch (error) {
          return reply(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    appendCompatLog('invisible route registered')
    return true
  } catch (e) {
    appendCompatLog('invisible route FAILED: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
}

/**
 * 扫除器：把「不可见 && 非 live && 静默超过宽限」的会话定期真删。
 *
 * 安全阀（缺一不可；任何一个不满足就跳过，宁可留着）：
 *   1. 登记表读不到 → 整轮放弃；
 *   2. 是当前会话（DSH_SESSION_ID）→ 永不删；
 *   3. live（内存里活着）→ 跳过，交给下一轮；
 *   4. 静默未满宽限（默认 30 分钟）→ 跳过（刚分叉/刚建那会儿会话还没登记）。
 *
 * 默认**关**：真删不可逆，要用户在面板里显式打开（config.sweepInvisible === true）。
 */

export function installInvisibleSweeper(ctx, config = {}) {
  if (config?.sweepInvisible !== true) {
    appendCompatLog('invisible sweeper: disabled (config.sweepInvisible !== true)')
    return () => {}
  }
  const home = dshHomeDir()
  const graceMs = Number.isFinite(config?.sweepGraceMs) ? Number(config.sweepGraceMs) : 30 * 60e3
  const intervalMs = Number.isFinite(config?.sweepIntervalMs) ? Number(config.sweepIntervalMs) : 10 * 60e3
  const run = (trigger) => {
    try {
      const scan = scanInvisibleSessions(home)
      if (scan.ok !== true) { appendCompatLog(`invisible sweep(${trigger}): skipped — ${scan.reason}`); return }
      const now = Date.now()
      const me = currentSessionId()
      const targets = scan.sessions.filter((s) => s.id !== me && now - s.mtimeMs > graceMs && !isSessionLive(ctx, s.id))
      if (targets.length === 0) {
        appendCompatLog(`invisible sweep(${trigger}): nothing to do (${scan.sessions.length} invisible, all within grace or live)`)
        return
      }
      let freed = 0
      const done = []
      for (const t of targets) {
        const r = deleteSessionDir(ctx, home, t.id)
        if (r.status === 'deleted') { freed += r.freedMB ?? 0; done.push(t.id) }
      }
      appendCompatLog(`invisible sweep(${trigger}): deleted ${done.length}, freed ${freed.toFixed(2)}MB [${done.join(' ')}]`)
    } catch (error) {
      appendCompatLog(`invisible sweep(${trigger}) FAILED: ${String(error?.message ?? error)}`)
    }
  }
  /* 自动扫除已取消（2026-10-16）：不再有 boot / interval 定时器，
     只能由面板「一键清理不可见会话」显式触发一次 run()。 */  appendCompatLog(`invisible sweeper: enabled (grace ${Math.round(graceMs / 60000)}min, interval ${Math.round(intervalMs / 60000)}min)`)
  return () => {}
}

/** 客户端半身自我报到路由：把浏览器侧的注册结果落进宿主日志（诊断用，带 UA 以区分爬。便于区分「浏览器没加载新代码」与「加载了但注册失败」）。 */

export function readRegistryIds(home = dshHomeDir()) {
  try {
    const file = `${home}/storages/workspace.json`
    if (!existsSync(file)) return null
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const tables = doc?.tables?.workspaces
    /* ⚠️ 数组也是 object：不显式挡掉的话，tables.workspaces=[] 会通过校验、
       visible 空集 → 全部会话被当成「不可见」→ 退化成全删（单测抓到过）。 */
    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) return null
    const visible = new Set()
    const workspaceIds = new Set()
    for (const wid of Object.keys(tables)) {
      workspaceIds.add(wid)
      const rec = tables[wid]
      if (Array.isArray(rec?.sessionIds)) for (const sid of rec.sessionIds) if (typeof sid === 'string') visible.add(sid)
    }
    const archived = new Set()
    if (Array.isArray(doc?.global?.archivedSessionIds)) {
      for (const sid of doc.global.archivedSessionIds) if (typeof sid === 'string') archived.add(sid)
    }
    return { visible, archived, workspaceIds }
  } catch {
    return null
  }
}

/**
 * 当前 DSH 会话 id（进程环境变量 DSH_SESSION_ID）。
 *
 * ⚠️ 2026-10-16 补：这个函数被 installInvisibleSweeper 与 guardDeletion 调用，
 * 但**从未定义过**（HEAD 里就是悬空的）——扫除器一旦真正运行就会 ReferenceError。
 * 扫除器长期处于 disabled，所以这个坑一直没炸；守卫上线后被单测抓到。
 * @returns 会话 id；环境变量缺失时返回空串（调用方按「不匹配」处理）。
 */
export function currentSessionId(env = process.env) {
  const v = env?.DSH_SESSION_ID
  return typeof v === 'string' ? v : ''
}

/**
 * 删除守卫（2026-10-16 事故后新增，所有真删入口必须过这里）。
 *
 * 事故背景：我一次 `/versions/purge` 用 API 删掉 11 个会话，而它们在侧栏里
 * 是用户**看得见**的。真删除不可逆（其中有 6 个再也找不回来）。
 * 所以把「用户可见的会话」做成**硬拒绝**——不是提示、不是默认值，是拒绝执行。
 *
 * 三条规则：
 *   ① 登记表里可见（workspace.json 的 sessionIds / archivedSessionIds）→ 拒绝，永不删；
 *   ② 一次超过 BULK_LIMIT 个 → 必须显式 confirmBulk:true（防脚本/误操作批量误删）；
 *   ③ 当前会话（DSH_SESSION_ID）→ 拒绝。
 *
 * @returns {{ok:true} | {ok:false, error:string, details?:object}}
 */
export const BULK_DELETE_LIMIT = 3

export function guardDeletion(home, ids, options = {}) {
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x)
  if (list.length === 0) return { ok: false, error: '没有指定要删除的会话' }

  const me = currentSessionId()
  const selfHit = list.filter((id) => id === me)
  if (selfHit.length > 0) return { ok: false, error: '拒绝删除当前正在使用的会话', details: { ids: selfHit } }

  const reg = readRegistryIds(home)
  if (reg !== null) {
    const visible = list.filter((id) => reg.visible.has(id) || reg.archived.has(id))
    if (visible.length > 0) {
      appendCompatLog(`删除守卫拦下 ${visible.length} 个「可见会话」: ${visible.slice(0, 6).join(' ')}`)
      return {
        ok: false,
        error: `拒绝删除 ${visible.length} 个在侧栏里可见的会话（可见会话永不自动删除；要删请在会话列表里手动删）`,
        details: { visible: visible.slice(0, 20) },
      }
    }
  }

  if (list.length > BULK_DELETE_LIMIT && options.confirmBulk !== true) {
    return {
      ok: false,
      error: `一次删除 ${list.length} 个会话超过上限 ${BULK_DELETE_LIMIT}，需要显式 confirmBulk:true（防误操作批量误删）`,
      details: { count: list.length, ids: list.slice(0, 20) },
    }
  }
  return { ok: true }
}

/** 扫不可见会话：盘上有、登记表里任何列表都没有。 */

export function installHelloRoute(ctx, config = {}) {
  if (config?.helloRoute === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') return false
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/client-hello',
      handler: async (req, res) => {
        const reply = (status, obj) => {
          try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
        }
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        let body = ''
        try {
          for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('body too large') }
          const f = JSON.parse(body || '{}')
          const ua = String(req.headers['user-agent'] ?? '').slice(0, 110)
          appendCompatLog(`client-hello marker=${f.marker ?? '?'} nested=${f.nested} fallback=${f.fallback} skExtraEntries=${f.skExtraEntries} injectThrew=${f.injectThrew ?? '-'} renderSlotSeen=${f.renderSlotSeen ?? '-'} ua=${ua}`)
          return reply(res, 200, { ok: true })
        } catch (error) {
          return reply(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    return true
  } catch (e) {
    appendCompatLog('hello route FAILED: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
}

/** 真删一个会话目录（含 projcache），返回释放字节数；live 会话拒删。 */
export function deleteSessionDir(ctx, home, sid) {
  const dirs = sessionDirs(home)
  const info = dirs.get(sid)
  if (!info) return { id: sid, status: 'not-found', freedMB: 0 }
  if (isSessionLive(ctx, sid)) return { id: sid, status: 'live-refused', freedMB: 0 }
  const freed = info.sizeBytes
  try {
    /* ⚠️ 语义就是**真删除**（用户的插件本来就叫 true-delete：删掉不留墓碑、不留副本）。
        2026-10-16 曾被我加过「回收站」，用户否决：那不是真删除。
        真正的护栏不在这里 —— 第一层防护是「**只允许显式用户操作触发**」：
          · 自动扫除已停（sweepInvisible 默认 false，且不再有定时器）；
          · 版本家族清理必须走面板两步确认；
          · 墓碑切除的整轮误判已在 purge.js 修掉（memory-* 载体一律只外科摘除）。
        调用方若来自自动化路径，请先回到「用户点了什么」这件事上重新想。 */
    rmSync(info.dir, { recursive: true, force: true })
    try { rmSync(`${home}/storages/session_projcache/sessions/${sid}.json`, { force: true }) } catch { /* ignore */ }
    familyCache = { at: 0, ids: new Set() }
    appendCompatLog(`true-delete: removed ${sid} (${(freed / 1048576).toFixed(2)}MB)`)
    return { id: sid, status: 'deleted', freedMB: +(freed / 1048576).toFixed(2) }
  } catch (error) {
    return { id: sid, status: 'failed', error: String(error?.message ?? error), freedMB: 0 }
  }
}

/** 版本家族路由：GET 清单 / POST 真删。 */
export function installVersionsRoute(ctx, config = {}) {
  if (config?.versionsPanel === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') {
      appendCompatLog('versions route: webServer unavailable')
      return false
    }
    const reply = (res, status, obj) => {
      try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
    }
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/versions',
      handler: async (req, res) => {
        if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        try { return reply(res, 200, { ok: true, value: scanVersionFamilies() }) }
        catch (e) { return reply(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    })
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/versions/purge',
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        let body = ''
        try {
          for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('body too large') }
          const parsed = JSON.parse(body || '{}')
          const ids = Array.isArray(parsed?.ids) ? parsed.ids.filter((x) => typeof x === 'string' && x) : []
          if (ids.length === 0) return reply(res, 400, { ok: false, error: 'ids required' })
          const home0 = dshHomeDir()
          /* 删除守卫：可见会话硬拒绝、批量需 confirmBulk —— 2026-10-16 我就是在这里一次删了 11 个。 */
          const guard0 = guardDeletion(home0, ids, parsed)
          if (guard0.ok !== true) return reply(res, 409, { ok: false, error: guard0.error, details: guard0.details })
          if (parsed.write !== true) {
            return reply(res, 200, {
              ok: true,
              dryRun: true,
              results: ids.map((id) => ({ id, status: 'planned' })),
            })
          }
          const home = dshHomeDir()
          const results = ids.map((id) => deleteSessionDir(ctx, home, id))
          const freedMB = +results.reduce((a, b) => a + (b.freedMB ?? 0), 0).toFixed(2)
          appendCompatLog(`versions purge（用户显式操作）: freed ${freedMB}MB ids=${ids.join(' ')}`)
          return reply(res, 200, { ok: true, results, freedMB })
        } catch (error) {
          return reply(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    appendCompatLog('versions route registered')
    return true
  } catch (e) {
    appendCompatLog('versions route FAILED: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
}


/**
 * 手动触发路由（2026-10-16 用户要求「也要允许手动启动校准」）：
 *   POST /dsh-adapter-compat/calibrate-now  —— 立刻跑一次 contextPressure 校准
 *   POST /dsh-adapter-compat/warm-now       —— 立刻跑一次标题预热 + 重扫
 * 两条都不受「开机/变化」开关影响：开关关着也能手动跑。
 */
export function installManualRoutes(ctx, config = {}) {
  if (config?.manualRoutes === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') return false
    const reply = (res, status, obj) => {
      try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
    }
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/calibrate-now',
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          if (typeof compatHooks.calibrate !== 'function') return reply(res, 503, { ok: false, error: '校准未安装（插件未加载完或已关闭）' })
          compatHooks.calibrate(true)
          appendCompatLog('calibrate-now: 手动触发')
          return reply(res, 200, { ok: true })
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/warm-now',
      handler: async (req, res) => {
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const r = await runTitleWarmNow(ctx)
          return reply(res, r.ok ? 200 : 500, r)
        } catch (error) {
          return reply(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    appendCompatLog('manual routes registered (calibrate-now / warm-now)')
    return true
  } catch (e) {
    appendCompatLog('manual routes FAILED: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
}

/* ============ 第十三层：出口规范化（2026-10-17 重做） ============
 *
 * 前身是 2026-10-16 的「正文 <thinking> 标签剥离」，**挂载点搞错了**：
 * 它包的是 `ctx.llm.stream`，而主循环（dsh-agent-loop）走的是
 * `preparedCall.stream(request)` → `LlmRuntime.streamWithRegistration` →
 * `ctx.waterfall(this, 'llm/stream', …)` —— **根本不经过 llm.stream**。
 * 证据：本插件日志里「剥离正文开头」计数恒为 0（装了，但从未被调到）。
 *
 * 现在统一挂 `llm/stream` 瀑布（provider 产出 chunk 的唯一必经点），
 * 并扩到两类症状（都见 egress.js 顶部注释）：
 *   ① 思考链被当正文（上游把 thinking 同时写进 content）
 *   ② XML 式工具调用漏成正文（解析失败被原样吐出）
 *
 * 实现全在 egress.js（纯函数 + 流式状态机），这里只负责接线与配置读取。
 * 关闭：cordis.patch.yml 本插件行 config.egressNormalize: false。
 */

/** 思考标签剥离（薄封装，保留旧导出名给单测/排查用）。 */
export function stripLeadingThinking(text, inTag = false) {
  return stripLeadingThinkingPure(text, inTag)
}

/**
 * 装出口规范化器。作用域与开关全部走 heal options（设置页可改，重启生效）：
 *   egressScope: 'all' | 'web' | 'off'   （web = 只对网页端路由生效）
 *   egressThinking: boolean
 *   egressXmlTools: 'strip' | 'convert' | 'off'
 */
export function installEgressNormalizer(ctx, config = {}) {
  return installEgressNormalizerImpl(ctx, config, {
    log: (line) => appendCompatLog(line),
    readOptions: () => readHealOptions(),
  })
}

/**
 * 向后兼容别名（旧名）。旧实现是包 `ctx.llm.stream` —— **那条路主循环根本不走**，
 * 所以旧版实际上没生效；这里直接指向新的正确实现，避免旧配置/脚本引用悬空。
 */
export function installThinkingTagFilter(ctx, config = {}) {
  return installEgressNormalizer(ctx, config)
}

/**
 * 自检状态：供两端（电脑/手机）一眼确认出口规范化到底装没装、有没有生效。
 * 2026-10-16 用户「搬到手机后思考链又出现在正文」——最常见原因就是那台机器上的
 * adapter-compat 还是旧版（没有本层）。
 */
export function pluginSelfCheck(ctx) {
  const llm = ctx?.llm ?? (typeof ctx?.get === 'function' ? ctx.get('llm') : undefined)
  const heals = readHealOptions()
  let installed = false
  try { installed = llm?.[EGRESS_NORMALIZER] === true } catch { installed = false }
  let version = 'unknown'
  try {
    const here = fileURLToPath(import.meta.url)
    const pkg = JSON.parse(readFileSync(`${here.replace(/[\\/][^\\/]*$/, '')}/../package.json`, 'utf8'))
    version = String(pkg.version ?? 'unknown')
  } catch { /* ignore */ }
  return {
    version,
    egress: {
      installed,
      scope: heals.egressScope,
      thinking: heals.egressThinking !== false,
      xmlToolCalls: heals.egressXmlTools,
      stats: { ...egressStats },
    },
    cadence: {
      changeRescan: heals.changeRescan !== false,
      changePurge: heals.changePurge !== false,
      changeHeadGuard: heals.changeHeadGuard !== false,
      watchDebounceMs: heals.watchDebounceMs,
      watchPollMs: heals.watchPollMs,
      bootTitleWarm: heals.bootTitleWarm !== false,
      bootHeadGuard: heals.bootHeadGuard !== false,
      bootTrueDelete: heals.bootTrueDelete !== false,
      pressureCalibration: heals.pressureCalibration !== false,
      pressureCalibrationIntervalMs: heals.pressureCalibrationIntervalMs,
    },
  }
}

/** 自检路由：GET /dsh-adapter-compat/selfcheck（手机端也能 curl 一眼看）。 */
export function installSelfCheckRoute(ctx, config = {}) {
  if (config?.selfCheckRoute === false) return false
  try {
    const web = serviceOf(ctx, 'webServer')
    if (!web || typeof web.register !== 'function') return false
    web.register({
      kind: 'exact',
      path: '/dsh-adapter-compat/selfcheck',
      handler: async (req, res) => {
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, value: pluginSelfCheck(ctx) }, null, 1))
        } catch (error) {
          try { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) })) } catch { /* ignore */ }
        }
      },
    })
    appendCompatLog('selfcheck route registered')
    return true
  } catch (e) {
    appendCompatLog('selfcheck route FAILED: ' + String(e?.message ?? e).slice(0, 200))
    return false
  }
}

export function apply(ctx, config = {}) {
  // -3) 会话改工作区：路由（不依赖 llm，排在早退之前）
  try {
    installMoveRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.5) 会话瘦身：路由（不依赖 llm，排在早退之前）
  try {
    installSlimRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.51) A线：开机自动瘦身（autoSlim 默认关——关着时这里零成本直接 return）
  try {
    installAutoSlim(ctx)
  } catch {
    /* 自动瘦身失败绝不拖垮 apply；手动瘦身路由照常可用 */
  }

  // -3.55) 断号修复：路由（强退丢批兜底，不依赖 llm，排在早退之前）
  try {
    installRepairRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.57) 压缩 .txt 出口 + 版本分页器开关：设置读写路由（不依赖 llm，排在早退之前）
  try {
    installExitRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.58) 版本家族清单 + 手动清理路由（不依赖 llm）
  try {
    installVersionsRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.59) 客户端自我报到路由（诊断：区分「浏览器缓存旧代码」与「注册失败」）
  try {
    installHelloRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.59) 不可见会话（侧栏选不出来的）清单 + 清理路由
  try {
    installInvisibleRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.585) F线：子代理对话管理（扫描 + 清理路由；随 invisiblePanel 开关）
  try {
    installSubagentRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.60) 不可见扫除器（默认关，面板里显式打开）
  try {
    installInvisibleSweeper(ctx, config)
  } catch {
    /* 扫除器起不来不拖垮 apply */
  }

  // -3.61) 手动触发路由（立即校准 / 立即重扫；不受开机与变化开关影响）
  try {
    installManualRoutes(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -3.7) 出口规范化（思考链/XML 工具调用被当正文；挂 llm/stream 瀑布，越早装越好）
  try {
    installEgressNormalizer(ctx, config)
  } catch {
    /* 规范化装不上不能拖垮 apply */
  }

  // -3.71) 自检路由（两端一眼确认版本与出口规范化状态）
  try {
    installSelfCheckRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  /* -3.56) 开机一次性扫（2026-10-13 用户定案）：
     只有 bootScan 开着才跑；**一次性，不加定时器**（用户明确不要频繁扫盘吃内存）。
     延时 15s 启动（等宿主把会话/注册表就绪，避免和启动潮抢 IO），
     遵守 skipUnchanged（只 stat 跳过未变的），live 会话自动跳过。 */
  try {
    const boot = readHealOptions()
    if (boot.bootScan) {
      const t = setTimeout(async () => {
        try {
          appendCompatLog('boot-heal: start（一次性）')
          const state = boot.skipUnchanged ? readHealState(dshHomeDir()) : {}
          let healed = 0, unchanged = 0, live = 0, failed = 0
          for (const entry of listSessionFiles(dshHomeDir())) {
            try {
              if (boot.skipUnchanged) {
                const fp = fileFingerprint(entry.file)
                const prev = state[entry.id]
                if (fp && prev && prev.size === fp.size && prev.mtimeMs === fp.mtimeMs) { unchanged += 1; continue }
              }
              const r = await healSessionFile(ctx, entry.id, { write: true })
              if (!r.alreadyHealthy) healed += 1
            } catch (e) {
              if (e?.code === 'SESSION_LIVE') live += 1
              else failed += 1
            }
          }
          appendCompatLog(`boot-heal: done healed=${healed} unchanged=${unchanged} live=${live} failed=${failed}`)
        } catch (e) { appendCompatLog('boot-heal failed: ' + String(e?.message ?? e).slice(0, 160)) }
      }, 15000)
      if (typeof t.unref === 'function') t.unref()
    } else {
      appendCompatLog('boot-heal: 已关闭（设置页可开）')
    }
  } catch { /* 开机扫失败绝不影响启动 */ }

  // -3.6) 侧栏排序：路由（工作区/会话顺序，只读写宿主 registry，不碰 workspace.json）
  try {
    installOrderRoute(ctx, config)
  } catch {
    /* 路由注册失败绝不拖垮 apply */
  }

  // -1) 会话盘监视 + 标题投影预热（不依赖 llm，必须排在 llm 早退之前）
  try {
    installTitleWarm(ctx, config)
  } catch {
    /* 预热失败绝不拖垮 apply */
  }

  // -2) 真删除：物理切除墓碑（不依赖 llm，必须排在 llm 早退之前）
  try {
    installTrueDelete(ctx, config)
  } catch {
    /* 清理失败绝不拖垮 apply */
  }

  // -1.4) 线级取证探针：把 provider 真正收到的 messages 结构落盘（llm-wire.jsonl）
  try {
    installWireTap(ctx, config, { getOptions: () => readHealOptions() })
  } catch {
    /* 探针失败绝不拖垮 apply */
  }

  // -1.5) 受保护系统头守卫：补「无头哑弹」（真删除最容易把 system 头拔掉）
  //       必须排在真删除之后：afterPurge 定向补扫要靠这里的 compatHooks.headGuard。
  try {
    installHeadGuard(ctx, config)
  } catch {
    /* 守卫失败绝不拖垮 apply */
  }

  // 0) 上下文占用校准（不依赖 llm，必须排在下面的 llm 早退之前）
  const installPressureCalibration = (final = false) => {
    try {
      const projections = serviceOf(ctx, 'sessionProjections')
      setPressureReserveTokens(config?.contextReserveTokens ?? pressureReserve.tokens)
  const patchedNow = calibrateContextPressure(projections)
      /* 落盘铁证：既报走了哪条挂接路径，也报一次算术自证。
         合成状态 pressure=200000 / surface=150000 / sampled=100000（倍率 2）：
         官方公式给 200000+50000=250000，校准后必须是 300000。 */
      const probe = calibratePressureView(
        { pressureTokens: 200000, surfaceTokens: 150000, sampledSurfaceTokens: 100000 },
        { pressureTokens: 200000, projectedTokens: 250000 },
      )
      const registerWrapped = projections?.register?.[PRESSURE_CALIBRATED] === true
      let unitWrapped = false
      try {
        for (const registration of projections?.registrations?.values?.() ?? []) {
          if (registration?.def?.key === 'contextPressure') {
            unitWrapped = registration.def.wire?.view?.[PRESSURE_CALIBRATED] === true
          }
        }
      } catch {
        /* 无 registrations 面 */
      }
      // 最后一次重试必写一行，其余只在有变化时写——启动最多 4 行，不刷屏
      if (final || patchedNow > 0 || registerWrapped || unitWrapped) {
        appendCompatLog(
          `contextPressure calibration: patchedNow=${patchedNow} registerWrapped=${String(registerWrapped)} unitWrapped=${String(unitWrapped)} probeProjected=${String(probe?.projectedTokens)}`,
        )
      }
      if (patchedNow > 0) {
        ctx.logger?.info?.(`[adapter-compat] contextPressure calibrated: units=${patchedNow}`)
      }
    } catch {
      /* 无投影面时静默：这是显示校准，不是硬功能 */
    }
  }
  const onCal = readHealOptions()
  /* 「立即校准」的手动入口：不管开关怎样都能随时跑一次（设置页按钮用）。 */
  compatHooks.calibrate = (final = true) => installPressureCalibration(final)
  if (onCal.pressureCalibration !== false) {
    installPressureCalibration()
    for (const ms of [1000, 3000, 8000]) {
      const t = setTimeout(() => installPressureCalibration(ms === 8000), ms)
      if (typeof t.unref === 'function') t.unref()
    }
    /* 定期重试（用户可配；0 = 只在启动那几轮跑一次，即 2026-10-16 之前的行为）。 */
    if (Number.isFinite(onCal.pressureCalibrationIntervalMs) && onCal.pressureCalibrationIntervalMs > 0) {
      const iv = setInterval(() => installPressureCalibration(true), onCal.pressureCalibrationIntervalMs)
      if (typeof iv.unref === 'function') iv.unref()
      appendCompatLog(`contextPressure calibration: 定期重试已开启（每 ${Math.round(onCal.pressureCalibrationIntervalMs / 1000)}s）`)
    }
  } else {
    appendCompatLog('contextPressure calibration: 自动校准已关闭（仍可用设置页「立即校准」手动跑）')
  }

  const llm = ctx.llm
  if (!llm) return

  // 1) 先于本插件注册的 adapter
  sweep(llm)

  // 2) 包装 registerAdapter：未来注册（含被保护插件的自更新/热重载）先回填再交给宿主
  if (typeof llm.registerAdapter === 'function' && !llm.registerAdapter[WRAPPED]) {
    const original = llm.registerAdapter.bind(llm)
    const wrapped = (providers, adapter) => {
      backfillAdapter(adapter)
      return original(providers, adapter)
    }
    wrapped[WRAPPED] = true
    try {
      llm.registerAdapter = wrapped
      try {
        ctx.effect?.(
          () => () => {
            if (llm.registerAdapter === wrapped) llm.registerAdapter = original
          },
          'adapter-compat: registerAdapter wrap',
        )
      } catch {
        // 无 effect 面也无所谓：包装本身幂等且无害
      }
    } catch {
      // 服务对象不可写时退化为仅扫描模式
    }
  }

  // 3) 拓扑变化时再扫一遍（热重载、replace 等旁路）
  try {
    const off = ctx.on?.('llm/adapters-updated', () => sweep(llm))
    if (typeof off === 'function') {
      try {
        ctx.effect?.(() => off, 'adapter-compat: adapters-updated listener')
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 内核无该事件面时静默 */
  }

  // 4) settings null-Config 防崩守卫（与 autoGate 开关无关，无条件执行）
  let guardInstalled = false
  try {
    /* 只做启动期一次性归一；不接管 settings.schema，避免模型选择页被全局包装影响。 */
    const normalized = normalizeRuntimeConfigs(ctx)
    if (normalized > 0) {
      ctx.logger?.info?.(`[adapter-compat] settings null-Config normalized=${normalized}`)
    }
  } catch {
    // 守卫失败不影响其余两层
  }
  // 延迟补扫：兜住晚注册条目（dsh-sync 在 bundles 中排本插件之后）与守卫未装上的极端形态
  for (const ms of [1000, 3000, 8000]) {
    const t = setTimeout(() => {
      try {
        normalizeRuntimeConfigs(ctx)
      } catch {
        /* 幂等静默 */
      }
    }, ms)
    if (typeof t.unref === 'function') t.unref()
  }

  // 压缩摘要模型跟随已停用：模型选择必须完全交给宿主原生链路。
  // 保留 armSummarizerSelection 导出供旧测试/诊断使用，但不在插件入口挂载。

  // 5) 自动压缩硬闸（默认开；cordis.patch.yml 本插件行 config.autoGate:false 可恢复官方行为）
  if (config?.autoGate === false) return
  armGate(ctx)
}
