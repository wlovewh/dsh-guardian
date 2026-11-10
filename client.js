/**
 * dsh-guardian — Client half (vertical slice).
 *
 * Registers the sidebar entry + its main panel. Host calls go through the generic
 * Connection RPC channel (`dsh-guardian.*` endpoints under `/api`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-guardian',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'dsh-guardian'
    const NS = 'guardian'
    const CHANNEL = '/guardian'

    const DICT = {
      zh: { panel: '会话历史', status: '连接状态', ping: '测试 Host 连接', ok: '已连接', fail: '连接失败', loading: '加载中…' },
      en: { panel: 'Session history', status: 'Connection', ping: 'Test Host connection', ok: 'Connected', fail: 'Failed', loading: 'Loading…' },
    }

    /** Call one Host endpoint through the Connection RPC channel, with a fetch fallback. */
    async function callHost(ctx, method, args, signal) {
      const connection = ctx.get('connection')
      if (connection !== undefined && connection.rpc !== undefined && typeof connection.rpc.call === 'function') {
        const result = await connection.rpc.call(CHANNEL, method, args ?? null, signal)
        if (result !== undefined && result.ok === true) return result.value
        const error = new Error(result?.error?.message ?? `Host call ${method} failed`)
        error.code = result?.error?.code
        throw error
      }
      const rpcId = globalThis.crypto?.randomUUID?.() ?? `rpc-${Date.now()}`
      const response = await fetch(`${CHANNEL.slice(1)}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: args ?? null }),
        signal,
      })
      if (!response.ok) throw new Error(`Host call ${method} failed: HTTP ${response.status}`)
      const full = await response.json()
      if (full?.result?.ok === true) return full.result.value
      const error = new Error(full?.result?.error?.message ?? `Host call ${method} failed`)
      error.code = full?.result?.error?.code
      throw error
    }

    /** The sidebar glyph, drawn with the glyph from icon.svg in the theme's text color. */
    function GuardianIcon({ size }) {
      return h(
        'svg',
        {
          viewBox: '0 0 1024 1024',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M209.1 956.3c-65.5 0-118.9-53.3-118.9-118.8V185c0-65.5 53.3-118.8 118.9-118.8h482.7l240.6 240.5v530.7c0 65.5-53.3 118.8-118.9 118.8H209.1z m0-833.7c-34.4 0-62.4 28-62.4 62.4v652.4c0 34.4 28 62.4 62.4 62.4h604.4c34.4 0 62.4-28 62.4-62.4V394.5H722.8c-35.8 0-64.1-6.7-84.4-20-22.9-15-34.5-38.1-34.5-68.7 0-1.1-1.4-109.7-0.9-181.3v-2H209.1z m451.3 153.1c0 34.4 28 62.4 62.4 62.4h155.9L660.4 119.8v155.9z',
        }),
        h('path', {
          d: 'M330 563.5c-15.5 0-28.2-12.7-28.2-28.2s12.6-28.2 28.2-28.2h362.6c15.5 0 28.2 12.6 28.2 28.2s-12.6 28.2-28.2 28.2H330z',
        }),
        h('path', {
          d: 'M330 714.6c-15.5 0-28.2-12.7-28.2-28.2s12.6-28.2 28.2-28.2h362.6c15.5 0 28.2 12.6 28.2 28.2s-12.6 28.2-28.2 28.2H330z',
        }),
      )
    }

    function GuardianPage(props) {
      const { ctx, t } = props
      const [state, setState] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        const controller = new AbortController()
        callHost(ctx, 'ping', { from: 'panel' }, controller.signal)
          .then((value) => setState({ status: 'ok', value }))
          .catch((error) => setState({ status: 'fail', message: String(error?.message ?? error) }))
        return () => controller.abort()
      }, [])
      const ok = state.status === 'ok'
      return h(
        'div',
        { style: { padding: '24px', color: 'var(--dsw-alias-label-primary)', font: '14px/1.6 system-ui, sans-serif' } },
        h('h2', { style: { margin: '0 0 12px', fontSize: '18px' } }, 'dsh-guardian'),
        h('div', null, `${t('status')}: ${state.status === 'loading' ? t('loading') : ok ? t('ok') : t('fail')}`),
        ok ? h('pre', { style: { fontSize: '12px', opacity: 0.7 } }, JSON.stringify(state.value, null, 2)) : null,
        state.message ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, state.message) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-guardian: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ ctx, t }) }, GuardianPage),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: () => t('panel'), locale: NS },
            GuardianIcon,
          ),
        )

        // TEMP end-to-end probe: verify the browser half can reach the Host channel.
        setTimeout(() => {
          callHost(ctx, 'ping', { from: 'client-activation', at: Date.now() })
            .then((value) => callHost(ctx, 'diag', { ok: true, value }))
            .catch((error) => callHost(ctx, 'diag', { ok: false, message: String(error?.message ?? error) }))
        }, 1500)
      },
    }
  },
})
