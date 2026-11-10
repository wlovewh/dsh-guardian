/**
 * Configuration snapshots: capture the profile's configuration surface, diff it
 * against the live state, and restore it with a pre-restore snapshot.
 *
 * The snapshot lives in `$DSH_HOME/guardian/snapshots/<id>/`:
 *   meta.json            modules, file list, per-file hashes, DSH version
 *   files/<virtual>      the captured bytes, keyed by a stable virtual path
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  copyTree,
  diffText,
  ensureDir,
  pathExists,
  readJson,
  removePath,
  sha256Buffer,
  shortId,
  stampId,
  walkFiles,
  writeJson,
} from './util.js'
import { profileDir } from './util.js'

/** Directory names a configuration snapshot never walks into. */
export const SNAPSHOT_IGNORED_DIRS = [
  'node_modules',
  '.git',
  '.research',
  'backups',
  'dist',
  'build',
  '.cache',
  '.turbo',
  'coverage',
  '.vscode',
  '.idea',
  '__pycache__',
  '.venv',
]

/** Virtual-path key → real absolute path for the surfaces this plugin snapshots. */
async function configSurfaces(paths, options = {}) {
  const surfaces = []
  const add = (key, absolute, required = false) => surfaces.push({ key, absolute, required })
  add('home/settings.yaml', paths.settingsYaml)
  add('home/storages/workspace.json', paths.workspaceRegistry)
  if (options.credentials === true) {
    add('home/.credentials.yaml', paths.credentialsYaml)
    add('home/.env', paths.envFile)
  }
  const profile = paths.profile ?? profileDir()
  if (profile !== undefined) {
    add('profile/cordis.patch.yml', path.join(profile, 'cordis.patch.yml'), true)
    add('profile/cordis.yml', path.join(profile, 'cordis.yml'))
    add('profile/package.json', path.join(profile, 'package.json'), true)
  }
  if (options.skills === true) {
    const skillsRoot = path.join(paths.home, 'skills')
    if (await pathExists(skillsRoot)) surfaces.push({ key: 'skills', absolute: skillsRoot, tree: true })
    if (profile !== undefined && (await pathExists(path.join(profile, 'skills')))) {
      surfaces.push({ key: 'profile-skills', absolute: path.join(profile, 'skills'), tree: true })
    }
  }
  if (options.pluginSources === true && profile !== undefined) {
    const manifest = await readJson(path.join(profile, 'package.json'), {})
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const target = path.resolve(profile, spec.slice('link:'.length))
      if (!(await pathExists(target))) continue
      surfaces.push({ key: `plugin/${name.replace(/[\\/]/g, '_')}`, absolute: target, tree: true, pluginSource: true })
    }
  }
  return surfaces
}

export class SnapshotManager {
  constructor(ctx, paths, stores) {
    this.ctx = ctx
    this.paths = paths
    this.stores = stores
  }

  snapshotDir(id) {
    return path.join(this.paths.snapshotsRoot, id)
  }

  /** Capture one snapshot; returns its metadata entry. */
  async create({ label, kind = 'manual', include } = {}) {
    const settings = await this.stores.settings.load()
    const modules = {
      config: true,
      skills: include?.skills ?? true,
      pluginSources: include?.pluginSources ?? true,
      credentials: include?.credentials ?? false,
      includeSecrets: settings.includeCredentials === true || include?.credentials === true,
    }
    const id = `${stampId()}-${kind === 'manual' ? 'manual' : kind}`
    const root = this.snapshotDir(id)
    await ensureDir(path.join(root, 'files'))
    const surfaces = await configSurfaces(this.paths, modules)
    const files = []
    let totalBytes = 0
    for (const surface of surfaces) {
      if (!(await pathExists(surface.absolute))) continue
      if (surface.tree === true) {
        const result = await copyTree(surface.absolute, path.join(root, 'files', surface.key), {
          ignoreDirs: SNAPSHOT_IGNORED_DIRS,
          maxBytes: 8 * 1024 * 1024,
          maxFileBytes: 2 * 1024 * 1024,
        })
        const copied = await walkFiles(path.join(root, 'files', surface.key))
        for (const file of copied) {
          files.push({ path: `${surface.key}/${file.relative}`, bytes: file.size })
          totalBytes += file.size
        }
        if (result.copied === 0) continue
        continue
      }
      const data = await fs.readFile(surface.absolute)
      const destination = path.join(root, 'files', surface.key)
      await ensureDir(path.dirname(destination))
      await fs.writeFile(destination, data)
      files.push({ path: surface.key, bytes: data.length, sha256: sha256Buffer(data) })
      totalBytes += data.length
    }

    const meta = {
      id,
      label: label ?? (kind === 'manual' ? '手动快照' : kind),
      kind,
      createdAt: Date.now(),
      files,
      bytes: totalBytes,
      includesSecrets: modules.includeSecrets === true,
      modules,
      dshVersion: this.ctx.get('clientModules')?.graph?.()?.release?.version ?? 'unknown',
      profile: this.paths.profile ?? null,
    }
    await writeJson(path.join(root, 'meta.json'), meta)
    await this.stores.audit.append('snapshot.create', { id, kind, files: files.length, bytes: totalBytes })
    await this.prune()
    return meta
  }

  async list() {
    const settings = await this.stores.settings.load()
    let names = []
    try {
      names = await fs.readdir(this.paths.snapshotsRoot)
    } catch {
      return { items: [], retention: settings.backupSnapshotRetention }
    }
    const items = []
    for (const name of names) {
      const meta = await readJson(path.join(this.paths.snapshotsRoot, name, 'meta.json'), undefined)
      if (meta !== undefined) items.push(meta)
    }
    items.sort((left, right) => right.createdAt - left.createdAt)
    return { items, retention: settings.backupSnapshotRetention }
  }

  /** Delete automatic snapshots beyond the configured retention. */
  async prune() {
    const settings = await this.stores.settings.load()
    const { items } = await this.list()
    const automatic = items.filter((item) => item.kind !== 'manual')
    const excess = automatic.slice(Math.max(0, settings.backupSnapshotRetention))
    for (const item of excess) await removePath(this.snapshotDir(item.id)).catch(() => {})
    if (excess.length > 0) await this.stores.audit.append('snapshot.prune', { removed: excess.map((item) => item.id) })
  }

  async delete({ id }) {
    const root = this.snapshotDir(id)
    if (!(await pathExists(root))) throw new Error('快照不存在')
    await removePath(root)
    await this.stores.audit.append('snapshot.delete', { id })
    return { deleted: true }
  }

  /** File-level and plugin-level diff: live state → snapshot. */
  async diff({ id }) {
    const meta = await readJson(path.join(this.snapshotDir(id), 'meta.json'), undefined)
    if (meta === undefined) throw new Error('快照不存在')
    const snapshotFiles = new Map(meta.files.map((file) => [file.path, file]))
    const surfaces = await configSurfaces(this.paths, meta.modules ?? {})
    const currentFiles = new Map()
    for (const surface of surfaces) {
      if (!(await pathExists(surface.absolute))) continue
      if (surface.tree === true) {
        const walked = await walkFiles(surface.absolute, { ignoreDirs: SNAPSHOT_IGNORED_DIRS })
        for (const file of walked) currentFiles.set(`${surface.key}/${file.relative}`, file)
      } else {
        const stat = await fs.stat(surface.absolute).catch(() => undefined)
        if (stat === undefined) continue
        currentFiles.set(surface.key, { absolute: surface.absolute, size: stat.size })
      }
    }

    const files = []
    for (const [key, snapshotFile] of snapshotFiles) {
      const current = currentFiles.get(key)
      if (current === undefined) {
        files.push({ path: key, kind: 'removed', addedLines: 0, removedLines: snapshotFile.bytes })
        continue
      }
      const snapshotText = await fs.readFile(path.join(this.snapshotDir(id), 'files', key), 'utf8').catch(() => undefined)
      const currentText = await fs.readFile(current.absolute, 'utf8').catch(() => undefined)
      if (snapshotText === undefined || currentText === undefined) {
        if (snapshotFile.bytes !== current.size) files.push({ path: key, kind: 'changed', addedLines: 0, removedLines: 0 })
        continue
      }
      if (snapshotText === currentText) continue
      if (!isTextual(key)) {
        files.push({ path: key, kind: 'changed', addedLines: 0, removedLines: 0 })
        continue
      }
      const diff = diffText(currentText, snapshotText, key)
      files.push({ path: key, kind: 'changed', addedLines: diff.added, removedLines: diff.removed, patch: diff.patch })
    }
    for (const [key] of currentFiles) {
      if (!snapshotFiles.has(key)) files.push({ path: key, kind: 'added', addedLines: 0, removedLines: 0 })
    }

    const plugins = await this.diffPlugins(meta, id)
    return {
      files,
      plugins,
      currentIsNewer: files.length > 0,
    }
  }

  /** Compare plugin rows in the snapshot's `cordis.patch.yml` with the live file. */
  async diffPlugins(meta, id) {
    const snapshotFile = path.join(this.snapshotDir(id), 'files', 'profile/cordis.patch.yml')
    const profile = this.paths.profile ?? profileDir()
    const liveFile = profile === undefined ? undefined : path.join(profile, 'cordis.patch.yml')
    if (!(await pathExists(snapshotFile)) || liveFile === undefined || !(await pathExists(liveFile))) {
      return { added: [], removed: [], changed: [] }
    }
    const before = rowsOfYaml(await fs.readFile(snapshotFile, 'utf8'))
    const after = rowsOfYaml(await fs.readFile(liveFile, 'utf8'))
    const added = []
    const removed = []
    const changed = []
    for (const [rowId, row] of before) {
      const live = after.get(rowId)
      if (live === undefined) {
        removed.push(rowId)
        continue
      }
      const keys = []
      for (const key of new Set([...Object.keys(row), ...Object.keys(live)])) {
        if (row[key] !== live[key]) keys.push(key)
      }
      if (keys.length > 0) changed.push({ id: rowId, keys })
    }
    for (const [rowId] of after) if (!before.has(rowId)) added.push(rowId)
    return { added, removed, changed }
  }

  /** Restore every captured file, after taking a pre-restore snapshot. */
  async restore({ id }) {
    const root = this.snapshotDir(id)
    const meta = await readJson(path.join(root, 'meta.json'), undefined)
    if (meta === undefined) throw new Error('快照不存在')
    const preRestore = await this.create({ label: '恢复前自动快照', kind: 'auto-before-restore', include: meta.modules ?? {} })
    const surfaceMap = new Map((await configSurfaces(this.paths, meta.modules ?? {})).map((surface) => [surface.key, surface]))
    let restoredFiles = 0
    for (const file of meta.files) {
      const key = file.path
      const baseKey = key.split('/')[0] === 'plugin' ? key.split('/').slice(0, 2).join('/') : key
      const surface = surfaceMap.get(baseKey) ?? surfaceMap.get(key.split('/').slice(0, 1).join('/'))
      const source = path.join(root, 'files', key)
      if (!(await pathExists(source))) continue
      if (surface !== undefined && surface.tree === true) {
        const relative = key.slice(baseKey.length + 1)
        const destination = path.join(surface.absolute, relative)
        await ensureDir(path.dirname(destination))
        await fs.copyFile(source, destination)
      } else {
        const destination = surface?.absolute ?? this.resolveAbsoluteKey(key)
        if (destination === undefined) continue
        await ensureDir(path.dirname(destination))
        await fs.copyFile(source, destination)
      }
      restoredFiles += 1
    }
    await this.stores.audit.append('snapshot.restore', { id, preRestoreSnapshotId: preRestore.id, restoredFiles })
    return { snapshotId: id, preRestoreSnapshotId: preRestore.id, restoredFiles }
  }

  resolveAbsoluteKey(key) {
    if (key.startsWith('home/')) return path.join(this.paths.home, key.slice('home/'.length))
    const profile = this.paths.profile ?? profileDir()
    if (profile !== undefined && key.startsWith('profile/')) return path.join(profile, key.slice('profile/'.length))
    return undefined
  }
}

/** Extract the top-level patch rows (`- id: <name>`) with their flat scalar keys. */
export function rowsOfYaml(text) {
  const rows = new Map()
  let current = undefined
  for (const line of text.split('\n')) {
    const idMatch = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line)
    if (idMatch !== null) {
      const rowId = stripQuotes(idMatch[1])
      current = {}
      rows.set(rowId, current)
      continue
    }
    if (current === undefined) continue
    const scalar = /^\s{2,}([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (scalar === null) continue
    const value = scalar[2].trim()
    if (value === '' || value.startsWith('|') || value.startsWith('>')) continue
    current[scalar[1]] = value
  }
  return rows
}

function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/g, '')
}

function isTextual(key) {
  return /\.(ya?ml|json|jsonl|env|md|txt|js|mjs|cjs|ts|toml|ini)$/i.test(key)
}

/** Convenience wrapper used by the backup module. */
export async function createSnapshotFor(manager, label, kind) {
  return manager.create({ label, kind })
}

export { shortId }
