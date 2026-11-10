/**
 * dsh-guardian — Host half.
 *
 * Responsibilities:
 * - mount one authenticated HTTP prefix route (`/guardian/<endpoint>`) that the
 *   browser panel drives through the Connection RPC envelope,
 * - own the data operations behind the four modules (sessions/export, recycle
 *   bin, configuration snapshots, backups + rescue script),
 * - register the agent-facing safety net (`safe_delete`, `guardian_trash`, the
 *   shell-deletion guard),
 * - run the durable backup schedule and the trash retention sweep.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackupManager } from './lib/backup.js'
import { GuardianService } from './lib/service.js'
import { SnapshotManager } from './lib/snapshot.js'
import {
  BackupStore,
  DEFAULT_SETTINGS,
  SettingsStore,
  TrashStore,
  ensureGuardianDirs,
  guardianPaths,
  resolveBackupRoot,
  sanitiseSettings,
} from './lib/store.js'
import { GuardianTools } from './lib/tools.js'
import { humanSize, pathExists, resolveProfileDir } from './lib/util.js'

/** Web prefix route carrying the panel's RPC calls. */
export const CHANNEL = '/guardian'

/** Largest request body accepted for one panel call. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

export const name = 'dsh-guardian'

export const inject = ['connection', 'webServer']

/** Mount the panel route, the data service, the tools and the scheduler. */
export async function apply(ctx) {
  const paths = guardianPaths()
  paths.profile = await resolveProfileDir(path.dirname(fileURLToPath(import.meta.url))).catch(() => undefined)
  const settingsStore = new SettingsStore(paths)
  const trashStore = new TrashStore(paths)
  const backupStore = new BackupStore(paths, settingsStore)
  const stores = {
    settings: settingsStore,
    trash: trashStore,
    backups: backupStore,
    audit: settingsStore.audit,
  }
  const service = new GuardianService(ctx, paths, stores)
  const snapshots = new SnapshotManager(ctx, paths, stores)
  const backups = new BackupManager(ctx, paths, stores, snapshots)
  stores.snapshots = snapshots

  const ready = ensureGuardianDirs(paths).catch(() => {})

  /* --------------------------------------------------------------- helpers */

  /** One status snapshot for the panel header. */
  async function status() {
    const settings = await settingsStore.load()
    const persist = ctx.get('sessionPersistence')
    const sessions = persist === undefined ? [] : await persist.list().catch(() => [])
    const trash = await trashStore.load().catch(() => [])
    const snaps = await snapshots.list().catch(() => ({ items: [] }))
    const backs = await backups.list().catch(() => ({ items: [] }))
    const state = await settingsStore.state().catch(() => ({}))
    return {
      version: '0.1.0',
      dshHome: paths.home,
      guardianRoot: paths.root,
      backupRoot: resolveBackupRoot(settings),
      sessions: sessions.length,
      trash: trash.length,
      snapshots: snaps.items.length,
      backups: backs.items.length,
      nextBackupAt: await backups.nextRunAt(),
      lastBackupAt: state.lastBackupAt ?? null,
      settings,
    }
  }

  /** Endpoint table: every browser call lands in exactly one of these. */
  const endpoints = new Map([
    ['ping', async (payload) => ({ pong: true, at: Date.now(), echo: payload ?? null })],
    ['status', () => status()],

    ['sessions.list', () => service.listSessions()],
    ['sessions.search', (payload) => service.searchSessions(payload ?? {})],
    ['sessions.rename', (payload) => service.renameSession(payload ?? {})],
    ['sessions.archive', (payload) => service.archiveSession(payload ?? {})],
    ['sessions.trash', (payload) => service.trashSessions(payload ?? {})],
    ['sessions.attachments', (payload) => service.sessionAttachments(payload ?? {})],

    ['export.run', (payload) => service.exportRun(payload ?? {})],
    ['import.inspect', (payload) => service.importInspect(payload ?? {})],
    ['import.run', (payload) => service.importRun(payload ?? {})],
    ['fs.list', (payload) => service.listDir(payload ?? {})],

    ['trash.list', () => service.trashList()],
    ['trash.restore', (payload) => service.trashRestore(payload ?? {})],
    ['trash.previewPurge', (payload) => service.trashPreviewPurge(payload ?? {})],
    ['trash.purge', (payload) => service.trashPurge(payload ?? {})],
    ['trash.sweep', () => service.trashSweep()],

    ['snapshot.create', (payload) => snapshots.create(payload ?? {})],
    ['snapshot.list', () => snapshots.list()],
    ['snapshot.diff', (payload) => snapshots.diff(payload ?? {})],
    ['snapshot.restore', (payload) => snapshots.restore(payload ?? {})],
    ['snapshot.delete', (payload) => snapshots.delete(payload ?? {})],

    ['backup.run', (payload) => backups.run(payload ?? {})],
    ['backup.list', () => backups.list()],
    ['backup.verify', (payload) => backups.verify(payload ?? {})],
    ['backup.restore', (payload) => backups.restore(payload ?? {})],
    ['backup.reveal', (payload) => backups.reveal(payload ?? {})],

    [
      'settings.get',
      async () => {
        const settings = await settingsStore.load()
        return {
          settings,
          defaults: DEFAULT_SETTINGS,
          resolvedBackupRoot: resolveBackupRoot(settings),
          envEscapeHatch: process.env.DSH_GUARDIAN_FORCE_DELETE === '1',
        }
      },
    ],
    [
      'settings.update',
      async (payload) => {
        const settings = await settingsStore.update(payload?.patch ?? {})
        await backups.reschedule()
        await stores.audit.append('settings.update', sanitiseSettings(payload?.patch ?? {}))
        return { settings }
      },
    ],
    ['audit.list', (payload) => stores.audit.list(payload?.limit ?? 50).then((items) => ({ items }))],
  ])

  /* ---------------------------------------------------------------- route */

  /** Read and parse one JSON request body, bounded by MAX_BODY_BYTES. */
  async function readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text.length === 0 ? undefined : JSON.parse(text)
  }

  /** Answer one RPC call with the Connection server-response envelope. */
  async function serve(req, res) {
    const connection = ctx.connection
    const admission = connection.admit(req)
    if ('rejection' in admission) {
      res.writeHead(admission.rejection, { 'content-type': 'text/plain' })
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }

    let body
    try {
      body = await readJson(req)
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end(`invalid body: ${String(error && error.message ? error.message : error)}`)
      return
    }

    const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
    /** @type {{ok: true, value: unknown} | {ok: false, error: {code: string, message: string, details: object}}} */
    let result
    try {
      const pathname = new URL(req.url ?? CHANNEL, 'http://localhost').pathname
      const endpoint = pathname.startsWith(`${CHANNEL}/`) ? pathname.slice(CHANNEL.length + 1) : ''
      if (body?.type !== 'client-request' || typeof body?.method !== 'string') {
        result = { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request envelope', details: {} } }
      } else if (body.method !== endpoint) {
        result = {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: {},
          },
        }
      } else {
        const handler = endpoints.get(endpoint)
        if (handler === undefined) {
          result = { ok: false, error: { code: 'guardian/unknown-method', message: `Unknown method ${endpoint}`, details: {} } }
        } else {
          await ready
          result = { ok: true, value: await handler(body.payload, { peer: admission.peer }) }
        }
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      ctx.logger?.warn?.(`dsh-guardian: ${message}`)
      result = { ok: false, error: { code: 'guardian/handler-failed', message, details: {} } }
    }

    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: CHANNEL, handler: serve }), 'dsh-guardian: panel route')

  /* ---------------------------------------------------------------- tools */

  try {
    const tools = new GuardianTools(ctx, Object.assign(service, { paths }), stores)
    ctx.effect(() => tools.register(), 'dsh-guardian: safety tools')
  } catch (error) {
    ctx.logger?.warn?.(`dsh-guardian: tools unavailable: ${String(error && error.message ? error.message : error)}`)
  }

  /* ------------------------------------------------------------- schedule */

  ctx.effect(() => {
    let stopped = false
    let running = false

    const tick = async () => {
      if (stopped || running) return
      running = true
      try {
        await ready
        const settings = await settingsStore.load()
        const state = await settingsStore.state()
        const now = Date.now()

        // Retention sweep: once per boot and then at most daily.
        if (settings.trashRetentionDays > 0) {
          const lastSweep = state.lastSweepAt ?? 0
          if (now - lastSweep > 24 * 60 * 60 * 1000) {
            await service.trashSweep().catch(() => {})
          }
        }

        if (settings.backupIntervalHours > 0) {
          const interval = settings.backupIntervalHours * 60 * 60 * 1000
          const last = state.lastBackupAt ?? 0
          const due = (state.nextBackupAt ?? 0) > 0 ? now >= state.nextBackupAt : last === 0 ? false : now - last >= interval
          const seed = last === 0 && state.nextBackupAt === null && now - (state.startedAt ?? 0) > 0
          if (due) {
            await backups.run({ kind: 'scheduled' })
          } else if (state.nextBackupAt === null) {
            // First boot with scheduling enabled: plan the first run one interval out.
            const next = last === 0 ? now + 90 * 1000 : now + interval
            await settingsStore.setState({ nextBackupAt: next, startedAt: state.startedAt ?? now })
          }
          void seed
        }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-guardian: scheduled task failed: ${String(error && error.message ? error.message : error)}`)
      } finally {
        running = false
      }
    }

    const timer = setInterval(() => void tick(), 60 * 1000)
    const kickoff = setTimeout(() => void tick(), 15 * 1000)
    return () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(kickoff)
    }
  }, 'dsh-guardian: schedule')

  /* ----------------------------------------------------------- dev probe */

  // Dev-only: the maintainer's RPC harness needs one authenticated URL. Enabled
  // only while the marker file exists inside the development checkout.
  try {
    const marker = path.join('D:/Project/dsh-guardian/.research/DEV_PROBE')
    if (fs.existsSync(marker)) {
      fs.writeFileSync(
        path.join('D:/Project/dsh-guardian/.research/url.txt'),
        ctx.connection.authenticatedUrl(`${ctx.webServer.getOrigin()}/`),
      )
    }
  } catch {
    /* ignore */
  }

  // Surface the resolved roots once at startup so the panel and logs agree.
  void ready.then(() => {
    ctx.logger?.info?.(
      `dsh-guardian ready: home=${paths.home} trash=${path.relative(paths.home, paths.trashRoot)} backups=${resolveBackupRoot(DEFAULT_SETTINGS)} (${humanSize(0)})`,
    )
  })
}

export { pathExists }
