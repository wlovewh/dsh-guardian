/**
 * Agent-facing half of the safety net:
 * - `safe_delete` moves a work-tree path into the guardian file bin,
 * - `guardian_trash` lists / restores / purges recycle-bin entries,
 * - a `tools/pre-execute` guard refuses shell deletions and points the model at
 *   `safe_delete`, with `DSH_GUARDIAN_FORCE_DELETE=1` as the audited escape hatch.
 */
import path from 'node:path'

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
        async execute(args, exec) {
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
        async execute(args) {
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

    // Deny shell deletions; the guard is synchronous and order-independent.
    disposers.push(
      this.ctx.on('tools/pre-execute', async (exec, next) => {
        const settings = await this.stores.settings.load()
        if (!settings.safeDeleteEnabled) return next()
        if (process.env.DSH_GUARDIAN_FORCE_DELETE === '1') return next()
        const name = String(exec?.name ?? '')
        if (!['bash', 'pwsh', 'shell', 'terminal_run', 'run_code'].includes(name)) return next()
        const command = commandOf(exec?.arguments)
        if (!looksDestructive(command)) return next()
        await this.stores.audit.append('tool.denied', { tool: name, command: command.slice(0, 500) })
        return {
          kind: 'deny',
          reason:
            'dsh-guardian 拦截了这条删除命令：它会直接抹掉文件，无法撤销。\n' +
            '请改用 `safe_delete` 工具（目标路径会被移入回收站，可从“会话历史 → 回收站”恢复）；' +
            '如果确实需要永久删除，请让用户设置 DSH_GUARDIAN_FORCE_DELETE=1 后重启 DSH。',
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
