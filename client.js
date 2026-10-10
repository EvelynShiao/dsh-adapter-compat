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
    const { createElement: h, useState, useEffect, useCallback } = React

    const NS = 'adapter-compat'
    const inject = ['slots']
    const LIST_ROUTE = '/dsh-adapter-compat/slim-list'
    const MOVE_ROUTE = '/dsh-adapter-compat/move-session'

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

    function apply(ctx) {
      /* 2026-10-10 用户定案：顶级「会话搬家」分区退役——唯一入口改为
         设置 → 会话与提示词 → 会话搬家（批量）（session-kit 的批量面板）。
         本客户端不再注册任何 UI；move-session 宿主路由照常服务批量面板。 */
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = NS
    return module.exports
  },
})
