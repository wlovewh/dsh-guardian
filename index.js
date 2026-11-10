/**
 * dsh-guardian — Host half.
 *
 * Registers one generic Connection RPC channel at `/guardian`. The Connection
 * service mounts that channel as an authenticated prefix route, so the browser
 * panel calls it through `ctx.connection.rpc.call('/guardian', '<endpoint>', …)`
 * with the same Host/Origin and cookie checks as the shipped UI.
 *
 * Feature modules are added incrementally; this file owns dispatch only.
 */

/** Web channel mounted for the panel's RPC calls. */
const CHANNEL = '/guardian'

export const name = 'dsh-guardian'

/**
 * `connection` mounts the panel's RPC channel and `webServer` carries it, so both
 * are required: in a headless profile the plugin stays inactive rather than
 * registering a channel nobody can reach.
 */
export const inject = ['connection', 'webServer']

/** Register the RPC channel. */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined || connection.rpc === undefined) {
    ctx.logger?.warn?.('dsh-guardian: no Connection service; the web panel API is unavailable')
    return
  }

  const handler = async (endpoint, payload, signal, peer) => {
    switch (endpoint) {
      case 'ping':
        return { ok: true, value: { pong: true, at: Date.now(), echo: payload ?? null, peer: peer?.principal?.kind ?? null } }
      default:
        return {
          ok: false,
          error: { code: 'guardian/unknown-method', message: `Unknown method ${endpoint}`, details: {} },
        }
    }
  }

  ctx.effect(() => connection.rpc.handle(CHANNEL, handler), 'dsh-guardian: rpc channel')
}
