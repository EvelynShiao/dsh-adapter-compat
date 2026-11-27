/**
 * dsh-adapter-compat — 浏览器半身（会话搬家面板）。
 *
 * 唯一职责：在官方设置页里放一行「会话搬家」，点开是一个弹窗——
 * 列出全部会话（按工作区分组，数据来自本插件已有的 /dsh-adapter-compat/slim-list），
 * 选目标工作区后逐条 POST /dsh-adapter-compat/move-session 完成搬迁。
 *
 * 为什么挂在设置页而不是会话管理菜单：手机端没有会话页顶部按钮
 * （侧边栏收成竖条），设置页是唯一两端都够得着的入口。
 *
 * 不依赖 session-kit——列表与搬家两条路由都是本插件自己的；
 * session-kit 保持上游干净版。
 *
 * 手写 ModuleLoader bundle：无构建步骤，除宿主自带的 react 外零依赖。
 * 颜色一律走主题变量，换肤不糊。
 */
window.__ModuleLoader__.load({
  id: 'dsh-adapter-compat',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React
    /* ── ModelSelect：仿 MemorySelect（分组下拉 + 可搜索 + 选中勾）────────────── */
    function ModelSelect({ value, options, disabled, placeholder, ariaLabel, onChange, searchable = false, searchPlaceholder }) {
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const rootRef = React.useRef(null)
      const searchInputRef = React.useRef(null)
      const normalizedOptions = (Array.isArray(options) ? options : []).map((option) => ({ ...option, id: String(option.value) }))
      const selected = normalizedOptions.find((option) => option.id === String(value))
      const label = selected?.composed || selected?.label || placeholder || ''
      const trimmedQuery = query.trim().toLowerCase()
      const visibleOptions = !searchable || trimmedQuery === ''
        ? normalizedOptions
        : normalizedOptions.filter((option) => String(option.label ?? '').toLowerCase().includes(trimmedQuery) || String(option.composed ?? '').toLowerCase().includes(trimmedQuery))
      React.useEffect(() => {
        if (!open) { setQuery(''); return undefined }
        const onPointerDown = (event) => {
          if (!(event.target instanceof Node)) return
          if (rootRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
      React.useEffect(() => {
        if (!open || !searchable) return undefined
        const id = typeof window !== 'undefined' ? window.requestAnimationFrame(() => searchInputRef.current?.focus()) : 0
        return () => { if (typeof window !== 'undefined') window.cancelAnimationFrame(id) }
      }, [open, searchable])
      const selectOption = (option) => {
        if (option.disabled) return
        setOpen(false)
        onChange?.(option.value)
      }
      return h('span', { ref: rootRef, className: 'dsh-chain-select-root' },
        h(primitives.Button, {
          variant: 'outline', size: 'md', disabled,
          className: 'dsh-chain-select-button',
          onClick: () => { if (!disabled) setOpen((current) => !current) },
          'aria-haspopup': 'menu', 'aria-expanded': open,
          'aria-label': ariaLabel || placeholder || label,
        },
          h('span', { className: 'dsh-chain-select-label', title: label }, label),
          h('span', { className: `dsh-chain-select-chevron${open ? ' dsh-chain-select-chevron-open' : ''}`, 'aria-hidden': 'true' },
            h(primitives.IconChevronDownOutlineRegular, { size: 14 }))),
        open && h('div', { className: 'dsh-chain-select-panel', role: 'menu' },
          searchable && h('div', { className: 'dsh-chain-select-search' },
            h('span', { className: 'dsh-chain-select-search-icon', 'aria-hidden': 'true' }, h(primitives.IconSearchOutlineRegular, { size: 14 })),
            h('input', {
              ref: searchInputRef, type: 'text', className: 'dsh-chain-select-search-input',
              value: query, placeholder: searchPlaceholder || placeholder || '',
              'aria-label': searchPlaceholder || ariaLabel || placeholder || '',
              onChange: (event) => setQuery(event.currentTarget.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && visibleOptions.length > 0 && !visibleOptions[0].disabled) {
                  event.preventDefault()
                  selectOption(visibleOptions[0])
                }
              },
              onClick: (event) => event.stopPropagation(),
              onPointerDown: (event) => event.stopPropagation(),
            })),
          visibleOptions.length === 0
            ? h('div', { className: 'dsh-chain-select-empty' }, '—')
            : (() => {
              /* 分组渲染：连续同 group 的选项归为一节，节前插组头（provider 名）。 */
              const sections = []
              for (const option of visibleOptions) {
                const group = typeof option.group === 'string' && option.group !== '' ? option.group : ''
                const last = sections[sections.length - 1]
                if (last === undefined || last.group !== group) sections.push({ group, items: [option] })
                else last.items.push(option)
              }
              return sections.map((section) => h(React.Fragment, { key: section.group || '__ungrouped__' },
                section.group !== '' && h('div', { className: 'dsh-chain-select-group-label' }, section.group),
                section.items.map((option) => h('button', {
                  key: option.id, type: 'button', role: 'menuitem', disabled: option.disabled,
                  className: 'dsh-chain-select-option',
                  'data-selected': option.id === selected?.id || undefined,
                  onClick: () => selectOption(option),
                },
                  h('span', { className: 'dsh-chain-select-option-label', title: option.composed || option.label }, option.label),
                  option.id === selected?.id && h(primitives.IconCheckOutlineRegular, { size: 16 })))))
            })()
          ))
    }

    /* ── 模型目录 hook：与蒸馏同源（ctx.modelDirectories.directoryFor(当前会话)）─────
       目录不可用时返回 groups=[]、status='unavailable'，调用方降级为手输 provider/model。 */
    function useModelDirectory(ctx) {
      const emptyState = React.useMemo(() => ({ current: null, groups: [], status: 'idle', error: null }), [])
      const [state, setState] = React.useState(emptyState)
      React.useEffect(() => {
        let disposed = false
        let retryTimer = null
        let unsubscribe
        let attempts = 0
        const resolveSessionId = () => {
          let sessionId = ''
          const sessions = ctx?.sessions
          /* 与 session-kit 同一把尺子：list 快照中 retainedBy.mainView > 0 的主视图会话。
             兼容其他宿主形态；每一路径独立捕获，拿不到 id 时保持空串并由 directoryFor 外层捕获。 */
          for (const store of [sessions?.list, sessions?.store, sessions]) {
            if (!store || sessionId) continue
            try {
              const snapshot = typeof store?.getSnapshot === 'function' ? store.getSnapshot() : store
              const byId = snapshot?.byId ?? snapshot?.sessions ?? null
              if (byId && typeof byId === 'object') {
                const current = Object.values(byId).find((session) => (session?.retainedBy?.mainView ?? 0) > 0)
                if (current?.id) sessionId = String(current.id)
              }
              if (!sessionId) {
                const current = snapshot?.currentId ?? snapshot?.current
                const id = current && typeof current === 'object' ? current.id ?? current.sessionId : current
                if (id !== undefined && id !== null && String(id)) sessionId = String(id)
              }
            } catch { /* ignore */ }
          }
          for (const key of ['current', 'currentId', 'active', 'activeId', 'currentSessionId']) {
            if (sessionId) break
            try {
              const candidate = sessions?.[key]
              const value = typeof candidate === 'function' ? candidate.call(sessions) : candidate
              const id = value && typeof value === 'object' ? value.id ?? value.sessionId : value
              if (id !== undefined && id !== null && String(id)) sessionId = String(id)
            } catch { /* ignore */ }
          }
          return sessionId
        }
        const attempt = () => {
          if (disposed) return
          attempts += 1
          let directory
          try {
            directory = ctx?.modelDirectories?.directoryFor?.(resolveSessionId())
          } catch { directory = undefined }
          const store = directory?.store
          if (!store) {
            setState({ ...emptyState, status: 'unavailable' })
            if (attempts < 3) retryTimer = setTimeout(attempt, 1500)
            return
          }
          setState(store.getSnapshot?.() ?? emptyState)
          unsubscribe = store.subscribe?.(() => {
            if (!disposed) setState(store.getSnapshot?.() ?? emptyState)
          })
          try {
            const snap = store.getSnapshot?.()
            if (snap?.status === 'idle') void directory.load?.().catch(() => undefined)
          } catch { /* ignore */ }
        }
        attempt()
        return () => {
          disposed = true
          if (retryTimer !== null) clearTimeout(retryTimer)
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [ctx, emptyState])
      return state
    }

    /* ── ChainEditor：链条编辑器（与蒸馏链条卡逐项同构）──────────────────────────
       props: { chain, onChange(nextChain), directory:{groups,status}, t(key), busy,
                followLabel, addLabel, reasoningLabel, providerDefaultLabel } */
    function ChainEditor(props) {
      const { chain, onChange, directory, t, busy } = props
      const items = Array.isArray(chain) ? chain : []
      const safeGroups = Array.isArray(directory?.groups) ? directory.groups : []
      /* 可用判据 = 目录里有模型（groups 非空）。宿主目录快照的 status 字段值不稳定
         （实测 ready 之外还有别的形态），只看 status 会把已加载误判为不可用。 */
      const directoryReady = safeGroups.length > 0
      const setItem = (index, next) => {
        const copy = [...items]
        copy[index] = next
        onChange(copy)
      }
      const move = (index, delta) => {
        const target = index + delta
        if (target < 0 || target >= items.length) return
        const copy = [...items]
        ;[copy[target], copy[index]] = [copy[index], copy[target]]
        onChange(copy)
      }
      const remove = (index) => onChange(items.filter((_, i) => i !== index))
      const addFixed = () => onChange([...items, { type: 'fixed', provider: '', model: '', reasoningEffort: undefined }])
      const addSession = () => onChange([...items, { type: 'session' }])

      const rows = items.map((item, index) => {
        const isSession = item.type === 'session'
        const modelOptions = [
          { value: '__follow_session__', label: props.followLabel, composed: props.followLabel },
          ...safeGroups.flatMap((group) => (Array.isArray(group?.models) ? group.models : []).map((model) => ({
            value: `${group?.id ?? ''}\u001F${model?.id ?? ''}`,
            label: model?.name || model?.id,
            group: group?.name || group?.id,
            composed: `${group?.name || group?.id} / ${model?.name || model?.id}`,
          }))),
        ]
        const handleModelPick = (combined) => {
          if (combined === '__follow_session__') { setItem(index, { type: 'session' }); return }
          const sep = String(combined ?? '').indexOf('\u001F')
          if (sep < 0) return
          const provider = String(combined).slice(0, sep)
          const model = String(combined).slice(sep + 1)
          if (!provider || !model) return
          setItem(index, { ...items[index], type: 'fixed', provider, model })
        }
        /* 思考度选项：按目录里该模型的 reasoning.efforts 出（与蒸馏同款）；
           目录里没有该模型/无 reasoning 信息时不渲染此行。 */
        const selectedGroup = safeGroups.find((group) => group.id === item.provider)
        const selectedModel = (Array.isArray(selectedGroup?.models) ? selectedGroup.models : []).find((model) => model.id === item.model)
        const reasoningOptions = selectedModel?.reasoning ? [
          ...(selectedModel.reasoning.defaultEffort === undefined ? [{ value: '', label: props.providerDefaultLabel }] : []),
          ...(Array.isArray(selectedModel.reasoning.efforts) ? selectedModel.reasoning.efforts : []).map((effort) => ({ value: effort.id, label: effort.name || effort.id })),
        ] : []
        return h('div', { key: index, className: 'dsh-chain-item' },
          h('div', { className: 'dsh-chain-item-header' },
            h('span', { className: 'dsh-chain-item-index' }, `#${index + 1}`),
            h('span', { className: isSession ? 'dsh-chain-item-type-session' : 'dsh-chain-item-type-fixed' },
              isSession ? t('chainSession') : t('chainFixed')),
            h('div', { className: 'dsh-chain-item-actions' },
              index > 0 && h(primitives.Button, { variant: 'ghost', size: 'sm', icon: h(primitives.IconChevronUpOutlineRegular, { size: 14 }), onClick: () => move(index, -1), 'aria-label': t('chainMoveUp') }),
              index < items.length - 1 && h(primitives.Button, { variant: 'ghost', size: 'sm', icon: h(primitives.IconChevronDownOutlineRegular, { size: 14 }), onClick: () => move(index, 1), 'aria-label': t('chainMoveDown') }),
              h(primitives.Button, { variant: 'ghost', size: 'sm', icon: h(primitives.IconTrashOutlineRegular, { size: 14 }), onClick: () => remove(index), 'aria-label': t('chainDelete') }))),
          h('div', { className: 'dsh-chain-item-fields' },
            h('label', { className: 'dsh-chain-field' },
              h('span', null, t('chainModel')),
              h(ModelSelect, {
                value: isSession ? '__follow_session__' : (item.provider && item.model ? `${item.provider}\u001F${item.model}` : ''),
                options: modelOptions,
                disabled: busy || !directoryReady,
                placeholder: safeGroups.length === 0 && directory?.status !== 'unavailable' ? t('chainModelsLoading') : t('chainNoModels'),
                ariaLabel: t('chainModel'),
                searchable: true,
                searchPlaceholder: t('chainSearchModels'),
                onChange: handleModelPick,
              })),
            /* 目录不可用时的兜底：手输 provider/model，保证任何环境都能配置。 */
            !directoryReady && !isSession && h('div', { className: 'dsh-chain-manual' },
              h('input', {
                className: 'dsh-chain-manual-input', placeholder: 'provider',
                value: item.provider ?? '',
                onChange: (e) => setItem(index, { ...items[index], provider: e.target.value }),
              }),
              h('input', {
                className: 'dsh-chain-manual-input', placeholder: 'model',
                value: item.model ?? '',
                onChange: (e) => setItem(index, { ...items[index], model: e.target.value }),
              })),
            !isSession && reasoningOptions.length > 0 && h('label', { className: 'dsh-chain-field' },
              h('span', null, props.reasoningLabel),
              h(ModelSelect, {
                value: item.reasoningEffort || '',
                options: reasoningOptions,
                disabled: busy,
                placeholder: props.providerDefaultLabel,
                ariaLabel: props.reasoningLabel,
                onChange: (effort) => setItem(index, { ...items[index], reasoningEffort: effort || undefined }),
              }))))
      })

      return h('div', { className: 'dsh-chain-editor' },
        ...rows,
        h(primitives.Button, { variant: 'outline', className: 'dsh-chain-add', disabled: busy, onClick: addFixed }, props.addLabel),
        h(primitives.Button, { variant: 'outline', className: 'dsh-chain-add', disabled: busy, onClick: addSession }, props.addSessionLabel))
    }

    /* ── 样式：注入一次（与蒸馏链条卡同款外观，类名加 dsh-chain- 前缀避免撞宿主）── */
    const CHAIN_EDITOR_CSS = `
.dsh-chain-editor { display: flex; flex-direction: column; gap: 10px; }
.dsh-chain-item { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); }
.dsh-chain-item-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dsh-chain-item-index { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 600; }
.dsh-chain-item-type-session, .dsh-chain-item-type-fixed { flex: none; font-size: 11px; line-height: 16px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-chain-item-type-fixed { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, var(--dsw-alias-border-l2)); color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent); }
.dsh-chain-item-actions { display: inline-flex; gap: 4px; }
.dsh-chain-item-fields { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dsh-chain-field { display: grid; gap: 4px; font-size: 12px; }
.dsh-chain-add { align-self: flex-start; margin-top: 4px; font-weight: 600; }
.dsh-chain-manual { display: flex; gap: 8px; flex-wrap: wrap; }
.dsh-chain-manual-input { flex: 1 1 140px; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-strong, #888); background: transparent; color: inherit; font-size: 12px; }
.dsh-chain-select-root { position: relative; display: inline-block; max-width: 100%; }
.dsh-chain-select-label { display: inline-block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
.dsh-chain-select-chevron { display: inline-flex; margin-left: 6px; vertical-align: middle; transition: transform .15s ease; }
.dsh-chain-select-chevron-open { transform: rotate(180deg); }
.dsh-chain-select-panel { position: absolute; z-index: 1200; top: calc(100% + 4px); left: 0; min-width: 240px; max-width: 360px; max-height: 320px; overflow-y: auto; padding: 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base)); box-shadow: var(--dsw-shadow-lv3); }
.dsh-chain-select-search { display: flex; align-items: center; gap: 6px; padding: 4px 6px 8px; }
.dsh-chain-select-search-input { flex: 1; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: inherit; font-size: 12px; }
.dsh-chain-select-group-label { padding: 6px 8px 2px; font-size: 11px; font-weight: 700; color: var(--dsw-alias-label-tertiary); }
.dsh-chain-select-option { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; text-align: left; cursor: pointer; }
.dsh-chain-select-option:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-chain-select-option[data-selected] { color: var(--dsw-alias-state-business-primary); }
.dsh-chain-select-empty { padding: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
`
    let cssInjected = false
    function ensureCss() {
      if (cssInjected || typeof document === 'undefined') return
      cssInjected = true
      const el = document.createElement('style')
      el.setAttribute('data-dsh-chain-editor', '')
      el.textContent = CHAIN_EDITOR_CSS
      document.head.appendChild(el)
    }

    const NS = 'adapter-compat'
    const inject = ['slots', 'locale', 'modelDirectories', 'sessions']
    const LIST_ROUTE = '/dsh-adapter-compat/slim-list'
    const MOVE_ROUTE = '/dsh-adapter-compat/move-session'
    /* 侧栏排序（2026-10-11）：顺序真源在宿主 workspace.json，三条路由都只读写宿主 registry。 */
    const ORDER_READ = '/dsh-adapter-compat/order'
    const ORDER_MOVE_WS = '/dsh-adapter-compat/order/workspace'
    const ORDER_MOVE_SES = '/dsh-adapter-compat/order/session'
    /* 逐工作区展开/折叠记忆（浏览器级，与官方侧栏同一套思路）。 */
    const EXPAND_KEY = 'dsh-adapter-compat.order.expanded'
    /* 官方侧栏 view store 的持久化键（手动顺序存在这里；写它 = 界面活体重排）。 */
    const VIEW_KEY = 'dsh.workspace.view.v5'

    /* 文案走宿主 locale 服务（2026-11-12 用户要求英文界面全英）：ZH/EN 双字典，缺失键回落中文。 */
    const ZH = {
      nav: '会话搬家',
      desc: '把一条会话从当前工作区搬到另一个工作区（数据全在本机）',
      open: '打开',
      loading: '正在读取会话列表…',
      loadFailed: '读取失败',
      retry: '重试',
      close: '关闭',
      target: '目标工作区',
      targetPlaceholder: '选择要搬去的工作区',
      move: '移动',
      moving: '移动中…',
      done: '已移动到「{target}」',
      current: '当前',
      sessionsIn: '{count} 条会话',
      empty: '还没有任何会话',
      errLive: '该会话正在运行，先让它停下来再搬',
      errNotFound: '会话或目标工作区不存在（可能已被删除）',
      errOther: '移动失败',
      orderNav: '侧栏排序',
      /* 压缩 .txt 出口 + 版本分页器（2026-10-16） */
      exitNav: '压缩出口 / 自然语言协议 / 版本分页器',
      exitDesc: '压缩摘要的 .txt 出口开关、知识库/通用自然语言协议等全局开关（写 config 顶层，API 通道与 LDW 车道同时生效）、LDW 独立设置、标题前缀，以及「版本切换」按钮的显隐（改完即时生效）',
      directThresholdLabel: '.txt 直接发送阈值',
      directThresholdDesc: 'API 通道不装附件（HTTP JSON 直传），此值仅作显示与未来兼容；LDW 车道用它判定大输入走 .txt',
      txtChunkLabel: '附件分段阈值',
      txtChunkDesc: '单段 .txt 上限字节；超限把大附件切 partN-ofM 逐段上传。全局开关：写 config 顶层，API 通道与 LDW 车道同时生效',
      chatOnlyLabel: '纯聊天模式',
      chatOnlyDesc: '开：剥净工具目录（模型收不到工具=纯聊天）。全局开关：写 config 顶层，API 通道与 LDW 车道同时生效。压缩/标题请求不受影响',
      zhToolNamesLabel: '中文工具名',
      zhToolNamesDesc: '开：工具目录每项带「（中文名：XX，两个名字等价）」标注，模型可用中文说工具名（如「我要用工具 读取文件」），翻译层自动翻回真名。全局开关（写 config 顶层）。独立开关，默认关',
      kbLabel: '知识库自然语言协议',
      kbDesc: '开：模型说「我要调动第一层/第二层知识库，搜索xx」会被翻译成真正的检索调用；「通用 NL」未开时，工具目录只保留知识库工具（knowledge 系列 + 对话档案检索），其余全部裁掉。按钮优先级（上对下）：纯聊天 > 知识库 > 通用 NL。全局开关（写 config 顶层）。关：这句话按普通文字处理、不裁目录',
      nlToolLabel: '自然语言工具调用',
      nlToolDesc: '开：模型说「我要用工具 <工具名>，参数 {...}」也会翻译成真正调用——动态映射（从本轮工具目录现查名字，工具增减无需改代码）；「知识库 NL」显式关闭时，工具目录去掉知识库工具、其余全留（KB > 通用 的按钮优先级）。全局开关（写 config 顶层）。默认关（保守）',
      titlePrefixLabel: '标题 LDW 前缀',
      titlePrefixDesc: '开：走 LDW 网页端时机器生成的会话标题带「LDW 」前缀（前缀识别清理靠它）；关：原样',
      titleModelLabel: '标题生成模型',
      titleModelNav: '标题生成模型',
      titleModelDesc: '会话标题由宿主官方插件自动生成（对首条消息发一次小请求总结）。这里改它走哪条车道（provider / model，真源 cordis.patch.yml 的 session-title-llm 块）。近期标题一直失败，多半是原车道（inai-deepseek）不可用——换一个能用的即可。',
      titleModelChainHint: '按顺序逐项尝试：某项失败（配额、超时等）自动换下一项重发；空链条＝使用当前会话模型。',
      chainFollowSession: '跟随会话使用模型',
      chainAdd: '添加固定渠道',
      chainAddSession: '添加跟随会话',
      chainReasoning: '思考度',
      chainProviderDefault: '跟随提供商默认',
      chainSession: '跟随会话',
      chainFixed: '固定模型',
      chainModel: 'Model',
      chainMoveUp: '上移',
      chainMoveDown: '下移',
      chainDelete: '删除',
      chainModelsLoading: '模型目录加载中…',
      chainNoModels: '目录不可用，可手输 provider/model',
      chainSearchModels: '搜索模型',
      titleModelBlockMissing: 'patch.yml 里没有 session-title-llm 块——重启 DSH 让 webin 自愈补块后再设置。',
      titleModelRestartNote: '改完重启 DSH 生效',
      pagerLabel: '「版本切换」按钮',
      pagerDesc: '分叉会话 / 修改过对话后出现在消息下方的版本分页器（dsh-easyrewrite 提供）',
      pagerHidden: '已隐藏',
      pagerShown: '显示中',
      /* [B线 2026-10-24] 消息流懒渲染 */
      renderFxLabel: '长会话滚动优化',
      renderFxDesc: '屏幕外的消息跳过布局与绘制（content-visibility），长会话滚动更顺；时间轴不受影响。默认关，改完点保存',
      renderFxOn: '已开启',
      renderFxOff: '已关闭',
      autoCompactLabel: '自动压缩',
      autoCompactDesc: '开：窗口快满时宿主自动压缩摘要（宿主原生行为）。关：从代码层拦掉自动压缩，到顶直接报 context-overflow，手动 /compact 仍可用。改完即时生效，不用重启',
      modeLabel: '压缩 .txt 出口',
      modeDesc: '压缩摘要（/compact）输入太大时，把全文打包成 .txt 附件传给网页端',
      thresholdLabel: '直接发送阈值（字符）',
      thresholdDesc: 'auto 模式下低于该值直接发输入框，超过才打包 .txt',
      exitNote: '改完点保存即生效，不用重启',
      save: '保存',
      /* 扫描与校准频率（2026-10-16 用户要求：频率/自动扫描/校准都要能控，且要能手跑） */
      cadNav: '扫描与校准频率',
      cadDesc: '控制「什么时候扫」和「扫多勤」——默认值就是插件长期以来的行为',
      cadChangeTitle: '会话盘变化后（含 dsh-sync 同步落盘）自动做什么：',
      cadRescan: '标题预热 + 重扫列表',
      cadRescanDesc: '变化稳定后补标题投影并刷新会话列表；关掉则只在开机时做',
      cadPurge: '真删除扫描',
      cadPurgeDesc: '变化后跟一次墓碑清理（幂等）；不需要可关掉，省全盘扫',
      cadHead: '头保护扫描',
      cadHeadDesc: '变化后检查「无头会话」；同步进来的文件最容易缺头',
      cadDebounce: '变化后台稳定时间',
      cadDebounceDesc: '越小越灵敏、越费 IO；文件还在写时不会触发（等指纹稳定）',
      cadPoll: '兜底轮询间隔',
      cadPollDesc: 'fs.watch 漏事件时的保底检查（正常情况用不到）',
      cadBootTitle: '开机时自动做：',
      cadBootWarm: '开机预热标题（12s / 60s 各一轮）',
      cadBootWarmDesc: '让侧栏标题在启动后尽快正常显示',
      cadBootHead: '开机头保护（4s / 25s 预筛 + 45s 深扫）',
      cadBootHeadDesc: '深扫会整读+校验，最费 IO；关掉可明显减轻启动期负载',
      cadBootTrueDelete: '开机真删除补清（1.2s / 2.5s / 5s / 30s 四个窗口）',
      cadBootTrueDeleteDesc: '赶在会话被激活成 live 之前清墓碑；关掉则只靠变化后扫描',
      cadCalTitle: '上下文占用校准（contextPressure）：',
      cadCal: '自动校准',
      cadCalDesc: '修正「显示还剩 10% 却报超 1M」那类偏差；关掉不影响对话，只是显示值可能偏',
      cadCalInterval: '定期重试间隔',
      cadCalIntervalDesc: '0 = 只在启动那几轮跑一次（长期以来的行为）',
      cadManualNote: '手动触发（不受上面开关影响）：',
      cadManualCal: '立即校准',
      cadManualWarm: '立即重扫标题',
      cadRestartHint: '⚠️ 开关与频率在插件启动时读一次，改完请重启 DSH 生效；两个手动按钮随时可用。',
      /* 版本家族与磁盘占用（2026-10-16） */
      verNav: '版本家族与磁盘占用',
      verDesc: '分叉会话会复制父会话的历史，这里列出各版本家族的体积，可按需清理旧版本',
      verGuard: '旧版本受保护（不自动真删）',
      verGuardDesc: '切换版本时另一个分支会被标墓碑，本插件的真删除默认跳过这些家族成员，只记账不动刀',
      verNote: '清理是真删（不留副本），正在运行的会话会被跳过',
      /* 不可见会话（2026-10-16 用户规则：看不见的不要留） */
      invNav: '不可见会话清理',
      invDesc: '左边侧栏选不出来的会话（盘上有文件、宿主登记表里没有）——按「只要看得见的」规则属于残留',
      invSweepNote: '自动扫除（开机 + 每 10 分钟）需要用户显式开启；当前默认关，避免误删刚分叉还没登记的会话',
      invNote: '删除是真删不留副本；正在运行的会话会被跳过',
      /* 同上分区补的（2026-10-22 用户要求：列表显示标题；保险要能显式强制跳过） */
      invCleanTitle: '只处理「文件存在但侧栏看不见」的会话',
      invRefresh: '刷新',
      invScanning: '正在扫描…',
      invReadFailed: '读取失败$',
      invScanUnavailable: '扫描不可用',
      invClean: '一键清理不可见会话',
      invCleanForce: '强制清理不可见会话',
      invConfirm: '确认删除 {count} 条',
      invConfirmForce: '确认强制删除 {count} 条',
      invCancel: '取消',
      invNoTitle: '（无标题）',
      /* F线：子代理对话管理（2026-10-24） */
      subNav: '子代理对话清理',
      subDesc: 'workflow/子代理工具派生的子任务会话——侧栏从不显示，任务完成后就是死数据',
      subCleanTitle: '只处理 origin=subagent 的会话（自动跳过正在运行的）',
      subScanning: '正在扫描…',
      subReadFailed: '读取失败$',
      subEmpty: '没有子代理会话——干净',
      subSummary: '子代理会话 {count} 条 · 共 {mb} MB',
      subLiveNote: '（{count} 条正在运行，会跳过）',
      subClean: '清理子代理会话',
      subConfirm: '确认删除 {count} 条子代理会话',
      subFreed: '已删 {count} 条 · 释放 {mb} MB',
      subPurgeFailed: '清理失败',
      subNote: '真删不可逆（删前自动备份到 backup-true-delete-subagent）；正在运行的跳过',
      /* A线：自动瘦身设置（2026-10-24） */
      asNav: '自动瘦身',
      asDesc: '开机自动把大会话的老轮次瘦身（擦推理流/工具输出，结构不动）。默认关',
      asToggle: '开机自动瘦身',
      asToggleDesc: '开了每次启动 90 秒后扫一遍：非运行中 + ≥1MB 的会话自动瘦身（走 verify/备份/回滚全套门禁）',
      asKeep: '保留最近轮数',
      asKeepDesc: '最近 N 轮原文完整保留，更早的才瘦身（0 = 全部瘦）',
      asDigest: '摘要占位',
      asDigestDesc: '占位符带「前两行 + 字数」，AI 翻旧账能认出这里原本在干嘛；关闭则纯「[内容已清除]」',
      asMin: '事件数门槛',
      asMinDesc: '事件数低于此值的会话不碰（防误伤小会话）',
      asNote: '手动瘦身仍走会话与提示词里的瘦身面板；改完点保存，下次开机生效',
      invFamilyTag: '家族',
      invPathLabel: '目录',
      invFamilyNote: '其中 {count} 条是版本家族成员：默认不动刀（切版本还要用到），勾下面的强制清理才会一起删',
      invAnomalyOn: '⚠️ 登记表疑似异常：这份清单是按「盘上文件」判的，删之前请自己再确认一遍',
      invForceLabel: '我已确认，强制清理（含家族成员 / 跳过保险）',
      invForceDesc: '勾上才会：① 连版本家族成员一起清；② 登记表疑似异常时也放行清单与清理。真删不可逆，勾了还要再点一次「确认」。',
      invForceOn: '强制模式',
      invSkippedTitle: '因为有保险所以没删（{count} 条）：',
      invReasonFamily: '版本家族成员（切版本还要用到）',
      invReasonAnomaly: '登记表疑似异常',
      invReasonBulk: '超过一次删除上限（批量保险）',
      invReasonVisible: '在侧栏里可见（硬红线，永不删）',
      invReasonSelf: '就是当前正在用的这条会话',
      invReasonLive: '会话正在运行中',
      invReasonNotFound: '文件已不在盘上',
      invReasonFailed: '删除出错',
      invFreed: '已删除 {count} 条，释放 {mb} MB',
      invPurgeFailed: '清理失败',
      invOrphanTitle: '孤儿投影（有缓存、无会话文件）',
      invOrphanDesc: '删除方没清理标题缓存留下的残影——任何列表都不会显示它们，只有这里看得见。清理 = 移入备份目录（session_projcache/orphans-backup-*），确认无误后可整目录手工删。',
      invOrphanClean: '清理孤儿投影',
      invOrphanConfirm: '确认移入备份（{count} 条）',
      invOrphanDone: '已移入备份 {count} 条（{kb} KB）→ {dir}',
      invOrphanTooFresh: '{count} 条太新（<5 分钟）跳过，防新建竞态',
      invUnknown: '未知$',
      /* 会话日志修复分区文案（2026-10-13） */
      healNav: '会话日志修复',
      healMain: '清理与体检',
      healMainDesc: '三个开关、保存选项、全面体检与修复结果（默认收起）',
      healDesc: '清理会话日志里的残缺工具结果与失效附件（断流/加载失败/附件对象丢失留下），修复前自动备份',
      healBoot: '开机自动扫',
      healBootDesc: '启动 15 秒后一次性扫描并修复（不加定时器，不常驻）',
      healSend: '发送前扫',
      healSendDesc: '发消息前把载荷里的空工具结果/残缺块兜底修好（纯内存，零磁盘 IO）',
      healSendWarn: '关闭后 DeepSeek 可能重新拒收残缺载荷',
      healSkip: '无变化对话不扫',
      healSkipDesc: '按文件指纹跳过上次检查后没变过的对话（只 stat 不读盘）',
      healSave: '保存选项',
      healSaved: '已保存',
      healSaveFail: '保存失败',
      healCheck: '全面体检',
      healChecking: '体检中…',
      healRepair: '修复发现的问题',
      healRepairing: '修复中…',
      healClean: '全部会话日志结构完整，无需修复',
      orderIntro: '拖动 ⠿ 手柄（或长按整行）换位置，↑↓ 是稳的备选。顺序直接写进宿主 workspace.json（工作区 global.workspaceIds / 会话 sessionIds），不是只改页面。正在运行的会话不能重排。',
      orderTabSession: '会话管理',
      orderTabWorkspace: '工作区管理',
      orderHintSession: '按工作区展开，拖会话行调整区内先后（默认全展开）。',
      orderHintWorkspace: '拖工作区行调整工作区先后，展开后也能拖里面的会话（默认折叠）。',
      orderExpandAll: '全部展开',
      orderCollapseAll: '全部折叠',
      /* 侧边栏入口显隐（四组折叠引擎已于 2026-11-26 整体移除，只留三入口开关） */
      sidebarEntriesNav: '侧边栏入口',
      sidebarEntriesDesc: '记忆 / 任务 / 归档三个侧边栏入口的显示开关',
      sidefoldReadFail: '读取失败，可重试',
      sidefoldSaved: '已保存 · 即时生效',
      sidefoldSaveFail: '保存失败：',
      entriesDesc: '关掉后入口从侧边栏消失，恢复=这里重新打开，设置页永远够得着',
      entryMemory: '记忆入口',
      entryTask: '任务入口',
      entryArchive: '归档入口',
      entryShown: '显示中',
      entryHidden: '已隐藏',
      orderRefresh: '重新读取',
      orderLoading: '正在读取顺序…',
      orderEmpty: '一个工作区都没有',
      orderSessions: '{count} 条会话',
      orderSaved: '顺序已写入',
      orderFailed: '排序失败',
      orderReadFailed: '读取顺序失败',
      handle: '拖我排序',
      toTop: '上移',
      toBottom: '下移',
      exitNever: 'never · 不走网页（压缩请求直接拒绝）',
      exitAuto: 'auto · 超过阈值才打包 .txt（推荐）',
      exitAlways: 'always · 一律打包 .txt 上传',
      unknownReason: '未知原因',
      unknown: '未知',
      stateExpand: '展开',
      stateCollapse: '折叠',
      runBtn: '执行',
      loadingPrefs: '读取设置…',
      on: '开启',
      off: '关闭',
      ldwIndependentDesc: '独立值，仅 LDW 车道生效；与上方全局开关互不影响',
      ldwFollowLabel: 'LDW 车道开关跟随全局',
      ldwFollowDesc: '默认跟随全局开关（压缩出口/协议对 LDW 车道同样生效）；点成「独立设置中」后，下方键改用 LDW 段自己的值',
      followGlobal: '跟随全局',
      followIndependent: '独立设置中',
      saving: '保存中…',
      verStatsDesc: '分叉=复制父会话历史，这里按家族统计体积',
      statizing: '正在统计…',
      rootTag: '根',
      branchTag: '分叉',
      orphanTag: '·孤',
      cleanOld: '清理旧版本',
      savedNextBoot: '已保存 · 下次开机生效',
      okSuffix: '完成',
      failedSuffix: '失败',
      running: '执行中…',
      healBrokenNote: '（断流/附件加载失败留下的残缺；发送前扫会兜底，也可点下面按钮根治到盘上）',
      healRejectNote: '（发给 DeepSeek 官方 API 会整轮拒收；出口守卫会替换成占位，也可点下面按钮根治到盘上）',
      unitSec: '秒',
      unitSecOnce: '秒（0 = 只在启动跑一次）',
      ungrouped: '(未分组)',
    }

    /* EN 字典：与 ZH 逐键对齐；触发词示例（中文名标注、KB/NL 句式）按功能语义保留中文原文。 */
    const EN = {
      nav: 'Move sessions',
      desc: 'Move a session from the current workspace to another one (all data stays local)',
      open: 'Open',
      loading: 'Loading session list…',
      loadFailed: 'Failed to load',
      retry: 'Retry',
      close: 'Close',
      target: 'Target workspace',
      targetPlaceholder: 'Pick the workspace to move to',
      move: 'Move',
      moving: 'Moving…',
      done: 'Moved to "{target}"',
      current: 'Current',
      sessionsIn: '{count} sessions',
      empty: 'No sessions yet',
      errLive: 'This session is running — stop it before moving',
      errNotFound: 'Session or target workspace not found (may have been deleted)',
      errOther: 'Move failed',
      orderNav: 'Sidebar ordering',
      exitNav: 'Compaction exit / NL protocol / version pager',
      exitDesc: 'Switches for the comp-summary .txt exit, KB/general NL protocol and other global switches (written to the top-level config keys, effective on both the API channel and the LDW lane), LDW custom settings, the title prefix, and the visibility of the "version pager" button (takes effect immediately)',
      directThresholdLabel: '.txt direct-send threshold',
      directThresholdDesc: 'The API channel never attaches files (HTTP JSON straight through); this value is for display and future compatibility only. The LDW lane uses it to decide when large inputs go as .txt',
      txtChunkLabel: 'Attachment chunk size',
      txtChunkDesc: 'Max bytes per .txt part; larger attachments are split into partN-ofM chunks and uploaded one by one. Global switch: written to the top-level config keys, effective on both the API channel and the LDW lane',
      chatOnlyLabel: 'Chat-only mode',
      chatOnlyDesc: 'On: strips the tool catalog (the model receives no tools = pure chat). Global switch: written to the top-level config keys, effective on both the API channel and the LDW lane. Compaction/title requests are unaffected',
      zhToolNamesLabel: 'Chinese tool names',
      zhToolNamesDesc: 'On: each tool catalog entry carries a "（Chinese name: XX, two names equivalent)" note so the model can say tool names in Chinese (e.g. "I want to use tool Read File"); the translation layer maps them back to the real names. Global switch (top-level config keys). Independent switch, default off',
      kbLabel: 'KB natural-language protocol',
      kbDesc: 'On: phrases like "I want to invoke the first/second knowledge layer, search for xx" get translated into real retrieval calls; when "general NL" is off, the tool catalog keeps only KB tools (knowledge series + archive search) and drops the rest. Button priority (top to bottom): chat-only > KB > general NL. Global switch (top-level config keys). Off: the phrase is treated as plain text and the catalog is not trimmed',
      nlToolLabel: 'Natural-language tool calls',
      nlToolDesc: 'On: "I want to use tool <tool name>, params {...}" also gets translated into a real call — dynamic mapping (names looked up from the current turn catalog, so tools can come and go without code changes); when "KB NL" is explicitly off, the catalog drops KB tools and keeps the rest (KB > general priority). Global switch (top-level config keys). Default off (conservative)',
      titlePrefixLabel: 'LDW title prefix',
      titleModelLabel: 'Session title model',
      titleModelNav: 'Session title model',
      titleModelDesc: 'Session titles are generated by the host plugin (one small request summarizing the first message). This sets which lane it uses (provider / model; source of truth = the session-title-llm block in cordis.patch.yml). Recent failures most likely mean the original lane (inai-deepseek) is unusable — switch to one that works.',
      titleModelChainHint: 'Tried in order: on failure (quota, timeout, ...) the request is retried with the next item. An empty chain = use the current session model.',
      chainFollowSession: 'Follow the session model',
      chainAdd: 'Add fixed lane',
      chainAddSession: 'Add follow-session',
      chainReasoning: 'Reasoning',
      chainProviderDefault: 'Provider default',
      chainSession: 'Follow session',
      chainFixed: 'Fixed model',
      chainModel: 'Model',
      chainMoveUp: 'Move up',
      chainMoveDown: 'Move down',
      chainDelete: 'Delete',
      chainModelsLoading: 'Loading model directory…',
      chainNoModels: 'Directory unavailable; you can type provider/model manually',
      chainSearchModels: 'Search models',
      titleModelBlockMissing: 'No session-title-llm block in cordis.patch.yml — restart DSH once so the webin self-heal recreates it, then set it here.',
      titleModelRestartNote: 'restart DSH to take effect',
      titlePrefixDesc: 'On: machine-generated session titles carry an "LDW " prefix on the LDW web lane (prefix-based cleanup relies on it); off: as-is',
      pagerLabel: '"Version pager" button',
      pagerDesc: 'The version pager that appears under messages for forked/edited conversations (provided by dsh-easyrewrite)',
      pagerHidden: 'Hidden',
      pagerShown: 'Visible',
      renderFxLabel: 'Long-session scroll optimization',
      renderFxDesc: 'Off-screen messages skip layout and paint (content-visibility) so long sessions scroll smoother; the timeline is unaffected. Default off; click save after changing',
      renderFxOn: 'Enabled',
      renderFxOff: 'Disabled',
      autoCompactLabel: 'Auto compaction',
      autoCompactDesc: 'On: the host summarizes automatically when the window fills up (native behavior). Off: auto compaction is gated out at the code layer, hitting the ceiling reports context-overflow, manual /compact still works. Applies immediately, no restart',
      modeLabel: 'Compaction .txt exit',
      modeDesc: 'When a compaction summary (/compact) is too large, the full text is packed into a .txt attachment for the web side',
      thresholdLabel: 'Direct-send threshold (chars)',
      thresholdDesc: 'In auto mode, inputs below this value go straight into the input box; larger ones are packed as .txt',
      exitNote: 'Takes effect on save — no restart needed',
      save: 'Save',
      cadNav: 'Scan & calibration frequency',
      cadDesc: 'Controls when to scan and how often — the defaults match the long-standing behavior of this plugin',
      cadChangeTitle: 'After session-file changes (incl. dsh-sync writes):',
      cadRescan: 'Title warm-up + list rescan',
      cadRescanDesc: 'After changes settle, backfill title projections and refresh the session list; off = only at boot',
      cadPurge: 'True-delete scan',
      cadPurgeDesc: 'Runs one idempotent tombstone cleanup after changes; turn off to skip the full scan',
      cadHead: 'Head-guard scan',
      cadHeadDesc: 'Checks for "headless sessions" after changes; synced-in files most often lack heads',
      cadDebounce: 'Change settle time',
      cadDebounceDesc: 'Lower = more responsive but more IO; files still being written never trigger (waits for a stable fingerprint)',
      cadPoll: 'Fallback poll interval',
      cadPollDesc: 'Safety-net check for when fs.watch misses events (normally unused)',
      cadBootTitle: 'Automatically at boot:',
      cadBootWarm: 'Boot-time title warm-up (12s / 60s rounds)',
      cadBootWarmDesc: 'So sidebar titles display normally as soon as possible after start',
      cadBootHead: 'Boot-time head guard (4s / 25s prefilter + 45s deep scan)',
      cadBootHeadDesc: 'The deep scan reads and verifies whole files — the heaviest IO; turning it off visibly reduces startup load',
      cadBootTrueDelete: 'Boot-time true-delete sweep (1.2s / 2.5s / 5s / 30s windows)',
      cadBootTrueDeleteDesc: 'Cleans tombstones before sessions get activated as live; off = only the after-change scan',
      cadCalTitle: 'Context-pressure calibration (contextPressure):',
      cadCal: 'Auto calibration',
      cadCalDesc: 'Fixes drift like "shows 10% left yet reports over 1M"; disabling does not affect chats — the displayed value may just drift',
      cadCalInterval: 'Periodic retry interval',
      cadCalIntervalDesc: '0 = only around startup (the long-standing behavior)',
      cadManualNote: 'Manual triggers (unaffected by the switches above):',
      cadManualCal: 'Calibrate now',
      cadManualWarm: 'Rescan titles now',
      cadRestartHint: '⚠️ Switches and frequencies are read once at plugin start — restart DSH after changing; the two manual buttons work anytime.',
      verNav: 'Version families & disk usage',
      verDesc: 'Forked sessions copy the parent history; this lists the size of each version family so you can clean old versions on demand',
      verGuard: 'Old versions protected (no auto true-delete)',
      verGuardDesc: 'Switching versions marks the other branch with a tombstone; true-delete skips these family members by default — bookkeeping only, no cutting',
      verNote: 'Cleanup is a true delete (no copies kept); running sessions are skipped',
      invNav: 'Invisible-session cleanup',
      invDesc: 'Sessions the sidebar cannot show (files on disk, absent from the host registry) — under the "if you can see it, keep it" rule these are leftovers',
      invSweepNote: 'Automatic sweeping (boot + every 10 min) requires explicit opt-in; default off, to avoid deleting just-forked sessions that are not registered yet',
      invNote: 'Deletes are true deletes (no copies kept); running sessions are skipped',
      invCleanTitle: 'Only handle sessions that exist on disk but are invisible in the sidebar',
      invRefresh: 'Refresh',
      invScanning: 'Scanning…',
      invReadFailed: 'Failed to load',
      invScanUnavailable: 'Scan unavailable',
      invClean: 'Clean invisible sessions',
      invCleanForce: 'Force-clean invisible sessions',
      invConfirm: 'Confirm deleting {count} sessions',
      invConfirmForce: 'Confirm force-deleting {count} sessions',
      invCancel: 'Cancel',
      invNoTitle: '(untitled)',
      subNav: 'Subagent-session cleanup',
      subDesc: 'Sessions spawned via workflow/subagent tools — never shown in the sidebar, dead weight once the task finishes',
      subCleanTitle: 'Only handle origin=subagent sessions (running ones are auto-skipped)',
      subScanning: 'Scanning…',
      subReadFailed: 'Failed to load',
      subEmpty: 'No subagent sessions — clean',
      subSummary: '{count} subagent sessions · {mb} MB total',
      subLiveNote: '({count} running, will be skipped)',
      subClean: 'Clean subagent sessions',
      subConfirm: 'Confirm deleting {count} subagent sessions',
      subFreed: 'Deleted {count} · freed {mb} MB',
      subPurgeFailed: 'Cleanup failed',
      subNote: 'True delete is irreversible (auto-backed-up to backup-true-delete-subagent first); running sessions are skipped',
      asNav: 'Auto slimming',
      asDesc: 'At boot, automatically slim old turns of large sessions (wipe reasoning streams/tool outputs, keep structure). Default off',
      asToggle: 'Auto-slim at boot',
      asToggleDesc: 'When on, 90s after each start: sessions that are not running and ≥1MB get slimmed (full verify/backup/rollback gates)',
      asKeep: 'Keep recent turns',
      asKeepDesc: 'The most recent N turns keep their full text; only older ones get slimmed (0 = all)',
      asDigest: 'Digest placeholder',
      asDigestDesc: 'The placeholder carries "first two lines + char count" so the AI can tell what used to be there when reading old context; off = plain "[content cleared]"',
      asMin: 'Event-count threshold',
      asMinDesc: 'Sessions with fewer events are untouched (protects small sessions)',
      asNote: 'Manual slimming still lives in the slimming panel under Sessions & Prompts; click save — takes effect next boot',
      invFamilyTag: 'family',
      invPathLabel: 'Directory',
      invFamilyNote: '{count} of these are version-family members: untouched by default (still needed for version switching); tick force-clean below to include them',
      invAnomalyOn: '⚠️ Registry looks anomalous: this list was judged from on-disk files — double-check before deleting',
      invForceLabel: 'I confirm, force-clean (family members included / guards skipped)',
      invForceDesc: 'Ticking enables: ① clean version-family members too; ② allow listing and cleanup even when the registry looks anomalous. True delete is irreversible; after ticking you still press Confirm once more.',
      invForceOn: 'Force mode',
      invSkippedTitle: 'Not deleted because of guards ({count}):',
      invReasonFamily: 'Version-family member (still needed for version switching)',
      invReasonAnomaly: 'Registry looks anomalous',
      invReasonBulk: 'Exceeds the per-run delete cap (bulk guard)',
      invReasonVisible: 'Visible in the sidebar (hard red line, never deleted)',
      invReasonSelf: 'This is the very session in use right now',
      invReasonLive: 'Session is running',
      invReasonNotFound: 'File no longer on disk',
      invReasonFailed: 'Delete errored',
      invFreed: 'Deleted {count}, freed {mb} MB',
      invPurgeFailed: 'Cleanup failed',
      invOrphanTitle: 'Orphan projections (cached, no session file)',
      invOrphanDesc: 'Ghosts left behind when the deleter did not clean the title cache — no list ever shows them, only this panel. Cleanup = move into the backup dir (session_projcache/orphans-backup-*); once verified you can delete that directory by hand.',
      invOrphanClean: 'Clean orphan projections',
      invOrphanConfirm: 'Confirm moving to backup ({count})',
      invOrphanDone: 'Moved {count} to backup ({kb} KB) → {dir}',
      invOrphanTooFresh: '{count} too fresh (<5 min), skipped to avoid a create race',
      invUnknown: 'Unknown',
      healNav: 'Session log repair',
      healMain: 'Cleanup & checkup',
      healMainDesc: 'Three switches, save options, full checkup and repair results (collapsed by default)',
      healDesc: 'Cleans broken tool results and dead attachments out of session logs (left by interrupted streams/load failures/lost attachment objects); auto-backup before repair',
      healBoot: 'Scan at boot',
      healBootDesc: 'One scan+repair 15s after startup (no timers, nothing resident)',
      healSend: 'Scan before send',
      healSendDesc: 'Before sending, repairs empty tool results/broken blocks in the payload in memory (zero disk IO)',
      healSendWarn: 'When off, DeepSeek may again reject broken payloads',
      healSkip: 'Skip unchanged conversations',
      healSkipDesc: 'Skips conversations whose file fingerprint is unchanged since the last check (stat only, no reads)',
      healSave: 'Save options',
      healSaved: 'Saved',
      healSaveFail: 'Save failed',
      healCheck: 'Full checkup',
      healChecking: 'Checking…',
      healRepair: 'Repair found issues',
      healRepairing: 'Repairing…',
      healClean: 'All session logs are structurally sound — nothing to repair',
      orderIntro: 'Drag the ⠿ handle (or long-press the row) to reorder; ↑↓ are the safe fallback. The order is written straight into the host workspace.json (workspace global.workspaceIds / session sessionIds), not just the page. Running sessions cannot be reordered.',
      orderTabSession: 'Session manager',
      orderTabWorkspace: 'Workspace manager',
      orderHintSession: 'Expanded per workspace; drag session rows to reorder within a workspace (all expanded by default).',
      orderHintWorkspace: 'Drag workspace rows to reorder workspaces; once expanded you can also drag their sessions (collapsed by default).',
      orderExpandAll: 'Expand all',
      orderCollapseAll: 'Collapse all',
      sidebarEntriesNav: 'Sidebar entries',
      sidebarEntriesDesc: 'Show/hide switches for the memory / task / archive sidebar entries',
      sidefoldReadFail: 'Failed to load — you can retry',
      sidefoldSaved: 'Saved · effective immediately',
      sidefoldSaveFail: 'Save failed: ',
      entriesDesc: 'When off, the entries disappear from the sidebar. Restore = turn them back on here; the settings page is always reachable',
      entryMemory: 'Memory entry',
      entryTask: 'Tasks entry',
      entryArchive: 'Archive entry',
      entryShown: 'Visible',
      entryHidden: 'Hidden',
      orderRefresh: 'Reload',
      orderLoading: 'Loading order…',
      orderEmpty: 'No workspaces at all',
      orderSessions: '{count} sessions',
      orderSaved: 'Order written',
      orderFailed: 'Reorder failed',
      orderReadFailed: 'Failed to load order',
      handle: 'Drag to sort',
      toTop: 'Move up',
      toBottom: 'Move down',
      exitNever: 'never · never web-bound (compaction requests are rejected outright)',
      exitAuto: 'auto · pack as .txt only past the threshold (recommended)',
      exitAlways: 'always · always pack as .txt upload',
      unknownReason: 'unknown reason',
      unknown: 'unknown',
      stateExpand: 'Expand',
      stateCollapse: 'Collapse',
      runBtn: 'Run',
      loadingPrefs: 'Loading settings…',
      on: 'On',
      off: 'Off',
      ldwIndependentDesc: 'Independent values, effective on the LDW lane only; does not touch the global switches above',
      ldwFollowLabel: 'LDW lane switches follow global',
      ldwFollowDesc: 'By default the LDW lane follows the global switches (compaction exit / protocols apply to LDW too); switch to "independent" and the keys below use the LDW-section values instead',
      followGlobal: 'Follow global',
      followIndependent: 'Independent',
      saving: 'Saving…',
      verStatsDesc: 'Fork = a copy of the parent history; sizes are tallied per family here',
      statizing: 'Tallying…',
      rootTag: 'root',
      branchTag: 'fork',
      orphanTag: '·orphan',
      cleanOld: 'Clean old versions',
      savedNextBoot: 'Saved · takes effect next boot',
      okSuffix: 'done',
      failedSuffix: 'failed',
      running: 'Running…',
      healBrokenNote: '(broken bits left by interrupted streams / attachment load failures; the pre-send scan patches them in memory, or use the button below to repair on disk)',
      healRejectNote: '(the DeepSeek official API would reject the whole turn; the exit guard replaces them with placeholders, or use the button below to repair on disk)',
      unitSec: 's',
      unitSecOnce: 's (0 = only around startup)',
      ungrouped: '(ungrouped)',
    }

    let t = (key, vars) => {
      let out = ZH[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    }

    const style = `
      .ac-settings { display: flex; flex-direction: column; width: 100%; max-width: 760px; gap: 10px; }
      /* 折叠行（2026-11-24 仿 session-kit SessionKitFoldRow）：轻量分隔线行，不再是重卡片。 */
      .ac-fold { display: flex; flex-direction: column; gap: 8px; }
      .ac-fold-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-bottom: 0.5px solid var(--dsh-color-border, rgba(128,128,128,0.28)); flex-wrap: wrap; }
      .ac-fold-text { min-width: 0; flex: 1 1 auto; }
      .ac-fold-title { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); }
      .ac-fold-hint { display: block; margin-top: 4px; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-secondary); opacity: 0.82; }
      .ac-fold-body { display: flex; flex-direction: column; gap: 10px; padding-top: 4px; }
      .ac-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-base); }
      .ac-row-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ac-row-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
      .ac-btn { font: inherit; font-size: 12px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
      .ac-btn:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary); }
      .ac-btn:disabled { opacity: .5; cursor: default; }
      .ac-btn-primary { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
      .ac-overlay { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .38); }
      .ac-modal { width: min(560px, calc(100vw - 24px)); max-height: min(74vh, 620px); display: flex; flex-direction: column; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-base); box-shadow: 0 12px 40px rgba(0, 0, 0, .25); overflow: hidden; }
      .ac-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
      .ac-modal-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ac-modal-body { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
      .ac-modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--dsw-alias-border-l2); }
      .ac-select { font: inherit; font-size: 13px; height: 34px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); outline: none; max-width: 100%; }
      .ac-select:focus { border-color: var(--dsw-alias-state-business-primary); }
      .ac-group-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 4px 2px; }
      .ac-session { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); }
      .ac-session-name { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-session-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
      /* 会话日志修复分区（2026-10-13） */
      .ac-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .ac-check input { margin-top: 3px; accent-color: var(--dsw-alias-state-business-primary); }
      .ac-report { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; }
      .ac-report b { color: var(--dsw-alias-label-primary); }
      .ac-hint-warn { font-size: 11px; color: var(--dsw-alias-state-error-primary, #d5303f); margin-top: 2px; }
      .ac-notice { font-size: 12px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
      .ac-notice-ok { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
      .ac-notice-err { border-color: var(--dsw-alias-state-error-primary, #d5303f); color: var(--dsw-alias-state-error-primary, #d5303f); }
      .ac-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); text-align: center; padding: 18px 0; }

      /* ---- 侧栏排序面板 ---- */
      .ac-order { display: flex; flex-direction: column; width: 100%; max-width: 760px; gap: 10px; }
      .ac-order-intro { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; margin: 0; }
      .ac-order-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ac-order-tabs { display: flex; gap: 6px; flex: 1; min-width: 0; }
      .ac-order-tab { font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .ac-order-tab.ac-on { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
      .ac-order-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }
      .ac-order-ws { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); }
      .ac-order-ws-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-order-session { display: flex; align-items: center; gap: 8px; padding: 7px 10px; margin-left: 14px; border: 1px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2)); border-radius: 9px; background: var(--dsw-alias-bg-base); }
      .ac-order-session-name { font-size: 13px; color: var(--dsw-alias-label-primary); min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-order-sid { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* 手柄：touch-action none，触摸下从手柄起拖不会滚页 */
      .ac-order-handle { flex: none; cursor: grab; touch-action: none; font-size: 14px; line-height: 1; padding: 4px 2px; color: var(--dsw-alias-label-secondary); user-select: none; }
      .ac-order-handle:active { cursor: grabbing; }
      .ac-order-caret { flex: none; font: inherit; font-size: 12px; width: 22px; height: 22px; border: none; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; border-radius: 6px; }
      .ac-order-caret:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .ac-order-count { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ac-order-mini { flex: none; font: inherit; font-size: 12px; width: 24px; height: 24px; padding: 0; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); cursor: pointer; }
      .ac-order-mini:disabled { opacity: .35; cursor: default; }
      .ac-order-mini:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary); }
      /* 拖动中：被拖的行半透明，落点用上/下边框标出来 */
      .ac-order-dragging { opacity: .45; }
      .ac-order-over-before { box-shadow: inset 0 2px 0 0 var(--dsw-alias-state-business-primary); }
      .ac-order-over-after { box-shadow: inset 0 -2px 0 0 var(--dsw-alias-state-business-primary); }
      .ac-order-legend { font-size: 11px; color: var(--dsw-alias-label-secondary); }
    `

    const titleOf = (session) => {
      const t = session?.title
      return typeof t === 'string' && t.trim() ? t : String(session?.id ?? '').slice(0, 18)
    }

    const friendlyError = (message) => {
      if (/live/i.test(message)) return t('errLive')
      if (/not found/i.test(message)) return t('errNotFound')
      return t('errOther') + '：' + message
    }

    function MoveDialog({ onClose }) {
      const [groups, setGroups] = useState(null)
      const [error, setError] = useState('')
      const [target, setTarget] = useState('')
      const [busyId, setBusyId] = useState('')
      const [notice, setNotice] = useState(null)
      const load = useCallback(async () => {
        setError('')
        setGroups(null)
        try {
          const res = await fetch(LIST_ROUTE)
          const out = await res.json().catch(() => ({}))
          if (!res.ok || out?.ok !== true) throw new Error(String(out?.error ?? ('HTTP ' + res.status)))
          setGroups(Array.isArray(out.value) ? out.value : [])
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }, [])
      useEffect(() => { void load() }, [load])
      const move = async (sessionId) => {
        if (!target) return
        setBusyId(sessionId)
        setNotice(null)
        try {
          const res = await fetch(MOVE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, target }),
          })
          const out = await res.json().catch(() => ({}))
          if (!res.ok || out?.ok !== true) throw new Error(String(out?.error ?? ('HTTP ' + res.status)))
          setNotice({ ok: true, text: t('done').replace('{target}', target) })
          await load()
        } catch (e) {
          setNotice({ ok: false, text: friendlyError(String(e?.message ?? e)) })
        } finally {
          setBusyId('')
        }
      }
      const workspaceTitles = (groups ?? [])
        .map((g) => g?.workspaceTitle)
        .filter((t) => typeof t === 'string' && t && t !== '(未分组)')
      return h('div', { className: 'ac-overlay', onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'ac-modal' },
          h('div', { className: 'ac-modal-head' },
            h('div', { className: 'ac-modal-title' }, t('nav')),
            h('button', { className: 'ac-btn', onClick: onClose }, t('close'))),
          h('div', { className: 'ac-modal-body' },
            h('div', null,
              h('div', { className: 'ac-session-hint', style: { marginBottom: 4 } }, t('target')),
              h('select', {
                className: 'ac-select',
                value: target,
                onChange: (e) => setTarget(e.currentTarget.value),
              },
              h('option', { value: '' }, t('targetPlaceholder')),
              workspaceTitles.map((name) => h('option', { key: name, value: name }, name === '(未分组)' ? t('ungrouped') : name)))),
            notice ? h('div', { className: 'ac-notice ' + (notice.ok ? 'ac-notice-ok' : 'ac-notice-err') }, notice.text) : null,
            groups === null && !error ? h('div', { className: 'ac-empty' }, t('loading')) : null,
            error ? h('div', { className: 'ac-notice ac-notice-err' },
              t('loadFailed') + ': ' + error + ' ',
              h('button', { className: 'ac-btn', style: { marginLeft: 8 }, onClick: () => void load() }, t('retry'))) : null,
            (groups ?? []).length === 0 && !error && groups !== null ? h('div', { className: 'ac-empty' }, t('empty')) : null,
            (groups ?? []).map((group) =>
              h('div', { key: group.workspaceTitle },
                h('div', { className: 'ac-group-title' },
                  (group.workspaceTitle === '(未分组)' ? t('ungrouped') : group.workspaceTitle) + ' · ' + t('sessionsIn').replace('{count}', String(group.sessions.length))),
                group.sessions.map((session) =>
                  h('div', { key: session.id, className: 'ac-session' },
                    h('div', { style: { minWidth: 0, flex: 1 } },
                      h('div', { className: 'ac-session-name' }, titleOf(session)),
                      h('div', { className: 'ac-session-hint' }, session.id)),
                    h('button', {
                      className: 'ac-btn ac-btn-primary',
                      disabled: !target || busyId !== '',
                      onClick: () => void move(session.id),
                    }, busyId === session.id ? t('moving') : t('move'))))))),
          h('div', { className: 'ac-modal-foot' },
            h('button', { className: 'ac-btn', onClick: onClose }, t('close'))))
      )
    }

    function MoveSessionSection() {
      const [styleMounted, setStyleMounted] = useState(false)
      const [open, setOpen] = useState(false)
      useEffect(() => {
        if (styleMounted) return
        const el = document.createElement('style')
        el.dataset.plugin = NS
        el.textContent = style
        document.head.appendChild(el)
        setStyleMounted(true)
      }, [styleMounted])
      return h('div', { className: 'ac-settings' },
        h('div', { className: 'ac-row' },
          h('div', null,
            h('div', { className: 'ac-row-title' }, t('nav')),
            h('div', { className: 'ac-row-desc' }, t('desc'))),
          h('button', { className: 'ac-btn', onClick: () => setOpen(true) }, t('open'))),
        open ? h(MoveDialog, {
          onClose: () => setOpen(false),
        }) : null)
    }

    /* ── 会话日志修复分区（2026-10-13）──────────────────────────────
       三个开关默认全关，手动勾选保存（存 .dsh/adapter-compat-heal.json，服务端读）。
       开机扫 = 一次性（服务端 15s 延时，不加定时器）；
       发送前扫 = 出口守卫的结构修（纯内存）；无变化不扫 = 指纹 stat 跳过。
       全面体检 = GET heal-scan（尊重「无变化不扫」），只读不修；
       体检发现空工具结果后才出现「修复」按钮 → POST heal-tools {write:true}。
       写法约定：**每个子块先单独算好再展开**（一层一层摆平）—— 上一版在 return 里
       塞了三层嵌套 h(，括号数到自己都不信，node --check 卡在最后一行。 */
    const HEAL_OPTS = '/dsh-adapter-compat/heal-options'
    const HEAL_SCAN = '/dsh-adapter-compat/heal-scan'
    const HEAL_FIX = '/dsh-adapter-compat/heal-tools'

    async function fetchJson(url, options) {
      const res = await fetch(url, options)
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, data }
    }

    /* ── 压缩 .txt 出口 + 版本分页器开关（9999.9.24）────────────────
       用户要求：①禁掉「版本切换」按钮（分叉会话 / 修改过对话后出现的分页器）；
                ②把 .txt 出口设置放本插件（不放 webin 的设置页）。
       分页器是 dsh-easyrewrite 的 DOM（data-dsh-easyrewrite="version-pager"），
       这里只注入 CSS 隐藏 —— 不动 easyrewrite 一个字节。
       .txt 出口的值写真源是 ~/.dsh/webin/config.json 的
       compactionFileMode / compactionFileThresholdChars；
       webin 每次请求都 readConfig() 现读，所以改完即时生效、不用重启。 */
    const EXIT_PREFS = '/dsh-adapter-compat/exit-prefs'
    const HELLO = '/dsh-adapter-compat/client-hello'
    /** session-kit 在「会话与提示词」分区里声明的子插槽（见它对 settings.section 的 children 表）。 */
    const SK_EXTRA = 'dsh-session-kit.settings.extra'
    const PAGER_SELECTOR = '[data-dsh-easyrewrite="version-pager"]'
    /** 模式 → 字典键（渲染期经 t() 出词，语言切换即时生效；勿在此处直接存文案）。 */
    const EXIT_MODE_LABELS = {
      never: 'exitNever',
      auto: 'exitAuto',
      always: 'exitAlways',
    }

    /** 按偏好显示/隐藏版本分页器（幂等：重复调用只更新同一个 style 节点）。 */
    function applyPagerHidden(hidden) {
      try {
        let el = document.querySelector('style[data-plugin="dsh-adapter-compat-pager"]')
        if (hidden !== true) {
          if (el) el.remove()
          return
        }
        if (!el) {
          el = document.createElement('style')
          el.dataset.plugin = 'dsh-adapter-compat-pager'
          document.head.appendChild(el)
        }
        el.textContent = PAGER_SELECTOR + '{display:none !important}'
      } catch {
        /* 隐藏失败不影响其它功能 */
      }
    }

    /* [B线 2026-10-24] 消息流懒渲染：屏幕外的消息项跳过布局与绘制（content-visibility）。
       宿主消息流容器 [data-conversation-scroll]，消息项 .EvIC1a_flowItem（宿主 chat 包的
       稳定 class）；预估高度给 contain-intrinsic-size 防滚动跳动。Timeline 的 turn 轨道
       （.eGxaPq_frame，绝对定位独立层）不在消息流内、且显式豁免——缩略条/刻度照常渲染。 */
    /* hidden="until-found" relies on UA content-visibility:hidden. Never override it:
       doing so reveals collapsed assistant steps even while disclosure stays closed.
       选择器锚点（2026-11-26 换锚）：原先用混淆类名 .EvIC1a_flowItem / .eGxaPq_*，
       宿主升到 0.2.2-rc.5 后前缀全变（现为 .V4vHZW_flowItem、timeline 改用
       iFBRtq_* + data-dsh-tl-*），旧选择器一条都匹配不到 == 懒渲染整条静默失效。
       改锚到语义属性：宿主 flowItem 恒带 data-chat-flow-key（新宿主 client.js 实锤），
       timeline 有稳定前缀 data-dsh-tl-theme，两者都不随混淆前缀变化。 */
    const RENDER_FX_CSS = [
      '[data-conversation-scroll] [data-chat-flow-key]:not([hidden]) {',
      '  content-visibility: auto;',
      '  contain-intrinsic-size: auto 220px;',
      '}',
      '/* Timeline 轨道豁免：绝对定位层不吃 content-visibility，双保险显式还原 */',
      '[data-conversation-scroll] [data-dsh-tl-theme],',
      '[data-conversation-scroll] [data-dsh-tl-theme] * {',
      '  content-visibility: visible;',
      '}',
    ].join('\n')

    /** 按开关注入/移除懒渲染 CSS（幂等：同一个 style 节点）。 */
    function applyRenderFx(on) {
      try {
        let el = document.querySelector('style[data-plugin="dsh-adapter-compat-renderfx"]')
        if (on !== true) {
          if (el) el.remove()
          return
        }
        if (!el) {
          el = document.createElement('style')
          el.dataset.plugin = 'dsh-adapter-compat-renderfx'
          document.head.appendChild(el)
        }
        el.textContent = RENDER_FX_CSS
      } catch {
        /* 注入失败不影响其它功能 */
      }
    }

    /* 侧边栏三入口彻底隐藏（session-kit 的功能，走 /dsh-session-kit/sidebar-entries 路由）。
       四组折叠引擎已于 2026-11-26 整体移除（用户要求去掉「折叠侧边栏」），这里只剩开关。 */
    const SESSION_KIT_ENTRIES_ROUTE = '/dsh-session-kit/sidebar-entries'

    /* 设置 → 会话与提示词 → 侧边栏入口：记忆/任务/归档三入口彻底隐藏
       （隐藏不留标题行，恢复=这里重新打开）。 */
    function SidebarEntriesSection() {
      const [entries, setEntries] = useState(null)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let dead = false
        fetchJson(SESSION_KIT_ENTRIES_ROUTE).then((r) => {
          if (!dead && r.ok && r.data) {
            const v = r.data.value ?? r.data
            setEntries({ memory: v.memoryVisible !== false, task: v.taskVisible !== false, archive: v.archiveVisible !== false })
          }
        }).catch(() => { if (!dead) setNote(t('sidefoldReadFail')) })
        return () => { dead = true }
      }, [])

      const saveEntries = async (next) => {
        setBusy(true); setNote('')
        try {
          const r = await fetchJson(SESSION_KIT_ENTRIES_ROUTE, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ memoryVisible: next.memory, taskVisible: next.task, archiveVisible: next.archive }),
          })
          if (r.ok && r.data && (r.data.ok || r.data.memoryVisible !== undefined)) {
            const v = r.data.value ?? r.data
            setEntries({ memory: v.memoryVisible !== false, task: v.taskVisible !== false, archive: v.archiveVisible !== false })
            setNote(t('sidefoldSaved'))
          } else setNote(t('sidefoldSaveFail') + String(r.data && r.data.error ? r.data.error : t('unknownReason')))
        } catch (e) { setNote(t('sidefoldSaveFail') + String(e && e.message ? e.message : e)) }
        finally { setBusy(false) }
      }

      const wrap = (kids) => h(Fold, { title: t('sidebarEntriesNav'), desc: t('sidebarEntriesDesc') }, ...kids)

      const entryRow = (key, label) => h('div', { className: 'ac-row', key },
        h('div', { className: 'ac-row-title' }, label),
        h('button', {
          className: 'ac-btn', disabled: busy || !entries,
          onClick: () => saveEntries({ ...entries, [key]: !(entries?.[key] !== false) }),
        }, entries ? (entries[key] !== false ? t('entryShown') : t('entryHidden')) : '…'))

      return wrap([
        h('div', { className: 'ac-row-desc', style: { margin: '0 2px 8px' } }, t('entriesDesc')),
        entryRow('memory', t('entryMemory')),
        entryRow('task', t('entryTask')),
        entryRow('archive', t('entryArchive')),
        note && h('span', { role: 'alert', style: { marginLeft: 8, color: 'var(--dsw-alias-state-error-primary, #e5534b)' } }, note),
      ])
    }

    function ExitSection() {
      const [prefs, setPrefs] = useState(null)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let dead = false
        fetchJson(EXIT_PREFS).then((r) => {
          if (dead) return
          if (r.ok && r.data && r.data.value) {
            setPrefs(r.data.value)
            applyPagerHidden(r.data.value.hideVersionPager !== false)
            applyRenderFx(r.data.value.renderFx === true)
          } else setNote(t('sidefoldReadFail'))
        }).catch(() => { if (!dead) setNote(t('sidefoldReadFail')) })
        return () => { dead = true }
      }, [])

      const save = async () => {
        if (!prefs) return
        setBusy(true)
        setNote('')
        try {
          const r = await fetchJson(EXIT_PREFS, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            /** ⚠️ 全量发（2026-10-20 修「保存弹回」bug：此前只发 3 个键，
             *  kbProtocol/nlToolProtocol/titlePrefix 没进 body ⇒ 后端收不到 ⇒
             *  下次 GET 又读回旧值——用户看到「一点保存就弹回去」。 */
            body: JSON.stringify({
              compactionFileMode: prefs.compactionFileMode,
              compactionFileThresholdChars: prefs.compactionFileThresholdChars,
              hideVersionPager: prefs.hideVersionPager,
              renderFx: prefs.renderFx === true,
              /** 自动压缩开关（2026-11-26）：写本插件偏好文件，后端读完立即切实时标志。 */
              autoCompaction: prefs.autoCompaction === true,
              kbProtocol: prefs.kbProtocol !== false,
              nlToolProtocol: prefs.nlToolProtocol === true,
              titlePrefix: prefs.titlePrefix !== false,
              /** 全局 .txt 三件套（2026-10-21 用户定案「都要弄上」）：
               *  directSendThresholdChars/txtChunkBytes/chatOnly 写 webin config 同源。 */
              directSendThresholdChars: Math.max(0, Number(prefs.directSendThresholdChars) || 0),
              txtChunkBytes: Math.max(0, Number(prefs.txtChunkBytes) || 0),
              chatOnly: prefs.chatOnly === true,
              /** 中文工具名（2026-10-24）：同源 webin config。 */
              zhToolNames: prefs.zhToolNames === true,
              /** LDW 独立模式（2026-11-12）：跟随=后端清 ldw 段五键；独立=ldwCustom 落段。
               *  跟随模式不发 ldwCustom——避免把回显的全局值写进独立段攒残留。 */
              ldwFollowGlobal: prefs.ldwFollowGlobal !== false,
              ...(prefs.ldwFollowGlobal === false ? {
                ldwCustom: {
                  chatOnly: prefs.ldwCustom?.chatOnly === true,
                  zhToolNames: prefs.ldwCustom?.zhToolNames === true,
                  kbProtocol: prefs.ldwCustom?.kbProtocol === true,
                  nlToolProtocol: prefs.ldwCustom?.nlToolProtocol === true,
                  txtChunkBytes: Math.max(0, Number(prefs.ldwCustom?.txtChunkBytes) || 0),
                },
              } : {}),
              /* 标题生成模型已拆分为独立面板 TitleModelSection（2026-11-23 用户要求与
                 「压缩出口」同级），不再随本面板全量 POST。 */
            }),
          })
          if (r.ok && r.data && r.data.ok) {
            const v = r.data.value || prefs
            setPrefs(v)
            applyPagerHidden(v.hideVersionPager !== false)
            applyRenderFx(v.renderFx === true)
            setNote(t('sidefoldSaved'))
          } else setNote(t('sidefoldSaveFail') + String(r.data && r.data.error ? r.data.error : t('unknownReason')))
        } catch (e) {
          setNote(t('sidefoldSaveFail') + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      /* 折叠项（2026-10-16 用户要求「每个大项加折叠、默认折叠」）：
         外层 Fold 提供标题与展开按钮，内容才是真正的控件。
         好处：在「会话与提示词」里它一定以**一行可见标题**出现，不会被误认为「没做进来」。 */
      const wrap = (kids) => h(Fold, { title: t('exitNav'), desc: t('exitDesc') }, ...kids)

      if (!prefs) {
        return wrap([h('div', { className: 'ac-row-desc' }, t('loadingPrefs'))])
      }

      const pagerRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('pagerLabel')),
          h('div', { className: 'ac-row-desc' }, t('pagerDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, hideVersionPager: p.hideVersionPager !== true })),
        }, prefs.hideVersionPager !== true ? t('pagerShown') : t('pagerHidden')))

      /* [B线 2026-10-24] 消息流懒渲染开关（默认关）：开了以后屏幕外的消息跳过布局绘制，
         长会话滚动更顺；Timeline 时间轴不受影响（独立渲染层）。 */
      const renderFxRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('renderFxLabel')),
          h('div', { className: 'ac-row-desc' }, t('renderFxDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, renderFx: p.renderFx !== true })),
        }, prefs.renderFx === true ? t('renderFxOn') : t('renderFxOff')))

      /* 自动压缩开关（2026-11-26 用户要求）：放在压缩出口上方——先决定「要不要自动压缩」，
         再决定「压缩摘要怎么出口」。 */
      const autoCompactRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('autoCompactLabel')),
          h('div', { className: 'ac-row-desc' }, t('autoCompactDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, autoCompaction: p.autoCompaction !== true })),
        }, prefs.autoCompaction === true ? t('on') : t('off')))

      const modeRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('modeLabel')),
          h('div', { className: 'ac-row-desc' }, t('modeDesc'))),
        h('select', {
          className: 'ac-btn',
          value: prefs.compactionFileMode,
          onChange: (e) => setPrefs((p) => ({ ...p, compactionFileMode: e.target.value })),
        }, ...Object.keys(EXIT_MODE_LABELS).map((k) => h('option', { key: k, value: k }, t(EXIT_MODE_LABELS[k])))))

      const thresholdRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('thresholdLabel')),
          h('div', { className: 'ac-row-desc' }, t('thresholdDesc'))),
        h('input', {
          className: 'ac-btn',
          type: 'number',
          min: 1000,
          step: 1000,
          style: { width: '140px' },
          value: String(prefs.compactionFileThresholdChars),
          onChange: (e) => setPrefs((p) => ({ ...p, compactionFileThresholdChars: Number(e.target.value) })),
        }))

      const kbRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('kbLabel')),
          h('div', { className: 'ac-row-desc' }, t('kbDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, kbProtocol: p.kbProtocol !== false ? false : true })),
        }, prefs.kbProtocol !== false ? t('on') : t('off')))

      /** 全局 .txt 三件套（2026-10-21 用户定案「不管实际用不用都要弄上」）——
       *  directSendThresholdChars / txtChunkBytes / chatOnly（纯聊天）。
       *  全局侧写 webin config 同源（全局真源=顶层；LDW 车道默认跟随全局，独立需开「LDW 车道独立设置」）。 */
      const directThresholdRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('directThresholdLabel')),
          h('div', { className: 'ac-row-desc' }, t('directThresholdDesc'))),
        h('input', {
          className: 'ac-btn',
          type: 'number', min: 0, step: 1000, style: { width: '140px' },
          value: String(prefs.directSendThresholdChars ?? 6000),
          onChange: (e) => setPrefs((p) => ({ ...p, directSendThresholdChars: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })),
        }))
      const txtChunkRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('txtChunkLabel')),
          h('div', { className: 'ac-row-desc' }, t('txtChunkDesc'))),
        h('input', {
          className: 'ac-btn',
          type: 'number', min: 0, step: 10240, style: { width: '140px' },
          value: String(prefs.txtChunkBytes ?? 409600),
          onChange: (e) => setPrefs((p) => ({ ...p, txtChunkBytes: Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0) })),
        }))
      const chatOnlyRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('chatOnlyLabel')),
          h('div', { className: 'ac-row-desc' }, t('chatOnlyDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, chatOnly: p.chatOnly !== true })),
        }, prefs.chatOnly === true ? t('on') : t('off')))

      /* 中文工具名（2026-10-24 用户点名「调用时用汉字代替不要漏名字」）：
         独立开关——开启后 API 请求的工具目录带中文名标注，模型说中文工具名也能翻回真名。 */
      const zhRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('zhToolNamesLabel')),
          h('div', { className: 'ac-row-desc' }, t('zhToolNamesDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, zhToolNames: p.zhToolNames === true ? false : true })),
        }, prefs.zhToolNames === true ? t('on') : t('off')))

      const nlRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('nlToolLabel')),
          h('div', { className: 'ac-row-desc' }, t('nlToolDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, nlToolProtocol: p.nlToolProtocol === true ? false : true })),
        }, prefs.nlToolProtocol === true ? t('on') : t('off')))

      /* LDW 独立模式（2026-11-12）：跟随全局/独立设置。独立时渲染五键编辑行
         （写 config.ldw 段，仅 LDW 车道读）；跟随模式不渲染（保存时后端清段内五键）。 */
      const ldwToggleRow = (key, label) => h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, 'LDW·' + label),
          h('div', { className: 'ac-row-desc' }, t('ldwIndependentDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, ldwCustom: { ...p.ldwCustom, [key]: !(p.ldwCustom?.[key] === true) } })),
        }, prefs.ldwCustom?.[key] === true ? t('on') : t('off')))
      const ldwNumberRow = (key, label, step) => h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, 'LDW·' + label),
          h('div', { className: 'ac-row-desc' }, t('ldwIndependentDesc'))),
        h('input', {
          className: 'ac-btn',
          type: 'number', min: 0, step, style: { width: '140px' },
          value: String(prefs.ldwCustom?.[key] ?? 0),
          onChange: (e) => setPrefs((p) => ({ ...p, ldwCustom: { ...p.ldwCustom, [key]: Math.max(0, Number(String(e.target.value).replace(/\D/g, '')) || 0) } })),
        }))
      const ldwFollowRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('ldwFollowLabel')),
          h('div', { className: 'ac-row-desc' }, t('ldwFollowDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, ldwFollowGlobal: p.ldwFollowGlobal === false })),
        }, prefs.ldwFollowGlobal === false ? t('followIndependent') : t('followGlobal')))
      const ldwRows = prefs.ldwFollowGlobal === false ? [
        ldwToggleRow('chatOnly', t('chatOnlyLabel')),
        ldwToggleRow('zhToolNames', t('zhToolNamesLabel')),
        ldwToggleRow('kbProtocol', t('kbLabel')),
        ldwToggleRow('nlToolProtocol', t('nlToolLabel')),
        ldwNumberRow('txtChunkBytes', t('txtChunkLabel'), 10240),
      ] : []
      const titleRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('titlePrefixLabel')),
          h('div', { className: 'ac-row-desc' }, t('titlePrefixDesc'))),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, titlePrefix: p.titlePrefix !== false ? false : true })),
        }, prefs.titlePrefix !== false ? t('on') : t('off')))
      /* 标题生成模型行已迁出 → 独立面板 TitleModelSection（与压缩出口同级）。 */

      const foot = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' }, note || t('exitNote')),
        h('button', { className: 'ac-btn', disabled: busy, onClick: () => void save() }, busy ? t('saving') : t('save')))

      return wrap([pagerRow, renderFxRow, autoCompactRow, modeRow, thresholdRow, directThresholdRow, txtChunkRow, chatOnlyRow, zhRow, kbRow, nlRow, ldwFollowRow, ...ldwRows, titleRow, foot])
    }

    /* 链条编辑器需要的宿主上下文：从 apply 注入的 ctx 读取（modelDirectories/agents）。 */
    const ModelContext = React.createContext(null)
    function useModelContext() { return React.useContext(ModelContext) }

    /* ── 标题生成模型（独立面板，2026-11-24 仿记忆蒸馏链条）────────
       真源 = cordis.patch.yml 的 session-title-llm 块（后端 readTitleModel/writeTitleModel，
       经 /dsh-adapter-compat/exit-prefs 的 titleModel 键读写；只发 titleModel 一个键）。
       链条按顺序逐项尝试：session 项 = 跟随会话当前模型；fixed 项 = 指定 provider/model；
       某车道失败自动换下一项重发；空链 = 只用会话当前模型。改完重启 DSH 生效。 */
    function TitleModelSection() {
      const [chain, setChain] = useState(null)
      const [blockPresent, setBlockPresent] = useState(true)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      const ctx = useModelContext()
      const directory = useModelDirectory(ctx)
      useEffect(() => { ensureCss() }, [])
      useEffect(() => {
        let dead = false
        fetchJson(EXIT_PREFS).then((r) => {
          if (dead) return
          const tm = r.ok && r.data && r.data.value && r.data.value.titleModel
          if (tm) {
            setBlockPresent(tm.blockPresent !== false)
            setChain(Array.isArray(tm.chain) ? tm.chain : [])
          } else setNote(t('sidefoldReadFail'))
        }).catch(() => { if (!dead) setNote(t('sidefoldReadFail')) })
        return () => { dead = true }
      }, [])
      const save = async () => {
        if (chain === null) return
        setBusy(true); setNote('')
        try {
          const r = await fetchJson(EXIT_PREFS, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ titleModel: { chain } }),
          })
          if (r.ok && r.data && r.data.ok) setNote(t('titleModelRestartNote'))
          else setNote(t('sidefoldSaveFail') + String(r.data && r.data.error ? r.data.error : t('unknownReason')))
        } catch (e) {
          setNote(t('sidefoldSaveFail') + String(e && e.message ? e.message : e))
        } finally { setBusy(false) }
      }
      const kids = chain === null
        ? [h('div', { className: 'ac-row-desc' }, note || t('loadingPrefs'))]
        : blockPresent === false
        ? [h('div', { className: 'ac-row-desc', style: { color: 'var(--dsw-alias-state-error-primary, #e5534b)' } }, t('titleModelBlockMissing'))]
        : [
            h('div', { className: 'ac-row-desc' }, t('titleModelChainHint')),
            h(ChainEditor, {
              chain, onChange: setChain, directory, t, busy,
              followLabel: t('chainFollowSession'),
              addLabel: t('chainAdd'),
              addSessionLabel: t('chainAddSession'),
              reasoningLabel: t('chainReasoning'),
              providerDefaultLabel: t('chainProviderDefault'),
            }),
            h('div', { className: 'ac-row' },
              h('div', { className: 'ac-row-desc' }, note || t('titleModelRestartNote')),
              h('button', { className: 'ac-btn', disabled: busy, onClick: () => void save() }, busy ? t('saving') : t('save'))),
          ]
      return h(Fold, { title: t('titleModelNav'), desc: t('titleModelDesc') }, ...kids)
    }

    /* ── 版本家族与磁盘占用（9999.9.25）──────────────────────────
       分叉 = 把父会话的事件前缀**复制**进新会话（DSH 的 buildForkSeed），
       header 记 parentSession ⇒ 确实占盘（实测 17 条 / 21.97 MB）。
       真删除默认**跳过**这些家族成员：切换版本会往另一个分支写墓碑，
       真删会把那个版本的内容物理切除，旧版本就回不去了。
       想省空间时在这里手动清（真删，不留副本）。 */
    const VERSIONS = '/dsh-adapter-compat/versions'
    const VERSIONS_PURGE = '/dsh-adapter-compat/versions/purge'

    /** 版本家族子块 —— 同样嵌在「会话日志修复」里（2026-10-16 用户要求），默认折叠。 */
    function VersionsBlock() {
      const [data, setData] = useState(null)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState('')
      const [confirmId, setConfirmId] = useState('')

      const load = useCallback(async () => {
        try {
          const r = await fetchJson(VERSIONS)
          if (r.ok && r.data && r.data.value) setData(r.data.value)
          else setNote(t('loadFailed'))
        } catch { setNote(t('loadFailed')) }
      }, [])

      useEffect(() => { void load() }, [load])

      const purge = async (ids, label) => {
        setBusy(label)
        setNote('')
        try {
          const r = await fetchJson(VERSIONS_PURGE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids, write: true }),
          })
          if (r.ok && r.data && r.data.ok) {
            const freed = r.data.freedMB ?? 0
            const refused = (r.data.results || []).filter((x) => x.status === 'live-refused').length
            setNote(`已释放 ${freed} MB${refused > 0 ? `（${refused} 条正在运行，跳过）` : ''}`)
            await load()
          } else setNote(t('invPurgeFailed') + ': ' + String(r.data && r.data.error ? r.data.error : t('unknown')))
        } catch (e) {
          setNote(t('invPurgeFailed') + ': ' + String(e && e.message ? e.message : e))
        } finally {
          setBusy('')
          setConfirmId('')
        }
      }

      const head = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' }, t('verStatsDesc')),
        h('button', { className: 'ac-btn', onClick: () => void load() }, t('invRefresh')))

      if (!data) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, head,
          h('div', { className: 'ac-row-desc' }, note || t('statizing')))
      }

      const summary = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' },
          `${data.familyCount} 个版本家族 · ${data.forkCount} 条分叉 · 分叉占 ${data.totalForkMB} MB · 全部会话 ${data.totalAllMB.toFixed(1)} MB`))

      const protection = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('verGuard')),
          h('div', { className: 'ac-row-desc' }, t('verGuardDesc'))))

      const famRows = data.families.slice(0, 12).map((fam) => {
        const forks = fam.members.filter((m) => m.isFork)
        /* 2026-10-23 用户要求：成员行显示标题（后端已补 m.title：projcache →
           session/title → 首条用户消息前 24 字兜底），认得出是谁。 */
        const members = fam.members.map((m) => h('div', { key: m.id, className: 'ac-row-desc', style: { fontFamily: 'monospace' } },
          `${m.title ? `"${m.title}"` : ''}${m.id.slice(0, 26)}  ${m.sizeMB}MB  ${m.isRoot ? t('rootTag') : t('branchTag')}${m.orphanFork ? ' ' + t('orphanTag') : ''}  ${m.mtime}`))
        const actions = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('span', { className: 'ac-row-desc' }, `${fam.sizeMB}MB`),
          confirmId === fam.root
            ? h('button', { className: 'ac-btn', disabled: busy !== '', onClick: () => void purge(forks.map((m) => m.id), fam.root) }, `确认删除 ${forks.length} 条分叉`)
            : h('button', {
                className: 'ac-btn',
                disabled: busy !== '' || forks.length === 0,
                onClick: () => setConfirmId(fam.root),
              }, t('cleanOld')),
          confirmId === fam.root ? h('button', { className: 'ac-btn', onClick: () => setConfirmId('') }, t('invCancel')) : null)
        return h('div', { key: fam.root, style: { borderTop: '1px solid var(--dsw-alias-border-subtle, #3333)', paddingTop: '6px' } },
          h('div', { className: 'ac-row' },
            h('div', null,
              h('div', { className: 'ac-row-title' }, fam.title ? `「${fam.title}」家族` : `家族 ${fam.root.slice(0, 26)}`),
              h('div', { className: 'ac-row-desc' }, `${fam.members.length} 个版本 · 分叉 ${forks.length} 条`)),
            actions),
          ...members)
      })

      const foot = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' }, note || t('verNote')))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        head, summary, protection, ...famRows, foot)
    }

    /* ── 不可见会话（侧栏选不出来的）（9999.9.26）──────────────────
       用户规则：「我只要左边我用的能看见的，不看见的不要留着，从源头上断绝」。
       判据 = 宿主登记表 storages/workspace.json：
         tables.workspaces[].sessionIds = 侧栏能选出来的（正本）
         global.archivedSessionIds      = 收起可展开的
         其余（盘上有文件、登记表没有）= 不可见 → 清理对象
       注：DSH 登记表没有「移除会话」API，所以侧栏里点不开的空条目
       （登记了但文件已删）只能停机改文件；这里只处理「文件存在但看不见」。 */
    const INVISIBLE = '/dsh-adapter-compat/invisible'
    const INVISIBLE_PURGE = '/dsh-adapter-compat/invisible/purge'

    /** 折叠块：默认收起，点标题/按钮展开（2026-10-16 用户要求「默认折叠」）。
     *  2026-11-24 复刻 session-kit 的 SessionKitFoldRow（「▸ 注入源开关」那套）：
     *  标题左侧三角 + 描述仅展开时显示 + 右侧 outline「展开/折叠」按钮；
     *  行样式从「卡片边框圆角」改为「细分隔线」的轻量行，与「会话与提示词」视觉一致。 */
    function Fold({ title, desc, children, defaultOpen = false }) {
      const [open, setOpen] = useState(defaultOpen)
      return h('div', { className: 'ac-fold' },
        h('div', { className: 'ac-fold-row' },
          h('div', { className: 'ac-fold-text' },
            h('div', { className: 'ac-fold-title', style: { cursor: 'pointer' }, onClick: () => setOpen((v) => !v) },
              `${open ? '▾' : '▸'} ${title}`),
            open && desc ? h('small', { className: 'ac-fold-hint' }, desc) : null),
          h('button', { className: 'ac-btn', onClick: () => setOpen((v) => !v) }, open ? t('stateCollapse') : t('stateExpand'))),
        open ? h('div', { className: 'ac-fold-body' }, children) : null)
    }

    /** 不可见会话子块 —— 嵌在「会话日志修复」分区里（2026-10-16 用户要求：紧致点，别单开顶级分区）。
     *  2026-10-22 用户要求：①列表要显示标题（原来一排光秃秃的 id）；②「保险不准全部清除」要能
     *  显式跳过。默认三道保险（家族保护 / 登记表异常拒绝 / 批量上限）一条不撤；勾了
     *  「我已确认，强制清理」并再次确认后放行，且**被保险挡下的条目连同原因一起显示**，不静默跳过。 */
    function InvisibleBlock() {
      const [data, setData] = useState(null)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const [force, setForce] = useState(false)
      const [skipped, setSkipped] = useState([])
      const [blocked, setBlocked] = useState([])
      const [orphanConfirming, setOrphanConfirming] = useState(false)

      const load = useCallback(async () => {
        try {
          /* force=1：登记表疑似异常时后端也肯把清单给出来（只给看，删还得再点一次确认）。 */
          const r = await fetchJson(INVISIBLE + (force ? '?force=1' : ''))
          if (r.ok && r.data && r.data.value) setData(r.data.value)
          else setNote(t('invReadFailed'))
        } catch { setNote(t('invReadFailed')) }
      }, [force])

      useEffect(() => { void load() }, [load])

      const purge = async () => {
        setBusy(true)
        setNote('')
        setSkipped([])
        setBlocked([])
        try {
          const r = await fetchJson(INVISIBLE_PURGE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            /* 两个参数都显式发，别指望后端猜：
               force  = 用户勾了「强制清理」并二次确认 → 后端放行「家族保护」与「登记表异常拒绝」；
               confirmBulk = 连带把 guardDeletion 的批量上限（一次 ≤3 条）一并放行。 */
            body: JSON.stringify({ write: true, force, confirmBulk: force }),
          })
          if (r.ok && r.data && r.data.ok) {
            setSkipped(Array.isArray(r.data.skipped) ? r.data.skipped : [])
            const base = t('invFreed').replace('{count}', String(r.data.deletedCount ?? 0)).replace('{mb}', String(r.data.freedMB ?? 0))
            /* 后端补的说明（如「全部被保险跳过：勾选强制才会删」）附在后面，别丢。 */
            setNote(r.data.note ? `${base} · ${String(r.data.note)}` : base)
            await load()
          } else {
            /* 保险拦下：把结构化原因摆出来 —— 「是保险挡的，不是坏了」。 */
            if (Array.isArray(r.data && r.data.blocked)) setBlocked(r.data.blocked)
            setNote(t('invPurgeFailed') + '：' + String(r.data && r.data.error ? r.data.error : t('invUnknown')))
          }
        } catch (e) {
          setNote(t('invPurgeFailed') + '：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
          setConfirming(false)
        }
      }

      /** 孤儿投影清理（2026-11-11）：POST purge 带 purgeOrphanProjections，写死 write:true
          ——按钮本身已带两步确认（orphanConfirming），干跑对用户没有意义。 */
      const purgeOrphans = async () => {
        setBusy(true)
        setNote('')
        try {
          const r = await fetchJson(INVISIBLE_PURGE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ purgeOrphanProjections: true, write: true }),
          })
          if (r.ok && r.data && r.data.ok) {
            let msg = t('invOrphanDone')
              .replace('{count}', String(r.data.purgedCount ?? 0))
              .replace('{kb}', String(r.data.purgedKB ?? 0))
              .replace('{dir}', String(r.data.backupDir ?? '-'))
            if (Array.isArray(r.data.skippedFresh) && r.data.skippedFresh.length > 0) {
              msg += ' · ' + t('invOrphanTooFresh').replace('{count}', String(r.data.skippedFresh.length))
            }
            setNote(msg)
            await load()
          } else {
            setNote(t('invPurgeFailed') + '：' + String(r.data && r.data.error ? r.data.error : t('invUnknown')))
          }
        } catch (e) {
          setNote(t('invPurgeFailed') + '：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
          setOrphanConfirming(false)
        }
      }

      /** 保险原因 → 人话（前后端共用同一套 reason 字符串）。 */
      const reasonText = (reason) => ({
        'family-protected': t('invReasonFamily'),
        'registry-anomaly': t('invReasonAnomaly'),
        'bulk-limit': t('invReasonBulk'),
        'visible-refused': t('invReasonVisible'),
        'self-session': t('invReasonSelf'),
        'live-refused': t('invReasonLive'),
        'not-found': t('invReasonNotFound'),
        failed: t('invReasonFailed'),
      })[reason] ?? String(reason)

      const wrap = (...kids) => h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '8px' },
      },
      h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' }, t('invCleanTitle')),
        h('button', { className: 'ac-btn', onClick: () => void load() }, t('invRefresh'))),
      ...kids)

      /* 强制开关：默认不勾；勾了会重新拉一次清单（登记表异常时也看得见）。 */
      const forceRow = h('div', { className: 'ac-row' },
        h('label', { className: 'ac-check', style: { minWidth: 0, flex: 1 } },
          h('input', {
            type: 'checkbox',
            checked: force,
            onChange: () => { setConfirming(false); setForce((v) => !v) },
          }),
          h('span', null,
            h('div', { className: 'ac-row-title', style: { display: 'inline' } }, t('invForceLabel')),
            h('div', { className: 'ac-row-desc' }, t('invForceDesc')))),
        force ? h('span', { className: 'ac-hint-warn' }, t('invForceOn')) : null)

      /* 被保险挡下的原因清单（skipped = 动手时逐条挡的；blocked = 整批拒绝时挡的）。 */
      let reasonBlock = null
      if (skipped.length > 0) {
        reasonBlock = h('div', { className: 'ac-report' },
          h('div', null, h('b', null, t('invSkippedTitle').replace('{count}', String(skipped.length)))),
          ...skipped.slice(0, 30).map((x, i) => h('div', { key: String(x.id ?? i) + i },
            `${x.title ? x.title : (x.id ? String(x.id).slice(0, 8) : '')}` +
            `${x.sizeMB ? ' · ' + x.sizeMB + 'MB' : ''} —— ${(x.reasons || []).map(reasonText).join('; ')}${x.note ? ': ' + x.note : ''}`)))
      }
      let blockedBlock = null
      if (blocked.length > 0) {
        blockedBlock = h('div', { className: 'ac-report' },
          ...blocked.map((b, i) => h('div', { key: String(b.reason) + i, style: { marginBottom: '4px' } },
            h('div', null,
              h('b', null, `${reasonText(b.reason)} × ${b.count ?? 0}`),
              b.limit ? ` (max ${b.limit} per run)` : ''),
            b.ids && b.ids.length
              ? h('div', { style: { fontFamily: 'monospace' } }, b.ids.slice(0, 8).map((x) => String(x).slice(0, 8)).join(' ') + (b.ids.length > 8 ? ' …' : ''))
              : null)))
      }

      if (!data) return wrap(h('div', { className: 'ac-row-desc' }, note || t('invScanning')))

      /* 孤儿投影小节（2026-11-11）：有缓存、无活体——任何列表都不显示，这里是它们
         唯一能被看见的地方。登记表异常（ok!==true）时照样渲染：判定不依赖登记表。 */
      const orphanList = Array.isArray(data.orphanProjections) ? data.orphanProjections : []
      const orphanCount = data.orphanCount ?? orphanList.length
      const orphanSection = orphanCount > 0 ? h('div', { className: 'ac-report' },
        h('div', null, h('b', null, `${t('invOrphanTitle')}：${orphanCount} 个（${data.orphanKB ?? 0} KB）`)),
        h('div', { className: 'ac-row-desc' }, t('invOrphanDesc')),
        ...orphanList.slice(0, 20).map((o) => h('div', { key: o.id, style: { fontFamily: 'monospace' } },
          `${String(o.id).slice(0, 26)}  ${o.sizeKB}KB  ${o.mtime}（${o.ageMinutes} 分钟前）`)),
        orphanList.length > 20 ? h('div', { className: 'ac-row-desc' }, `（还有 ${orphanList.length - 20} 条没列出，清理是一起清的）`) : null,
        h('div', { className: 'ac-row' },
          h('div', { className: 'ac-row-desc', style: { flex: 1 } }, orphanConfirming ? t('invOrphanConfirm').replace('{count}', String(orphanCount)) : ''),
          orphanConfirming
            ? h('button', { className: 'ac-btn', disabled: busy, onClick: () => void purgeOrphans() }, t('invOrphanConfirm').replace('{count}', String(orphanCount)))
            : h('button', { className: 'ac-btn', disabled: busy, onClick: () => setOrphanConfirming(true) }, t('invOrphanClean')),
          orphanConfirming ? h('button', { className: 'ac-btn', onClick: () => setOrphanConfirming(false) }, t('invCancel')) : null)) : null

      if (data.ok !== true) {
        /* 保险拦下（登记表疑似异常）：讲清「为什么没删 / 共多少条 / 怎么强行清」，不再只丢一句错。 */
        const ids = Array.isArray(data.anomalyIds) ? data.anomalyIds : []
        return wrap(
          h('div', { className: 'ac-hint-warn' }, data.reason || t('invScanUnavailable')),
          h('div', { className: 'ac-report' },
            h('div', null, h('b', null, t('invSkippedTitle').replace('{count}', String(data.anomalyCount ?? ids.length)))),
            h('div', null, reasonText('registry-anomaly')),
            ids.length
              ? h('div', { style: { fontFamily: 'monospace' } }, ids.slice(0, 8).map((x) => String(x).slice(0, 8)).join(' ') + (ids.length > 8 ? ' …' : ''))
              : null),
          forceRow,
          blockedBlock,
          orphanSection,
          h('div', { className: 'ac-row-desc' }, note || t('invNote')))
      }

      const familyCount = data.familyCount ?? 0
      /* 按钮上的数字 = 这一次真正会删几条（不勾强制时家族成员自动跳过，数字要诚实）。 */
      const targetCount = force ? data.sessions.length : Math.max(0, data.sessions.length - familyCount)

      const summary = h('div', { className: 'ac-row-desc' },
        data.sessions.length === 0
          ? `干净：${data.visibleCount ?? 0} 条可见会话，没有看不见的残留`
          : `不可见 ${data.sessions.length} 条 · ${data.totalMB} MB（可见 ${data.visibleCount ?? 0} 条）`)

      const rows = data.sessions.slice(0, 50).map((s) => h('div', { key: s.id, className: 'ac-session' },
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { className: 'ac-session-name' }, (s.title || t('invNoTitle')) + (s.family ? ` · ${t('invFamilyTag')}` : '')),
          h('div', { className: 'ac-session-hint', style: { fontFamily: 'monospace' } },
            `${String(s.id).slice(0, 26)}  ${s.sizeMB}MB  ${s.mtime}（${s.ageMinutes} 分钟前）`),
          s.workspaceKey
            ? h('div', { className: 'ac-session-hint', style: { fontFamily: 'monospace' } },
                `${t('invPathLabel')}：${String(s.workspaceKey).slice(0, 60)}`)
            : null)))

      const more = data.sessions.length > rows.length
        ? h('div', { className: 'ac-row-desc' }, `（还有 ${data.sessions.length - rows.length} 条没列出，清理是一起清的）`)
        : null

      const familyNote = familyCount > 0
        ? h('div', { className: 'ac-hint-warn' }, t('invFamilyNote').replace('{count}', String(familyCount)))
        : null

      const anomalyNote = data.registryAnomaly === true
        ? h('div', { className: 'ac-hint-warn' }, t('invAnomalyOn'))
        : null

      const actionRow = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' }, t('invSweepNote')),
        h('div', { style: { display: 'flex', gap: '8px' } },
          data.sessions.length === 0
            ? null
            : (confirming
              ? h('button', { className: 'ac-btn', disabled: busy, onClick: () => void purge() },
                  (force ? t('invConfirmForce') : t('invConfirm')).replace('{count}', String(targetCount)))
              : h('button', { className: 'ac-btn', disabled: busy || (targetCount === 0 && data.sessions.length > 0), onClick: () => setConfirming(true) },
                  force ? t('invCleanForce') : t('invClean'))),
          confirming ? h('button', { className: 'ac-btn', onClick: () => setConfirming(false) }, t('invCancel')) : null))

      return wrap(summary, anomalyNote, familyNote, forceRow, actionRow, ...rows, more, blockedBlock, reasonBlock,
        orphanSection,
        h('div', { className: 'ac-row-desc' }, note || t('invNote')))
    }

    /* ── F线：子代理对话管理（2026-10-24）────────────────────────
       subagent 会话（workflow/subagent 派生的子任务）侧栏不显示、任务完成后
       就是死数据。用户定位：无意义/不可见 → 可清。与「不可见会话」并列，
       默认折叠；清理带两步确认（真删不可逆，删前自动备份到 backup-true-delete-subagent）。 */
    const SUBAGENT = '/dsh-adapter-compat/subagent'
    const SUBAGENT_PURGE = '/dsh-adapter-compat/subagent/purge'

    function SubagentBlock() {
      const [data, setData] = useState(null)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)
      const [confirming, setConfirming] = useState(false)

      const load = useCallback(async () => {
        try {
          const r = await fetchJson(SUBAGENT)
          if (r.ok && r.data && r.data.value) setData(r.data.value)
          else setNote(t('subReadFailed'))
        } catch { setNote(t('subReadFailed')) }
      }, [])

      useEffect(() => { void load() }, [load])

      const purge = async () => {
        setBusy(true)
        setNote('')
        try {
          const dead = (data.sessions ?? []).filter((s) => !s.live)
          const r = await fetchJson(SUBAGENT_PURGE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: dead.map((s) => s.id) }),
          })
          if (r.ok && r.data && r.data.ok) {
            const refused = (r.data.results || []).filter((x) => x.status !== 'deleted' && x.status !== 'not-found').length
            setNote(t('subFreed').replace('{count}', String(r.data.deletedCount ?? 0)).replace('{mb}', String(r.data.freedMB ?? 0))
              + (refused > 0 ? `（${refused} 条被拒，见结果）` : ''))
            await load()
          } else setNote(t('subPurgeFailed') + '：' + String(r.data && r.data.error ? r.data.error : t('invUnknown')))
        } catch (e) {
          setNote(t('subPurgeFailed') + '：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
          setConfirming(false)
        }
      }

      const wrap = (...kids) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { className: 'ac-row' },
          h('div', { className: 'ac-row-desc' }, t('subCleanTitle')),
          h('button', { className: 'ac-btn', onClick: () => void load() }, t('invRefresh'))),
        ...kids)

      if (!data) return wrap(h('div', { className: 'ac-row-desc' }, note || t('subScanning')))

      const liveCount = (data.sessions ?? []).filter((s) => s.live).length
      const dead = (data.sessions ?? []).filter((s) => !s.live)

      const rows = dead.slice(0, 30).map((s) => h('div', { key: s.id, className: 'ac-session' },
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { className: 'ac-session-name' }, s.title ? `「${s.title}」` : t('invNoTitle')),
          h('div', { className: 'ac-session-hint', style: { fontFamily: 'monospace' } },
            `${String(s.id).slice(0, 26)}  ${s.sizeMB}MB  ${s.mtime}  depth=${s.depth ?? '?'}`))))

      const actionRow = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' },
          data.count === 0
            ? t('subEmpty')
            : t('subSummary').replace('{count}', String(data.count)).replace('{mb}', String(data.totalMB))
              + (liveCount > 0 ? t('subLiveNote').replace('{count}', String(liveCount)) : '')),
        h('div', { style: { display: 'flex', gap: '8px' } },
          dead.length === 0
            ? null
            : (confirming
              ? h('button', { className: 'ac-btn', disabled: busy, onClick: () => void purge() },
                  t('subConfirm').replace('{count}', String(dead.length)))
              : h('button', { className: 'ac-btn', disabled: busy, onClick: () => setConfirming(true) }, t('subClean'))),
          confirming ? h('button', { className: 'ac-btn', onClick: () => setConfirming(false) }, t('invCancel')) : null))

      return wrap(actionRow, ...rows,
        data.count > 30 ? h('div', { className: 'ac-row-desc' }, `…共 ${data.count} 条` ) : null,
        h('div', { className: 'ac-row-desc' }, note || t('subNote')))
    }

    /* ── A线：自动瘦身设置（2026-10-24，默认关）─────────────────────
       选项存 adapter-compat-slim.json（GET/POST /dsh-adapter-compat/slim-options）：
         autoSlim  开关（默认关——用户明令「不倾向打开」）
         keepTurns 保留最近 N 轮原文（默认 10）
         digest    占位带前两行摘要（默认开）
         minEvents 触发门槛：事件数低于此不动（默认 2000，防误伤小会话）
       开启后开机 90s 扫一遍：非 live + ≥1MB + 走全套 verify/备份/回滚门禁。 */
    const SLIM_OPTS = '/dsh-adapter-compat/slim-options'

    function AutoSlimBlock() {
      const [opts, setOpts] = useState(null)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const r = await fetchJson(SLIM_OPTS)
          if (r.ok && r.data && r.data.options) setOpts(r.data.options)
          else setNote(t('loadFailed'))
        } catch { setNote(t('loadFailed')) }
      }, [])

      useEffect(() => { void load() }, [load])

      const save = async () => {
        if (!opts) return
        setBusy(true)
        setNote('')
        try {
          const r = await fetchJson(SLIM_OPTS, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              autoSlim: opts.autoSlim === true,
              keepTurns: Math.max(0, Number(opts.keepTurns) || 0),
              digest: opts.digest !== false,
              minEvents: Math.max(100, Number(opts.minEvents) || 2000),
            }),
          })
          if (r.ok && r.data && r.data.options) { setOpts(r.data.options); setNote(t('savedNextBoot')) }
          else setNote(t('sidefoldSaveFail') + String(r.data && r.data.error ? r.data.error : t('unknownReason')))
        } catch (e) { setNote(t('sidefoldSaveFail') + String(e && e.message ? e.message : e)) }
        finally { setBusy(false) }
      }

      if (!opts) return h('div', { className: 'ac-row-desc' }, note || t('loadingPrefs'))

      const toggle = (key) => () => setOpts((p) => ({ ...p, [key]: p[key] !== true }))

      const autoRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('asToggle')),
          h('div', { className: 'ac-row-desc' }, t('asToggleDesc'))),
        h('button', { className: 'ac-btn', onClick: toggle('autoSlim') }, opts.autoSlim === true ? t('renderFxOn') : t('renderFxOff')))

      const keepRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('asKeep')),
          h('div', { className: 'ac-row-desc' }, t('asKeepDesc'))),
        h('input', {
          className: 'ac-btn', type: 'number', min: 0, max: 500, step: 1, style: { width: '100px' },
          value: String(opts.keepTurns ?? 10),
          onChange: (e) => setOpts((p) => ({ ...p, keepTurns: Number(e.target.value.replace(/\D/g, '')) || 0 })),
        }))

      const digestRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('asDigest')),
          h('div', { className: 'ac-row-desc' }, t('asDigestDesc'))),
        h('button', { className: 'ac-btn', onClick: toggle('digest') }, opts.digest !== false ? t('renderFxOn') : t('renderFxOff')))

      const minRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, t('asMin')),
          h('div', { className: 'ac-row-desc' }, t('asMinDesc'))),
        h('input', {
          className: 'ac-btn', type: 'number', min: 100, max: 100000, step: 100, style: { width: '110px' },
          value: String(opts.minEvents ?? 2000),
          onChange: (e) => setOpts((p) => ({ ...p, minEvents: Number(e.target.value.replace(/\D/g, '')) || 2000 })),
        }))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        autoRow, keepRow, digestRow, minRow,
        h('div', { className: 'ac-row' },
          h('div', { className: 'ac-row-desc' }, note || t('asNote')),
          h('button', { className: 'ac-btn', disabled: busy, onClick: () => void save() }, busy ? t('saving') : t('save'))))
    }

    function HealSection() {      const [opts, setOpts] = useState({ bootScan: false, sendScan: false, skipUnchanged: false })
      const [manualBusy, setManualBusy] = useState('')
      const [manualNote, setManualNote] = useState('')
      const [loaded, setLoaded] = useState(false)
      const [saving, setSaving] = useState(false)
      const [saved, setSaved] = useState('')
      const [report, setReport] = useState(null)
      const [checking, setChecking] = useState(false)
      const [fixing, setFixing] = useState(false)
      const [fixResult, setFixResult] = useState(null)

      useEffect(() => {
        let dead = false
        fetchJson(HEAL_OPTS).then((r) => {
          if (dead) return
          if (r.ok && r.data && r.data.options) setOpts(r.data.options)
          setLoaded(true)
        }).catch(() => { if (!dead) setLoaded(true) })
        return () => { dead = true }
      }, [])

      const toggle = (key) => setOpts((o) => ({ ...o, [key]: !o[key] }))

      const save = async () => {
        setSaving(true); setSaved('')
        try {
          const r = await fetchJson(HEAL_OPTS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts) })
          if (r.ok && r.data && r.data.options) { setOpts(r.data.options); setSaved('ok') } else setSaved('fail')
        } catch (e) { setSaved('fail') }
        setSaving(false)
      }

      const check = async () => {
        setChecking(true); setReport(null); setFixResult(null)
        try {
          const url = HEAL_SCAN + (opts.skipUnchanged ? '?skipUnchanged=1' : '')
          const r = await fetchJson(url)
          if (r.ok) setReport(r.data.report)
        } catch (e) { /* 网络失败保持空 */ }
        setChecking(false)
      }

      const fix = async () => {
        setFixing(true); setFixResult(null)
        try {
          const r = await fetchJson(HEAL_FIX, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ write: true, skipUnchanged: opts.skipUnchanged }),
          })
          if (r.ok) { setFixResult(r.data.result); setReport(null) }
        } catch (e) { /* 同上 */ }
        setFixing(false)
      }

      const checkRow = (key, title, desc, warnText) => {
        const kids = [
          h('div', { className: 'ac-row-title', style: { display: 'inline' } }, title),
          h('div', { className: 'ac-row-desc' }, desc),
        ]
        if (warnText) kids.push(h('div', { className: 'ac-hint-warn' }, warnText))
        return h('label', { className: 'ac-check' },
          h('input', { type: 'checkbox', checked: opts[key], onChange: () => toggle(key) }),
          h('span', null, ...kids))
      }

      /** 数值选项行（scale=1000 时界面按秒显示）。 */
      const numRow = (key, title, desc, { min, max, step = 1, scale = 1, unit = '' } = {}) => h('div', { className: 'ac-check', style: { alignItems: 'flex-start' } },
        h('span', null,
          h('div', { className: 'ac-row-title', style: { display: 'inline' } }, title),
          h('div', { className: 'ac-row-desc' }, desc),
          h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', marginTop: '4px' } },
            h('input', {
              className: 'ac-btn',
              type: 'number',
              style: { width: '120px' },
              min, max, step,
              value: String(Math.round(Number(opts[key] ?? 0) / scale)),
              onChange: (e) => {
                const n = Number(e.target.value)
                if (!Number.isFinite(n)) return
                setOpts((o) => ({ ...o, [key]: Math.round(n * scale) }))
              },
            }),
            unit ? h('span', { className: 'ac-row-desc' }, unit) : null)))

      /** 手动触发按钮（不受上面开关影响 —— 用户要求「也要允许手动启动校准」）。 */
      const manualBtn = (route, label, key) => h('button', {
        className: 'ac-btn',
        disabled: manualBusy === key,
        onClick: async () => {
          setManualBusy(key)
          setManualNote('')
          try {
            const r = await fetchJson(route, { method: 'POST' })
            setManualNote(r.ok && r.data && r.data.ok ? `${label}：完成` : `${label}失败：${String(r.data && r.data.error ? r.data.error : t('unknown'))}`)
          } catch (e) {
            setManualNote(`${label}失败：${String(e && e.message ? e.message : e)}`)
          } finally {
            setManualBusy('')
          }
        },
      }, manualBusy === key ? t('running') : label)

      /* 分区整体也折叠（2026-11-24 用户要求「会话日志修复都弄成这样」）：
         标题行 = ▸ 会话日志修复，展开才显示描述与各子块；不再常驻一个标题卡片。 */
      const head = null

      const buttons = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('button', { className: 'ac-btn ac-btn-primary', disabled: saving, onClick: save },
          saving ? t('saving') : (saved === 'ok' ? t('healSaved') : t('healSave'))),
        saved === 'fail' ? h('span', { className: 'ac-hint-warn' }, t('healSaveFail')) : null,
        h('button', { className: 'ac-btn', disabled: checking, onClick: check },
          checking ? t('healChecking') : t('healCheck')))

      let reportBlock = null
      if (report) {
        const kids = [h('div', null, `扫描 ${report.scanned} 个会话` +
          (report.skippedUnchanged ? `，按指纹跳过 ${report.skippedUnchanged} 个` : ''))]
        if (report.unreadable && report.unreadable.length) kids.push(h('div', null, `读取失败 ${report.unreadable.length} 个`))
        if (report.withBlanks > 0) {
          kids.push(h('div', null, h('b', null, `${report.withBlanks} 个会话共 ${report.totalBlanks} 条空工具结果`)))
          kids.push(h('div', null, t('healBrokenNote')))
        }
        /* 失效附件（9999.9.38）：以前完全不查，所以「所有对话正常」是假阴性 ——
           结构完好、字节已不在磁盘上的图片块会让官方 DeepSeek 整轮拒收。 */
        if (report.totalDeadAttachments > 0) {
          kids.push(h('div', null, h('b', null, `${report.withDeadAttachments} 个会话共 ${report.totalDeadAttachments} 个失效附件（图片/文件已不在磁盘上）`)))
          kids.push(h('div', null, t('healRejectNote')))
        }
        if (report.withBlanks > 0 || report.totalDeadAttachments > 0) {
          kids.push(h('div', { style: { marginTop: '6px' } },
            h('button', { className: 'ac-btn ac-btn-primary', disabled: fixing, onClick: fix },
              fixing ? t('healRepairing') : t('healRepair'))))
        } else {
          kids.push(h('div', null, t('healClean')))
        }
        reportBlock = h('div', { className: 'ac-report' }, ...kids)
      }

      let fixBlock = null
      if (fixResult) {
        const done = (fixResult.done || []).length
        const unchanged = fixResult.unchanged || 0
        const live = (fixResult.skipped || []).length
        const failed = (fixResult.failed || []).length
        let txt = `修复完成：${done} 个会话`
        if (unchanged) txt += `，${unchanged} 个未变化跳过`
        if (live) txt += `，${live} 个正在运行跳过`
        if (failed) txt += `，${failed} 个失败`
        fixBlock = h('div', { className: 'ac-report' }, h('div', null, txt))
      }

      const body = loaded
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            /* 2026-10-16 用户要求：本分区里**每个大项**都折叠、默认收起（点标题或右侧按钮展开）。 */
            h(Fold, { key: 'main', title: t('healMain'), desc: t('healMainDesc') },
              checkRow('bootScan', t('healBoot'), t('healBootDesc')),
              checkRow('sendScan', t('healSend'), t('healSendDesc'), opts.sendScan ? null : t('healSendWarn')),
              checkRow('skipUnchanged', t('healSkip'), t('healSkipDesc')),
              buttons,
              reportBlock,
              fixBlock),
            /* A线（2026-10-24）：自动瘦身（默认关）。设置存 adapter-compat-slim.json，
               与 heal-options 解耦；手动瘦身照旧走会话与提示词里的瘦身面板。 */
            h(Fold, { key: 'autoslim', title: t('asNav'), desc: t('asDesc') }, h(AutoSlimBlock)),
            /* 2026-10-16 用户要求：扫描频率/自动扫描/校准频率都做成开关，手动校准也要有。 */
            h(Fold, { key: 'cadence', title: t('cadNav'), desc: t('cadDesc') },
              h('div', { className: 'ac-row-desc' }, t('cadChangeTitle')),
              checkRow('changeRescan', t('cadRescan'), t('cadRescanDesc')),
              checkRow('changePurge', t('cadPurge'), t('cadPurgeDesc')),
              checkRow('changeHeadGuard', t('cadHead'), t('cadHeadDesc')),
              numRow('watchDebounceMs', t('cadDebounce'), t('cadDebounceDesc'), { min: 0.2, max: 600, unit: t('unitSec'), scale: 1000 }),
              numRow('watchPollMs', t('cadPoll'), t('cadPollDesc'), { min: 5, max: 3600, unit: t('unitSec'), scale: 1000 }),
              h('div', { className: 'ac-row-desc', style: { marginTop: '6px' } }, t('cadBootTitle')),
              checkRow('bootTitleWarm', t('cadBootWarm'), t('cadBootWarmDesc')),
              checkRow('bootHeadGuard', t('cadBootHead'), t('cadBootHeadDesc')),
              checkRow('bootTrueDelete', t('cadBootTrueDelete'), t('cadBootTrueDeleteDesc')),
              h('div', { className: 'ac-row-desc', style: { marginTop: '6px' } }, t('cadCalTitle')),
              checkRow('pressureCalibration', t('cadCal'), t('cadCalDesc')),
              numRow('pressureCalibrationIntervalMs', t('cadCalInterval'), t('cadCalIntervalDesc'), { min: 0, max: 3600, unit: t('unitSecOnce'), scale: 1000 }),
              h('div', { className: 'ac-row' },
                h('div', { className: 'ac-row-desc' }, t('cadManualNote')),
                h('div', { style: { display: 'flex', gap: '8px' } },
                  manualBtn('/dsh-adapter-compat/calibrate-now', t('cadManualCal'), 'cal'),
                  manualBtn('/dsh-adapter-compat/warm-now', t('cadManualWarm'), 'warm'))),
              h('div', { className: 'ac-row-desc' }, manualNote || t('cadRestartHint'))),
            h(Fold, { key: 'inv', title: t('invNav'), desc: t('invDesc') }, h(InvisibleBlock)),
            h(Fold, { key: 'sub', title: t('subNav'), desc: t('subDesc') }, h(SubagentBlock)),
            h(Fold, { key: 'ver', title: t('verNav'), desc: t('verDesc') }, h(VersionsBlock)))
        : h('div', { className: 'ac-row-desc' }, t('loadingPrefs'))

      return h('div', { className: 'ac-settings' },
        h(Fold, { title: t('healNav'), desc: t('healDesc') }, body))
    }

    function apply(ctx) {
      const applyCtx = ctx
      /* 2026-11-12 i18n：注册宿主 locale（zh/en），语言切换由宿主重渲染生效；locale 服务缺席时回落中文。 */
      try {
        ctx.effect(() => ctx.locale && ctx.locale.register && ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: dictionaries`)
        const bound = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
        if (bound) {
          t = (key, vars) => {
            let out = bound(key) || ZH[key] || key
            if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
            return out
          }
        }
      } catch { /* locale 缺席回落中文 */ }
      /* 2026-10-11 夜：本插件的「侧栏排序」设置分区已**退役** ——
         用户定案排序改在 dsh-session-kit 的两个面板里（工作区管理 / 会话搬家（批量））。
         本插件的 order.js 三条路由**保留**，现在只作为 session-kit 的后端。 */
      /* 2026-10-10 用户定案：顶级「会话搬家」分区退役——唯一入口改为
         设置 → 会话与提示词 → 会话搬家（批量）（session-kit 的批量面板）。
         move-session 宿主路由照常服务批量面板。 */

      /* 2026-10-13：设置 → 会话与提示词 下加「会话日志修复」分区。
         插槽点 settings.section（list slot；registerOptions: id/order/label）。
         order 37 —— 挨着 session-kit「会话与提示词」（35）与已退役的排序分区（36）。 */
      try {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: `${NS}-heal`,
          order: 37,
          locale: NS,
          label: () => t('healNav'),
        }, HealSection)), `${NS}: heal section`)
      } catch {
        /* 注册失败不影响插件其余部分 */
      }

      /* 2026-10-16（用户要求「session-kit 也弄吧」）：压缩出口**真正挂进**
         「会话与提示词」分区内部 —— session-kit 已在它的 settings.section 注册里
         声明子插槽 `dsh-session-kit.settings.extra`（children 表）并在组件里 renderSlot。
         slot 机制：注册进未声明的槽位会抛「is not declared」⇒ 走 ctx.slots.inject，
         它按声明 epoch 触发；声明不出现就永不触发（= session-kit 没装/没开也不报错）。
         兜底：session-kit 不在时保留独立分区（order 36）；子插槽一旦挂上就撤掉兜底，避免重复。 */
      let standaloneExitDispose = null
      let nestedExitActive = false
      let injectThrew = ''
      let standaloneTitleDispose = null
      let titleModelNestedActive = false
      try {
        ctx.effect(() => ctx.slots.inject(SK_EXTRA, () => {
          try {
            const dispose = ctx.slots.register({
              name: SK_EXTRA,
              id: `${NS}-exit`,
              order: 0,
            }, ExitSection)
            /* ⚠️ 只有**注册成功**才置位。上一版先置位再注册：register 一旦抛错
               （槽位其实没声明），标志位已是 true ⇒ 兜底分区被静默跳过 ⇒ 两边都不显示。
               这就是「压缩出口根本不出现」的根因。 */
            nestedExitActive = true
            try {
              if (typeof standaloneExitDispose === 'function') {
                standaloneExitDispose()
                standaloneExitDispose = null
              }
            } catch { /* ignore */ }
            return dispose
          } catch (error) {
            injectThrew = String(error && error.message ? error.message : error).slice(0, 120)
            nestedExitActive = false
            return () => {}
          }
        }), `${NS}: exit section (session-kit sub-slot)`)
      } catch (error) {
        injectThrew = String(error && error.message ? error.message : error).slice(0, 120)
        nestedExitActive = false
      }
      try {
        ctx.effect(() => ctx.slots.inject('settings.section', () => {
          if (nestedExitActive) return () => {}
          const dispose = ctx.slots.register({
            name: 'settings.section',
            id: `${NS}-exit-standalone`,
            order: 36,
            locale: NS,
            label: () => t('exitNav'),
          }, ExitSection)
          standaloneExitDispose = dispose
          return dispose
        }), `${NS}: exit section (fallback)`)
      } catch {
        /* 注册失败不影响插件其余部分 */
      }
      /* 标题生成模型独立面板（2026-11-23）：SK_EXTRA order 2（与压缩出口 order 0 并排）；
         session-kit 不在时走独立 settings.section 兜底（order 38），与压缩出口兜底互不影响。
         双注册防重复的模式与压缩出口同款：子插槽注册成功才置位，兜底看到置位就撤。 */
      try {
        ctx.effect(() => ctx.slots.inject(SK_EXTRA, () => {
          try {
            const dispose = ctx.slots.register({ name: SK_EXTRA, id: `${NS}-title-model`, order: 2 }, () => h(ModelContext.Provider, { value: applyCtx }, h(TitleModelSection)))
            titleModelNestedActive = true
            try {
              if (typeof standaloneTitleDispose === 'function') {
                standaloneTitleDispose()
                standaloneTitleDispose = null
              }
            } catch { /* ignore */ }
            return dispose
          } catch (error) {
            titleModelNestedActive = false
            return () => {}
          }
        }), `${NS}: title model section (session-kit sub-slot)`)
      } catch { titleModelNestedActive = false }
      try {
        ctx.effect(() => ctx.slots.inject('settings.section', () => {
          if (titleModelNestedActive) return () => {}
          const dispose = ctx.slots.register({
            name: 'settings.section',
            id: `${NS}-title-model-standalone`,
            order: 38,
            locale: NS,
            label: () => t('titleModelNav'),
          }, () => h(ModelContext.Provider, { value: applyCtx }, h(TitleModelSection)))
          standaloneTitleDispose = dispose
          return dispose
        }), `${NS}: title model section (fallback)`)
      } catch {
        /* 注册失败不影响插件其余部分 */
      }
      /* 侧边栏入口显隐卡片挂进 session-kit 的 SK_EXTRA 子插槽（order 1，与压缩出口
         order 0 并排；list 插槽多条目共存）。四组折叠引擎已于 2026-11-26 整体移除。 */
      try {
        ctx.effect(() => ctx.slots.inject(SK_EXTRA, () => {
          try {
            const dispose = ctx.slots.register({
              name: SK_EXTRA,
              id: `${NS}-sidebar-entries`,
              order: 1,
            }, SidebarEntriesSection)
            return dispose
          } catch {
            /* 注册失败不影响其余部分 */
            return () => {}
          }
        }), `${NS}: sidebar entries section (session-kit sub-slot)`)
      } catch {
        /* ignore */
      }

      /* 2026-10-16（用户要求「紧致点」）：不可见会话清理**并入**「会话日志修复」分区，
         不再单开顶级分区 —— 上面的 HealSection 里渲染 h(InvisibleBlock)。 */
      try {
        fetchJson(EXIT_PREFS).then((r) => {
          if (r.ok && r.data && r.data.value) {
            applyPagerHidden(r.data.value.hideVersionPager !== false)
            /* [B线] 启动即应用懒渲染——用户没打开设置页时也吃到开关。 */
            applyRenderFx(r.data.value.renderFx === true)
          }
        }).catch(() => { /* 读不到就保持默认（不隐藏），不影响其它功能 */ })
      } catch {
        /* ignore */
      }
      /* 报到（诊断）：把浏览器侧的真实注册结果写进宿主日志 —— 我自己 curl 不会带这个 marker，
         所以日志里出现 marker=adapter-client 就证明**浏览器确实加载了这一版**。 */
      try {
        let skExtraEntries = -1
        try { skExtraEntries = typeof ctx.slots.entries === 'function' ? ctx.slots.entries(SK_EXTRA).length : -1 } catch { /* ignore */ }
        fetch(HELLO, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            marker: 'adapter-client-9999.9.9-ldwglobal',
            nested: nestedExitActive,
            fallback: typeof standaloneExitDispose === 'function',
            skExtraEntries,
            injectThrew,
          }),
        }).catch(() => { /* 报到失败无关功能 */ })
      } catch {
        /* ignore */
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = NS
    return module.exports
  },
})
