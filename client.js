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
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    const NS = 'adapter-compat'
    const inject = ['slots']
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

    /* 文案写死中文：这是 Evelyn 的私人插件，不值得为单用户铺 locale。 */
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
      exitNav: '压缩出口与版本分页器',
      exitDesc: '压缩摘要的 .txt 出口开关，以及「版本切换」按钮的显隐（值写真源仍是 webin 配置，改完即时生效）',
      pagerLabel: '「版本切换」按钮',
      pagerDesc: '分叉会话 / 修改过对话后出现在消息下方的版本分页器（dsh-easyrewrite 提供）',
      pagerHidden: '已隐藏',
      pagerShown: '显示中',
      modeLabel: '压缩 .txt 出口',
      modeDesc: '压缩摘要（/compact）输入太大时，把全文打包成 .txt 附件传给网页端',
      thresholdLabel: '直接发送阈值（字符）',
      thresholdDesc: 'auto 模式下低于该值直接发输入框，超过才打包 .txt',
      exitNote: '改完点保存即生效，不用重启',
      save: '保存',
      /* 版本家族与磁盘占用（2026-10-16） */
      verNav: '版本家族与磁盘占用',
      verDesc: '分叉会话会复制父会话的历史，这里列出各版本家族的体积，可按需清理旧版本',
      verGuard: '旧版本受保护（不自动真删）',
      verGuardDesc: '切换版本时另一个分支会被标墓碑，本插件的真删除默认跳过这些家族成员，只记账不动刀',
      verNote: '清理是真删（不留副本），正在运行的会话会被跳过',
      /* 会话日志修复分区文案（2026-10-13） */
      healNav: '会话日志修复',
      healDesc: '清理会话日志里的残缺工具结果（断流/加载失败留下），修复前自动备份',
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
    }

    const style = `
      .ac-settings { display: flex; flex-direction: column; width: 100%; max-width: 760px; gap: 10px; }
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
      if (/live/i.test(message)) return ZH.errLive
      if (/not found/i.test(message)) return ZH.errNotFound
      return ZH.errOther + '：' + message
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
          setNotice({ ok: true, text: ZH.done.replace('{target}', target) })
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
            h('div', { className: 'ac-modal-title' }, ZH.nav),
            h('button', { className: 'ac-btn', onClick: onClose }, ZH.close)),
          h('div', { className: 'ac-modal-body' },
            h('div', null,
              h('div', { className: 'ac-session-hint', style: { marginBottom: 4 } }, ZH.target),
              h('select', {
                className: 'ac-select',
                value: target,
                onChange: (e) => setTarget(e.currentTarget.value),
              },
              h('option', { value: '' }, ZH.targetPlaceholder),
              workspaceTitles.map((t) => h('option', { key: t, value: t }, t)))),
            notice ? h('div', { className: 'ac-notice ' + (notice.ok ? 'ac-notice-ok' : 'ac-notice-err') }, notice.text) : null,
            groups === null && !error ? h('div', { className: 'ac-empty' }, ZH.loading) : null,
            error ? h('div', { className: 'ac-notice ac-notice-err' },
              ZH.loadFailed + '：' + error + ' ',
              h('button', { className: 'ac-btn', style: { marginLeft: 8 }, onClick: () => void load() }, ZH.retry)) : null,
            (groups ?? []).length === 0 && !error && groups !== null ? h('div', { className: 'ac-empty' }, ZH.empty) : null,
            (groups ?? []).map((group) =>
              h('div', { key: group.workspaceTitle },
                h('div', { className: 'ac-group-title' },
                  group.workspaceTitle + ' · ' + ZH.sessionsIn.replace('{count}', String(group.sessions.length))),
                group.sessions.map((session) =>
                  h('div', { key: session.id, className: 'ac-session' },
                    h('div', { style: { minWidth: 0, flex: 1 } },
                      h('div', { className: 'ac-session-name' }, titleOf(session)),
                      h('div', { className: 'ac-session-hint' }, session.id)),
                    h('button', {
                      className: 'ac-btn ac-btn-primary',
                      disabled: !target || busyId !== '',
                      onClick: () => void move(session.id),
                    }, busyId === session.id ? ZH.moving : ZH.move)))))),
          h('div', { className: 'ac-modal-foot' },
            h('button', { className: 'ac-btn', onClick: onClose }, ZH.close)))
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
            h('div', { className: 'ac-row-title' }, ZH.nav),
            h('div', { className: 'ac-row-desc' }, ZH.desc)),
          h('button', { className: 'ac-btn', onClick: () => setOpen(true) }, ZH.open)),
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
    const PAGER_SELECTOR = '[data-dsh-easyrewrite="version-pager"]'
    const EXIT_MODE_LABELS = {
      never: 'never · 不走网页（压缩请求直接拒绝）',
      auto: 'auto · 超过阈值才打包 .txt（推荐）',
      always: 'always · 一律打包 .txt 上传',
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
          } else setNote('读取失败，可重试')
        }).catch(() => { if (!dead) setNote('读取失败，可重试') })
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
            body: JSON.stringify({
              compactionFileMode: prefs.compactionFileMode,
              compactionFileThresholdChars: prefs.compactionFileThresholdChars,
              hideVersionPager: prefs.hideVersionPager,
            }),
          })
          if (r.ok && r.data && r.data.ok) {
            const v = r.data.value || prefs
            setPrefs(v)
            applyPagerHidden(v.hideVersionPager !== false)
            setNote('已保存 · 即时生效')
          } else setNote('保存失败：' + String(r.data && r.data.error ? r.data.error : '未知原因'))
        } catch (e) {
          setNote('保存失败：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      const head = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, ZH.exitNav),
          h('div', { className: 'ac-row-desc' }, ZH.exitDesc)))

      if (!prefs) {
        return h('div', { className: 'ac-settings' }, head, h('div', { className: 'ac-row-desc' }, '读取设置…'))
      }

      const pagerRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, ZH.pagerLabel),
          h('div', { className: 'ac-row-desc' }, ZH.pagerDesc)),
        h('button', {
          className: 'ac-btn',
          onClick: () => setPrefs((p) => ({ ...p, hideVersionPager: p.hideVersionPager !== true })),
        }, prefs.hideVersionPager !== true ? ZH.pagerShown : ZH.pagerHidden))

      const modeRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, ZH.modeLabel),
          h('div', { className: 'ac-row-desc' }, ZH.modeDesc)),
        h('select', {
          className: 'ac-btn',
          value: prefs.compactionFileMode,
          onChange: (e) => setPrefs((p) => ({ ...p, compactionFileMode: e.target.value })),
        }, ...Object.keys(EXIT_MODE_LABELS).map((k) => h('option', { key: k, value: k }, EXIT_MODE_LABELS[k]))))

      const thresholdRow = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, ZH.thresholdLabel),
          h('div', { className: 'ac-row-desc' }, ZH.thresholdDesc)),
        h('input', {
          className: 'ac-btn',
          type: 'number',
          min: 1000,
          step: 1000,
          style: { width: '140px' },
          value: String(prefs.compactionFileThresholdChars),
          onChange: (e) => setPrefs((p) => ({ ...p, compactionFileThresholdChars: Number(e.target.value) })),
        }))

      const foot = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' }, note || ZH.exitNote),
        h('button', { className: 'ac-btn', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : ZH.save))

      return h('div', { className: 'ac-settings' }, head, pagerRow, modeRow, thresholdRow, foot)
    }

    /* ── 版本家族与磁盘占用（9999.9.25）──────────────────────────
       分叉 = 把父会话的事件前缀**复制**进新会话（DSH 的 buildForkSeed），
       header 记 parentSession ⇒ 确实占盘（实测 17 条 / 21.97 MB）。
       真删除默认**跳过**这些家族成员：切换版本会往另一个分支写墓碑，
       真删会把那个版本的内容物理切除，旧版本就回不去了。
       想省空间时在这里手动清（真删，不留副本）。 */
    const VERSIONS = '/dsh-adapter-compat/versions'
    const VERSIONS_PURGE = '/dsh-adapter-compat/versions/purge'

    function VersionsSection() {
      const [data, setData] = useState(null)
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState('')
      const [confirmId, setConfirmId] = useState('')

      const load = useCallback(async () => {
        try {
          const r = await fetchJson(VERSIONS)
          if (r.ok && r.data && r.data.value) setData(r.data.value)
          else setNote('读取失败')
        } catch { setNote('读取失败') }
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
          } else setNote('清理失败：' + String(r.data && r.data.error ? r.data.error : '未知'))
        } catch (e) {
          setNote('清理失败：' + String(e && e.message ? e.message : e))
        } finally {
          setBusy('')
          setConfirmId('')
        }
      }

      const head = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, ZH.verNav),
          h('div', { className: 'ac-row-desc' }, ZH.verDesc)),
        h('button', { className: 'ac-btn', onClick: () => void load() }, '刷新'))

      if (!data) {
        return h('div', { className: 'ac-settings' }, head, h('div', { className: 'ac-row-desc' }, note || '正在统计…'))
      }

      const summary = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' },
          `${data.familyCount} 个版本家族 · ${data.forkCount} 条分叉 · 分叉占 ${data.totalForkMB} MB · 全部会话 ${data.totalAllMB.toFixed(1)} MB`))

      const protection = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, ZH.verGuard),
          h('div', { className: 'ac-row-desc' }, ZH.verGuardDesc)))

      const famRows = data.families.slice(0, 12).map((fam) => {
        const forks = fam.members.filter((m) => m.isFork)
        const members = fam.members.map((m) => h('div', { key: m.id, className: 'ac-row-desc', style: { fontFamily: 'monospace' } },
          `${m.id.slice(0, 26)}  ${m.sizeMB}MB  ${m.isRoot ? '根' : '分叉'}${m.orphanFork ? '·孤' : ''}  ${m.mtime}`))
        const actions = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('span', { className: 'ac-row-desc' }, `${fam.sizeMB}MB`),
          confirmId === fam.root
            ? h('button', { className: 'ac-btn', disabled: busy !== '', onClick: () => void purge(forks.map((m) => m.id), fam.root) }, `确认删除 ${forks.length} 条分叉`)
            : h('button', {
                className: 'ac-btn',
                disabled: busy !== '' || forks.length === 0,
                onClick: () => setConfirmId(fam.root),
              }, '清理旧版本'),
          confirmId === fam.root ? h('button', { className: 'ac-btn', onClick: () => setConfirmId('') }, '取消') : null)
        return h('div', { key: fam.root, style: { borderTop: '1px solid var(--dsw-alias-border-subtle, #3333)', paddingTop: '6px' } },
          h('div', { className: 'ac-row' },
            h('div', null,
              h('div', { className: 'ac-row-title' }, `家族 ${fam.root.slice(0, 26)}`),
              h('div', { className: 'ac-row-desc' }, `${fam.members.length} 个版本 · 分叉 ${forks.length} 条`)),
            actions),
          ...members)
      })

      const foot = h('div', { className: 'ac-row' },
        h('div', { className: 'ac-row-desc' }, note || ZH.verNote))

      return h('div', { className: 'ac-settings' }, head, summary, protection, ...famRows, foot)
    }

    function HealSection() {      const [opts, setOpts] = useState({ bootScan: false, sendScan: false, skipUnchanged: false })
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

      const head = h('div', { className: 'ac-row' },
        h('div', null,
          h('div', { className: 'ac-row-title' }, ZH.healNav),
          h('div', { className: 'ac-row-desc' }, ZH.healDesc)))

      const buttons = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('button', { className: 'ac-btn ac-btn-primary', disabled: saving, onClick: save },
          saving ? '保存中…' : (saved === 'ok' ? ZH.healSaved : ZH.healSave)),
        saved === 'fail' ? h('span', { className: 'ac-hint-warn' }, ZH.healSaveFail) : null,
        h('button', { className: 'ac-btn', disabled: checking, onClick: check },
          checking ? ZH.healChecking : ZH.healCheck))

      let reportBlock = null
      if (report) {
        const kids = [h('div', null, `扫描 ${report.scanned} 个会话` +
          (report.skippedUnchanged ? `，按指纹跳过 ${report.skippedUnchanged} 个` : ''))]
        if (report.unreadable && report.unreadable.length) kids.push(h('div', null, `读取失败 ${report.unreadable.length} 个`))
        if (report.withBlanks > 0) {
          kids.push(h('div', null, h('b', null, `${report.withBlanks} 个会话共 ${report.totalBlanks} 条空工具结果`)))
          kids.push(h('div', null, '（断流/附件加载失败留下的残缺；发送前扫会兜底，也可点下面按钮根治到盘上）'))
          kids.push(h('div', { style: { marginTop: '6px' } },
            h('button', { className: 'ac-btn ac-btn-primary', disabled: fixing, onClick: fix },
              fixing ? ZH.healRepairing : ZH.healRepair)))
        } else {
          kids.push(h('div', null, ZH.healClean))
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
            checkRow('bootScan', ZH.healBoot, ZH.healBootDesc),
            checkRow('sendScan', ZH.healSend, ZH.healSendDesc, opts.sendScan ? null : ZH.healSendWarn),
            checkRow('skipUnchanged', ZH.healSkip, ZH.healSkipDesc),
            buttons,
            reportBlock,
            fixBlock)
        : h('div', { className: 'ac-row-desc' }, '加载选项…')

      return h('div', { className: 'ac-settings' }, head, body)
    }

    function apply(ctx) {
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
          label: ZH.healNav,
        }, HealSection)), `${NS}: heal section`)
      } catch {
        /* 注册失败不影响插件其余部分 */
      }

      /* 2026-10-16：设置页第三个分区「版本家族与磁盘占用」。
         order 39 —— 紧挨 exit（38）。同时模块加载即按偏好隐藏分页器，
         不等用户打开设置页（否则分叉会话后仍会先看到按钮）。 */
      try {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: `${NS}-versions`,
          order: 39,
          label: ZH.verNav,
        }, VersionsSection)), `${NS}: versions section`)
      } catch {
        /* 注册失败不影响插件其余部分 */
      }
      try {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: `${NS}-exit`,
          order: 38,
          label: ZH.exitNav,
        }, ExitSection)), `${NS}: exit section`)
      } catch {
        /* 注册失败不影响插件其余部分 */
      }
      try {
        fetchJson(EXIT_PREFS).then((r) => {
          if (r.ok && r.data && r.data.value) applyPagerHidden(r.data.value.hideVersionPager !== false)
        }).catch(() => { /* 读不到就保持默认（不隐藏），不影响其它功能 */ })
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
