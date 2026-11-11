/**
 * Agent-facing half of the safety net:
 * - `safe_delete` moves a work-tree path into the guardian file bin,
 * - `guardian_trash` lists / restores / purges recycle-bin entries,
 * - a `tools/pre-execute` guard refuses shell deletions and points the model at
 *   `safe_delete`, with `DSH_GUARDIAN_FORCE_DELETE=1` as the audited escape hatch.
 */
import path from 'node:path'
import { isInside } from './util.js'

/** Shell verbs that delete without a recycle bin. */
const DESTRUCTIVE_PATTERNS = [
  /(^|[;&|]\s*)rm\s+(-[a-zA-Z]*\s+)*/m,
  /(^|[;&|]\s*)del\s+/im,
  /(^|[;&|]\s*)erase\s+/im,
  /(^|[;&|]\s*)rmdir\s+/im,
  /(^|[;&|]\s*)rd\s+\/s/im,
  /remove-item\b/im,
  /\brimraf\b/im,
  /\brm(Sync)?\s*\(/m,
  /\brmdir(Sync)?\s*\(/m,
  /\bunlink(Sync)?\s*\(/m,
]

/** True when a shell command deletes files the user cannot get back. */
export function looksDestructive(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return false
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text))
}

/** Split one command line into tokens, honouring single and double quotes. */
function tokenize(text) {
  const tokens = []
  let current = ''
  let quote = ''
  for (const character of text) {
    if (quote !== '') {
      if (character === quote) quote = ''
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (quote !== '') return []
  if (current !== '') tokens.push(current)
  return tokens
}

const DELETE_VERBS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item'])

/**
 * Recognise a *simple* deletion command whose targets can be moved into the
 * recycle bin: one verb, no pipes, redirects, variables, globs or subshells.
 *
 * Anything more expressive is refused and handled by the plain denial path,
 * because guessing targets of a composed command is how data gets lost.
 */
export function planShellDelete(command) {
  const text = String(command ?? '').trim()
  if (text === '') return undefined
  if (/[|;&<>`$*?(){}]/.test(text)) return undefined
  const tokens = tokenize(text)
  if (tokens.length < 2) return undefined
  const verb = tokens[0].toLowerCase()
  if (!DELETE_VERBS.has(verb)) return undefined
  const flagLike = (token) => token.startsWith('-') || /^\/[A-Za-z][A-Za-z0-9_-]*$/.test(token)
  const targets = tokens.slice(1).filter((token) => !flagLike(token))
  if (targets.length === 0 || targets.length > 20) return undefined
  return { verb, targets }
}

/** Working directory the shell call will run in, when the tool reports one. */
export function shellCwd(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of ['workdir', 'cwd', 'dir', 'directory']) {
    if (typeof args[key] === 'string' && args[key].trim() !== '') return path.resolve(args[key])
  }
  return undefined
}

/** Read a shell tool's command text regardless of its exact argument name. */
function commandOf(args) {
  if (args === null || typeof args !== 'object') return ''
  for (const key of ['command', 'script', 'cmd', 'input']) {
    if (typeof args[key] === 'string') return args[key]
  }
  return ''
}

function textBlocks(lines) {
  return [{ type: 'text', text: lines.join('\n') }]
}

export class GuardianTools {
  constructor(ctx, service, stores) {
    this.ctx = ctx
    this.service = service
    this.stores = stores
  }

  /** Register the tools, the guard and the prompt hint. */
  register() {
    const tools = this.ctx.get('tools')
    if (tools === undefined) return
    const disposers = []

    disposers.push(
      tools.register({
        name: 'safe_delete',
        description:
          'Move a file or directory into the guardian recycle bin instead of deleting it permanently. ' +
          'The path is recoverable from the dsh-guardian panel (回收站) until its retention expires. ' +
          'Prefer this over `rm`, `Remove-Item`, `del` or `rmdir` for anything inside a workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path of the file or directory to move into the recycle bin.' },
            reason: { type: 'string', description: 'Why this path should be removed (shown in the audit log).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              entryId: { type: 'string' },
              originalPath: { type: 'string' },
              trashedTo: { type: 'string' },
              bytes: { type: 'number' },
              restoreHint: { type: 'string' },
            },
            required: ['entryId', 'originalPath', 'bytes'],
            additionalProperties: false,
          },
          render(_args, value) {
            const record = value ?? {}
            return textBlocks([
              `已移入回收站：${record.originalPath}`,
              `条目 ${record.entryId}，${record.bytes ?? 0} 字节；可在“会话历史 → 回收站”中恢复。`,
            ])
          },
        },
        execute: async (args, exec) => {
          const target = path.resolve(String(args?.path ?? ''))
          const entry = await this.service.trashPath(target, args?.reason ?? `safe_delete by ${exec?.agent?.id ?? 'agent'}`)
          return {
            entryId: entry.id,
            originalPath: entry.originalPaths[0],
            trashedTo: path.join(this.service.paths.trashFiles, entry.id),
            bytes: entry.sizeBytes,
            restoreHint: '打开左侧栏“会话历史 → 回收站”，选择该条目后点击恢复。',
          }
        },
      }),
    )

    disposers.push(
      tools.register({
        name: 'guardian_trash',
        description:
          'Inspect or recover the dsh-guardian recycle bin: list entries, restore entries, or permanently purge entries. ' +
          'Purge is irreversible and must pass confirm: true; it never deletes shared attachments.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'restore', 'purge', 'sweep'], description: 'Operation to perform.' },
            entryIds: { type: 'array', items: { type: 'string' }, description: 'Recycle-bin entry ids for restore/purge.' },
            confirm: { type: 'boolean', description: 'Required true for purge.' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { result: { type: 'object' } }, required: ['result'], additionalProperties: false },
          render(_args, value) {
            return textBlocks([JSON.stringify(value?.result ?? value, null, 2)])
          },
        },
        execute: async (args) => {
          switch (args?.action) {
            case 'list': {
              const list = await this.service.trashList()
              return {
                result: {
                  retentionDays: list.retentionDays,
                  totalBytes: list.totalBytes,
                  items: list.items.map((item) => ({
                    id: item.id,
                    kind: item.kind,
                    titles: item.titles,
                    sizeBytes: item.sizeBytes,
                    movedAt: item.movedAt,
                    expiresAt: item.expiresAt,
                  })),
                },
              }
            }
            case 'restore': {
              const result = await this.service.trashRestore({ ids: args.entryIds ?? [] })
              return { result }
            }
            case 'purge': {
              const result = await this.service.trashPurge({ ids: args.entryIds ?? [], confirm: args.confirm === true })
              return { result }
            }
            case 'sweep': {
              const result = await this.service.trashSweep()
              return { result }
            }
            default:
              throw new Error(`未知操作：${String(args?.action)}`)
          }
        },
      }),
    )

    // Deny shell deletions; simple commands are redirected into the file bin so the
    // user finds the target in the recycle bin instead of losing it. The guard is
    // synchronous in shape but may await, which the pipeline allows.
    disposers.push(
      this.ctx.on('tools/pre-execute', async (exec, next) => {
        const settings = await this.stores.settings.load()
        const envForce = process.env.DSH_GUARDIAN_FORCE_DELETE === '1'
        const bypassUntil = Number(settings.safeDeleteBypassUntil ?? 0)
        const bypass = bypassUntil > Date.now()
        if (envForce || bypass) {
          await this.stores.audit.append('tool.bypass', {
            tool: String(exec?.name ?? ''),
            command: commandOf(exec?.arguments).slice(0, 500),
            via: envForce ? 'env' : 'temporary',
            until: bypass ? bypassUntil : null,
          })
          return next()
        }
        if (!settings.safeDeleteEnabled) return next()
        const name = String(exec?.name ?? '')
        if (!['bash', 'pwsh', 'shell', 'terminal_run', 'run_code'].includes(name)) return next()
        const command = commandOf(exec?.arguments)
        if (!looksDestructive(command)) return next()

        const plan = planShellDelete(command)
        if (settings.fileTrashEnabled && plan !== undefined) {
          const cwd = shellCwd(exec?.arguments)
          if (cwd !== undefined) {
            const moved = []
            const refused = []
            for (const target of plan.targets) {
              const resolved = path.resolve(cwd, target)
              const root = path.parse(resolved).root
              if (resolved === cwd || isInside(resolved, cwd) || resolved === root) {
                refused.push(`${target}（目标是当前目录、其上级或盘符根，已拒绝）`)
                continue
              }
              try {
                const entry = await this.service.trashPath(resolved, `shell ${plan.verb}`)
                moved.push({ target, entry })
              } catch (error) {
                refused.push(`${target}（${String(error && error.message ? error.message : error)}）`)
              }
            }
            if (moved.length > 0) {
              await this.stores.audit.append('tool.redirected', {
                tool: name,
                verb: plan.verb,
                moved: moved.map((item) => item.entry.originalPaths[0]),
                refused,
              })
              return {
                kind: 'deny',
                reason:
                  `dsh-guardian 已拦截这条删除命令，并把目标移入回收站（可恢复）：\n` +
                  moved.map((item) => `· ${item.entry.originalPaths[0]}（条目 ${item.entry.id}）`).join('\n') +
                  (refused.length > 0 ? `\n未处理：\n${refused.map((line) => `· ${line}`).join('\n')}` : '') +
                  `\n\n用户可在左侧栏「会话历史 → 回收站」恢复。需要永久删除时请让用户在回收站里确认，或设置 DSH_GUARDIAN_FORCE_DELETE=1 后重启 DSH，或在设置页启用临时放行。`,
                info: { name: 'guardian/safe-delete', code: 'guardian/redirected-to-trash', reason: 'moved to recycle bin' },
              }
            }
          }
        }

        await this.stores.audit.append('tool.denied', { tool: name, command: command.slice(0, 500) })
        return {
          kind: 'deny',
          reason:
            'dsh-guardian 拦截了这条删除命令：它会直接抹掉文件，无法撤销。\n' +
            '请改用 `safe_delete` 工具（目标路径会被移入回收站，可从“会话历史 → 回收站”恢复）；' +
            '如果确实需要永久删除，请让用户设置 DSH_GUARDIAN_FORCE_DELETE=1 后重启 DSH，或在设置页启用临时放行。',
          info: { name: 'guardian/safe-delete', code: 'guardian/blocked-delete', reason: 'shell deletion is blocked' },
        }
      }),
    )

    const prompts = this.ctx.get('systemPrompt')
    if (prompts !== undefined) {
      disposers.push(
        prompts.section({
          name: 'dsh-guardian-safe-delete',
          order: 320,
          text:
            'Deleting files: the dsh-guardian plugin is installed. Do not run `rm`, `Remove-Item`, `del` or `rmdir`; ' +
            'they are blocked and recorded in the audit log. Call the `safe_delete` tool instead — it moves the path ' +
            'into a recycle bin the user can restore. Use `guardian_trash` to list or restore recycled entries.',
        }),
      )
    }

    return () => {
      for (const dispose of disposers) dispose()
    }
  }
}
