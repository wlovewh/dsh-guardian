/**
 * Filesystem, archive, hashing and diff helpers for dsh-guardian.
 *
 * Everything here is dependency-free on purpose: the plugin may run in a
 * deployment with no network, so a recursive copy, a tar.gz writer/reader and a
 * line diff are implemented locally.
 */
import {
  createHash,
  randomUUID,
} from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGunzip, createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

/** Resolve `$DSH_HOME` the way the Harness does. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  return path.resolve(configured && configured.length > 0 ? configured : path.join(os.homedir(), '.dsh'))
}

/** Resolve the active profile directory, when the Harness was started with one. */
export function profileDir() {
  const configured = process.env.DSH_PROFILE_DIR
  return configured && configured.length > 0 ? path.resolve(configured) : undefined
}

/**
 * Resolve the profile this plugin is installed into.
 *
 * `DSH_PROFILE_DIR` / `DSH_PROFILE` are only exported to shell tools, not to the
 * Host process, so the fallback looks for the profile whose `node_modules`
 * links this package, then for the one that declares it as a dependency.
 */
export async function resolveProfileDir(packageRoot, packageName = 'dsh-guardian') {
  const direct = profileDir()
  if (direct !== undefined) return direct
  const named = process.env.DSH_PROFILE
  const profilesRoot = path.join(dshHome(), 'profiles')
  if (typeof named === 'string' && named.length > 0) {
    const candidate = path.join(profilesRoot, named)
    if (await pathExists(candidate)) return candidate
  }
  let entries = []
  try {
    entries = await fs.readdir(profilesRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(profilesRoot, entry.name))
  if (packageRoot !== undefined) {
    for (const candidate of directories) {
      try {
        const resolved = await fs.realpath(path.join(candidate, 'node_modules', packageName))
        if (path.resolve(resolved) === path.resolve(packageRoot)) return candidate
      } catch {
        /* this profile does not link the package */
      }
    }
  }
  for (const candidate of directories) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8'))
      if (manifest?.dependencies?.[packageName] === undefined) continue
      if (await pathExists(path.join(candidate, 'cordis.patch.yml'))) return candidate
    } catch {
      /* unreadable profile */
    }
  }
  return undefined
}

/** Format bytes for the panel. */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** A sortable, filesystem-safe timestamp id such as `20261110-094500-123`. */
export function stampId(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
  )
}

/** Short random suffix for collision-free directory names. */
export function shortId() {
  return randomUUID().slice(0, 8)
}

export async function pathExists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true })
}

/** Read JSON, returning `fallback` for a missing or malformed file. */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Write JSON atomically: serialise, write `<file>.tmp`, keep one `.bak` of the
 * previous content, then rename over the target. A crash leaves either the old
 * or the new file, never a torn one.
 */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temp = `${file}.tmp`
  await fs.writeFile(temp, text, 'utf8')
  if (await pathExists(file)) {
    await fs.copyFile(file, `${file}.bak`).catch(() => {})
  }
  await fs.rename(temp, file)
}

/** Descendant directory sizes, keyed by absolute path. */
export async function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile()) {
        try {
          total += (await fs.stat(target)).size
        } catch {
          /* raced with a writer */
        }
      }
    }
  }
  return total
}

/** Count files (not directories) below `dir`. */
export async function countFiles(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile()) total += 1
    }
  }
  return total
}

/** Recursively list files with relative paths, skipping ignored directory names. */
export async function walkFiles(root, options = {}) {
  const { ignoreDirs = [], maxFiles = 100000 } = options
  const out = []
  const stack = ['']
  while (stack.length > 0) {
    const relative = stack.pop()
    let entries
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      const absolute = path.join(root, childRelative)
      if (entry.isDirectory()) {
        if (ignoreDirs.includes(entry.name)) continue
        stack.push(childRelative)
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = (await fs.stat(absolute)).size
        } catch {
          continue
        }
        out.push({ relative: childRelative.split(path.sep).join('/'), absolute, size })
        if (out.length >= maxFiles) return out
      }
    }
  }
  out.sort((left, right) => left.relative.localeCompare(right.relative))
  return out
}

/** Copy a directory tree, returning the number of copied files and bytes. */
export async function copyTree(source, target, options = {}) {
  const { ignoreDirs = [], maxBytes = Number.POSITIVE_INFINITY, maxFileBytes = Number.POSITIVE_INFINITY } = options
  const files = await walkFiles(source, { ignoreDirs })
  let bytes = 0
  let copied = 0
  for (const file of files) {
    if (file.size > maxFileBytes) continue
    if (bytes + file.size > maxBytes) break
    const destination = path.join(target, file.relative)
    await ensureDir(path.dirname(destination))
    await fs.copyFile(file.absolute, destination)
    bytes += file.size
    copied += 1
  }
  return { copied, bytes }
}

/** Remove a file or directory, ignoring "already gone". */
export async function removePath(target) {
  await fs.rm(target, { recursive: true, force: true })
}

/** Move a file or directory, falling back to copy+verify+delete across volumes. */
export async function movePath(source, target) {
  await ensureDir(path.dirname(target))
  if (path.parse(source).root === path.parse(target).root) {
    try {
      await fs.rename(source, target)
      return { strategy: 'rename' }
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
  }
  await copyTreeVerified(source, target)
  await removePath(source)
  return { strategy: 'copy' }
}

/** Copy then verify every file's size before the source may be deleted. */
export async function copyTreeVerified(source, target) {
  const sourceStat = await fs.stat(source)
  if (sourceStat.isFile()) {
    await fs.copyFile(source, target)
    const [from, to] = await Promise.all([fs.stat(source), fs.stat(target)])
    if (from.size !== to.size) throw new Error(`copy verification failed for ${source}`)
    return
  }
  const files = await walkFiles(source)
  for (const file of files) {
    const destination = path.join(target, file.relative)
    await ensureDir(path.dirname(destination))
    await fs.copyFile(file.absolute, destination)
    const copied = await fs.stat(destination)
    if (copied.size !== file.size) throw new Error(`copy verification failed for ${file.absolute}`)
  }
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function sha256File(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** True when `child` is a strict descendant of `parent`. */
export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Paths a permanent delete must never touch. */
export function assertDeletable(target) {
  const resolved = path.resolve(target)
  const home = dshHome()
  const protectedPaths = [
    path.parse(resolved).root,
    process.env.SystemRoot ?? 'C:\\Windows',
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    home,
    path.join(home, 'sessions'),
    path.join(home, 'attachments'),
    path.join(home, 'storages'),
    path.join(home, 'profiles'),
  ].filter((entry) => typeof entry === 'string' && entry.length > 0)
  for (const candidate of protectedPaths) {
    if (path.relative(path.resolve(candidate), resolved) === '') {
      throw new Error(`拒绝删除受保护路径：${resolved}`)
    }
  }
  if (!isInside(home, resolved) && !isInside(os.homedir(), resolved)) {
    // Outside the DSH home the guardian only deletes inside its own trash.
    if (!isInside(path.join(home, 'guardian'), resolved)) {
      throw new Error(`拒绝删除 DSH 数据目录之外的路径：${resolved}`)
    }
  }
}

/* ------------------------------------------------------------------ tar.gz */

/** Serialise one ustar header. */
function tarHeader({ name, size, mode, mtime, type }) {
  const buffer = Buffer.alloc(512)
  const write = (value, offset, length) => {
    const text = Buffer.from(value, 'utf8')
    text.copy(buffer, offset, 0, Math.min(text.length, length))
  }
  const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`
  let target = name
  let prefix = ''
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const segments = name.split('/')
    let found = false
    for (let split = segments.length - 1; split >= 1; split -= 1) {
      const suffix = segments.slice(split).join('/')
      const leading = segments.slice(0, split).join('/')
      if (Buffer.byteLength(suffix, 'utf8') <= 100 && Buffer.byteLength(leading, 'utf8') <= 155) {
        target = suffix
        prefix = leading
        found = true
        break
      }
    }
    if (!found) throw new Error(`tar path too long: ${name}`)
  }
  write(target, 0, 100)
  write(octal(mode ?? 0o644, 8), 100, 8)
  write(octal(0, 8), 108, 8)
  write(octal(0, 8), 116, 8)
  write(octal(size, 12), 124, 12)
  write(octal(Math.floor(mtime / 1000), 12), 136, 12)
  write('        ', 148, 8)
  write(type === 'dir' ? '5' : '0', 156, 1)
  write('ustar\0', 257, 6)
  write('00', 263, 2)
  write(prefix, 345, 155)
  let checksum = 0
  for (const byte of buffer) checksum += byte
  write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return buffer
}

function pad512(length) {
  const remainder = length % 512
  return remainder === 0 ? 0 : 512 - remainder
}

/**
 * Write a gzipped tar archive from `entries`:
 * `{ name, type: 'file'|'dir', text?, data?, source?, mtime? }`.
 * File bodies are streamed from `source` so a backup of a large session tree
 * never has to sit in memory.
 */
export async function writeTarGz(target, entries) {
  await ensureDir(path.dirname(target))
  const output = createWriteStream(target)
  const gzip = createGzip({ level: 6 })
  gzip.pipe(output)
  let failure
  gzip.on('error', (error) => {
    failure = error
  })
  output.on('error', (error) => {
    failure = error
  })
  const write = (chunk) =>
    new Promise((resolve, reject) => {
      if (failure !== undefined) {
        reject(failure)
        return
      }
      if (!gzip.write(chunk)) gzip.once('drain', resolve)
      else resolve()
    })
  for (const entry of entries) {
    const mtime = entry.mtime ?? Date.now()
    if (entry.type === 'dir') {
      await write(tarHeader({ name: `${entry.name.replace(/\/$/, '')}/`, size: 0, mode: 0o755, mtime, type: 'dir' }))
      continue
    }
    let size = entry.data?.length ?? 0
    if (entry.source !== undefined) size = (await fs.stat(entry.source)).size
    await write(tarHeader({ name: entry.name, size, mode: 0o644, mtime, type: 'file' }))
    if (entry.data !== undefined) {
      await write(entry.data)
    } else if (entry.source !== undefined) {
      for await (const chunk of createReadStream(entry.source)) await write(chunk)
    }
    const padding = pad512(size)
    if (padding > 0) await write(Buffer.alloc(padding))
  }
  await write(Buffer.alloc(1024))
  await new Promise((resolve, reject) => {
    gzip.end((error) => (error ? reject(error) : resolve()))
    output.once('close', resolve)
    output.once('error', reject)
  })
}

/** Parse one ustar block sequence into entries, honouring 512-byte padding. */
export async function* readTarGz(source) {
  const gunzip = createReadStream(source).pipe(createGunzip())
  let buffer = Buffer.alloc(0)
  let pendingName = null
  let remaining = 0
  let skip = 0
  let done = false

  for await (const chunk of gunzip) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    while (!done) {
      if (skip > 0) {
        if (buffer.length < skip) break
        buffer = buffer.subarray(skip)
        skip = 0
        continue
      }
      if (pendingName !== null) {
        if (buffer.length < remaining) break
        const name = pendingName
        const body = Buffer.from(buffer.subarray(0, remaining))
        buffer = buffer.subarray(remaining)
        skip = pad512(remaining)
        pendingName = null
        remaining = 0
        yield { name, type: 'file', data: body }
        continue
      }
      if (buffer.length < 512) break
      const header = buffer.subarray(0, 512)
      buffer = buffer.subarray(512)
      if (header.every((byte) => byte === 0)) {
        done = true
        break
      }
      const readText = (offset, length) => header.subarray(offset, offset + length).toString('utf8').replace(/\0[^]*$/s, '').trim()
      const name = [readText(345, 155), readText(0, 100)].filter(Boolean).join('/')
      const size = Number.parseInt(readText(124, 12), 8) || 0
      const type = readText(156, 1) || '0'
      if (type === '5') {
        yield { name: name.replace(/\/$/, ''), type: 'dir', data: Buffer.alloc(0) }
        continue
      }
      if (size === 0) {
        yield { name, type: 'file', data: Buffer.alloc(0) }
        continue
      }
      pendingName = name
      remaining = size
    }
    if (done) break
  }
}

/* ------------------------------------------------------------------- diff */

/**
 * Minimal line diff (Myers-lite via LCS table for short inputs, prefix/suffix
 * trim for long ones). Returns counts and a compact unified patch body.
 */
export function diffText(before, after, label = 'file') {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  const oldMiddle = oldLines.slice(start, oldEnd)
  const newMiddle = newLines.slice(start, newEnd)
  let added = 0
  let removed = 0
  const body = []
  for (const line of oldMiddle) {
    body.push(`-${line}`)
    removed += 1
  }
  for (const line of newMiddle) {
    body.push(`+${line}`)
    added += 1
  }
  const head = `--- ${label}\n+++ ${label}\n@@ -${start + 1},${oldMiddle.length} +${start + 1},${newMiddle.length} @@`
  return { added, removed, patch: `${head}\n${body.join('\n')}` }
}
