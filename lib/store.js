/**
 * Guardian's own persistence: settings, the recycle-bin index, the backup index
 * and the audit log.
 *
 * Every index is written atomically with a `.bak` and is rebuildable from its
 * directory (the trash entries and the backup sidecars are the source of truth),
 * so a damaged index never makes the user's data unreachable.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHome, ensureDir, pathExists, readJson, writeJson } from './util.js'

/** Defaults; `settings.json` only stores the user's overrides. */
export const DEFAULT_SETTINGS = Object.freeze({
  backupRoot: '',
  backupIntervalHours: 24,
  backupCron: null,
  backupFullRetention: 7,
  backupSnapshotRetention: 30,
  includeSessions: true,
  includeConfig: true,
  includeAttachments: true,
  includeCredentials: false,
  trashRetentionDays: 30,
  safeDeleteEnabled: true,
  safeDeleteBypassUntil: 0,
  fileTrashEnabled: true,
  snapshotOnImport: true,
  toastPosition: 'top',
  toastSeconds: 3,
})

const SETTING_TYPES = {
  backupRoot: 'string',
  backupIntervalHours: 'number',
  backupCron: 'string',
  backupFullRetention: 'number',
  backupSnapshotRetention: 'number',
  includeSessions: 'boolean',
  includeConfig: 'boolean',
  includeAttachments: 'boolean',
  includeCredentials: 'boolean',
  trashRetentionDays: 'number',
  safeDeleteEnabled: 'boolean',
  safeDeleteBypassUntil: 'number',
  fileTrashEnabled: 'boolean',
  snapshotOnImport: 'boolean',
  toastPosition: 'string',
  toastSeconds: 'number',
}

/** Every path the plugin owns. */
export function guardianPaths() {
  const home = dshHome()
  const root = path.join(home, 'guardian')
  return {
    home,
    root,
    settingsFile: path.join(root, 'settings.json'),
    stateFile: path.join(root, 'state.json'),
    trashRoot: path.join(root, 'trash'),
    trashSessions: path.join(root, 'trash', 'sessions'),
    trashFiles: path.join(root, 'trash', 'files'),
    trashIndex: path.join(root, 'trash-index.json'),
    snapshotsRoot: path.join(root, 'snapshots'),
    backupIndex: path.join(root, 'backup-index.json'),
    auditFile: path.join(root, 'audit.jsonl'),
    sessionsRoot: path.join(home, 'sessions'),
    storagesRoot: path.join(home, 'storages'),
    attachmentsRoot: path.join(home, 'attachments'),
    projectionCache: path.join(home, 'storages', 'session_projcache', 'sessions'),
    workspaceRegistry: path.join(home, 'storages', 'workspace.json'),
    settingsYaml: path.join(home, 'settings.yaml'),
    credentialsYaml: path.join(home, '.credentials.yaml'),
    envFile: path.join(home, '.env'),
  }
}

/** Clamp/sanitise a settings patch, ignoring unknown keys. */
export function sanitiseSettings(patch, base = DEFAULT_SETTINGS) {
  const next = { ...base }
  if (patch === null || typeof patch !== 'object') return next
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in SETTING_TYPES)) continue
    const type = SETTING_TYPES[key]
    if (type === 'boolean') {
      if (typeof value === 'boolean') next[key] = value
      continue
    }
    if (type === 'string') {
      if (typeof value === 'string') next[key] = value.trim()
      else if (value === null) next[key] = ''
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (key === 'backupIntervalHours') next[key] = Math.max(0, Math.min(24 * 365, Math.round(value * 100) / 100))
      else if (key === 'safeDeleteBypassUntil') next[key] = Math.max(0, Math.round(value))
      else if (key === 'toastSeconds') next[key] = Math.max(1, Math.min(15, Math.round(value)))
      else if (key === 'backupCron') next[key] = String(value)
      else next[key] = Math.max(0, Math.min(10000, Math.round(value)))
      continue
    }
    if (value === null && key === 'backupCron') next[key] = null
    if (value === null && key === 'backupIntervalHours') next[key] = 0
  }
  if (next.toastPosition !== 'bottom') next.toastPosition = 'top'
  if (next.backupCron !== null && typeof next.backupCron !== 'string') next.backupCron = null
  if (typeof next.backupCron === 'string' && next.backupCron.trim() === '') next.backupCron = null
  return next
}

/** Effective backup root: the configured path, else `~/Documents/dsh-guardian-backups`. */
export function resolveBackupRoot(settings) {
  if (typeof settings.backupRoot === 'string' && settings.backupRoot.trim() !== '') {
    return path.resolve(settings.backupRoot.trim())
  }
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? dshHome(), 'Documents', 'dsh-guardian-backups')
}

/** Minimal JSONL audit log, newest last. */
export class AuditLog {
  constructor(file) {
    this.file = file
  }

  async append(kind, detail) {
    const line = JSON.stringify({ at: Date.now(), kind, detail: detail ?? null })
    try {
      await ensureDir(path.dirname(this.file))
      await fs.appendFile(this.file, `${line}\n`, 'utf8')
    } catch {
      /* auditing must never break the operation it records */
    }
  }

  async list(limit = 50) {
    try {
      const text = await fs.readFile(this.file, 'utf8')
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      return lines
        .slice(-Math.max(1, Math.min(500, limit)))
        .reverse()
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { at: 0, kind: 'unreadable', detail: line.slice(0, 200) }
          }
        })
    } catch {
      return []
    }
  }
}

/** Settings + runtime state (next backup time) with atomic writes. */
export class SettingsStore {
  constructor(paths) {
    this.paths = paths
    this.audit = new AuditLog(paths.auditFile)
    this.cache = undefined
  }

  async load() {
    if (this.cache !== undefined) return this.cache
    const stored = await readJson(this.paths.settingsFile, {})
    this.cache = sanitiseSettings(stored)
    return this.cache
  }

  async update(patch) {
    const current = await this.load()
    const next = sanitiseSettings(patch, current)
    this.cache = next
    await writeJson(this.paths.settingsFile, next)
    return next
  }

  async state() {
    return readJson(this.paths.stateFile, { nextBackupAt: null, lastBackupAt: null, lastSweepAt: null })
  }

  async setState(patch) {
    const current = await this.state()
    const next = { ...current, ...patch }
    await writeJson(this.paths.stateFile, next)
    return next
  }
}

/** Recycle-bin index with rebuild and atomic writes. */
export class TrashStore {
  constructor(paths) {
    this.paths = paths
    this.items = undefined
  }

  async load() {
    if (this.items !== undefined) return this.items
    const stored = await readJson(this.paths.trashIndex, undefined)
    if (stored === undefined || !Array.isArray(stored.items)) {
      this.items = await this.rebuild()
      if (this.items.length > 0) await this.save()
      return this.items
    }
    this.items = stored.items
    return this.items
  }

  async save() {
    await writeJson(this.paths.trashIndex, { version: 1, items: this.items ?? [] })
  }

  /**
   * Rebuild the index from the trash directory: each entry directory carries its
   * own `entry.json`, so losing the index only loses the order, never the data.
   */
  async rebuild() {
    const items = []
    for (const [folder, kind] of [
      [this.paths.trashSessions, 'session'],
      [this.paths.trashFiles, 'file'],
    ]) {
      let entries = []
      try {
        entries = await fs.readdir(folder, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const meta = await readJson(path.join(folder, entry.name, 'entry.json'), undefined)
        if (meta !== undefined) items.push({ ...meta, kind: meta.kind ?? kind })
      }
    }
    items.sort((left, right) => (right.movedAt ?? 0) - (left.movedAt ?? 0))
    this.items = items
    return items
  }

  async add(item) {
    const items = (await this.load()).filter((existing) => existing.id !== item.id)
    items.unshift(item)
    this.items = items
    await this.save()
    return item
  }

  async remove(ids) {
    const items = await this.load()
    const keep = []
    const removed = []
    const wanted = new Set(ids)
    for (const item of items) {
      if (wanted.has(item.id)) removed.push(item)
      else keep.push(item)
    }
    this.items = keep
    await this.save()
    return removed
  }
}

/** Backup index with rebuild from `<backup>.guardian.json` sidecars. */
export class BackupStore {
  constructor(paths, settingsStore) {
    this.paths = paths
    this.settingsStore = settingsStore
    this.items = undefined
  }

  async load() {
    if (this.items !== undefined) return this.items
    const stored = await readJson(this.paths.backupIndex, undefined)
    if (stored === undefined || !Array.isArray(stored.items)) {
      this.items = await this.rebuild()
      return this.items
    }
    this.items = stored.items
    return this.items
  }

  async save() {
    await writeJson(this.paths.backupIndex, { version: 1, items: this.items ?? [] })
  }

  async rebuild() {
    const settings = await this.settingsStore.load()
    const root = resolveBackupRoot(settings)
    const items = []
    let names = []
    try {
      names = await fs.readdir(root)
    } catch {
      this.items = items
      return items
    }
    for (const name of names) {
      if (!name.endsWith('.guardian.json')) continue
      const meta = await readJson(path.join(root, name), undefined)
      if (meta !== undefined && typeof meta.id === 'string') items.push(meta)
    }
    items.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    this.items = items
    return items
  }

  async add(item) {
    const items = (await this.load()).filter((existing) => existing.id !== item.id)
    items.unshift(item)
    items.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    this.items = items
    await this.save()
    return item
  }

  async remove(ids) {
    const items = await this.load()
    const wanted = new Set(ids)
    this.items = items.filter((item) => !wanted.has(item.id))
    await this.save()
  }

  async update(id, patch) {
    const items = await this.load()
    const index = items.findIndex((item) => item.id === id)
    if (index === -1) return undefined
    items[index] = { ...items[index], ...patch }
    await this.save()
    return items[index]
  }
}

/** Ensure every directory the plugin writes to exists. */
export async function ensureGuardianDirs(paths) {
  for (const dir of [paths.root, paths.trashSessions, paths.trashFiles, paths.snapshotsRoot]) {
    await ensureDir(dir)
  }
  await ensureDir(path.dirname(resolveDefaultBackupRoot()))
}

function resolveDefaultBackupRoot() {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? dshHome(), 'Documents', 'dsh-guardian-backups')
}

/** True when a path belongs to a guardian-owned directory (safe to delete). */
export async function isGuardianOwned(paths, target) {
  const resolved = path.resolve(target)
  const roots = [paths.trashRoot, paths.snapshotsRoot, path.join(paths.root, 'file-trash')]
  for (const root of roots) {
    if (resolved === path.resolve(root)) return false
    if (resolved.startsWith(`${path.resolve(root)}${path.sep}`)) return true
  }
  return false
}

export { pathExists }
