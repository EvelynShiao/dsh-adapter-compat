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
 */

export const name = 'adapter-compat'

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

export function apply(ctx, config = {}) {
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
