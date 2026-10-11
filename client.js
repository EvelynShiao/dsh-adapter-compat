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

    /* ===================== 侧栏排序（2026-10-11） =====================
       手机端侧边栏收成竖栏，官方那条工作区/会话树的拖动排序够不着，所以这里给
       设置页补一个「侧栏排序」分区：工作区可拖、每个工作区下的会话可拖、逐工作区
       展开折叠且记住，顺序经本插件后端路由落到宿主 workspace.json。

       拖动用 Pointer Events + setPointerCapture（手机触摸也吃），手柄 touch-action:none
       所以从手柄起拖不会滚页；整行长按 320ms 也能起拖；↑↓ 按钮是稳的兜底。 */

    /** 读「哪些工作区是展开的」：显式记过的用记的，没记过的按当前 tab 的默认值。 */
    function readExpandedMap() {
      try {
        const raw = localStorage.getItem(EXPAND_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writeExpandedMap(map) {
      try {
        localStorage.setItem(EXPAND_KEY, JSON.stringify(map))
      } catch {
        /* 记不住就记不住，不影响排序 */
      }
    }

    /** 收集同一层要参与排序的行（DOM 顺序 = 当前显示顺序）。 */
    function rowsFor(kind, workspaceId) {
      try {
        const all = Array.from(document.querySelectorAll(`[data-ac-kind="${kind}"]`))
        return kind === 'workspace' ? all : all.filter((el) => el.dataset.acWs === workspaceId)
      } catch {
        return []
      }
    }

    /** 指针落在哪一行、落在那行的上半还是下半。 */
    function targetAt(rows, y, movedId) {
      const others = rows.filter((el) => el.dataset.acId !== movedId)
      if (others.length === 0) return null
      for (const el of others) {
        const rect = el.getBoundingClientRect()
        if (y < rect.top + rect.height / 2) return { id: el.dataset.acId, after: false }
      }
      return { id: others[others.length - 1].dataset.acId, after: true }
    }

    /**
     * 落点 → 宿主 anchor。宿主语义是 insertBefore(anchor)，anchor 为空 = 移到末尾；
     * 而且 anchor 是在「去掉被移项之后」的数组里找的，这里必须同款算法，否则会差一位。
     */
    function beforeIdFor(ids, movedId, hit) {
      if (!hit) return null
      const without = ids.filter((id) => id !== movedId)
      let at = without.indexOf(hit.id)
      if (at < 0) return null
      if (hit.after) at += 1
      return at >= without.length ? null : without[at]
    }

    /** 本地先按落点重排（乐观更新，松手立刻看到变化）。 */
    function reordered(groups, kind, workspaceId, movedId, beforeId) {
      if (kind === 'workspace') {
        const without = groups.filter((g) => g.id !== movedId)
        const moved = groups.find((g) => g.id === movedId)
        if (!moved) return groups
        /* 注意：这里要在「id 字符串数组」里找 anchor，不是在对象数组里找，
           否则 indexOf 恒为 -1、整体静默不重排（踩过一次）。 */
        const withoutIds = without.map((g) => g.id)
        const at = beforeId === null ? withoutIds.length : withoutIds.indexOf(beforeId)
        if (at < 0) return groups
        return [...without.slice(0, at), moved, ...without.slice(at)]
      }
      return groups.map((group) => {
        if (group.id !== workspaceId) return group
        const without = group.sessionIds.filter((id) => id !== movedId)
        const at = beforeId === null ? without.length : without.indexOf(beforeId)
        if (at < 0) return group
        const ids = [...without.slice(0, at), movedId, ...without.slice(at)]
        const byId = new Map(group.sessions.map((s) => [s.id, s]))
        return { ...group, sessionIds: ids, sessions: ids.map((id) => byId.get(id) ?? { id, title: '' }) }
      })
    }

    /* initialGroups / initialTab：渲染测试注入初始态用（线上永远是 undefined，自己去 fetch）。 */
    function OrderSection({ mirrorOrder, initialGroups, initialTab }) {
      const [tab, setTab] = useState(initialTab ?? 'session')
      const [groups, setGroups] = useState(initialGroups ?? null)
      const [expanded, setExpanded] = useState(readExpandedMap)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const [drag, setDrag] = useState(null)
      const [over, setOver] = useState(null)
      const pendingRef = useRef(null)
      const styleMountedRef = useRef(false)

      useEffect(() => {
        if (styleMountedRef.current) return
        const el = document.createElement('style')
        el.dataset.plugin = NS
        el.textContent = style
        document.head.appendChild(el)
        styleMountedRef.current = true
      }, [])

      const load = useCallback(async () => {
        try {
          const res = await fetch(ORDER_READ)
          const out = await res.json().catch(() => ({}))
          if (!res.ok || out?.ok !== true) throw new Error(String(out?.error ?? ('HTTP ' + res.status)))
          setGroups(Array.isArray(out.value?.workspaces) ? out.value.workspaces : [])
          setError('')
        } catch (e) {
          setError(String(e?.message ?? e))
          setGroups([])
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const isExpanded = useCallback((workspaceId) => {
        const saved = expanded[workspaceId]
        if (typeof saved === 'boolean') return saved
        /* 没记过：会话管理 tab 默认展开（要拖里面的会话），工作区管理 tab 默认折叠。 */
        return tab === 'session'
      }, [expanded, tab])

      const setOne = (workspaceId, value) => {
        setExpanded((prev) => {
          const next = { ...prev, [workspaceId]: value }
          writeExpandedMap(next)
          return next
        })
      }

      const setAll = (value) => {
        setExpanded((prev) => {
          const next = { ...prev }
          for (const group of groups ?? []) next[group.id] = value
          writeExpandedMap(next)
          return next
        })
      }

      /** 真正落库：POST 给本插件路由 → 宿主 registry → workspace.json。 */
      const commit = useCallback(async (kind, workspaceId, movedId, beforeId) => {
        const idsNow = kind === 'workspace'
          ? (groups ?? []).map((g) => g.id)
          : ((groups ?? []).find((g) => g.id === workspaceId)?.sessionIds ?? [])
        const index = idsNow.indexOf(movedId)
        if (index < 0) return
        /* 位次没变就别写盘（省事也省宿主一次 mutation） */
        if (beforeId === (idsNow[index + 1] ?? null)) return

        setGroups((prev) => (Array.isArray(prev) ? reordered(prev, kind, workspaceId, movedId, beforeId) : prev))
        setBusy(movedId)
        setNotice(null)
        const path = kind === 'workspace' ? ORDER_MOVE_WS : ORDER_MOVE_SES
        const body = kind === 'workspace'
          ? { workspaceId: movedId, beforeWorkspaceId: beforeId }
          : { workspaceId, sessionId: movedId, beforeSessionId: beforeId }
        try {
          const res = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const out = await res.json().catch(() => ({}))
          if (!res.ok || out?.ok !== true) throw new Error(String(out?.error ?? ('HTTP ' + res.status)))
          /* 官方侧栏的会话顺序读的是浏览器 view store，不是 workspace.json；
             这里顺手也写一份，界面才会立刻跟着动（session-kit 的顺序桥会侦测到
             这次 setItem，3s 后自动上云）。 */
          const ids = Array.isArray(out.value?.sessionIds) ? out.value.sessionIds : null
          if (kind === 'session' && ids && typeof mirrorOrder === 'function') mirrorOrder(workspaceId, ids)
          setNotice({ ok: true, text: ZH.orderSaved })
        } catch (e) {
          setNotice({ ok: false, text: ZH.orderFailed + '：' + String(e?.message ?? e) })
        } finally {
          setBusy('')
          await load()
        }
      }, [groups, load, mirrorOrder])

      const endDrag = useCallback(() => {
        pendingRef.current = null
        setDrag(null)
        setOver(null)
        try { document.body.style.userSelect = '' } catch { /* ignore */ }
      }, [])

      const onPointerDown = useCallback((event, info) => {
        if (busy !== '' || event.button > 0) return
        const fromHandle = !!(event.target?.closest?.('.ac-order-handle'))
        const state = {
          kind: info.kind,
          workspaceId: info.workspaceId,
          id: info.id,
          ids: info.ids,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          timer: null,
        }
        pendingRef.current = state
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 拿不到捕获也能靠元素上的事件 */ }
        if (fromHandle) {
          event.preventDefault()
          event.stopPropagation()
          state.active = true
          setDrag({ kind: state.kind, workspaceId: state.workspaceId, id: state.id })
          try { document.body.style.userSelect = 'none' } catch { /* ignore */ }
          return
        }
        /* 长按整行 320ms 也能起拖（手指别先动，动了就让位给滚动） */
        state.timer = setTimeout(() => {
          if (pendingRef.current !== state) return
          state.active = true
          setDrag({ kind: state.kind, workspaceId: state.workspaceId, id: state.id })
          try { document.body.style.userSelect = 'none' } catch { /* ignore */ }
        }, 320)
      }, [busy])

      const onPointerMove = useCallback((event) => {
        const state = pendingRef.current
        if (!state) return
        if (!state.active) {
          if (Math.abs(event.clientY - state.startY) > 10 || Math.abs(event.clientX - state.startX) > 10) {
            if (state.timer) clearTimeout(state.timer)
            endDrag()
          }
          return
        }
        event.preventDefault()
        const rows = rowsFor(state.kind, state.workspaceId)
        const hit = targetAt(rows, event.clientY, state.id)
        setOver(hit ? { kind: state.kind, workspaceId: state.workspaceId, id: hit.id, after: hit.after } : null)
      }, [endDrag])

      const onPointerUp = useCallback((event) => {
        const state = pendingRef.current
        if (state?.timer) clearTimeout(state.timer)
        if (!state?.active) { endDrag(); return }
        const rows = rowsFor(state.kind, state.workspaceId)
        const hit = targetAt(rows, event.clientY, state.id)
        const beforeId = beforeIdFor(state.ids, state.id, hit)
        const { kind, workspaceId, id: movedId } = state
        endDrag()
        if (!hit) return
        void commit(kind, workspaceId, movedId, beforeId)
      }, [commit, endDrag])

      /** ↑↓：等效于拖到上/下一个位置。 */
      const nudge = (kind, workspaceId, movedId, dir) => {
        const ids = kind === 'workspace'
          ? (groups ?? []).map((g) => g.id)
          : ((groups ?? []).find((g) => g.id === workspaceId)?.sessionIds ?? [])
        const index = ids.indexOf(movedId)
        const at = index + dir
        if (index < 0 || at < 0 || at >= ids.length) return
        const without = ids.filter((id) => id !== movedId)
        const beforeId = dir < 0 ? without[at - 1] ?? null : without[at + 1] ?? null
        void commit(kind, workspaceId, movedId, beforeId)
      }

      const rowProps = (kind, workspaceId, id, ids, extraClass) => {
        const dragging = drag?.kind === kind && drag?.id === id
        const classes = [extraClass]
        if (dragging) classes.push('ac-order-dragging')
        if (over?.kind === kind && over?.id === id && !dragging) {
          classes.push(over.after ? 'ac-order-over-after' : 'ac-order-over-before')
        }
        return {
          className: classes.filter(Boolean).join(' '),
          'data-ac-kind': kind,
          'data-ac-id': id,
          'data-ac-ws': kind === 'session' ? workspaceId : undefined,
          onPointerDown: (event) => onPointerDown(event, { kind, workspaceId, id, ids }),
          onPointerMove,
          onPointerUp,
          onPointerCancel: endDrag,
        }
      }

      const handle = h('span', { className: 'ac-order-handle', title: ZH.handle, 'aria-hidden': 'true' }, '\u28FF')
      const tabs = h('div', { className: 'ac-order-tabs' },
        ['session', 'workspace'].map((id) => h('button', {
          key: id,
          type: 'button',
          className: 'ac-order-tab' + (tab === id ? ' ac-on' : ''),
          onClick: () => setTab(id),
        }, id === 'session' ? ZH.orderTabSession : ZH.orderTabWorkspace)))

      const list = groups ?? []
      return h('div', { className: 'ac-order' },
        h('div', { className: 'ac-order-bar' },
          tabs,
          h('button', { type: 'button', className: 'ac-btn', onClick: () => setAll(true), disabled: list.length === 0 }, ZH.orderExpandAll),
          h('button', { type: 'button', className: 'ac-btn', onClick: () => setAll(false), disabled: list.length === 0 }, ZH.orderCollapseAll),
          h('button', { type: 'button', className: 'ac-btn', onClick: () => void load() }, ZH.orderRefresh)),
        h('p', { className: 'ac-order-intro' }, ZH.orderIntro),
        h('div', { className: 'ac-order-legend' }, tab === 'session' ? ZH.orderHintSession : ZH.orderHintWorkspace),
        notice ? h('div', { className: 'ac-notice ' + (notice.ok ? 'ac-notice-ok' : 'ac-notice-err') }, notice.text) : null,
        error ? h('div', { className: 'ac-notice ac-notice-err' }, ZH.orderReadFailed + '：' + error) : null,
        groups === null && !error ? h('div', { className: 'ac-empty' }, ZH.orderLoading) : null,
        groups !== null && list.length === 0 && !error ? h('div', { className: 'ac-empty' }, ZH.orderEmpty) : null,
        list.map((group, gi) => {
          const wsIds = list.map((g) => g.id)
          const openGroup = isExpanded(group.id)
          return h('div', { key: group.id, className: 'ac-order-group' },
            h('div', rowProps('workspace', group.id, group.id, wsIds, 'ac-order-ws'),
              handle,
              h('button', {
                type: 'button',
                className: 'ac-order-caret',
                title: openGroup ? ZH.orderCollapseAll : ZH.orderExpandAll,
                onClick: () => setOne(group.id, !openGroup),
              }, openGroup ? '\u25BE' : '\u25B8'),
              h('div', { style: { minWidth: 0, flex: 1 } },
                h('div', { className: 'ac-order-ws-title' }, group.title || group.id.slice(0, 12)),
                h('div', { className: 'ac-order-sid', title: group.path }, group.path)),
              h('span', { className: 'ac-order-count' }, group.sessions.length + ' 条'),
              h('button', {
                type: 'button', className: 'ac-order-mini', title: ZH.toTop,
                disabled: busy !== '' || gi === 0,
                onClick: () => nudge('workspace', group.id, group.id, -1),
              }, '\u2191'),
              h('button', {
                type: 'button', className: 'ac-order-mini', title: ZH.toBottom,
                disabled: busy !== '' || gi === list.length - 1,
                onClick: () => nudge('workspace', group.id, group.id, 1),
              }, '\u2193')),
            openGroup ? group.sessions.map((session, si) => h('div', {
              key: session.id,
              ...rowProps('session', group.id, session.id, group.sessionIds, 'ac-order-session'),
            },
              handle,
              h('div', { style: { minWidth: 0, flex: 1 } },
                h('div', { className: 'ac-order-session-name' }, titleOf(session)),
                h('div', { className: 'ac-order-sid', title: session.id }, session.id)),
              h('button', {
                type: 'button', className: 'ac-order-mini', title: ZH.toTop,
                disabled: busy !== '' || si === 0,
                onClick: () => nudge('session', group.id, session.id, -1),
              }, '\u2191'),
              h('button', {
                type: 'button', className: 'ac-order-mini', title: ZH.toBottom,
                disabled: busy !== '' || si === group.sessions.length - 1,
                onClick: () => nudge('session', group.id, session.id, 1),
              }, '\u2193'))) : null)
        }))
    }

    function apply(ctx) {
      /* 2026-10-10 用户定案：顶级「会话搬家」分区退役——唯一入口改为
         设置 → 会话与提示词 → 会话搬家（批量）（session-kit 的批量面板）。
         move-session 宿主路由照常服务批量面板。 */

      /* 2026-10-11 新增：设置页「侧栏排序」。插槽点已查证 = settings.section
         （list slot；registerOptions: id/order/label；ownerProps: close；官方示例见
         dsh-cordis-client-runner 的 slot 契约表）。order 36 紧挨 session-kit 的
         「会话与提示词」（35）。 */
      try {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: `${NS}-order`,
          order: 36,
          label: ZH.orderNav,
          inject: () => ({
            /* 会话顺序顺手写一份到官方 view store：侧栏才会立刻跟着重排。
               键 accountKey = workspaceId（ui-workspace 里 owningGroupKey 的返回值）。 */
            mirrorOrder: (workspaceId, ids) => {
              try {
                const actions = ctx.get('uiWorkspace')?.view
                if (!actions || typeof actions.setSessionOrder !== 'function') return false
                let initial = {}
                try {
                  const raw = localStorage.getItem(VIEW_KEY)
                  const parsed = raw ? JSON.parse(raw) : null
                  if (parsed && parsed.orderBy === 'manual' && parsed.sessionOrderByAccount) {
                    initial = parsed.sessionOrderByAccount
                  }
                } catch { /* 读不到就传空：官方会把本区设成手动序 */ }
                actions.setSessionOrder(workspaceId, ids, initial)
                return true
              } catch {
                return false
              }
            },
          }),
        }, OrderSection)), `${NS}: sidebar order section`)
      } catch {
        /* 注册失败不影响插件其余部分 */
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = NS
    /* 测试缝：把纯函数与组件露出来给 _ordertest.mjs 做单测/SSR 冒烟。
       浏览器侧只是多挂一个属性，不参与任何运行路径。 */
    exports.__orderInternals = { beforeIdFor, targetAt, reordered, rowsFor, OrderSection }
    return module.exports
  },
})
