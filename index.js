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
 */

export const name = 'adapter-compat'

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { purgeSessionFile, readPendingLedger, writePendingLedger } from './purge.js'
import { redactSessionFile } from './purge.js'

export const inject = ['llm']

/** 标记已包装，防止热重载后二次包装。 */
const WRAPPED = Symbol.for('dsh-adapter-compat.wrapped')

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
      stream: (options) => this.stream(options),
    }
  },
}

/**
 * 给一个 adapter 实例回填缺失的基类默认方法。
 * 只在 `typeof adapter[key] !== 'function'` 时写入，已有实现一律不动。
 * @returns {string[]} 实际补上的方法名（幂等调用返回空数组）。
 */
export function backfillAdapter(adapter) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return []
  const added = []
  for (const [key, impl] of Object.entries(BASE_DEFAULTS)) {
    if (typeof adapter[key] === 'function') continue
    try {
      adapter[key] = impl
      added.push(key)
    } catch {
      // 冻结/只读对象：跳过，保持与宿主同样的失败面
    }
  }
  return added
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

/** 可信倍率的下限样本量与上限，越界一律退回官方原值。 */
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
    const pressure = state?.pressureTokens
    const total = state?.surfaceTokens
    const sampled = state?.sampledSurfaceTokens
    if (!Number.isFinite(pressure) || !Number.isFinite(total) || !Number.isFinite(sampled)) return out
    if (pressure <= 0 || sampled < PRESSURE_MIN_SAMPLE) return out
    const ratio = pressure / sampled
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > PRESSURE_MAX_RATIO) return out
    const projected = Math.max(0, Math.round(pressure + (total - sampled) * ratio))
    if (projected === out.projectedTokens) return out
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
  // b) 包装 register：将来注册（token-meter 晚于本插件加载时走这条）
  if (typeof projections.register === 'function' && !projections.register[PRESSURE_CALIBRATED]) {
    const original = projections.register.bind(projections)
    const wrapped = (definition) => {
      try {
        patchDef(definition)
      } catch {
        /* 单个定义失败不拦注册 */
      }
      return original(definition)
    }
    wrapped[PRESSURE_CALIBRATED] = true
    wrapped.original = original
    try {
      projections.register = wrapped
    } catch {
      /* 服务对象不可写时只剩 (a) 路径 */
    }
  }
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
    appendCompatLog(`sessions changed (${key}) -> title warm + rescan`, home)
    Promise.resolve()
      .then(() => rescanAndWarm(ctx, options))
      .catch(() => {})
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
  const options = {
    repairUntitled: config?.titleWarmRepairUntitled !== false,
    max: Number.isFinite(config?.titleWarmMax) ? config.titleWarmMax : undefined,
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
  at(12000, () => warmProjectionTitles(ctx, options))
  at(60000, () => rescanAndWarm(ctx, options))
  return { watch, timers }
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
  for (const entry of listSessionFiles(home)) {
    if (options.only !== undefined && options.only !== entry.id) continue
    if (isSessionLive(ctx, entry.id)) {
      /* live 会话不能整轮切除（内存事件数组会与文件错位），改走**就地擦文本**：
         清掉被删轮次里用户自己的消息正文，Timeline 立刻不再显示；seq/事件数不变，
         内存与文件保持对齐。assistant 回复与思考过程等非 live 时再由 excise 彻底拔。 */
      const red = redactSessionFile(entry.file, entry.id, { sinceMs, write, backupDir })
      if (red.status === 'redacted') {
        writtenIds.add(entry.id)
        delete ledger.pending[entry.id]
        try { rmSync(home + '/storages/session_projcache/sessions/' + entry.id + '.json', { force: true }) } catch { /* ignore */ }
        results.push(red)
      } else if (red.status === 'planned' || red.status === 'skipped') {
        ledger.pending[entry.id] = { removed: red.removed, at: new Date().toISOString(), why: 'live', note: red.notes[0] }
        results.push({ ...red, status: 'live-skipped' })
      }
      continue
    }
    const r = purgeSessionFile(entry.file, entry.id, { write, backupDir, sinceMs })
    if (r.status === 'written') {
      writtenIds.add(entry.id)
      delete ledger.pending[entry.id]
      try { rmSync(home + '/storages/session_projcache/sessions/' + entry.id + '.json', { force: true }) } catch { /* ignore */ }
    } else if (r.status === 'planned') {
      ledger.pending[entry.id] = { turns: r.turns, removed: r.removed, at: new Date().toISOString(), why: 'dry-run' }
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
    appendCompatLog(
      'true-delete[' + tag + '] written=' + written.length + ' liveSkipped=' + liveSkipped.length
        + ' failed=' + failed.length + ' pending=' + r.pending
        + (written.length > 0 ? ' ids=' + written.map((x) => x.sid.slice(0, 16) + '(' + x.events + '->' + x.after + ')').join(' ') : '')
        + (failed.length > 0 ? ' failedIds=' + failed.map((x) => x.sid.slice(0, 16)).join(' ') : ''),
      home,
    )
  }
  const run = (tag) => {
    Promise.resolve()
      .then(() => purgeTombstones(ctx, { home, write: true }))
      .then((r) => summarise(tag, r))
      .catch((e) => appendCompatLog('true-delete[' + tag + '] FAILED: ' + String(e?.message ?? e).slice(0, 160), home))
  }
  // 开机补清：越早越好——那时会话还没被激活（未 live），文件可安全重写
  const timers = []
  for (const ms of [5000, 30000]) {
    const t = setTimeout(() => run('boot+' + (ms / 1000) + 's'), ms)
    if (typeof t.unref === 'function') t.unref()
    timers.push(t)
  }
  /* 触发时机收敛：开机两次 + 会话目录变化后一次（见 rescanAndWarm 的钩子）。
     不再常驻轮询——用户明确要求「开机、下载后扫一下就差不多」。 */
  compatHooks.purge = () => run('hook')
  return { run, timers }
}

export function apply(ctx, config = {}) {
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

  // 0) 上下文占用校准（不依赖 llm，必须排在下面的 llm 早退之前）
  const installPressureCalibration = (final = false) => {
    try {
      const projections = serviceOf(ctx, 'sessionProjections')
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
  installPressureCalibration()
  for (const ms of [1000, 3000, 8000]) {
    const t = setTimeout(() => installPressureCalibration(ms === 8000), ms)
    if (typeof t.unref === 'function') t.unref()
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
    guardInstalled = guardSettingsSchema(ctx)
    const normalized = normalizeRuntimeConfigs(ctx)
    if (guardInstalled || normalized > 0) {
      ctx.logger?.info?.(`[adapter-compat] settings null-Config guard: schemaWrapped=${guardInstalled} normalized=${normalized}`)
    }
  } catch {
    // 守卫失败不影响其余两层
  }
  // 延迟补扫：兜住晚注册条目（dsh-sync 在 bundles 中排本插件之后）与守卫未装上的极端形态
  for (const ms of [1000, 3000, 8000]) {
    const t = setTimeout(() => {
      try {
        guardSettingsSchema(ctx)
        normalizeRuntimeConfigs(ctx)
      } catch {
        /* 幂等静默 */
      }
    }, ms)
    if (typeof t.unref === 'function') t.unref()
  }

  // 5) 自动压缩硬闸（默认开；cordis.patch.yml 本插件行 config.autoGate:false 可恢复官方行为）
  if (config?.autoGate === false) return
  armGate(ctx)
}
