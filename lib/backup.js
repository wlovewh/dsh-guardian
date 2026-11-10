/**
 * Scheduled/manual disaster-recovery backups.
 *
 * A backup is one gzipped tar written under the configured backup root:
 *   manifest.json                 what/when/how much
 *   sessions/**                   byte-exact copies of the session log directories
 *   storages/workspace.json       workspace ordering, archive and pin state
 *   attachments/v1/**             content-addressed attachment bytes (optional)
 *   config/**                     settings.yaml / .credentials.yaml / .env (opt-in)
 *   profile/**                    cordis.patch.yml, cordis.yml, package.json
 *   guardian-snapshot/**          the matching configuration snapshot (module C)
 *
 * Beside it live `<name>.sha256`, `<name>.guardian.json` (the index sidecar) and
 * the zero-dependency `rescue.mjs`/`rescue.cmd`/`rescue.command` launchers.
 *
 * Restoring never deletes anything first: it overwrites the whitelisted prefixes
 * after taking a pre-restore configuration snapshot, and asks for a restart.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  ensureDir,
  pathExists,
  profileDir,
  readTarGz,
  removePath,
  sha256File,
  shortId,
  stampId,
  walkFiles,
  writeJson,
  writeTarGz,
} from './util.js'
import { resolveBackupRoot } from './store.js'

export class BackupManager {
  constructor(ctx, paths, stores, snapshots) {
    this.ctx = ctx
    this.paths = paths
    this.stores = stores
    this.snapshots = snapshots
  }

  async backupRoot() {
    const settings = await this.stores.settings.load()
    return resolveBackupRoot(settings)
  }

  /** Next scheduled run, computed from settings + persisted state. */
  async nextRunAt() {
    const settings = await this.stores.settings.load()
    const state = await this.stores.settings.state()
    if (state?.nextBackupAt !== null && state?.nextBackupAt !== undefined) return state.nextBackupAt
    if (!settings.backupIntervalHours || settings.backupIntervalHours <= 0) return null
    return Date.now() + settings.backupIntervalHours * 60 * 60 * 1000
  }

  /** Recompute the persisted next run when settings change. */
  async reschedule() {
    const settings = await this.stores.settings.load()
    const next = settings.backupIntervalHours > 0 ? Date.now() + settings.backupIntervalHours * 60 * 60 * 1000 : null
    await this.stores.settings.setState({ nextBackupAt: next })
    return next
  }

  /** Build one backup archive plus its sidecars, then rotate. */
  async run({ kind = 'manual' } = {}) {
    const settings = await this.stores.settings.load()
    const root = await this.backupRoot()
    await ensureDir(root)
    const createdAt = Date.now()
    const id = `${stampId()}-${kind === 'manual' ? 'manual' : 'scheduled'}-${shortId()}`
    const archive = path.join(root, `${id}.tar.gz`)

    let snapshotMeta
    try {
      snapshotMeta = settings.includeConfig
        ? await this.snapshots.create({ label: `备份 ${new Date(createdAt).toLocaleString()} 配置快照`, kind: 'auto-with-backup' })
        : undefined
    } catch {
      snapshotMeta = undefined
    }

    const entries = []
    let sessions = 0
    let attachmentBytes = 0
    if (settings.includeSessions) {
      const sessionDirs = await this.sessionRoots()
      for (const dir of sessionDirs) {
        for (const file of await walkFiles(dir)) {
          const relative = path.relative(this.paths.sessionsRoot, file.absolute)
          entries.push({ name: `sessions/${relative.split(path.sep).join('/')}`, type: 'file', source: file.absolute, mtime: createdAt })
        }
        sessions += 1
      }
      if (await pathExists(this.paths.workspaceRegistry)) {
        entries.push({ name: 'storages/workspace.json', type: 'file', source: this.paths.workspaceRegistry, mtime: createdAt })
      }
    }
    if (settings.includeAttachments && (await pathExists(this.paths.attachmentsRoot))) {
      for (const file of await walkFiles(this.paths.attachmentsRoot, { ignoreDirs: ['tmp'], maxFiles: 200000 })) {
        entries.push({ name: `attachments/${file.relative}`, type: 'file', source: file.absolute, mtime: createdAt })
        attachmentBytes += file.size
      }
    }
    if (settings.includeConfig) {
      for (const [name, source] of [
        ['config/settings.yaml', this.paths.settingsYaml],
        ['config/.credentials.yaml', this.paths.credentialsYaml],
        ['config/.env', this.paths.envFile],
      ]) {
        if (name === 'config/settings.yaml' || settings.includeCredentials) {
          if (await pathExists(source)) entries.push({ name, type: 'file', source, mtime: createdAt })
        }
      }
      const profile = profileDir()
      if (profile !== undefined) {
        for (const name of ['cordis.patch.yml', 'cordis.yml', 'package.json']) {
          const source = path.join(profile, name)
          if (await pathExists(source)) {
            entries.push({ name: `profile/${name}`, type: 'file', source, mtime: createdAt })
          }
        }
      }
      if (snapshotMeta !== undefined) {
        for (const file of await walkFiles(this.snapshots.snapshotDir(snapshotMeta.id))) {
          entries.push({
            name: `guardian-snapshot/${file.relative}`,
            type: 'file',
            source: file.absolute,
            mtime: createdAt,
          })
        }
      }
    }

    const manifest = {
      format: 'dsh-guardian-backup',
      formatVersion: 1,
      id,
      kind,
      createdAt,
      dshVersion: this.ctx.get('clientModules')?.graph?.()?.release?.version ?? 'unknown',
      home: this.paths.home,
      profile: profileDir() ?? null,
      modules: {
        sessions: settings.includeSessions,
        attachments: settings.includeAttachments,
        config: settings.includeConfig,
        credentials: settings.includeCredentials,
        snapshotId: snapshotMeta?.id ?? null,
      },
      counts: {
        sessions,
        attachments: entries.filter((entry) => entry.name.startsWith('attachments/')).length,
        attachmentBytes,
        files: entries.length,
      },
    }
    entries.unshift({ name: 'manifest.json', type: 'file', data: Buffer.from(JSON.stringify(manifest, null, 2)), mtime: createdAt })
    await writeTarGz(archive, entries)
    const digest = await sha256File(archive)
    const stat = await fs.stat(archive)
    await fs.writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`, 'utf8')

    const entry = {
      id,
      path: archive,
      createdAt,
      kind,
      bytes: stat.size,
      sha256: digest,
      verified: true,
      sidecar: `${archive}.guardian.json`,
      contents: {
        sessions,
        snapshots: snapshotMeta === undefined ? 0 : 1,
        attachments: manifest.counts.attachments,
        files: manifest.counts.files,
      },
      rescuePath: path.join(root, 'rescue.mjs'),
      snapshotId: snapshotMeta?.id ?? null,
    }
    await writeJson(`${archive}.guardian.json`, entry)
    await this.writeRescueScripts(root)
    await this.stores.backups.add(entry)
    await this.rotate()
    await this.stores.settings.setState({
      lastBackupAt: Date.now(),
      nextBackupAt:
        settings.backupIntervalHours > 0 ? Date.now() + settings.backupIntervalHours * 60 * 60 * 1000 : null,
    })
    await this.stores.audit.append('backup.run', { id, kind, bytes: stat.size, sessions, attachments: manifest.counts.attachments })
    return entry
  }

  /** Every project directory that holds session logs, skipping nothing by name. */
  async sessionRoots() {
    let projectKeys = []
    try {
      projectKeys = await fs.readdir(this.paths.sessionsRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const roots = []
    for (const entry of projectKeys) {
      if (!entry.isDirectory()) continue
      const projectDir = path.join(this.paths.sessionsRoot, entry.name)
      let sessions = []
      try {
        sessions = await fs.readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (session.isDirectory()) roots.push(path.join(projectDir, session.name))
      }
    }
    return roots
  }

  async list() {
    const settings = await this.stores.settings.load()
    const items = await this.stores.backups.load()
    const refreshed = []
    for (const item of items) {
      const exists = await pathExists(item.path)
      refreshed.push({ ...item, exists })
    }
    return {
      items: refreshed,
      retention: { full: settings.backupFullRetention, snapshots: settings.backupSnapshotRetention },
      backupRoot: await this.backupRoot(),
      nextBackupAt: await this.nextRunAt(),
    }
  }

  async verify({ id }) {
    const items = await this.stores.backups.load()
    const item = items.find((candidate) => candidate.id === id)
    if (item === undefined) throw new Error('备份不存在')
    const actual = await sha256File(item.path).catch(() => 'missing')
    const ok = actual === item.sha256
    await this.stores.backups.update(id, { verified: ok })
    await this.stores.audit.append('backup.verify', { id, ok })
    return { ok, expected: item.sha256, actual, checkedAt: Date.now() }
  }

  /** Restore a backup over the current home/profile after a pre-restore snapshot. */
  async restore({ id, confirm }) {
    if (confirm !== true) throw new Error('恢复备份需要显式确认')
    const items = await this.stores.backups.load()
    const item = items.find((candidate) => candidate.id === id)
    if (item === undefined) throw new Error('备份不存在')
    if (!(await pathExists(item.path))) throw new Error('备份文件已不存在')
    const digest = await sha256File(item.path)
    if (digest !== item.sha256) throw new Error('备份校验失败，拒绝恢复（请先校验并改用更早的备份）')

    const settings = await this.stores.settings.load()
    let preRestoreSnapshotId = null
    if (settings.includeConfig) {
      try {
        const snapshot = await this.snapshots.create({ label: '备份恢复前自动快照', kind: 'auto-before-restore' })
        preRestoreSnapshotId = snapshot.id
      } catch {
        preRestoreSnapshotId = null
      }
    }

    let restored = 0
    for await (const entry of readTarGz(item.path)) {
      if (entry.type === 'dir') continue
      if (entry.name === 'manifest.json' || entry.name.startsWith('guardian-snapshot/')) continue
      const target = this.restoreTarget(entry.name)
      if (target === undefined) continue
      await ensureDir(path.dirname(target))
      await fs.writeFile(target, entry.data)
      restored += 1
    }
    await this.stores.audit.append('backup.restore', { id, restored, preRestoreSnapshotId })
    return { restored, preRestoreSnapshotId, rescanRequired: true }
  }

  /** Map an archive entry name onto its destination, or undefined when not restorable. */
  restoreTarget(name) {
    if (name.startsWith('sessions/')) return path.join(this.paths.sessionsRoot, name.slice('sessions/'.length))
    if (name === 'storages/workspace.json') return this.paths.workspaceRegistry
    if (name.startsWith('attachments/')) return path.join(this.paths.attachmentsRoot, name.slice('attachments/'.length))
    if (name === 'config/settings.yaml') return this.paths.settingsYaml
    if (name === 'config/.credentials.yaml') return this.paths.credentialsYaml
    if (name === 'config/.env') return this.paths.envFile
    if (name.startsWith('profile/')) {
      const profile = profileDir()
      if (profile === undefined) return undefined
      return path.join(profile, name.slice('profile/'.length))
    }
    return undefined
  }

  async reveal({ id }) {
    const items = await this.stores.backups.load()
    const item = id === undefined ? items[0] : items.find((candidate) => candidate.id === id)
    const root = await this.backupRoot()
    return {
      path: item?.path ?? root,
      rescuePath: item?.rescuePath ?? path.join(root, 'rescue.mjs'),
      root,
    }
  }

  /** Keep the newest `backupFullRetention` archives; delete the rest. */
  async rotate() {
    const settings = await this.stores.settings.load()
    const items = await this.stores.backups.load()
    const keep = Math.max(1, settings.backupFullRetention)
    const sorted = [...items].sort((left, right) => right.createdAt - left.createdAt)
    const excess = sorted.slice(keep)
    for (const item of excess) {
      await removePath(item.path).catch(() => {})
      await removePath(`${item.path}.sha256`).catch(() => {})
      await removePath(`${item.path}.guardian.json`).catch(() => {})
    }
    if (excess.length > 0) {
      await this.stores.backups.remove(excess.map((item) => item.id))
      await this.stores.audit.append('backup.rotate', { removed: excess.map((item) => item.id) })
    }
    return excess.map((item) => item.id)
  }

  /** Emit the zero-dependency rescue script beside the archives. */
  async writeRescueScripts(root) {
    await ensureDir(root)
    const script = path.join(root, 'rescue.mjs')
    const text = RESCUE_SCRIPT
    const current = await fs.readFile(script, 'utf8').catch(() => undefined)
    if (current !== text) await fs.writeFile(script, text, 'utf8')
    const cmd = path.join(root, 'rescue.cmd')
    const cmdText = [
      '@echo off',
      'setlocal',
      'pushd "%~dp0"',
      'where node >nul 2>nul',
      'if errorlevel 1 (',
      '  echo Node.js 18+ is required to run the rescue script.',
      '  pause',
      '  exit /b 1',
      ')',
      'node "%~dp0rescue.mjs" %*',
      'set EXITCODE=%ERRORLEVEL%',
      'pause',
      'popd',
      'exit /b %EXITCODE%',
      '',
    ].join('\r\n')
    await fs.writeFile(cmd, cmdText, 'utf8')
    const command = path.join(root, 'rescue.command')
    const commandText = [
      '#!/bin/sh',
      'cd "$(dirname "$0")" || exit 1',
      'command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required to run the rescue script."; read -r _; exit 1; }',
      'node ./rescue.mjs "$@"',
      'status=$?',
      'printf "Press Enter to close…"',
      'read -r _',
      'exit $status',
      '',
    ].join('\n')
    await fs.writeFile(command, commandText, 'utf8')
    await fs.chmod(command, 0o755).catch(() => {})
  }
}

/** Zero-dependency recovery script emitted next to every backup. */
export const RESCUE_SCRIPT = `#!/usr/bin/env node
/**
 * dsh-guardian rescue — restore a guardian backup without the Harness.
 *
 * This file is generated by the dsh-guardian plugin and depends only on Node.js
 * (>= 18) built-ins: it reads the .tar.gz itself (an ustar parser plus gunzip),
 * verifies the .sha256 sibling, and writes the restored files into $DSH_HOME.
 *
 * Usage:
 *   node rescue.mjs                        restore the newest backup beside this file
 *   node rescue.mjs --backup <file.tar.gz> restore one exact archive
 *   node rescue.mjs --home <dir>           target DSH home (default $DSH_HOME or ~/.dsh)
 *   node rescue.mjs --profile <dir>        also restore profile/ files
 *   node rescue.mjs --force                overwrite even when a .sha256 mismatch is found
 *   node rescue.mjs --list                 list available backups
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createGunzip } from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf('--' + name);
  return index === -1 ? fallback : (argv[index + 1] ?? true);
};
const has = (name) => argv.includes('--' + name);

const here = dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1'));
const home = resolve(String(flag('home', process.env.DSH_HOME || join(homedir(), '.dsh'))));
const profile = flag('profile', process.env.DSH_PROFILE_DIR || null);
const force = has('force');

if (has('list')) {
  const files = readdirSync(here).filter((name) => name.endsWith('.tar.gz'));
  console.log('Backups beside this script:');
  for (const name of files) {
    const size = readFileSync(join(here, name)).length;
    console.log('  ' + name + '  ' + (size / 1048576).toFixed(1) + ' MB');
  }
  process.exit(0);
}

const explicit = flag('backup', null);
let backup;
if (explicit !== null) {
  backup = resolve(here, String(explicit));
} else {
  const candidates = readdirSync(here).filter((name) => name.endsWith('.tar.gz')).sort();
  if (candidates.length === 0) {
    console.error('No .tar.gz backup found beside ' + here);
    process.exit(1);
  }
  backup = join(here, candidates[candidates.length - 1]);
}

console.log('Backup : ' + backup);
console.log('Target : ' + home);
if (profile !== null) console.log('Profile: ' + profile);

const digest = createHash('sha256');
for await (const chunk of createReadStream(backup)) digest.update(chunk);
const actual = digest.digest('hex');
const shaFile = backup + '.sha256';
let expected = null;
if (existsSync(shaFile)) {
  expected = readFileSync(shaFile, 'utf8').trim().split(/\\s+/)[0];
  if (expected !== actual) {
    console.error('Checksum mismatch: expected ' + expected + ', got ' + actual);
    if (!force) {
      console.error('Refusing to restore. Re-run with --force only if you accept possible corruption.');
      process.exit(1);
    }
  } else {
    console.log('Checksum: OK (' + actual.slice(0, 16) + '…)');
  }
}

/** Resolve one archive entry name onto a destination path. */
function target(name) {
  if (name.startsWith('sessions/')) return join(home, 'sessions', name.slice('sessions/'.length));
  if (name === 'storages/workspace.json') return join(home, 'storages', 'workspace.json');
  if (name.startsWith('attachments/')) return join(home, 'attachments', name.slice('attachments/'.length));
  if (name === 'config/settings.yaml') return join(home, 'settings.yaml');
  if (name === 'config/.credentials.yaml') return join(home, '.credentials.yaml');
  if (name === 'config/.env') return join(home, '.env');
  if (name.startsWith('profile/')) {
    if (profile === null) return undefined;
    return join(profile, name.slice('profile/'.length));
  }
  return undefined;
}

const padding = (length) => (length % 512 === 0 ? 0 : 512 - (length % 512));
let buffer = Buffer.alloc(0);
let pendingName = null;
let remaining = 0;
let skip = 0;
let restored = 0;
let skipped = 0;

function consume() {
  while (true) {
    if (skip > 0) {
      if (buffer.length < skip) return;
      buffer = buffer.subarray(skip);
      skip = 0;
      continue;
    }
    if (pendingName !== null) {
      if (buffer.length < remaining) return;
      const name = pendingName;
      const body = buffer.subarray(0, remaining);
      buffer = buffer.subarray(remaining);
      skip = padding(remaining);
      pendingName = null;
      remaining = 0;
      const destination = target(name);
      if (destination === undefined || name === 'manifest.json' || name.startsWith('guardian-snapshot/')) {
        skipped += 1;
        continue;
      }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, body);
      restored += 1;
      continue;
    }
    if (buffer.length < 512) return;
    const header = buffer.subarray(0, 512);
    buffer = buffer.subarray(512);
    if (header.every((byte) => byte === 0)) return;
    const text = (offset, length) => header.subarray(offset, offset + length).toString('utf8').replace(/\\0[^]*$/s, '').trim();
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
    const size = parseInt(text(124, 12), 8) || 0;
    const type = text(156, 1) || '0';
    if (type === '5') continue;
    if (size === 0) {
      const destination = target(name);
      if (destination !== undefined) {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, Buffer.alloc(0));
        restored += 1;
      } else skipped += 1;
      continue;
    }
    pendingName = name;
    remaining = size;
  }
}

for await (const chunk of createReadStream(backup).pipe(createGunzip())) {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  consume();
}
consume();

console.log('Restored ' + restored + ' files' + (skipped > 0 ? ' (' + skipped + ' skipped)' : '') + '.');
console.log('Restart DeepSeek Harness so the session store and configuration reload.');
`
