/**
 * 模型链条编辑器（2026-11-24 仿记忆蒸馏交互）——自包含浏览器模块。
 *
 * 复刻 dsh-session-kit 蒸馏模型卡的交互：
 *   链条按顺序逐项尝试；每项 = 「跟随会话使用模型」或「固定模型（按 provider 分组的下拉）」；
 *   fixed 项可指定思考度（reasoningEffort，按目录里该模型的 reasoning.efforts 出选项）；
 *   支持上移/下移/删除/添加固定渠道；空链 = 只用当前会话模型。
 *
 * 与蒸馏卡的差别：不依赖 session-kit——模型目录走宿主 ctx.modelDirectories.directoryFor(当前会话)，
 * 与蒸馏同源；目录不可用（拿不到会话/目录服务缺席）时下拉禁用、允许手输 provider/model，绝不让面板空白。
 *
 * 本文件是 dsh-knowledge-sqlite/chain-editor.js 的镜像副本（内容保持一致；id 不同）。
 * 被本插件 client.js 以 `require('./chain-editor.js')` 引入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-adapter-compat/chain-editor.js',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

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
        let directory
        try {
          /* 取「最近活跃会话」的目录：agents.currentInitiator 与后端扩展路由同一把尺子；
             拿不到会话 id 时退 directoryFor('')（目录服务对空 id 一般回全局目录）。 */
          let sessionId = ''
          try { sessionId = String(ctx?.agents?.currentInitiator?.()?.session?.id ?? '') } catch { /* ignore */ }
          directory = ctx?.modelDirectories?.directoryFor?.(sessionId)
        } catch { directory = undefined }
        const store = directory?.store
        if (!store) { setState({ ...emptyState, status: 'unavailable' }); return undefined }
        setState(store.getSnapshot?.() ?? emptyState)
        const unsubscribe = store.subscribe?.(() => setState(store.getSnapshot?.() ?? emptyState))
        try {
          const snap = store.getSnapshot?.()
          if (snap?.status === 'idle') void directory.load?.().catch(() => undefined)
        } catch { /* ignore */ }
        return typeof unsubscribe === 'function' ? unsubscribe : undefined
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
      const directoryReady = directory?.status === 'ready' && safeGroups.length > 0
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
                placeholder: directory?.status === 'loading' ? t('chainModelsLoading') : t('chainNoModels'),
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
        h(primitives.Button, { variant: 'outline', className: 'dsh-chain-add', disabled: busy, onClick: addFixed }, props.addLabel))
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

    module.exports = { ModelSelect, ChainEditor, useModelDirectory, ensureCss }
    return module.exports
  },
})
