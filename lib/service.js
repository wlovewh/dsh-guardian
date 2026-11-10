/**
 * Session overview, portable export/import and the recycle bin.
 *
 * Design notes that matter for safety:
 * - A session on disk is one directory (`sessions/<projectKey>/<sessionId>/`)
 *   holding every log generation, so a cycle-bin move is one same-volume
 *   `rename` of that directory (falling back to verified copy+delete off-volume).
 * - Subagent sessions are peer directories in the same project folder and are
 *   moved together with their root, keeping the conversation chain whole.
 * - Attachments are content-addressed and shared between sessions, so removal
 *   never touches `$DSH_HOME/attachments`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  assertDeletable,
  copyTreeVerified,
  dirSize,
  ensureDir,
  humanSize,
  isInside,
  movePath,
  pathExists,
  readJson,
  removePath,
  shortId,
  stampId,
  walkFiles,
  writeTarGz,
  readTarGz,
} from './util.js'

/** Sessions whose id starts with this prefix are minted by the Harness store. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/

/** Collect attachment ids referenced by a session's events. */
export function collectAttachmentIds(events) {
  const ids = new Map()
  const visit = (value) => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value.attachmentId === 'string') {
      ids.set(value.attachmentId, {
        attachmentId: value.attachmentId,
        bytes: typeof value.bytes === 'number' ? value.bytes : 0,
        name: typeof value.name === 'string' ? value.name : undefined,
        mediaType: typeof value.mediaType === 'string' ? value.mediaType : undefined,
      })
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(events)
  return [...ids.values()]
}

/** Count durable chat messages in one event log. */
export function countMessages(events) {
  let messages = 0
  for (const event of events) {
    if (event?.type === 'user/message' || event?.type === 'assistant/message') messages += 1
  }
  return messages
}

/** `sha256:<hex>` → attachment object path below `attachments/v1/objects`. */
export function attachmentObjectPath(attachmentsRoot, attachmentId) {
  const hex = String(attachmentId).replace(/^sha256:/, '')
  if (!/^[0-9a-f]{2,64}$/i.test(hex)) return undefined
  return path.join(attachmentsRoot, 'v1', 'objects', hex.slice(0, 2), hex)
}

export class GuardianService {
  /**
   * @param ctx Host plugin context.
   * @param paths Guardian path bundle.
   * @param stores `{ settings, trash, backups, audit }`.
   */
  constructor(ctx, paths, stores) {
    this.ctx = ctx
    this.paths = paths
    this.stores = stores
    this.statsCache = new Map()
    this.busy = new Set()
  }

  /* ------------------------------------------------------------ workspace */

  /** Read the durable workspace registry (read-only; mutations go through services). */
  async readWorkspaceState() {
    const stored = await readJson(this.paths.workspaceRegistry, undefined)
    const state = { workspaces: [], archived: new Set(), pinned: new Set() }
    if (stored === undefined) return state
    const tables = stored.tables?.workspaces ?? stored.tables ?? {}
    const order = Array.isArray(stored.global?.workspaceIds) ? stored.global.workspaceIds : []
    for (const id of order) {
      const entry = tables[id]
      if (entry === undefined) continue
      state.workspaces.push({
        id,
        path: entry.path,
        title: entry.title ?? entry.path,
        sessionIds: Array.isArray(entry.sessionIds) ? entry.sessionIds : [],
      })
    }
    for (const [id, entry] of Object.entries(tables)) {
      if (state.workspaces.some((workspace) => workspace.id === id)) continue
      state.workspaces.push({
        id,
        path: entry?.path ?? '',
        title: entry?.title ?? entry?.path ?? id,
        sessionIds: Array.isArray(entry?.sessionIds) ? entry.sessionIds : [],
      })
    }
    for (const id of stored.global?.archivedSessionIds ?? []) state.archived.add(id)
    for (const id of stored.global?.pinnedSessionIds ?? []) state.pinned.add(id)
    return state
  }

  /** One row per logical session, including subagent sessions. */
  async listSessions() {
    const persist = this.ctx.get('sessionPersistence')
    const query = this.ctx.get('sessionQuery')
    const snapshots = persist === undefined ? [] : await persist.list()
    const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]))
    const records = query === undefined ? [] : await query.listSessions()
    const workspaceState = await this.readWorkspaceState()
    const workspaceBySession = new Map()
    for (const workspace of workspaceState.workspaces) {
      for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace)
    }

    const ids = records.map((record) => record.header.id)
    const titles = new Map()
    if (query !== undefined && ids.length > 0) {
      const observations = await query.readTitleSnapshots(ids).catch(() => [])
      for (const observation of observations) {
        if (observation.status === 'fulfilled' && observation.value?.title !== undefined) {
          titles.set(observation.sessionId, observation.value.title.title)
        }
      }
    }

    const rows = []
    for (const record of records) {
      const header = record.header
      const snapshot = snapshotById.get(header.id)
      const stats = await this.sessionStats(header.id, snapshot?.revision)
      const workspace = workspaceBySession.get(header.id)
      rows.push({
        id: header.id,
        title: titles.get(header.id) ?? '未命名会话',
        cwd: header.cwd ?? null,
        workspaceId: workspace?.id ?? null,
        workspaceTitle: workspace?.title ?? null,
        createdAt: header.createdAt ?? 0,
        updatedAt: stats?.updatedAt ?? header.createdAt ?? 0,
        sizeBytes: snapshot?.sizeBytes ?? 0,
        messageCount: stats?.messages ?? 0,
        attachmentCount: stats?.attachments.length ?? 0,
        archived: workspaceState.archived.has(header.id),
        pinned: workspaceState.pinned.has(header.id),
        live: record.live === true,
        isSubagent: header.origin === 'subagent' || header.parentSession !== undefined,
        parentSessionId: header.parentSession ?? null,
        childCount: 0,
        inTrash: false,
      })
    }
    const byParent = new Map()
    for (const row of rows) {
      if (row.parentSessionId === null) continue
      byParent.set(row.parentSessionId, (byParent.get(row.parentSessionId) ?? 0) + 1)
    }
    for (const row of rows) row.childCount = byParent.get(row.id) ?? 0
    rows.sort((left, right) => right.updatedAt - left.updatedAt)

    const workspaces = workspaceState.workspaces.map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionIds: workspace.sessionIds,
    }))
    return {
      workspaces,
      sessions: rows,
      totals: {
        sessions: rows.filter((row) => !row.isSubagent).length,
        subagents: rows.filter((row) => row.isSubagent).length,
        bytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
        archived: rows.filter((row) => row.archived).length,
      },
    }
  }

  /** Event-derived stats (messages, attachments, last activity) with a per-revision cache. */
  async sessionStats(sessionId, revision) {
    const key = `${sessionId}:${String(revision ?? 'live')}`
    const cached = this.statsCache.get(key)
    if (cached !== undefined) return cached
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    try {
      const snapshot = await query.readSession(sessionId)
      const events = snapshot.events ?? []
      const last = events.length > 0 ? events[events.length - 1].time : 0
      const stats = {
        messages: countMessages(events),
        attachments: collectAttachmentIds(events),
        updatedAt: last,
        eventCount: events.length,
      }
      this.statsCache.set(key, stats)
      return stats
    } catch {
      return undefined
    }
  }

  /** Cross-session literal search over session event text. */
  async searchSessions({ query, limit = 50 }) {
    const text = String(query ?? '').trim()
    if (text === '') return { items: [], truncated: false, scanned: 0 }
    const client = this.ctx.get('sessionQuery')
    if (client === undefined) throw new Error('sessionQuery 服务不可用')
    const sessions = await client.listSessions()
    const items = []
    let scanned = 0
    const deadline = Date.now() + 10000
    for (const record of sessions) {
      if (Date.now() > deadline || items.length >= limit) break
      scanned += 1
      try {
        const events = await client.filterEvents(record.header.id, [{ kind: 'text', text }])
        if (events.length === 0) continue
        const first = events[0]
        items.push({
          id: record.header.id,
          title: (await client.readTitle(record.header.id).catch(() => undefined))?.title ?? '未命名会话',
          snippet: String(first.text ?? '').slice(0, 240),
          time: first.time ?? record.header.createdAt ?? 0,
          matches: events.length,
        })
      } catch {
        /* a single unreadable session must not fail the whole search */
      }
    }
    return { items, truncated: items.length >= limit, scanned }
  }

  async renameSession({ sessionId, title }) {
    const nextTitle = String(title ?? '').trim()
    if (nextTitle === '') throw new Error('标题不能为空')
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new Error('sessionController 服务不可用')
    const result = await controller.rename({ sessionId, title: nextTitle })
    await this.stores.audit.append('session.rename', { sessionId, title: nextTitle })
    return { id: sessionId, title: result?.title ?? nextTitle }
  }

  async archiveSession({ sessionId, archived }) {
    const controller = this.ctx.get('workspaceController')
    if (controller === undefined) throw new Error('workspaceController 服务不可用')
    if (archived) await controller.archiveSession({ sessionId })
    else await controller.unarchiveSession({ sessionId })
    await this.stores.audit.append(archived ? 'session.archive' : 'session.unarchive', { sessionId })
    return { id: sessionId, archived: archived === true }
  }

  async sessionAttachments({ sessionId }) {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) throw new Error('sessionQuery 服务不可用')
    const snapshot = await query.readSession(sessionId)
    const attachments = collectAttachmentIds(snapshot.events ?? [])
    return {
      items: attachments.map((item) => ({
        ...item,
        exists: attachmentObjectPath(this.paths.attachmentsRoot, item.attachmentId) !== undefined,
      })),
    }
  }

  /* ---------------------------------------------------------------- trash */

  /** Resolve a session plus every descendant subagent session. */
  async sessionChain(sessionId) {
    const query = this.ctx.get('sessionQuery')
    const records = query === undefined ? [] : await query.listSessions()
    const byParent = new Map()
    for (const record of records) {
      const parent = record.header.parentSession
      if (parent === undefined) continue
      const list = byParent.get(parent) ?? []
      list.push(record.header.id)
      byParent.set(parent, list)
    }
    const chain = []
    const visit = (id) => {
      if (chain.includes(id)) return
      chain.push(id)
      for (const child of byParent.get(id) ?? []) visit(child)
    }
    visit(sessionId)
    return chain
  }

  /** Absolute session directory from persistence, or undefined for an unstored session. */
  async sessionLocation(sessionId) {
    const persist = this.ctx.get('sessionPersistence')
    if (persist === undefined) return undefined
    const snapshot = await persist.stat(sessionId)
    const location = snapshot?.location
    if (location === undefined || typeof location.path !== 'string') return undefined
    return { path: location.path, sizeBytes: snapshot?.sizeBytes ?? 0, revision: snapshot?.revision }
  }

  /** Refuse to move a session that a live Agent still owns. */
  assertNotLive(sessionIds) {
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    for (const id of sessionIds) {
      if (agents?.get?.(id) !== undefined) {
        throw new Error(`会话正在运行，无法移入回收站：${id}（请先在 DSH 中结束该会话）`)
      }
      if (sessions?.get?.(id) !== undefined) {
        throw new Error(`会话仍处于活动状态，无法移入回收站：${id}`)
      }
    }
  }

  async trashSessions({ sessionIds }) {
    const roots = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === 'string'))]
    if (roots.length === 0) throw new Error('没有选择会话')
    const entries = []
    for (const rootId of roots) {
      const chain = await this.sessionChain(rootId)
      this.assertNotLive(chain)
      const controller = this.ctx.get('workspaceController')
      for (const id of chain) {
        await controller?.archiveSession?.({ sessionId: id }).catch(() => {})
      }
      const persist = this.ctx.get('sessionPersistence')
      await persist?.flush?.().catch(() => {})

      const entryId = `${stampId()}-${shortId()}`
      const entryRoot = path.join(this.paths.trashSessions, entryId)
      const payloadRoot = path.join(entryRoot, 'payload')
      const cacheRoot = path.join(entryRoot, 'cache')
      await ensureDir(payloadRoot)
      await ensureDir(cacheRoot)

      const moved = []
      const cache = []
      let totalBytes = 0
      const workspaceState = await this.readWorkspaceState()
      const workspace = workspaceState.workspaces.find((candidate) => candidate.sessionIds.includes(rootId))
      const pending = {
        id: entryId,
        kind: 'session',
        rootSessionId: rootId,
        sessionIds: chain,
        moved: [],
        movedAt: Date.now(),
        source: 'panel',
      }
      await fs.writeFile(path.join(entryRoot, 'entry.pending.json'), JSON.stringify(pending, null, 2), 'utf8')

      try {
        for (const [index, id] of chain.entries()) {
          const location = await this.sessionLocation(id)
          if (location === undefined) continue
          const sessionDir = path.dirname(location.path)
          if (!isInside(this.paths.sessionsRoot, sessionDir)) {
            throw new Error(`会话目录不在 DSH 会话根目录内，已拒绝移动：${sessionDir}`)
          }
          const relative = path.relative(this.paths.sessionsRoot, sessionDir).split(path.sep).join('/')
          const target = path.join(payloadRoot, String(index))
          const result = await movePath(sessionDir, target)
          moved.push({ sessionId: id, originalRelative: relative, originalPath: sessionDir, strategy: result.strategy, bytes: location.sizeBytes })
          totalBytes += location.sizeBytes
          const cacheFile = path.join(this.paths.projectionCache, `${id}.json`)
          if (await pathExists(cacheFile)) {
            const cacheTarget = path.join(cacheRoot, `${id}.json`)
            await movePath(cacheFile, cacheTarget).catch(() => {})
            cache.push({ sessionId: id, file: `${id}.json` })
          }
        }
      } catch (error) {
        // Roll back everything already moved for this entry.
        for (const item of [...moved].reverse()) {
          const source = path.join(payloadRoot, String(moved.indexOf(item)))
          await movePath(source, item.originalPath).catch(() => {})
        }
        await removePath(entryRoot).catch(() => {})
        throw error
      }

      const entry = {
        id: entryId,
        kind: 'session',
        titles: [rootId],
        rootSessionId: rootId,
        sessionIds: chain,
        originalPaths: moved.map((item) => item.originalPath),
        originalRelatives: moved.map((item) => item.originalRelative),
        originalWorkspace: workspace?.title ?? null,
        cwd: workspace?.path ?? null,
        sizeBytes: totalBytes,
        movedAt: Date.now(),
        expiresAt: (await this.retentionDeadline()),
        source: 'panel',
        cache,
      }
      await fs.writeFile(path.join(entryRoot, 'entry.json'), JSON.stringify(entry, null, 2), 'utf8')
      await fs.rm(path.join(entryRoot, 'entry.pending.json'), { force: true }).catch(() => {})
      await this.stores.trash.add(entry)
      await this.stores.audit.append('trash.move', { entryId, rootSessionId: rootId, sessions: chain.length, bytes: totalBytes })
      entries.push(entry)
    }
    return { entries }
  }

  async retentionDeadline() {
    const settings = await this.stores.settings.load()
    if (!settings.trashRetentionDays || settings.trashRetentionDays <= 0) return null
    return Date.now() + settings.trashRetentionDays * 24 * 60 * 60 * 1000
  }

  async trashList() {
    const settings = await this.stores.settings.load()
    const items = await this.stores.trash.load()
    const now = Date.now()
    const due = items.filter((item) => item.expiresAt !== null && item.expiresAt !== undefined && item.expiresAt <= now)
    return {
      items,
      retentionDays: settings.trashRetentionDays,
      dueCount: due.length,
      totalBytes: items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    }
  }

  async trashRestore({ ids }) {
    const items = await this.stores.trash.load()
    const wanted = new Set(Array.isArray(ids) ? ids : [])
    const restored = []
    const failed = []
    for (const item of items.filter((candidate) => wanted.has(candidate.id))) {
      try {
        const entryRoot = path.join(item.kind === 'file' ? this.paths.trashFiles : this.paths.trashSessions, item.id)
        if (item.kind === 'file') {
          await this.restoreFileEntry(item, entryRoot)
        } else {
          await this.restoreSessionEntry(item, entryRoot)
        }
        await this.stores.trash.remove([item.id])
        await removePath(entryRoot)
        await this.stores.audit.append('trash.restore', { entryId: item.id, sessions: item.sessionIds ?? [] })
        restored.push(item.id)
      } catch (error) {
        failed.push({ id: item.id, reason: String(error && error.message ? error.message : error) })
      }
    }
    return { restored, failed }
  }

  async restoreSessionEntry(item, entryRoot) {
    const payloadRoot = path.join(entryRoot, 'payload')
    const cacheRoot = path.join(entryRoot, 'cache')
    const controller = this.ctx.get('workspaceController')
    for (const [index, relative] of (item.originalRelatives ?? []).entries()) {
      const source = path.join(payloadRoot, String(index))
      if (!(await pathExists(source))) continue
      const target = path.join(this.paths.sessionsRoot, relative)
      await movePath(source, target)
      const sessionId = item.sessionIds[index]
      if (sessionId !== undefined) {
        const cacheFile = path.join(cacheRoot, `${sessionId}.json`)
        if (await pathExists(cacheFile)) {
          await ensureDir(this.paths.projectionCache)
          await movePath(cacheFile, path.join(this.paths.projectionCache, `${sessionId}.json`)).catch(() => {})
        }
        await controller?.unarchiveSession?.({ sessionId }).catch(() => {})
      }
    }
  }

  async restoreFileEntry(item, entryRoot) {
    const source = path.join(entryRoot, 'payload')
    if (!(await pathExists(source))) throw new Error('回收站条目内容已丢失')
    await movePath(source, item.originalPaths[0])
  }

  /** What a permanent delete would actually remove (never attachments). */
  async trashPreviewPurge({ ids }) {
    const items = await this.stores.trash.load()
    const wanted = new Set(Array.isArray(ids) ? ids : [])
    const selected = items.filter((item) => wanted.has(item.id))
    const preview = []
    for (const item of selected) {
      const entryRoot = path.join(item.kind === 'file' ? this.paths.trashFiles : this.paths.trashSessions, item.id)
      const files = (await walkFiles(entryRoot).catch(() => [])).length
      preview.push({
        id: item.id,
        titles: item.titles ?? [],
        sessionIds: item.sessionIds ?? [],
        sizeBytes: item.sizeBytes ?? (await dirSize(entryRoot).catch(() => 0)),
        paths: item.originalPaths ?? [],
        files,
        attachmentsSafe: true,
      })
    }
    return { items: preview, totalBytes: preview.reduce((sum, entry) => sum + entry.sizeBytes, 0) }
  }

  async trashPurge({ ids, confirm }) {
    if (confirm !== true) throw new Error('彻底删除需要显式确认')
    const items = await this.stores.trash.load()
    const wanted = new Set(Array.isArray(ids) ? ids : [])
    const purged = []
    let freed = 0
    for (const item of items.filter((candidate) => wanted.has(candidate.id))) {
      const entryRoot = path.join(item.kind === 'file' ? this.paths.trashFiles : this.paths.trashSessions, item.id)
      assertDeletable(entryRoot)
      const size = item.sizeBytes ?? (await dirSize(entryRoot).catch(() => 0))
      await removePath(entryRoot)
      await this.stores.trash.remove([item.id])
      await this.stores.audit.append('trash.purge', { entryId: item.id, sessionIds: item.sessionIds ?? [], bytes: size })
      purged.push(item.id)
      freed += size
    }
    return { purged, freedBytes: freed }
  }

  async trashSweep() {
    const items = await this.stores.trash.load()
    const now = Date.now()
    const due = items
      .filter((item) => item.expiresAt !== null && item.expiresAt !== undefined && item.expiresAt <= now)
      .map((item) => item.id)
    if (due.length === 0) return { purged: [] }
    const result = await this.trashPurge({ ids: due, confirm: true })
    await this.stores.settings.setState({ lastSweepAt: now })
    return { purged: result.purged }
  }

  /* ------------------------------------------------------- file-level bin */

  /** Move a work-tree path into the guardian file bin (used by `safe_delete`). */
  async trashPath(target, reason = 'safe-delete') {
    const resolved = path.resolve(target)
    if (!(await pathExists(resolved))) throw new Error(`路径不存在：${resolved}`)
    // Never swallow a data root or the guardian's own directories.
    const flightRoots = [
      this.paths.home,
      this.paths.sessionsRoot,
      this.paths.attachmentsRoot,
      this.paths.storagesRoot,
      this.paths.root,
    ]
    for (const root of flightRoots) {
      if (resolved === path.resolve(root) || isInside(resolved, root)) {
        throw new Error(`拒绝把数据目录或其上级移入回收站：${resolved}`)
      }
    }
    if (path.parse(resolved).root === resolved) throw new Error(`拒绝移动盘符根目录：${resolved}`)
    const settings = await this.stores.settings.load()
    if (!settings.fileTrashEnabled) throw new Error('文件回收站已关闭，请在守护者设置中开启')
    const entryId = `${stampId()}-${shortId()}`
    const entryRoot = path.join(this.paths.trashFiles, entryId)
    await ensureDir(entryRoot)
    const payload = path.join(entryRoot, 'payload')
    const size = (await fs.stat(resolved)).isDirectory() ? await dirSize(resolved) : (await fs.stat(resolved)).size
    await movePath(resolved, payload)
    const entry = {
      id: entryId,
      kind: 'file',
      titles: [path.basename(resolved)],
      sessionIds: [],
      originalPaths: [resolved],
      originalWorkspace: null,
      cwd: path.dirname(resolved),
      sizeBytes: size,
      movedAt: Date.now(),
      expiresAt: await this.retentionDeadline(),
      source: reason,
    }
    await fs.writeFile(path.join(entryRoot, 'entry.json'), JSON.stringify(entry, null, 2), 'utf8')
    await this.stores.trash.add(entry)
    await this.stores.audit.append('file.trash', { entryId, path: resolved, bytes: size, reason })
    return entry
  }

  /* ------------------------------------------------------- export / import */

  /** Gather one session's portable representation. */
  async readPortableSession(sessionId) {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) throw new Error('sessionQuery 服务不可用')
    const snapshot = await query.readSession(sessionId)
    const titleSnapshot = await query.readTitle(sessionId).catch(() => undefined)
    const attachments = collectAttachmentIds(snapshot.events ?? [])
    return {
      id: sessionId,
      header: snapshot.session,
      events: snapshot.events ?? [],
      title: titleSnapshot?.title ?? '未命名会话',
      attachments,
    }
  }

  async exportRun({ scope, sessionIds, workspaceId, outDir, fileName, includeAttachments = true }) {
    const targetDir = path.resolve(String(outDir ?? '').trim() || path.dirname(this.paths.root))
    await ensureDir(targetDir)
    const requested = new Set(Array.isArray(sessionIds) ? sessionIds : [])
    const workspaceList = await this.listSessions()
    let roots = []
    if (scope === 'workspace') {
      const workspace = workspaceList.workspaces.find((candidate) => candidate.id === workspaceId)
      if (workspace === undefined) throw new Error('工作区不存在')
      roots = workspace.sessionIds
    } else if (scope === 'sessions') {
      roots = [...requested]
    } else if (requested.size > 0) {
      roots = [...requested]
    } else {
      roots = workspaceList.sessions.filter((row) => !row.isSubagent).map((row) => row.id)
    }
    if (roots.length === 0) throw new Error('没有可导出的会话')

    const ids = []
    for (const rootId of roots) {
      for (const id of await this.sessionChain(rootId)) if (!ids.includes(id)) ids.push(id)
    }

    const portable = []
    const attachmentIds = new Map()
    for (const id of ids) {
      try {
        const session = await this.readPortableSession(id)
        portable.push(session)
        for (const attachment of session.attachments) attachmentIds.set(attachment.attachmentId, attachment)
      } catch {
        /* a session whose log cannot be replayed is skipped, not fatal */
      }
    }

    const files = []
    const attachments = []
    if (includeAttachments) {
      for (const [attachmentId, info] of attachmentIds) {
        const source = attachmentObjectPath(this.paths.attachmentsRoot, attachmentId)
        if (source === undefined || !(await pathExists(source))) continue
        const extension = extensionForMedia(info.mediaType) ?? path.extname(info.name ?? '') ?? '.bin'
        const entryName = `attachments/${String(attachmentId).replace(/^sha256:/, '')}${extension}`
        files.push({ name: entryName, type: 'file', source })
        attachments.push({ ...info, file: entryName })
      }
    }

    const manifest = {
      format: 'dsh-guardian-portable',
      formatVersion: 1,
      createdAt: Date.now(),
      dshVersion: this.ctx.get('clientModules')?.graph?.()?.release?.version ?? 'unknown',
      exportedFrom: {
        home: this.paths.home,
        profile: process.env.DSH_PROFILE ?? null,
      },
      sessions: portable.map((session) => ({
        id: session.id,
        title: session.title,
        cwd: session.header.cwd ?? null,
        createdAt: session.header.createdAt ?? 0,
        parentSession: session.header.parentSession ?? null,
        agentPreset: session.header.agentPreset ?? null,
        messageCount: countMessages(session.events),
        eventCount: session.events.length,
        attachmentCount: session.attachments.length,
      })),
      attachments,
      guardian: {
        scope: scope ?? 'session',
        workspaceId: workspaceId ?? null,
        includesAttachments: includeAttachments === true,
      },
    }

    for (const session of portable) {
      files.push({ name: `sessions/${session.id}/header.json`, type: 'file', data: Buffer.from(JSON.stringify(session.header, null, 2)) })
      files.push({
        name: `sessions/${session.id}/events.jsonl`,
        type: 'file',
        data: Buffer.from(session.events.map((event) => JSON.stringify(event)).join('\n')),
      })
    }

    const name = (givenName) =>
      typeof givenName === 'string' && givenName.trim() !== '' ? sanitiseFileName(givenName.trim()) : `dsh-guardian-export-${stampId()}.tar.gz`
    const target = path.join(targetDir, name(fileName))
    await writeTarGz(target, [
      { name: 'manifest.json', type: 'file', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'README.txt', type: 'file', data: Buffer.from(portablePackageReadme(manifest)) },
      ...files,
    ])
    const stat = await fs.stat(target)
    await this.stores.audit.append('export.run', { target, sessions: portable.length, attachments: attachments.length })
    return { path: target, bytes: stat.size, sessions: portable.length, attachments: attachments.length }
  }

  /** Read a portable package's manifest and first-level contents without importing. */
  async importInspect({ filePath }) {
    const target = path.resolve(String(filePath ?? '').trim())
    if (!(await pathExists(target))) throw new Error(`安装包不存在：${target}`)
    let manifest
    const sessionIds = []
    let attachmentFiles = 0
    for await (const entry of readTarGz(target)) {
      if (entry.name === 'manifest.json') {
        manifest = JSON.parse(entry.data.toString('utf8'))
      } else if (/^sessions\/[^/]+\/header\.json$/.test(entry.name)) {
        sessionIds.push(entry.name.split('/')[1])
      } else if (entry.name.startsWith('attachments/')) {
        attachmentFiles += 1
      }
    }
    if (manifest === undefined) throw new Error('不是有效的守护者可移植包（缺少 manifest.json）')
    const version = String(manifest.formatVersion ?? 0)
    return {
      manifest,
      sessions: manifest.sessions ?? sessionIds.map((id) => ({ id, title: id, messageCount: 0, attachmentCount: 0, cwd: null })),
      attachments: attachmentFiles,
      dshVersion: manifest.dshVersion ?? 'unknown',
      compatible: manifest.format === 'dsh-guardian-portable' && Number(version) === 1,
      warnings:
        manifest.format === 'dsh-guardian-portable'
          ? []
          : ['该包不是守护者可移植包，导入可能缺少会话元数据'],
    }
  }

  async importRun({ filePath, targetPath: destination, snapshot = true }) {
    const target = path.resolve(String(filePath ?? '').trim())
    if (!(await pathExists(target))) throw new Error(`安装包不存在：${target}`)
    const workspacePath = path.resolve(String(destination ?? '').trim())
    if (workspacePath === '') throw new Error('导入必须重新指定目标工作区/文件夹')
    if (!(await pathExists(workspacePath))) throw new Error(`目标文件夹不存在：${workspacePath}`)

    let snapshotId = null
    if (snapshot) {
      try {
        const created = await this.stores.snapshots.create({ label: '导入前自动快照', kind: 'auto-before-import' })
        snapshotId = created.id
      } catch {
        snapshotId = null
      }
    }

    const manifestFiles = new Map()
    const sessionPayloads = new Map()
    let manifest
    for await (const entry of readTarGz(target)) {
      if (entry.name === 'manifest.json') {
        manifest = JSON.parse(entry.data.toString('utf8'))
        continue
      }
      if (entry.type === 'dir') continue
      manifestFiles.set(entry.name, entry.data)
    }
    if (manifest === undefined) throw new Error('不是有效的守护者可移植包（缺少 manifest.json）')

    const persist = this.ctx.get('sessionPersistence')
    if (persist === undefined) throw new Error('sessionPersistence 服务不可用')

    const idMap = new Map()
    const imported = []
    const skipped = []
    const ordered = [...(manifest.sessions ?? [])]
    ordered.sort((left, right) => (left.parentSession === null ? -1 : 0) - (right.parentSession === null ? -1 : 0))

    for (const session of ordered) {
      const headerRaw = manifestFiles.get(`sessions/${session.id}/header.json`)
      const eventsRaw = manifestFiles.get(`sessions/${session.id}/events.jsonl`)
      if (headerRaw === undefined || eventsRaw === undefined) {
        skipped.push(`${session.id}：包内缺少会话日志`)
        continue
      }
      try {
        let newId = session.id
        const existing = await persist.stat(newId).catch(() => undefined)
        if (existing !== undefined) {
          const random = shortId()
          newId = `${session.id}-${random}`
          while ((await persist.stat(newId).catch(() => undefined)) !== undefined) {
            newId = `${session.id}-${shortId()}`
          }
        }
        if (!SESSION_ID_RE.test(newId)) throw new Error(`会话 id 非法：${newId}`)
        const parentOriginal = session.parentSession ?? null
        const header = {
          version: JSON.parse(headerRaw.toString('utf8')).version ?? 4,
          id: newId,
          createdAt: Date.now(),
          cwd: workspacePath,
          isSeeded: false,
          delegationDepth: session.delegationDepth ?? 0,
          ...(session.agentPreset ? { agentPreset: session.agentPreset } : {}),
          ...(parentOriginal !== null && idMap.has(parentOriginal) ? { parentSession: idMap.get(parentOriginal) } : {}),
          ...(session.origin === 'subagent' ? { origin: 'subagent' } : {}),
        }
        const events = eventsRaw
          .toString('utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line))
        const handle = await persist.create(header)
        try {
          const batchSize = 100
          for (let index = 0; index < events.length; index += batchSize) {
            await handle.append(events.slice(index, index + batchSize))
          }
          await handle.flush()
        } finally {
          await handle.close()
        }
        idMap.set(session.id, newId)
        imported.push({ sourceId: session.id, newId, title: session.title ?? session.id })
      } catch (error) {
        skipped.push(`${session.id}：${String(error && error.message ? error.message : error)}`)
      }
    }

    // Attachments are content-addressed, so writing the same bytes is idempotent.
    for (const attachment of manifest.attachments ?? []) {
      const data = manifestFiles.get(attachment.file)
      if (data === undefined) continue
      const destinationPath = attachmentObjectPath(this.paths.attachmentsRoot, attachment.attachmentId)
      if (destinationPath === undefined) continue
      if (await pathExists(destinationPath)) continue
      await ensureDir(path.dirname(destinationPath))
      await fs.writeFile(destinationPath, data)
    }

    await this.stores.audit.append('import.run', {
      package: target,
      workspacePath,
      imported: imported.length,
      skipped: skipped.length,
      snapshotId,
    })
    return { imported, skipped, snapshotId }
  }

  /** Directory listing for the panel's package/export pickers. */
  async listDir({ path: requested }) {
    const base = requested === undefined || String(requested).trim() === '' ? this.paths.home : path.resolve(String(requested))
    const stat = await fs.stat(base).catch(() => undefined)
    if (stat === undefined || !stat.isDirectory()) throw new Error(`目录不存在：${base}`)
    const entries = await fs.readdir(base, { withFileTypes: true })
    const dirs = []
    const files = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = path.join(base, entry.name)
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: absolute })
      } else if (entry.isFile()) {
        const info = await fs.stat(absolute).catch(() => undefined)
        files.push({ name: entry.name, path: absolute, bytes: info?.size ?? 0 })
      }
    }
    dirs.sort((left, right) => left.name.localeCompare(right.name))
    files.sort((left, right) => left.name.localeCompare(right.name))
    return {
      path: base,
      parent: path.dirname(base) === base ? null : path.dirname(base),
      dirs,
      files,
    }
  }
}

function extensionForMedia(mediaType) {
  switch (mediaType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      return undefined
  }
}

function sanitiseFileName(name) {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim()
  return cleaned === '' ? `dsh-guardian-export-${stampId()}.tar.gz` : cleaned
}

function portablePackageReadme(manifest) {
  return [
    'dsh-guardian portable session package',
    '',
    `created: ${new Date(manifest.createdAt).toISOString()}`,
    `sessions: ${manifest.sessions?.length ?? 0}`,
    `attachments: ${manifest.attachments?.length ?? 0}`,
    '',
    'Layout:',
    '  manifest.json                 package metadata (sessions, attachments, versions)',
    '  sessions/<id>/header.json     immutable session header',
    '  sessions/<id>/events.jsonl    complete durable event log, one JSON event per line',
    '  attachments/<sha256>.<ext>    content-addressed attachment bytes',
    '',
    'Import restores each session through the Harness session store with a freshly',
    'chosen cwd; the original cwd is never written back verbatim.',
    '',
  ].join('\n')
}
