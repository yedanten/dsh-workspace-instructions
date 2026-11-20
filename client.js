/**
 * Client half of `dsh-workspace-instructions`.
 *
 * Adds the workspace instruction-file picker beside the New Session preset
 * control and a read-only file label beside the Session title. The Host owns
 * the selection and the native file dialog; this module only mirrors that state
 * and drives the two calls.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-instructions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/workspace-instructions'
    const DEFAULT_FILE = 'AGENTS.md'

    /** Minimal external-store container compatible with useSyncExternalStore. */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          const value = typeof next === 'function' ? next(snapshot) : next
          if (value === snapshot) return
          snapshot = value
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function messageOf(error) {
      if (error instanceof Error) return error.message
      return typeof error === 'string' ? error : 'Unexpected error'
    }

    async function request(path, init) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        ...init,
      })
      let data
      try {
        data = await response.json()
      } catch {
        data = undefined
      }
      if (!response.ok || data === undefined || data.ok === false) {
        throw new Error(data?.error ?? `HTTP ${response.status}`)
      }
      return data
    }

    function baseName(value) {
      if (typeof value !== 'string' || value === '') return ''
      const parts = value.split(/[\\/]/)
      return parts[parts.length - 1] ?? value
    }

    function sessionState(snapshot, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return snapshot.sessions[sessionId]
    }

    function defaultState() {
      return {
        status: 'idle',
        file: DEFAULT_FILE,
        exists: undefined,
        error: undefined,
      }
    }

    function applyResult(update, sessionId, data) {
      update(sessionId, {
        status: 'ready',
        file: typeof data.file === 'string' && data.file !== '' ? data.file : DEFAULT_FILE,
        directory: data.directory,
        exists: data.exists !== false,
        error: undefined,
      })
    }

    const store = createStore({ sessions: {} })
    const inFlight = new Map()

    function update(sessionId, patch) {
      store.set((previous) => {
        const current = previous.sessions[sessionId] ?? { status: 'idle' }
        return {
          ...previous,
          sessions: { ...previous.sessions, [sessionId]: { ...current, ...patch } },
        }
      })
    }

    async function load(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (inFlight.get(sessionId) === 'load') return
      inFlight.set(sessionId, 'load')
      try {
        const data = await request(`${ROUTE}/state?sessionId=${encodeURIComponent(sessionId)}`)
        applyResult(update, sessionId, data)
      } catch (error) {
        update(sessionId, { status: 'error', error: messageOf(error) })
      } finally {
        inFlight.delete(sessionId)
      }
    }

    async function choose(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (inFlight.get(sessionId) === 'pick') return
      inFlight.set(sessionId, 'pick')
      update(sessionId, { status: 'picking', error: undefined })
      try {
        const data = await request(`${ROUTE}/pick`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        applyResult(update, sessionId, data)
      } catch (error) {
        update(sessionId, { status: 'ready', error: messageOf(error) })
      } finally {
        inFlight.delete(sessionId)
      }
    }

    async function selectFile(sessionId, file) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      update(sessionId, { status: 'picking', error: undefined })
      try {
        const data = await request(`${ROUTE}/select`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, file }),
        })
        applyResult(update, sessionId, data)
      } catch (error) {
        update(sessionId, { status: 'ready', error: messageOf(error) })
      }
    }

    function resetFile(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      update(sessionId, { status: 'picking', error: undefined })
      request(`${ROUTE}/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
        .then((data) => applyResult(update, sessionId, data))
        .catch((error) => update(sessionId, { status: 'ready', error: messageOf(error) }))
    }

    const ICON_DOC = h(
      'svg',
      { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
      h('path', {
        d: 'M4 1.75h5.2L13 5.55V14a.75.75 0 0 1-.75.75h-8A.75.75 0 0 1 3.5 14V2.5A.75.75 0 0 1 4.25 1.75Z',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.1,
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M9 1.9V5.4h3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.1,
        strokeLinejoin: 'round',
      }),
    )

    const ICON_CHEVRON = h(
      'svg',
      { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
      h('path', {
        d: 'M4 6.2 8 10l4-3.8',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    )

    const ICON_CHECK = h(
      'svg',
      { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true },
      h('path', {
        d: 'M3.4 8.4 6.4 11.4 12.6 4.9',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }),
    )

    function useDismiss(open, setOpen) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (ref.current !== null && ref.current.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, setOpen])
      return ref
    }

    /**
     * New Session control: the file the workspace root will load.
     * @param props slot props plus the injected store and actions
     * @returns the chip and its popover, or null without a Session
     */
    function LoadFilePicker({ sessionId, useWorkspaceInstructionFile, load: loadState }) {
      const [open, setOpen] = React.useState(false)
      const ref = useDismiss(open, setOpen)
      const state = useWorkspaceInstructionFile((snapshot) => sessionState(snapshot, sessionId))

      React.useEffect(() => {
        if (typeof sessionId === 'string' && sessionId !== '') loadState(sessionId)
      }, [sessionId, loadState])

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const current = state ?? defaultState()
      const file = typeof current.file === 'string' && current.file !== '' ? current.file : DEFAULT_FILE
      const busy = current.status === 'picking'
      const label = busy ? '正在选择…' : file
      const missing = current.exists === false
      const options = []
      options.push({ value: DEFAULT_FILE, title: '默认加载工作区根目录的 AGENTS.md' })
      if (file !== DEFAULT_FILE) options.push({ value: file, title: '当前已选择' })

      const pickItem = h(
        'button',
        {
          type: 'button',
          className: 'dsh-wsi-item',
          onClick: () => {
            setOpen(false)
            choose(sessionId)
          },
          disabled: busy,
        },
        h('span', { className: 'dsh-wsi-item-icon' }, ICON_DOC),
        h('span', { className: 'dsh-wsi-item-copy' }, '选择其他 Markdown 文件…'),
      )

      return h(
        'div',
        { className: 'dsh-wsi-root', ref },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-wsi-btn',
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            title: `工作区指令文件：${file}${missing ? '（当前不存在）' : ''}`,
            onClick: () => setOpen((value) => !value),
            disabled: busy,
          },
          h('span', { className: 'dsh-wsi-icon' }, ICON_DOC),
          h('span', { className: 'dsh-wsi-btn-label', 'data-missing': missing ? 'true' : 'false' }, label),
          h('span', { className: 'dsh-wsi-chevron' }, ICON_CHEVRON),
        ),
        open
          ? h(
              'div',
              { className: 'dsh-wsi-menu', role: 'listbox', 'aria-label': '工作区指令文件' },
              h(
                'div',
                { className: 'dsh-wsi-menu-caption' },
                '新建会话使用的指令文件',
              ),
              options.map((option) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: option.value,
                    className: 'dsh-wsi-item',
                    role: 'option',
                    'aria-selected': file === option.value,
                    onClick: () => {
                      setOpen(false)
                      if (file !== option.value) selectFile(sessionId, option.value)
                    },
                  },
                  h('span', { className: 'dsh-wsi-item-check' }, file === option.value ? ICON_CHECK : null),
                  h('span', { className: 'dsh-wsi-item-copy' }, option.value),
                ),
              ),
              h('div', { className: 'dsh-wsi-sep' }),
              pickItem,
              current.error
                ? h('div', { className: 'dsh-wsi-error' }, current.error)
                : null,
            )
          : null,
      )
    }

    /**
     * Session header label: the file currently feeding the workspace chain.
     * @param props slot props plus the injected store
     * @returns the label, or null when nothing is selected
     */
    function LoadFileLabel({ sessionId, useWorkspaceInstructionFile, load: loadState }) {
      const state = useWorkspaceInstructionFile((snapshot) => sessionState(snapshot, sessionId))
      React.useEffect(() => {
        if (typeof sessionId === 'string' && sessionId !== '') loadState(sessionId)
      }, [sessionId, loadState])

      const current = state ?? defaultState()
      if (current.status === 'idle') return null
      const file = typeof current.file === 'string' && current.file !== '' ? current.file : DEFAULT_FILE
      const missing = current.exists === false
      const name = baseName(file)
      return h(
        'span',
        {
          className: 'dsh-wsi-label',
          title: missing
            ? `工作区指令文件：${file}（当前不存在，将跳过加载）`
            : `工作区指令文件：${file}`,
        },
        h('span', { className: 'dsh-wsi-icon' }, ICON_DOC),
        h('span', { className: 'dsh-wsi-label-name', 'data-missing': missing ? 'true' : 'false' }, name),
      )
    }

    const CSS = `
.dsh-wsi-root{position:relative;display:inline-flex;align-items:center;min-width:0}
.dsh-wsi-btn{display:inline-flex;align-items:center;gap:6px;height:30px;max-width:240px;padding:0 9px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.dsh-wsi-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.dsh-wsi-btn:disabled{opacity:.6;cursor:default}
.dsh-wsi-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);flex:none}
.dsh-wsi-btn-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.dsh-wsi-btn-label[data-missing="true"]{color:var(--dsw-alias-state-warn-primary)}
.dsh-wsi-chevron{display:inline-flex;color:var(--dsw-alias-label-secondary);flex:none}
.dsh-wsi-menu{position:absolute;left:0;bottom:calc(100% + 8px);z-index:70;min-width:250px;max-width:340px;padding:6px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px rgba(0,0,0,.24);display:flex;flex-direction:column;gap:2px}
.dsh-wsi-menu-caption{padding:6px 10px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-wsi-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.dsh-wsi-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-wsi-item:disabled{opacity:.55;cursor:default}
.dsh-wsi-item-check{display:inline-flex;width:14px;justify-content:center;color:var(--dsw-alias-brand-primary);flex:none}
.dsh-wsi-item-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);flex:none}
.dsh-wsi-item-copy{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wsi-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}
.dsh-wsi-error{padding:6px 10px;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.dsh-wsi-label{display:inline-flex;align-items:center;gap:5px;max-width:220px;padding:0 6px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-wsi-label-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wsi-label-name[data-missing="true"]{color:var(--dsw-alias-state-warn-primary)}
`

    return {
      inject: ['slots'],
      apply(ctx) {
        if (typeof document !== 'undefined') {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-workspace-instructions'
          tag.textContent = CSS
          document.head.appendChild(tag)
          ctx.effect(() => () => tag.remove(), 'workspace-instructions: stylesheet')
        }

        const injected = () => ({
          hooks: { workspaceInstructionFile: store },
          load,
          choose,
          selectFile,
        })

        ctx.slots.inject('conversation.hero.options', () =>
          ctx.slots.register(
            {
              name: 'conversation.hero.options',
              id: 'workspace-instruction-file',
              order: 10,
              inject: injected,
            },
            LoadFilePicker,
          ),
        )

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'workspace-instruction-file-label',
              order: -9,
              inject: injected,
            },
            LoadFileLabel,
          ),
        )
      },
    }
  },
})
