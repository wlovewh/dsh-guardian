/**
 * dsh-guardian — Client half.
 *
 * Registers the sidebar entry (`sidebar.panellist`) and the main panel (`main`).
 * All data comes from the Host half through the Connection RPC channel
 * (`POST /guardian/<endpoint>`); shapes follow `.research/contract.md`.
 *
 * Loaded as-is by the browser module loader: no JSX, no imports, only `require('react')`.
 * Sections: transport · formatting · locale · styles · atoms · hooks · uiWorkspace bridges
 *           · file browser · sessions · recycle bin · snapshots · backups · settings
 *           · panel shell · plugin entry.
 */
window.__ModuleLoader__.load({
  id: 'dsh-guardian',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const PANEL_ID = 'dsh-guardian'
    const NS = 'guardian'
    const CHANNEL = '/guardian'
    // Remembered picker locations (the panel remounts often, module scope survives).
    const MEMORY = { exportDir: '', importFile: '', importTarget: '' }

    /* ==================================================================== *
     * Transport
     * ==================================================================== */

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

    /** Resolve an optional client service without throwing when it is absent. */
    function service(ctx, name) {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch (error) {
        return undefined
      }
    }

    function errText(error) {
      if (!error) return ''
      const message = String(error.message || error)
      return error.code ? `${message} (${error.code})` : message
    }

    /* ==================================================================== *
     * Formatting
     * ==================================================================== */

    const pad2 = (value) => String(value).padStart(2, '0')
    const listOf = (value) => (Array.isArray(value) ? value : [])
    const cx = (...parts) => parts.filter(Boolean).join(' ')

    function fmtTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function fmtDay(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const date = new Date(ms)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    function fmtRel(ms, t) {
      if (!Number.isFinite(ms) || ms <= 0) return t('never')
      const minutes = Math.floor(Math.max(0, Date.now() - ms) / 60000)
      if (minutes < 1) return t('justNow')
      if (minutes < 60) return `${minutes}${t('unitMin')}`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}${t('unitHour')}`
      return `${Math.floor(hours / 24)}${t('unitDay')}`
    }

    function fmtBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let size = value
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      const shown = index === 0 || size >= 100 ? Math.round(size) : Math.round(size * 10) / 10
      return `${shown} ${units[index]}`
    }

    const fmtNum = (value) => (Number.isFinite(Number(value)) ? String(Number(value)) : '0')
    const shortSha = (value) => (typeof value === 'string' && value.length > 0 ? value.slice(0, 12) : '—')

    function nameOfPath(path) {
      if (!path) return ''
      const text = String(path).replace(/[\\/]+$/, '')
      const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return cut >= 0 ? text.slice(cut + 1) : text
    }

    /* ==================================================================== *
     * Locale — flat dictionaries, zh is the product copy
     * ==================================================================== */

    const STRINGS = {
      panel: ['会话历史', 'Session history'],
      subtitle: ['会话、回收站、快照与备份的统一入口', 'Sessions, recycle bin, snapshots and backups in one place'],
      tabSessions: ['会话', 'Sessions'],
      tabTrash: ['回收站', 'Recycle bin'],
      tabSnapshots: ['快照', 'Snapshots'],
      tabBackups: ['备份', 'Backups'],
      tabSettings: ['设置', 'Settings'],
      refresh: ['刷新', 'Refresh'],
      retry: ['重试', 'Retry'],
      loading: ['加载中…', 'Loading…'],
      empty: ['暂无数据', 'No data'],
      emptyHint: ['这里还没有任何记录。', 'Nothing here yet.'],
      close: ['关闭', 'Close'],
      cancel: ['取消', 'Cancel'],
      save: ['保存', 'Save'],
      saved: ['已保存', 'Saved'],
      open: ['打开', 'Open'],
      browse: ['浏览…', 'Browse…'],
      chooseDir: ['选择目录', 'Choose folder'],
      chooseFile: ['选择文件', 'Choose file'],
      parentDir: ['上级', 'Parent'],
      go: ['前往', 'Go'],
      goPlaceholder: ['输入路径', 'Enter a path'],
      emptyDir: ['空目录', 'Empty folder'],
      untitled: ['未命名会话', 'Untitled session'],
      never: ['从未', 'Never'],
      justNow: ['刚刚', 'just now'],
      unitMin: [' 分钟前', ' min ago'],
      unitHour: [' 小时前', ' h ago'],
      unitDay: [' 天前', ' d ago'],
      errorTitle: ['操作失败', 'Failed'],
      lastRefresh: ['最近刷新', 'Last refresh'],
      no: ['否', 'No'],
      sourcePanel: ['面板', 'Panel'],
      sourceSafeDelete: ['安全删除', 'Safe delete'],
      sourceImportGuard: ['导入保护', 'Import guard'],
      sourceManual: ['手动', 'Manual'],
      kindManual: ['手动', 'Manual'],
      kindBeforeRestore: ['恢复前自动', 'Auto before restore'],
      kindBeforeImport: ['导入前自动', 'Auto before import'],
      kindWithBackup: ['随备份自动', 'Auto with backup'],

      // sessions
      workspaces: ['工作区', 'Workspaces'],
      allSessions: ['全部会话', 'All sessions'],
      sessionCount: ['会话数', 'Sessions'],
      subagentCount: ['子会话', 'Sub-sessions'],
      diskUsage: ['占用', 'Size'],
      searchPlaceholder: ['搜索会话标题或内容…', 'Search session titles or content…'],
      search: ['搜索', 'Search'],
      clearSearch: ['清除搜索', 'Clear search'],
      searchScanned: ['已扫描', 'Scanned'],
      searchTruncated: ['结果已截断，请细化关键词', 'Results truncated — refine the query'],
      title: ['标题', 'Title'],
      snippet: ['摘要', 'Snippet'],
      messages: ['消息数', 'Messages'],
      attachments: ['附件', 'Attachments'],
      lastActivity: ['最后活动', 'Last activity'],
      status: ['状态', 'Status'],
      badgeSubagent: ['子会话', 'Sub'],
      badgeArchived: ['归档', 'Archived'],
      badgeLive: ['运行中', 'Live'],
      badgeTrash: ['回收站', 'Trash'],
      noSessions: ['该工作区没有会话', 'No sessions in this workspace'],
      noSessionsHint: ['换一个工作区，或清除搜索条件。', 'Pick another workspace or clear the search.'],
      rename: ['重命名', 'Rename'],
      renamePlaceholder: ['会话标题', 'Session title'],
      renamed: ['标题已更新', 'Title updated'],
      archive: ['归档', 'Archive'],
      unarchive: ['取消归档', 'Unarchive'],
      archivedMsg: ['已归档', 'Archived'],
      unarchivedMsg: ['已取消归档', 'Unarchived'],
      trash: ['移入回收站', 'Move to recycle bin'],
      movedToTrash: ['已移入回收站，可随时恢复', 'Moved to the recycle bin; it stays recoverable'],
      trashConfirmTitle: ['移入回收站', 'Move to recycle bin'],
      trashConfirmBody: [
        '该会话（含子会话）会被移动到 guardian 回收站，不会从磁盘物理删除。你可以在「回收站」标签页里恢复它。',
        'This session (with its sub-sessions) is moved to the guardian recycle bin and is not deleted from disk. Restore it from the Recycle bin tab.',
      ],
      openError: ['无法打开会话：uiWorkspace 服务不可用', 'Cannot open session: uiWorkspace is unavailable'],
      selectedCount: ['已选', 'selected'],

      // export / import
      export: ['导出', 'Export'],
      exportTitle: ['导出会话', 'Export sessions'],
      scopeWorkspace: ['当前工作区', 'Current workspace'],
      scopeSelected: ['选中会话', 'Selected sessions'],
      scopeAll: ['全部会话', 'All sessions'],
      outDir: ['输出目录', 'Output folder'],
      fileName: ['文件名（可选）', 'File name (optional)'],
      fileNameHint: ['留空则自动命名', 'Leave empty to auto-name'],
      includeAttachments: ['包含附件', 'Include attachments'],
      runExport: ['开始导出', 'Start export'],
      exportDone: ['导出完成', 'Export complete'],
      needOutDir: ['请选择输出目录', 'Choose an output folder'],
      needSelection: ['请先在列表中勾选会话', 'Select at least one session first'],
      needWorkspace: ['请先在左侧选择工作区', 'Select a workspace on the left first'],
      exportPath: ['文件', 'File'],
      size: ['大小', 'Size'],
      import: ['导入', 'Import'],
      importTitle: ['导入会话', 'Import sessions'],
      packagePath: ['可移植包路径', 'Portable package path'],
      inspect: ['检查', 'Inspect'],
      importVersion: ['DSH 版本', 'DSH version'],
      importCompatible: ['兼容', 'Compatible'],
      importIncompatible: ['不兼容', 'Incompatible'],
      importSessions: ['包内会话', 'Sessions in package'],
      importWarnings: ['警告', 'Warnings'],
      targetPath: ['目标目录', 'Target folder'],
      targetPathHint: ['必须是已存在的目录；默认使用所选工作区路径', 'Must be an existing folder; defaults to the selected workspace path'],
      snapshotBefore: ['导入前自动快照', 'Auto snapshot before import'],
      runImport: ['开始导入', 'Start import'],
      importResult: ['导入结果', 'Import result'],
      importNoResult: ['没有会话被导入', 'No sessions were imported'],
      skipped: ['跳过', 'Skipped'],
      snapshotTaken: ['导入前快照', 'Snapshot'],
      sourceId: ['源 ID', 'Source ID'],
      newId: ['新 ID', 'New ID'],
      needPackage: ['请选择可移植包', 'Choose a portable package'],
      needTarget: ['请选择目标目录', 'Choose a target folder'],

      // recycle bin
      trashHint: [
        '这里只处理两类内容：被移入的会话日志（连同子会话与投影缓存），以及通过 safe_delete 或 shell 删除拦截移入的单个文件/目录。它不会改动项目源码、配置文件或共享附件——彻底删除也只清理条目自身。',
        'This bin holds exactly two things: moved session logs (with subagent children and projection cache), and the individual files/directories captured by safe_delete or the shell-delete guard. It never touches project sources, configuration, or shared attachments — a permanent delete removes only the entry itself.',
      ],
      trashSource: ['来源', 'Source'],
      movedAt: ['移入时间', 'Moved'],
      expiresAt: ['到期', 'Expires'],
      forever: ['永久保留', 'Kept forever'],
      restoreSelected: ['恢复选中', 'Restore selected'],
      purgeSelected: ['彻底删除选中', 'Delete selected permanently'],
      sweep: ['清理过期', 'Sweep expired'],
      swept: ['已清理过期条目', 'Expired entries swept'],
      purgeTitle: ['彻底删除回收站条目', 'Delete recycle bin entries permanently'],
      purgeWarning: [
        '以下内容将从磁盘永久删除，无法通过本插件恢复。',
        'The following will be permanently deleted from disk and cannot be restored by this plugin.',
      ],
      purgeAttachmentsSafe: [
        '仅这些条目的日志与投影缓存会被清理；被其他会话共享的附件不会被删除。',
        'Only these entries’ logs and projection cache are removed; attachments shared with other sessions are never deleted.',
      ],
      purgeAck: ['我已了解这些内容会被永久删除', 'I understand these will be permanently deleted'],
      confirmPurge: ['确认彻底删除', 'Confirm permanent delete'],
      purgedDone: ['已永久删除', 'Permanently deleted'],
      freedBytes: ['释放空间', 'Freed'],
      restoreDone: ['已恢复', 'Restored'],
      trashEmpty: ['回收站是空的', 'The recycle bin is empty'],
      trashEmptyHint: ['从「会话」标签页把不再需要的会话移入这里。', 'Move sessions here from the Sessions tab.'],
      retentionDays: ['保留天数', 'Retention (days)'],
      dueCount: ['到期条目', 'Expired'],
      totalBytes: ['合计', 'Total'],
      sessionEntries: ['会话', 'sessions'],
      filesCount: ['文件', 'files'],

      // snapshots
      snapshotNow: ['立即快照', 'Snapshot now'],
      snapshotLabel: ['标签', 'Label'],
      snapshotLabelPlaceholder: ['例如：改配置前', 'e.g. before changing config'],
      snapshotModules: ['包含模块', 'Modules'],
      modPluginSources: ['插件源码', 'Plugin sources'],
      modSkills: ['技能', 'Skills'],
      modUiPrefs: ['界面偏好', 'UI preferences'],
      modCredentials: ['凭证（风险）', 'Credentials (risky)'],
      credentialsNote: ['凭证会以明文写入快照目录，仅在必要时开启。', 'Credentials are written to the snapshot folder in clear text; enable only when necessary.'],
      snapshotTime: ['时间', 'Time'],
      snapshotKind: ['类型', 'Kind'],
      snapshotSecrets: ['含凭证', 'Secrets'],
      snapshotCreated: ['快照已创建', 'Snapshot created'],
      snapshotDiff: ['查看差异', 'View diff'],
      snapshotRestore: ['恢复', 'Restore'],
      snapshotDelete: ['删除', 'Delete'],
      diffTitle: ['配置差异', 'Configuration diff'],
      diffAdded: ['新增', 'Added'],
      diffRemoved: ['移除', 'Removed'],
      diffChanged: ['变更', 'Changed'],
      diffNoFiles: ['没有文件级差异', 'No file differences'],
      diffCurrentNewer: ['当前配置比快照更新', 'Current configuration is newer than the snapshot'],
      patchShow: ['展开补丁', 'Show patch'],
      patchHide: ['收起补丁', 'Hide patch'],
      diffPlugins: ['插件变更', 'Plugin changes'],
      restoreTitle: ['恢复快照', 'Restore snapshot'],
      restoreBody: [
        '恢复前会自动创建一张“恢复前快照”，本次恢复因此也可以回滚。',
        'A pre-restore snapshot is taken automatically, so this restore can itself be rolled back.',
      ],
      restoreConfirm: ['确认恢复', 'Confirm restore'],
      restoredSnapshot: ['已恢复快照', 'Snapshot restored'],
      preRestoreSnapshot: ['恢复前快照', 'Pre-restore snapshot'],
      restoreFailed: ['恢复失败', 'Restore failed'],
      deleteSnapshotTitle: ['删除快照', 'Delete snapshot'],
      deleteSnapshotBody: ['该快照目录会被删除，删除后不可恢复。', 'This snapshot folder will be deleted permanently.'],
      snapshotDeleted: ['快照已删除', 'Snapshot deleted'],
      snapshotEmpty: ['还没有快照', 'No snapshots yet'],
      snapshotEmptyHint: ['改配置或导入会话之前，先拍一张快照。', 'Take a snapshot before changing configuration or importing sessions.'],
      snapshotRetention: ['快照保留', 'Snapshot retention'],

      // backups
      backupNow: ['立即备份', 'Back up now'],
      openBackupDir: ['打开备份目录', 'Open backup folder'],
      verify: ['校验', 'Verify'],
      verifyOk: ['校验通过', 'Checksum verified'],
      verifyFail: ['校验失败，备份可能已损坏', 'Verification failed — the backup may be damaged'],
      verifyNever: ['未校验', 'Not checked'],
      verified: ['已校验', 'Verified'],
      sha256: ['校验和', 'Checksum'],
      backupKind: ['类型', 'Kind'],
      backupContents: ['内容', 'Contents'],
      rescuePath: ['救援脚本', 'Rescue script'],
      rescueNone: ['本次备份没有生成救援脚本', 'This backup has no rescue script'],
      nextBackup: ['下次自动备份', 'Next automatic backup'],
      lastBackup: ['上次备份', 'Last backup'],
      backupRoot: ['备份目录', 'Backup folder'],
      backupRetention: ['轮换策略', 'Rotation'],
      backupRestore: ['恢复备份', 'Restore backup'],
      backupRestoreTitle: ['从备份恢复', 'Restore from backup'],
      backupRestoreWarning: [
        '恢复会覆盖当前会话与配置数据，并自动创建一张恢复前快照。恢复完成后需要重新扫描。',
        'Restoring overwrites current session and configuration data and takes a pre-restore snapshot. A rescan is required afterwards.',
      ],
      backupRestoreConfirm: ['确认恢复', 'Confirm restore'],
      backupRestored: ['已恢复', 'Restored'],
      rescanRequired: ['需要重新扫描', 'Rescan required'],
      backupEmpty: ['还没有备份', 'No backups yet'],
      backupEmptyHint: ['点击「立即备份」创建第一份备份。', 'Create the first backup with “Back up now”.'],
      backupRunning: ['备份中…', 'Backing up…'],
      backupCreated: ['备份完成', 'Backup complete'],
      backupManual: ['手动', 'Manual'],
      backupScheduled: ['定时', 'Scheduled'],

      // settings
      settingsBackupRoot: ['备份目录', 'Backup folder'],
      settingsBackupRootHint: ['建议使用不含中文与空格的路径', 'Avoid non-ASCII characters and spaces in the path'],
      resolvedRoot: ['实际生效', 'Effective'],
      settingsInterval: ['备份周期', 'Backup interval'],
      intervalOff: ['关闭', 'Off'],
      interval1h: ['1 小时', '1 hour'],
      interval6h: ['6 小时', '6 hours'],
      interval12h: ['12 小时', '12 hours'],
      interval24h: ['24 小时', '24 hours'],
      interval7d: ['7 天', '7 days'],
      intervalCustom: ['自定义 cron', 'Custom cron'],
      cronPlaceholder: ['例如 0 */6 * * *', 'e.g. 0 */6 * * *'],
      settingsFullRetention: ['完整备份保留份数', 'Full backups retained'],
      settingsSnapshotRetention: ['快照保留份数', 'Snapshots retained'],
      settingsTrashRetention: ['回收站保留天数', 'Recycle bin retention (days)'],
      zeroNeverPurge: ['0 表示永不清理', '0 means never purge'],
      settingsInclude: ['备份内容', 'Backup contents'],
      incSessions: ['会话数据', 'Session data'],
      incConfig: ['插件配置', 'Plugin configuration'],
      incAttachments: ['附件', 'Attachments'],
      incCredentials: ['凭证与密钥', 'Credentials and keys'],
      credentialsPrivacy: [
        '开启后备份包内会包含 .credentials.yaml、.env 与 MCP 令牌，请自行妥善保管备份文件。',
        'When enabled, the backup archive contains .credentials.yaml, .env and MCP tokens — protect the archive yourself.',
      ],
      settingsSafety: ['安全网', 'Safety net'],
      safeDelete: ['拦截 shell 删除命令', 'Block shell delete commands'],
      safeDeleteHint: ['拦截 rm / Remove-Item / del / rmdir：能识别的简单命令会把目标移入文件回收站后再拒绝执行，复杂命令直接拒绝。', 'Blocks rm / Remove-Item / del / rmdir. Simple commands have their targets moved into the file recycle bin and are then refused; composed commands are refused outright.'],
      fileTrash: ['启用文件回收站（safe_delete 工具）', 'Enable file recycle bin (safe_delete tool)'],
      fileTrashHint: ['开启后，safe_delete 工具与被拦截的简单 shell 删除都会把文件移入回收站；关闭后文件级删除不会被接管。', 'When on, the safe_delete tool and intercepted simple shell deletes move files into the recycle bin; when off, file-level deletes are not captured.'],
      bypassTitle: ['临时放行 shell 删除', 'Temporary bypass'],
      bypassHint: ['放行期间 shell 删除命令按原样执行，删除的文件不会进入回收站；每次放行都会写入审计日志。', 'While active, shell delete commands run as-is and files do not enter the recycle bin; every bypass is written to the audit log.'],
      bypassIdle: ['当前未放行', 'Not bypassed'],
      bypassActive: ['放行中，截止', 'Active until'],
      bypassEnable: ['临时放行 30 分钟', 'Bypass for 30 minutes'],
      bypassBack: ['立即恢复拦截', 'Restore interception'],
      bypassConfirmTitle: ['临时放行 shell 删除？', 'Bypass shell-delete interception?'],
      bypassConfirmBody: ['接下来的 30 分钟内，rm / Remove-Item 等命令会直接执行，删除的文件不会进入回收站。', 'For the next 30 minutes, rm / Remove-Item run directly and deleted files do not enter the recycle bin.'],
      bypassConfirmAction: ['确认放行', 'Bypass'],
      bypassEnabled: ['已临时放行 30 分钟', 'Bypassed for 30 minutes'],
      bypassDisabled: ['已恢复删除拦截', 'Interception restored'],
      snapshotOnImport: ['导入前自动快照', 'Snapshot before import'],
      settingsSaved: ['设置已保存', 'Settings saved'],
      settingsNoChanges: ['没有需要保存的修改', 'No changes to save'],
      settingsChanged: ['项待保存', 'pending changes'],
      saveChanges: ['保存修改', 'Save changes'],
      useDefaults: ['使用默认值', 'Use defaults'],
      escapeHatch: ['逃生舱', 'Escape hatch'],
      escapeHatchText: [
        '两种临时放行方式：设置页的「临时放行 30 分钟」（到期自动恢复，需确认），或设置环境变量 DSH_GUARDIAN_FORCE_DELETE=1 后重启 DSH（长期生效，需自行移除）。每次放行都会写入审计日志。当前状态：',
        'Two ways to bypass: the “Bypass for 30 minutes” control on this page (auto-expires, confirmed first), or DSH_GUARDIAN_FORCE_DELETE=1 plus a DSH restart (persistent until removed). Every bypass is written to the audit log. Current state:',
      ],
      escapeOn: ['已启用', 'Enabled'],
      escapeOff: ['未启用', 'Not enabled'],
      audit: ['审计日志', 'Audit log'],
      auditHint: ['最近的永久删除与恢复事件。', 'Recent permanent-delete and restore events.'],
      auditEmpty: ['没有审计记录', 'No audit records'],
      auditAt: ['时间', 'Time'],
      auditKind: ['事件', 'Event'],
      auditDetail: ['详情', 'Detail'],
      settingsLoadFailed: ['设置加载失败', 'Failed to load settings'],
    }

    const DICT = { zh: {}, en: {} }
    for (const key of Object.keys(STRINGS)) {
      DICT.zh[key] = STRINGS[key][0]
      DICT.en[key] = STRINGS[key][1]
    }

    /* ==================================================================== *
     * Styles — theme tokens only, own classes prefixed `dg-`
     * ==================================================================== */

    const CSS = `
.dg-root{--dg-radius-sm:var(--dsw-radius-sm,6px);--dg-radius-md:var(--dsw-radius-md,8px);--dg-radius-lg:var(--dsw-radius-lg,12px);--dg-radius-xl:var(--dsw-radius-xl,16px);--dg-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent));display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:400 13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
.dg-root *{box-sizing:border-box;}
.dg-head{display:flex;align-items:flex-start;gap:16px;padding:20px 24px 10px;}
.dg-title{margin:0;font-size:19px;font-weight:500;line-height:26px;letter-spacing:-.01em;}
.dg-sub{margin-top:3px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}
.dg-head-actions{margin-left:auto;display:flex;align-items:center;gap:10px;flex:0 0 auto;}
.dg-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;}
.dg-status.dg-err{color:var(--dsw-alias-state-error-primary);}
.dg-tabs{display:inline-flex;align-self:flex-start;gap:4px;margin:0 24px 6px;padding:4px;border-radius:var(--dg-radius-md);background:var(--dsw-alias-bg-layer-2);}
.dg-tab{height:32px;padding:0 14px;border:.5px solid transparent;border-radius:var(--dg-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap;transition:background-color .12s,color .12s;}
.dg-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dg-hover);}
.dg-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500;}
.dg-body{flex:1;min-height:0;overflow:auto;padding:14px 24px 32px;display:flex;flex-direction:column;gap:16px;}
.dg-body > div{display:flex;flex-direction:column;gap:16px;min-width:0;}
.dg-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;}
.dg-spacer{flex:1 1 auto;}
.dg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap;transition:background-color .12s,border-color .12s,color .12s;}
.dg-btn:hover:not(:disabled){background:var(--dg-hover);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));}
.dg-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,var(--dg-hover));}
.dg-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.dg-btn:disabled{opacity:.45;cursor:default;}
.dg-btn.dg-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}
.dg-btn.dg-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,#000);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,#000);color:var(--dsw-alias-label-primary-foreground,#fff);}
.dg-btn.dg-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary);background:transparent;}
.dg-btn.dg-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}
.dg-btn.dg-danger-solid{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}
.dg-btn.dg-danger-solid:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,#000);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,#000);color:var(--dsw-alias-label-primary-foreground,#fff);}
.dg-btn.dg-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);}
.dg-btn.dg-ghost:hover:not(:disabled){background:var(--dg-hover);color:var(--dsw-alias-label-primary);}
.dg-input,.dg-select{height:36px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:var(--dg-radius-md);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;min-width:0;transition:border-color .12s,box-shadow .12s;}
.dg-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.dg-input:hover:not(:disabled),.dg-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));}
.dg-input:focus,.dg-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-brand-primary);}
.dg-input.dg-grow{flex:1 1 260px;}
.dg-input.dg-inline{height:30px;}
.dg-select{appearance:none;-webkit-appearance:none;padding-right:34px;cursor:pointer;}
.dg-select-wrap{position:relative;display:flex;align-items:center;min-width:0;}
.dg-select-wrap > .dg-select{flex:1 1 auto;width:100%;}
.dg-select-chevron{position:absolute;right:11px;top:50%;transform:translateY(-50%);pointer-events:none;display:inline-flex;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.dg-field{display:flex;flex-direction:column;gap:6px;min-width:0;}
.dg-field > label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dg-field.dg-span2{grid-column:1/-1;}
.dg-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.dg-hint.dg-danger{color:var(--dsw-alias-state-error-primary);}
.dg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px;}
.dg-rowline{display:flex;align-items:center;gap:8px;min-width:0;}
.dg-rowline .dg-input{flex:1 1 auto;}
.dg-inline-gap{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;}
.dg-export-scope{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;}
.dg-totals{display:flex;flex-wrap:wrap;gap:8px 20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dg-totals b{font-weight:600;color:var(--dsw-alias-label-primary);}
.dg-split{display:flex;gap:16px;align-items:flex-start;}
.dg-side{flex:0 0 276px;width:276px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.dg-side-head{padding:12px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border-bottom:.5px solid var(--dsw-alias-border-l2);}
.dg-side-list{max-height:min(58vh,560px);overflow:auto;padding:6px;}
.dg-side-row{display:block;width:100%;text-align:left;border:0;border-radius:var(--dg-radius-md);background:transparent;padding:9px 10px;cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;transition:background-color .12s;}
.dg-side-row:hover{background:var(--dg-hover);}
.dg-side-row[data-active="true"]{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);}
.dg-side-title{display:flex;justify-content:space-between;gap:10px;font-size:13px;line-height:20px;font-weight:500;}
.dg-side-path{margin-top:2px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dg-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));flex:0 0 auto;font-variant-numeric:tabular-nums;}
.dg-main{flex:1 1 auto;min-width:0;}
.dg-panel{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.dg-rowhead{display:flex;align-items:center;gap:12px;height:38px;padding:0 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border-bottom:.5px solid var(--dsw-alias-border-l2);}
.dg-row{display:flex;align-items:center;gap:12px;min-height:52px;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);transition:background-color .12s;}
.dg-row:last-child{border-bottom:0;}
.dg-row:hover{background:var(--dg-hover);}
.dg-cell-title{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;}
.dg-cell-title > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dg-col-num{flex:0 0 76px;width:76px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dg-col-size{flex:0 0 92px;width:92px;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dg-col-time{flex:0 0 110px;width:110px;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dg-col-badges{flex:0 0 132px;width:132px;display:flex;gap:4px;align-items:center;flex-wrap:wrap;}
.dg-actions{display:flex;gap:6px;flex:0 0 220px;width:220px;justify-content:flex-end;opacity:0;transition:opacity .12s;}
.dg-row:hover .dg-actions,.dg-row:focus-within .dg-actions{opacity:1;}
.dg-actions .dg-btn{height:28px;font-size:12px;padding:0 9px;}
.dg-actions-inline{display:flex;gap:6px;justify-content:flex-end;opacity:0;transition:opacity .12s;}
.dg-table tbody tr:hover .dg-actions-inline,.dg-table tbody tr:focus-within .dg-actions-inline{opacity:1;}
.dg-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dg-badge.dg-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);color:var(--dsw-alias-state-success-primary);}
.dg-badge.dg-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent);color:var(--dsw-alias-state-warn-primary);}
.dg-badge.dg-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);color:var(--dsw-alias-state-error-primary);}
.dg-badge.dg-idle{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.dg-tablewrap{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.dg-table{width:100%;border-collapse:collapse;font-size:13px;}
.dg-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1);text-align:left;font-weight:500;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));padding:11px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap;}
.dg-table td{padding:12px 14px;min-height:52px;height:52px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:middle;}
.dg-table tbody tr:last-child td{border-bottom:0;}
.dg-table tbody tr:hover td{background:var(--dg-hover);}
.dg-table .dg-num{text-align:right;font-variant-numeric:tabular-nums;}
.dg-table th.dg-num{text-align:right;}
.dg-table .dg-nowrap{white-space:nowrap;}
.dg-table .dg-btn{height:28px;font-size:12px;padding:0 10px;}
.dg-actions-cell{display:flex;gap:6px;justify-content:flex-end;}
.dg-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12px;}
.dg-strong{font-weight:500;font-size:13px;line-height:20px;}
.dg-dim{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px;}
.dg-snippet{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:560px;}
.dg-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;}
.dg-check input{accent-color:var(--dsw-alias-brand-primary);margin:0;cursor:pointer;width:15px;height:15px;}
.dg-switch{display:flex;align-items:flex-start;gap:12px;padding:6px 0;cursor:pointer;}
.dg-switch > div{flex:1 1 auto;min-width:0;}
.dg-switch input{appearance:none;-webkit-appearance:none;flex:0 0 auto;width:36px;height:20px;margin:1px 0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;transition:background-color .15s,border-color .15s;}
.dg-switch input::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform .15s;}
.dg-switch input:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}
.dg-switch input:checked::after{transform:translateX(16px);}
.dg-radios{display:flex;flex-wrap:wrap;gap:10px 18px;}
.dg-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);}
.dg-modal{width:min(720px,100%);max-height:min(86vh,800px);display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-xl);background:var(--dsw-alias-bg-layer-1);overflow:hidden;box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.22));}
.dg-modal-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.dg-modal-title{margin:0;font-size:15px;line-height:22px;font-weight:500;flex:1 1 auto;}
.dg-modal-body{padding:20px;overflow:auto;display:flex;flex-direction:column;gap:14px;}
.dg-modal-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);}
.dg-banner{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-md);background:var(--dsw-alias-bg-layer-2);font-size:12.5px;line-height:18px;}
.dg-banner > div{flex:1 1 auto;min-width:0;word-break:break-word;}
.dg-banner.dg-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);}
.dg-banner.dg-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);color:var(--dsw-alias-state-success-primary);}
.dg-banner.dg-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);color:var(--dsw-alias-state-warn-primary);}
.dg-banner.dg-info{color:var(--dsw-alias-label-secondary);}
.dg-empty{padding:44px 20px;text-align:center;}
.dg-empty-title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);}
.dg-empty-hint{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
.dg-kv{display:flex;justify-content:space-between;gap:14px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);}
.dg-kv b{font-weight:500;color:var(--dsw-alias-label-primary);}
.dg-code{padding:2px 6px;border-radius:var(--dg-radius-sm);background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Consolas,monospace;font-size:12px;}
.dg-pre{margin:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-md);background:var(--dsw-alias-bg-layer-2);overflow:auto;max-height:320px;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre;color:var(--dsw-alias-label-secondary);}
.dg-section{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:18px 20px;margin:0;}
.dg-section-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;}
.dg-section-title{margin:0;font-size:14px;line-height:22px;font-weight:500;flex:1 1 auto;}
.dg-plainlist{display:flex;flex-direction:column;gap:8px;}
.dg-listitem{padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-md);}
.dg-browser-list{max-height:min(46vh,380px);overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dg-radius-md);}
.dg-browser-row{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 12px;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer;}
.dg-browser-row:last-child{border-bottom:0;}
.dg-browser-row:hover{background:var(--dg-hover);}
.dg-browser-row > span:first-child{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dg-audit-row{display:grid;grid-template-columns:150px 140px minmax(0,1fr);gap:12px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;}
.dg-audit-row:last-child{border-bottom:0;}
.dg-collapse{display:flex;align-items:center;gap:8px;width:100%;padding:10px 0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;text-align:left;}
.dg-bypass-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px;margin-top:16px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l2);}
`


    /* ==================================================================== *
     * Shared UI atoms
     * ==================================================================== */

    function Button({ variant, disabled, onClick, title, children }) {
      const off = disabled === true
      return h('button', { type: 'button', className: cx('dg-btn', variant && `dg-${variant}`), disabled: off, title, onClick: off ? undefined : onClick }, children)
    }

    /** Controlled text input; `onChange` receives the raw string. */
    function Input({ value, onChange, placeholder, grow, inline, ariaLabel, onKeyDown, type, min, autoFocus }) {
      return h('input', {
        type: type || 'text', min, autoFocus: autoFocus === true,
        className: cx('dg-input', grow && 'dg-grow', inline && 'dg-inline'),
        value: value ?? '', placeholder, 'aria-label': ariaLabel,
        onChange: (event) => onChange(event.target.value), onKeyDown,
      })
    }

    function Field({ label, hint, danger, span2, children }) {
      return h('div', { className: cx('dg-field', span2 && 'dg-span2') },
        label ? h('label', null, label) : null, children,
        hint ? h('div', { className: 'dg-hint' }, hint) : null,
        danger ? h('div', { className: 'dg-hint dg-danger' }, danger) : null)
    }

    /** Label + path input + browse button, used by export/import/settings. */
    function PathField({ t, label, value, onChange, onBrowse, placeholder, hint, span2 }) {
      return h(Field, { label, hint, span2 }, h('div', { className: 'dg-rowline' },
        h(Input, { value, onChange, placeholder }),
        h(Button, { onClick: onBrowse }, t('browse'))))
    }

    function NumField({ label, hint, value, onChange, min }) {
      return h(Field, { label, hint }, h(Input, { type: 'number', min, value, onChange: (text) => onChange(Number(text)) }))
    }

    function SelectField({ label, hint, value, onChange, options }) {
      return h(Field, { label, hint }, h('div', { className: 'dg-select-wrap' },
        h('select', { className: 'dg-select', value, onChange: (event) => onChange(event.target.value) },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        h('span', { className: 'dg-select-chevron', 'aria-hidden': true },
          h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('path', { d: 'M4 6.5 8 10.5 12 6.5' })))))
    }

    function Checkbox({ checked, onChange, label, title }) {
      return h('label', { className: 'dg-check', title },
        h('input', { type: 'checkbox', checked: checked === true, onChange: (event) => onChange(event.target.checked) }),
        h('span', null, label))
    }

    function Switch({ checked, onChange, label, hint, danger }) {
      return h('label', { className: 'dg-switch' },
        h('input', { type: 'checkbox', checked: checked === true, onChange: (event) => onChange(event.target.checked) }),
        h('div', null, h('div', null, label), hint ? h('div', { className: 'dg-hint' }, hint) : null,
          danger ? h('div', { className: 'dg-hint dg-danger' }, danger) : null))
    }

    function Badge({ kind, children }) {
      return h('span', { className: cx('dg-badge', kind && `dg-${kind}`) }, children)
    }

    function Banner({ kind, children, onDismiss }) {
      return h('div', { className: cx('dg-banner', kind || 'info') }, h('div', null, children),
        onDismiss ? h(Button, { variant: 'ghost', onClick: onDismiss }, '✕') : null)
    }

    function EmptyState({ title, hint, action }) {
      return h('div', { className: 'dg-empty' }, h('div', { className: 'dg-empty-title' }, title),
        hint ? h('div', { className: 'dg-empty-hint' }, hint) : null,
        action ? h('div', { style: { marginTop: '14px' } }, action) : null)
    }

    function Loading({ label }) {
      return h(EmptyState, { title: label })
    }

    /** `headers` is an array of `[label, width?, align?]`; `children` holds the `<tr>` rows. */
    function Table({ headers, children, empty, emptyHint }) {
      const rows = (Array.isArray(children) ? children : children ? [children] : []).filter(Boolean)
      if (rows.length === 0) return h(EmptyState, { title: empty || '', hint: emptyHint })
      return h('div', { className: 'dg-tablewrap' }, h('table', { className: 'dg-table' },
        h('thead', null, h('tr', null, headers.map((column, index) => h('th', {
          key: index,
          className: column[2] === 'right' ? 'dg-num' : undefined,
          style: column[1] ? { width: column[1] } : undefined,
        }, column[0])))),
        h('tbody', null, rows)))
    }

    function Section({ title, extra, children }) {
      return h('div', { className: 'dg-section' },
        h('div', { className: 'dg-section-head' }, h('h4', { className: 'dg-section-title' }, title),
          extra ? h('span', { className: 'dg-hint' }, extra) : null),
        children)
    }

    function KV({ label, value }) {
      return h('div', { className: 'dg-kv' }, h('span', null, label), h('b', null, value))
    }

    function Modal({ title, onClose, children, footer }) {
      useEffect(() => {
        function onKeyDown(event) {
          if (event.key === 'Escape' || event.key === 'Esc') onClose()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])
      return h('div', { className: 'dg-mask', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'dg-modal', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'dg-modal-head' }, h('h3', { className: 'dg-modal-title' }, title),
            h(Button, { variant: 'ghost', onClick: onClose, title: 'Esc' }, '✕')),
          h('div', { className: 'dg-modal-body' }, children),
          footer ? h('div', { className: 'dg-modal-foot' }, footer) : null))
    }

    function Confirm({ title, text, children, confirmLabel, cancelLabel, destructive, busy, onConfirm, onClose }) {
      return h(Modal, {
        title, onClose,
        footer: [h(Button, { key: 'no', variant: 'ghost', onClick: onClose }, cancelLabel),
          h(Button, { key: 'yes', variant: destructive ? 'danger-solid' : 'primary', disabled: busy === true, onClick: onConfirm }, confirmLabel)],
      },
        text ? h(Banner, { kind: destructive ? 'error' : 'info' }, text) : null,
        children || null)
    }

    /** Render errors inside a tab must not take the whole slot down. */
    class BodyBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h('div', null,
            h(Banner, { kind: 'error' }, `${this.props.t('errorTitle')}: ${errText(this.state.error)}`),
            h(Button, { onClick: () => this.setState({ error: null }) }, this.props.t('retry')))
        }
        return this.props.children
      }
    }

    /* ==================================================================== *
     * Hooks — one request shape per tab, one action shape for mutations
     * ==================================================================== */

    /**
     * `useRequest(ctx, endpoint | loader, args, deps, { enabled })`
     * → `{ status: idle|loading|ok|error, data, error, at, reload(overrideArgs) }`
     */
    function useRequest(ctx, method, args, deps, options) {
      const enabled = !(options && options.enabled === false)
      const argsRef = useRef(args)
      argsRef.current = args
      const callRef = useRef(null)
      callRef.current = typeof method === 'function' ? method : (payload) => callHost(ctx, method, payload)
      const [state, setState] = useState({ status: enabled ? 'loading' : 'idle', data: undefined, error: null, at: 0 })
      const seq = useRef(0)
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false }, [])

      const reload = useCallback(async (override) => {
        const ticket = (seq.current += 1)
        setState((prev) => ({ status: 'loading', data: prev.data, error: null, at: prev.at }))
        try {
          const data = await callRef.current(override !== undefined ? override : argsRef.current)
          if (mounted.current && seq.current === ticket) setState({ status: 'ok', data, error: null, at: Date.now() })
          return data
        } catch (error) {
          if (mounted.current && seq.current === ticket) setState({ status: 'error', data: undefined, error, at: Date.now() })
          return undefined
        }
      }, [])

      useEffect(() => {
        if (!enabled) {
          setState((prev) => (prev.status === 'idle' ? prev : { status: 'idle', data: undefined, error: null, at: 0 }))
          return
        }
        reload()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [enabled, reload].concat(Array.isArray(deps) ? deps : []))

      return { status: state.status, data: state.data, error: state.error, at: state.at, reload }
    }

    /** Mutation helper: `{ busy, error, notice, setError, setNotice, run(fn, okText) }`. */
    function useAction() {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const run = useCallback(async (work, okText) => {
        setBusy(true)
        setError(null)
        try {
          const value = await work()
          if (okText !== undefined && okText !== null) setNotice(typeof okText === 'function' ? okText(value) : okText)
          return value
        } catch (cause) {
          setError(cause)
          return undefined
        } finally {
          setBusy(false)
        }
      }, [])
      return { busy, error, notice, setError, setNotice, run }
    }

    /** Push a request's loading/error/last-refresh state into the panel's status line. */
    function useReportStatus(onStatus, req) {
      useEffect(() => {
        onStatus({ status: req.error ? 'error' : req.status, at: req.at || 0, error: req.error || null })
      }, [onStatus, req.error, req.status, req.at])
    }

    /* ==================================================================== *
     * uiWorkspace bridges — an absent service degrades to an inline banner
     * ==================================================================== */

    function pathOf(value) {
      if (!value) return null
      if (typeof value === 'string') return value
      if (typeof value === 'object') {
        if (typeof value.path === 'string') return value.path
        if (typeof value.directory === 'string') return value.directory
        if (typeof value.dir === 'string') return value.dir
        if (Array.isArray(value.paths) && typeof value.paths[0] === 'string') return value.paths[0]
      }
      return null
    }

    function canPickDirectory(ctx) {
      const workspace = service(ctx, 'uiWorkspace')
      return Boolean(workspace && typeof workspace.pickDirectory === 'function')
    }

    async function pickDirectory(ctx) {
      const workspace = service(ctx, 'uiWorkspace')
      if (!workspace || typeof workspace.pickDirectory !== 'function') return null
      return pathOf(await workspace.pickDirectory())
    }

    /** Normalize `uiWorkspace.listDirectory` / `fs.list` into `{ path, parent, dirs, files }`. */
    function normalizeListing(raw) {
      const listing = { path: '', parent: null, dirs: [], files: [] }
      if (!raw || typeof raw !== 'object') return listing
      listing.path = typeof raw.path === 'string' ? raw.path : ''
      if (typeof raw.parent === 'string' || raw.parent === null) listing.parent = raw.parent
      const push = (entry, asDir) => {
        const path = typeof entry === 'string' ? entry : entry?.path || entry?.name
        if (!path) return
        const name = (typeof entry === 'string' ? '' : entry?.name) || nameOfPath(path)
        if (asDir) listing.dirs.push({ name, path })
        else listing.files.push({ name, path, bytes: Number(entry?.bytes) || 0 })
      }
      for (const entry of listOf(raw.dirs)) push(entry, true)
      for (const entry of listOf(raw.files)) push(entry, false)
      for (const entry of listOf(raw.entries)) {
        if (!entry) continue
        const isDir = entry.kind === 'directory' || entry.kind === 'dir' || entry.isDirectory === true || entry.type === 'directory'
        push(entry, isDir)
      }
      return listing
    }

    async function listDirectory(ctx, path) {
      const start = path || undefined
      const workspace = service(ctx, 'uiWorkspace')
      if (workspace && typeof workspace.listDirectory === 'function') {
        try {
          return normalizeListing(await workspace.listDirectory(start))
        } catch (error) {
          /* fall back to the Host file system endpoint */
        }
      }
      return normalizeListing(await callHost(ctx, 'fs.list', start ? { path: start } : {}))
    }

    /** Directory / file picker modal backed by `uiWorkspace.listDirectory`, `fs.list` fallback. */
    function FileBrowser({ ctx, t, mode, startPath, onPick, onClose }) {
      const [path, setPath] = useState(startPath || '')
      const [typed, setTyped] = useState(startPath || '')
      const [nonce, setNonce] = useState(0)
      const req = useRequest(ctx, (payload) => listDirectory(ctx, payload.path), { path }, [path, nonce])
      const listing = normalizeListing(req.data)

      useEffect(() => { setTyped(path) }, [path])

      const rows = [
        ...listing.dirs.map((entry) => h('button', {
          key: `d:${entry.path}`, type: 'button', className: 'dg-browser-row', onClick: () => setPath(entry.path),
        }, h('span', null, `▸ ${entry.name}`), h('span', { className: 'dg-dim' }, ''))),
        ...listing.files.map((entry) => h('button', {
          key: `f:${entry.path}`, type: 'button', className: 'dg-browser-row', title: entry.path, onClick: () => onPick(entry.path),
        }, h('span', null, `· ${entry.name}`), h('span', { className: 'dg-dim' }, fmtBytes(entry.bytes)))),
      ]

      return h(Modal, {
        title: mode === 'file' ? t('chooseFile') : t('chooseDir'), onClose,
        footer: [h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, t('cancel')),
          mode === 'dir' ? h(Button, { key: 'pick', variant: 'primary', onClick: () => onPick(path), disabled: path === '' }, t('chooseDir')) : null],
      },
        h('div', { className: 'dg-rowline' },
          h(Button, { onClick: () => setPath(listing.parent || path), disabled: !listing.parent }, t('parentDir')),
          h(Input, { value: typed, onChange: setTyped, placeholder: t('goPlaceholder'), onKeyDown: (event) => { if (event.key === 'Enter') setPath(typed.trim()) } }),
          h(Button, { onClick: () => setPath(typed.trim()) }, t('go')),
          h(Button, { onClick: () => setNonce(nonce + 1) }, t('refresh'))),
        req.status === 'error' ? h(Banner, { kind: 'error' }, errText(req.error)) : null,
        req.status === 'loading' && !req.data ? h(Loading, { label: t('loading') }) : null,
        req.data ? (rows.length === 0 ? h(EmptyState, { title: t('emptyDir') }) : h('div', { className: 'dg-browser-list' }, rows)) : null)
    }

    /* ==================================================================== *
     * Tab 1 — sessions
     * ==================================================================== */

    function SessionsTab({ ctx, t, nonce, onStatus }) {
      const [query, setQuery] = useState('')
      const [debounced, setDebounced] = useState('')
      const [workspaceId, setWorkspaceId] = useState('')
      const [selectedIds, setSelectedIds] = useState([])
      const [renaming, setRenaming] = useState(null)
      const [trashing, setTrashing] = useState(null)
      const [dialog, setDialog] = useState(null)
      const action = useAction()

      useEffect(() => {
        const timer = setTimeout(() => setDebounced(query.trim()), 350)
        return () => clearTimeout(timer)
      }, [query])

      const list = useRequest(ctx, 'sessions.list', {}, [nonce])
      const searching = debounced.length > 0
      const search = useRequest(ctx, 'sessions.search', { query: debounced, limit: 100 }, [debounced, nonce], { enabled: searching })
      useReportStatus(onStatus, searching ? search : list)

      const data = list.data || {}
      const workspaces = listOf(data.workspaces)
      const sessions = listOf(data.sessions)
      const totals = data.totals || {}
      const activeWorkspace = workspaces.find((entry) => entry.id === workspaceId) || null
      const visible = useMemo(() => {
        const filtered = workspaceId ? sessions.filter((entry) => entry.workspaceId === workspaceId) : sessions
        return filtered.slice().sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      }, [sessions, workspaceId])
      const searchData = search.data || {}
      const hits = listOf(searchData.items)
      const busy = list.status === 'loading' || (searching && search.status === 'loading')

      const toggleSelected = (id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : prev.concat(id)))

      function openSession(id) {
        const workspace = service(ctx, 'uiWorkspace')
        if (!workspace || typeof workspace.openSession !== 'function') {
          action.setError(new Error(t('openError')))
          return
        }
        try {
          const result = workspace.openSession({ kind: 'session', sessionId: id })
          if (result && typeof result.catch === 'function') result.catch((error) => action.setError(error))
        } catch (error) {
          action.setError(error)
        }
      }

      async function submitRename(session) {
        const title = (renaming && renaming.id === session.id ? renaming.value : '').trim()
        setRenaming(null)
        if (title === '') return
        await action.run(async () => {
          await callHost(ctx, 'sessions.rename', { sessionId: session.id, title })
          await list.reload()
        }, t('renamed'))
      }

      async function toggleArchive(session) {
        const archived = !session.archived
        await action.run(async () => {
          await callHost(ctx, 'sessions.archive', { sessionId: session.id, archived })
          await list.reload()
        }, archived ? t('archivedMsg') : t('unarchivedMsg'))
      }

      async function confirmTrash() {
        const session = trashing
        setTrashing(null)
        if (!session) return
        await action.run(async () => {
          await callHost(ctx, 'sessions.trash', { sessionIds: [session.id] })
          await list.reload()
        }, t('movedToTrash'))
      }

      const badges = (session) => [
        session.isSubagent ? h(Badge, { key: 'sub', kind: 'idle' }, t('badgeSubagent')) : null,
        session.archived ? h(Badge, { key: 'arc', kind: 'warn' }, t('badgeArchived')) : null,
        session.live ? h(Badge, { key: 'live', kind: 'ok' }, t('badgeLive')) : null,
        session.inTrash ? h(Badge, { key: 'tr', kind: 'danger' }, t('badgeTrash')) : null,
      ]

      const rowActions = (session) => {
        if (renaming && renaming.id === session.id) {
          return [
            h(Button, { key: 'save', variant: 'primary', onClick: () => submitRename(session) }, t('save')),
            h(Button, { key: 'cancel', variant: 'ghost', onClick: () => setRenaming(null) }, t('cancel')),
          ]
        }
        return [
          h(Button, { key: 'open', onClick: () => openSession(session.id) }, t('open')),
          h(Button, { key: 'rename', onClick: () => setRenaming({ id: session.id, value: session.title || '' }) }, t('rename')),
          h(Button, { key: 'archive', onClick: () => toggleArchive(session) }, session.archived ? t('unarchive') : t('archive')),
          h(Button, { key: 'trash', variant: 'danger', onClick: () => setTrashing(session) }, t('trash')),
        ]
      }

      const row = (session) => h('tr', { key: session.id, title: session.cwd || undefined },
        h('td', null,
          h('div', { className: 'dg-cell-title' },
            h(Checkbox, { checked: selectedIds.includes(session.id), onChange: () => toggleSelected(session.id), label: '' }),
            renaming && renaming.id === session.id
              ? h(Input, {
                  value: renaming.value, inline: true, autoFocus: true, placeholder: t('renamePlaceholder'),
                  onChange: (text) => setRenaming({ id: session.id, value: text }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitRename(session)
                    if (event.key === 'Escape') setRenaming(null)
                  },
                })
              : h('span', { className: 'dg-strong' }, session.title || t('untitled'))),
          h('div', { className: 'dg-dim dg-mono' }, session.id)),
        h('td', null, h('div', { className: 'dg-col-badges' }, badges(session))),
        h('td', { className: 'dg-num' }, fmtNum(session.messageCount)),
        h('td', { className: 'dg-num' }, fmtBytes(session.sizeBytes)),
        h('td', { className: 'dg-nowrap' }, fmtRel(session.updatedAt, t)),
        h('td', null, h('div', { className: 'dg-actions-inline' }, rowActions(session))))

      const hitRow = (hit) => h('tr', { key: hit.id, title: hit.snippet || undefined },
        h('td', null, h('div', { className: 'dg-strong' }, hit.title || t('untitled'))),
        h('td', null, h('div', { className: 'dg-snippet' }, hit.snippet || '')),
        h('td', { className: 'dg-nowrap' }, fmtRel(hit.time, t)),
        h('td', null, h('div', { className: 'dg-actions-cell' }, h(Button, { onClick: () => openSession(hit.id) }, t('open')))))

      const sideList = h('div', { className: 'dg-side' }, h('div', { className: 'dg-side-head' }, t('workspaces')),
        h('div', { className: 'dg-side-list' },
          h('button', { type: 'button', className: 'dg-side-row', 'data-active': workspaceId === '' ? 'true' : undefined, onClick: () => setWorkspaceId('') },
            h('div', { className: 'dg-side-title' }, h('span', null, t('allSessions')), h('span', { className: 'dg-count' }, fmtNum(sessions.length))),
            h('div', { className: 'dg-side-path' }, '—')),
          workspaces.map((workspace) => h('button', {
            key: workspace.id, type: 'button', className: 'dg-side-row', title: workspace.path || undefined,
            'data-active': workspaceId === workspace.id ? 'true' : undefined, onClick: () => setWorkspaceId(workspace.id),
          },
            h('div', { className: 'dg-side-title' }, h('span', null, workspace.title || t('untitled')),
              h('span', { className: 'dg-count' }, fmtNum(sessions.filter((entry) => entry.workspaceId === workspace.id).length))),
            h('div', { className: 'dg-side-path' }, workspace.path || '—')))))

      const sessionList = list.status === 'error'
        ? h(Banner, { kind: 'error' }, errText(list.error))
        : !list.data
          ? h(Loading, { label: t('loading') })
          : h(Table, {
            headers: [
              [t('title')],
              [t('status'), '140px'],
              [t('messages'), '92px', 'right'],
              [t('size'), '100px', 'right'],
              [t('lastActivity'), '120px'],
              ['', '230px'],
            ],
            empty: t('noSessions'), emptyHint: t('noSessionsHint'),
            children: visible.map(row),
          })

      const searchResults = h('div', null,
        search.status === 'error' ? h(Banner, { kind: 'error' }, errText(search.error)) : null,
        search.status === 'loading' && !search.data ? h(Loading, { label: t('loading') }) : null,
        search.data
          ? h('div', null,
            h('div', { className: 'dg-totals' },
              h('span', null, `${t('searchScanned')}: `, h('b', null, fmtNum(searchData.scanned))),
              h('span', null, `${t('title')}: `, h('b', null, fmtNum(hits.length))),
              searchData.truncated ? h(Badge, { kind: 'warn' }, t('searchTruncated')) : null),
            h(Table, {
              headers: [[t('title'), '40%'], [t('snippet')], [t('lastActivity'), '110px'], ['', '80px']],
              empty: t('empty'), emptyHint: t('emptyHint'), children: hits.map(hitRow),
            }))
          : null)

      return h('div', null,
        h('div', { className: 'dg-toolbar' },
          h(Input, { value: query, onChange: setQuery, placeholder: t('searchPlaceholder'), ariaLabel: t('search'), grow: true }),
          searching ? h(Button, { variant: 'ghost', onClick: () => setQuery('') }, t('clearSearch')) : null,
          h('div', { className: 'dg-spacer' }),
          h(Button, { onClick: () => setDialog('export') }, t('export')),
          h(Button, { onClick: () => setDialog('import') }, t('import')),
          h(Button, { onClick: () => list.reload(), disabled: busy }, t('refresh'))),
        h('div', { className: 'dg-totals' },
          h('span', null, `${t('sessionCount')}: `, h('b', null, fmtNum(totals.sessions))),
          h('span', null, `${t('subagentCount')}: `, h('b', null, fmtNum(totals.subagents))),
          h('span', null, `${t('diskUsage')}: `, h('b', null, fmtBytes(totals.bytes))),
          selectedIds.length > 0 ? h('span', null, `${t('selectedCount')}: `, h('b', null, fmtNum(selectedIds.length))) : null),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null,
        searching ? searchResults : h('div', { className: 'dg-split' }, sideList, h('div', { className: 'dg-main' }, sessionList)),
        trashing ? h(Confirm, {
          title: t('trashConfirmTitle'), text: t('trashConfirmBody'), confirmLabel: t('trash'), cancelLabel: t('cancel'),
          busy: action.busy, onConfirm: confirmTrash, onClose: () => setTrashing(null),
          children: h('div', { className: 'dg-strong' }, trashing.title || t('untitled')),
        }) : null,
        dialog === 'export' ? h(ExportDialog, {
          ctx, t, sessions, activeWorkspace, selectedIds, onClose: () => setDialog(null),
        }) : null,
        dialog === 'import' ? h(ImportDialog, {
          ctx, t, activeWorkspace, onClose: () => setDialog(null),
          onImported: () => { list.reload() },
        }) : null)
    }

    /* ---- export dialog ---- */

    function ExportDialog({ ctx, t, sessions, activeWorkspace, selectedIds, onClose }) {
      const [scope, setScope] = useState(activeWorkspace ? 'workspace' : 'all')
      const [outDir, setOutDir] = useState(MEMORY.exportDir || '')
      const [fileName, setFileName] = useState('')
      const [includeAttachments, setIncludeAttachments] = useState(true)
      const [browsing, setBrowsing] = useState(false)
      const [result, setResult] = useState(null)
      const action = useAction()

      async function browse() {
        if (!canPickDirectory(ctx)) { setBrowsing(true); return }
        try {
          const picked = await pickDirectory(ctx)
          if (picked) { setOutDir(picked); MEMORY.exportDir = picked }
        } catch (error) { action.setError(error) }
      }

      async function submit() {
        const dir = outDir.trim()
        if (dir === '') { action.setError(new Error(t('needOutDir'))); return }
        const payload = { scope, outDir: dir, includeAttachments }
        if (fileName.trim() !== '') payload.fileName = fileName.trim()
        if (scope === 'workspace') {
          if (!activeWorkspace) { action.setError(new Error(t('needWorkspace'))); return }
          payload.workspaceId = activeWorkspace.id
        } else if (scope === 'selected') {
          if (selectedIds.length === 0) { action.setError(new Error(t('needSelection'))); return }
          payload.scope = 'sessions'
          payload.sessionIds = selectedIds.slice()
        } else {
          payload.scope = 'sessions'
          payload.sessionIds = sessions.map((entry) => entry.id)
        }
        const value = await action.run(() => callHost(ctx, 'export.run', payload), null)
        if (value) { setResult(value); MEMORY.exportDir = dir }
      }

      const radio = (value, label) => h('label', { className: 'dg-check' },
        h('input', { type: 'radio', name: 'dg-export-scope', checked: scope === value, onChange: () => setScope(value) }),
        h('span', null, label))

      return h(Modal, {
        title: t('exportTitle'), onClose,
        footer: [h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, t('cancel')),
          h(Button, { key: 'run', variant: 'primary', disabled: action.busy, onClick: submit }, t('runExport'))],
      },
        h('div', { className: 'dg-radios' },
          radio('workspace', `${t('scopeWorkspace')}${activeWorkspace ? ` · ${activeWorkspace.title}` : ''}`),
          radio('selected', `${t('scopeSelected')} (${selectedIds.length})`),
          radio('all', `${t('scopeAll')} (${sessions.length})`)),
        h(PathField, {
          t, label: t('outDir'), value: outDir, onChange: setOutDir, onBrowse: browse,
          placeholder: 'D:\\dsh-exports',
        }),
        h(Field, { label: t('fileName'), hint: t('fileNameHint') },
          h(Input, { value: fileName, onChange: setFileName })),
        h(Checkbox, { checked: includeAttachments, onChange: setIncludeAttachments, label: t('includeAttachments') }),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        result ? h(Banner, { kind: 'ok' },
          h('div', null, t('exportDone')),
          h('div', null, `${t('exportPath')}: ${result.path || '—'}`),
          h('div', null, `${t('size')}: ${fmtBytes(result.bytes)} · ${t('sessionCount')}: ${fmtNum(result.sessions)} · ${t('attachments')}: ${fmtNum(result.attachments)}`)) : null,
        browsing ? h(FileBrowser, {
          ctx, t, mode: 'dir', startPath: outDir,
          onPick: (picked) => { setOutDir(picked); MEMORY.exportDir = picked; setBrowsing(false) },
          onClose: () => setBrowsing(false),
        }) : null)
    }

    /* ---- import dialog ---- */

    function ImportDialog({ ctx, t, activeWorkspace, onClose, onImported }) {
      const [filePath, setFilePath] = useState(MEMORY.importFile || '')
      const [targetPath, setTargetPath] = useState(MEMORY.importTarget || (activeWorkspace ? activeWorkspace.path : '') || '')
      const [snapshot, setSnapshot] = useState(true)
      const [inspectResult, setInspectResult] = useState(null)
      const [runResult, setRunResult] = useState(null)
      const [browsing, setBrowsing] = useState(null)
      const action = useAction()

      async function inspect() {
        if (filePath.trim() === '') { action.setError(new Error(t('needPackage'))); return }
        setRunResult(null)
        const value = await action.run(() => callHost(ctx, 'import.inspect', { filePath: filePath.trim() }), null)
        if (value) { setInspectResult(value); MEMORY.importFile = filePath.trim() }
      }

      async function submit() {
        if (filePath.trim() === '') { action.setError(new Error(t('needPackage'))); return }
        if (targetPath.trim() === '') { action.setError(new Error(t('needTarget'))); return }
        const value = await action.run(
          () => callHost(ctx, 'import.run', { filePath: filePath.trim(), targetPath: targetPath.trim(), snapshot }), null)
        if (value) {
          setRunResult(value)
          MEMORY.importTarget = targetPath.trim()
          if (typeof onImported === 'function') onImported()
        }
      }

      const inspected = inspectResult || {}
      const imported = listOf(runResult && runResult.imported)

      return h(Modal, {
        title: t('importTitle'), onClose,
        footer: [h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, t('cancel')),
          h(Button, { key: 'inspect', disabled: action.busy, onClick: inspect }, t('inspect')),
          h(Button, { key: 'run', variant: 'primary', disabled: action.busy, onClick: submit }, t('runImport'))],
      },
        h(PathField, {
          t, label: t('packagePath'), value: filePath, onChange: setFilePath,
          onBrowse: () => setBrowsing('file'), placeholder: 'D:\\dsh-exports\\session.tar.gz',
        }),
        inspectResult ? h(Section, {
          title: t('inspect'),
          extra: h(Badge, { kind: inspected.compatible ? 'ok' : 'danger' },
            inspected.compatible ? t('importCompatible') : t('importIncompatible')),
        },
          h(KV, { label: t('importVersion'), value: inspected.dshVersion || '—' }),
          h(KV, { label: t('importSessions'), value: fmtNum(listOf(inspected.sessions).length) }),
          h(KV, { label: t('attachments'), value: fmtNum(inspected.attachments) }),
          listOf(inspected.warnings).length > 0
            ? h(Banner, { kind: 'warn' }, h('div', null, t('importWarnings')),
              listOf(inspected.warnings).map((warning, index) => h('div', { key: index }, `· ${warning}`)))
            : null,
          h('div', { className: 'dg-plainlist' }, listOf(inspected.sessions).map((entry, index) =>
            h('div', { key: index, className: 'dg-listitem' },
              h('div', { className: 'dg-strong' }, entry.title || entry.id),
              h('div', { className: 'dg-dim' }, `${t('messages')}: ${fmtNum(entry.messageCount)} · ${t('attachments')}: ${fmtNum(entry.attachmentCount)}`)))))
          : null,
        h(PathField, {
          t, label: t('targetPath'), hint: t('targetPathHint'), value: targetPath, onChange: setTargetPath,
          onBrowse: () => setBrowsing('dir'),
        }),
        h(Checkbox, { checked: snapshot, onChange: setSnapshot, label: t('snapshotBefore') }),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        runResult ? h(Section, { title: t('importResult') },
          runResult.snapshotId ? h('div', { className: 'dg-dim' }, `${t('snapshotTaken')}: ${runResult.snapshotId}`) : null,
          imported.length === 0 ? h(EmptyState, { title: t('importNoResult') }) : h(Table, {
            headers: [[t('sourceId')], [t('newId')], [t('title')]],
            children: imported.map((entry) => h('tr', { key: `${entry.sourceId}:${entry.newId}` },
              h('td', { className: 'dg-mono' }, entry.sourceId || '—'),
              h('td', { className: 'dg-mono' }, entry.newId || '—'),
              h('td', null, entry.title || '—'))),
          }),
          listOf(runResult.skipped).length > 0
            ? h(Banner, { kind: 'warn' }, h('div', null, t('skipped')),
              listOf(runResult.skipped).map((entry, index) => h('div', { key: index }, `· ${entry}`)))
            : null)
          : null,
        browsing ? h(FileBrowser, {
          ctx, t, mode: browsing, startPath: browsing === 'file' ? filePath : targetPath,
          onPick: (picked) => {
            if (browsing === 'file') { setFilePath(picked); MEMORY.importFile = picked }
            else { setTargetPath(picked); MEMORY.importTarget = picked }
            setBrowsing(null)
          },
          onClose: () => setBrowsing(null),
        }) : null)
    }

    /* ==================================================================== *
     * Tab 2 — recycle bin
     * ==================================================================== */

    const sourceLabel = (source, t) =>
      source === 'safe-delete' ? t('sourceSafeDelete')
        : source === 'import-guard' ? t('sourceImportGuard')
          : source === 'manual' ? t('sourceManual') : t('sourcePanel')

    function TrashTab({ ctx, t, nonce, onStatus }) {
      const list = useRequest(ctx, 'trash.list', {}, [nonce])
      const [checked, setChecked] = useState([])
      const [purging, setPurging] = useState(null)
      const action = useAction()
      useReportStatus(onStatus, list)

      const data = list.data || {}
      const items = listOf(data.items)
      const allChecked = items.length > 0 && checked.length === items.length
      const toggle = (id) => setChecked((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : prev.concat(id)))

      async function restoreSelected() {
        if (checked.length === 0) return
        const result = await action.run(async () => {
          const value = await callHost(ctx, 'trash.restore', { ids: checked.slice() })
          setChecked([])
          await list.reload()
          return value
        }, t('restoreDone'))
        const failed = listOf(result && result.failed)
        if (failed.length > 0) {
          action.setNotice(null)
          action.setError(new Error(`${t('restoreFailed')}: ${failed.map((entry) => entry.reason).join('; ')}`))
        }
      }

      async function sweep() {
        await action.run(async () => {
          const value = await callHost(ctx, 'trash.sweep', {})
          await list.reload()
          return value
        }, (value) => `${t('swept')}: ${fmtNum(listOf(value && value.purged).length)}`)
      }

      const rows = items.map((entry) => h('tr', { key: entry.id },
        h('td', { style: { width: '28px' } },
          h('input', {
            type: 'checkbox', checked: checked.includes(entry.id), onChange: () => toggle(entry.id),
            'aria-label': entry.id, style: { accentColor: 'var(--dsw-alias-brand-primary)' },
          })),
        h('td', null,
          h('div', { className: 'dg-strong' }, listOf(entry.titles).filter(Boolean).join(' / ') || t('untitled')),
          h('div', { className: 'dg-dim' },
            `${t('sessionEntries')}: ${fmtNum(listOf(entry.sessionIds).length)} · ${listOf(entry.originalPaths).join(' ; ') || '—'}`)),
        h('td', { className: 'dg-nowrap' }, sourceLabel(entry.source, t)),
        h('td', { className: 'dg-num' }, fmtBytes(entry.sizeBytes)),
        h('td', { className: 'dg-nowrap' }, fmtTime(entry.movedAt)),
        h('td', { className: 'dg-nowrap' }, entry.expiresAt ? fmtDay(entry.expiresAt) : t('forever'))))

      return h('div', null,
        h(Banner, { kind: 'info' }, t('trashHint')),
        h('div', { className: 'dg-toolbar', style: { marginTop: '14px' } },
          h(Button, { variant: 'primary', disabled: checked.length === 0 || action.busy, onClick: restoreSelected },
            `${t('restoreSelected')} (${checked.length})`),
          h(Button, { variant: 'danger', disabled: checked.length === 0, onClick: () => setPurging(checked.slice()) },
            `${t('purgeSelected')} (${checked.length})`),
          h(Button, { onClick: sweep, disabled: action.busy }, t('sweep')),
          h('div', { className: 'dg-spacer' }),
          h('span', { className: 'dg-hint' }, `${t('retentionDays')}: ${fmtNum(data.retentionDays)}`),
          h('span', { className: 'dg-hint' }, `${t('dueCount')}: ${fmtNum(data.dueCount)}`),
          h('span', { className: 'dg-hint' }, `${t('totalBytes')}: ${fmtBytes(data.totalBytes)}`),
          h(Button, { onClick: () => list.reload(), disabled: list.status === 'loading' }, t('refresh'))),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null,
        list.status === 'error' ? h(Banner, { kind: 'error' }, errText(list.error))
          : !list.data ? h(Loading, { label: t('loading') })
            : h(Table, {
              headers: [[h('input', {
                type: 'checkbox', checked: allChecked,
                onChange: (event) => setChecked(event.target.checked ? items.map((entry) => entry.id) : []),
                style: { accentColor: 'var(--dsw-alias-brand-primary)' },
              }), '28px'],
              [t('title')], [t('trashSource'), '108px'], [t('size'), '96px', 'right'], [t('movedAt'), '160px'], [t('expiresAt'), '120px']],
              empty: t('trashEmpty'), emptyHint: t('trashEmptyHint'), children: rows,
            }),
        purging ? h(PurgeDialog, {
          ctx, t, ids: purging, onClose: () => setPurging(null),
          onDone: (result) => {
            setPurging(null)
            setChecked([])
            action.setNotice(`${t('purgedDone')} · ${t('freedBytes')}: ${fmtBytes(result && result.freedBytes)}`)
            list.reload()
          },
        }) : null)
    }

    /** Second step of a permanent delete: show exactly what `trash.previewPurge` reports. */
    function PurgeDialog({ ctx, t, ids, onClose, onDone }) {
      const preview = useRequest(ctx, 'trash.previewPurge', { ids }, [ids.join('|')])
      const [ack, setAck] = useState(false)
      const action = useAction()
      const data = preview.data || {}
      const items = listOf(data.items)

      async function submit() {
        const value = await action.run(() => callHost(ctx, 'trash.purge', { ids, confirm: true }), null)
        if (value) onDone(value)
      }

      return h(Modal, {
        title: t('purgeTitle'), onClose,
        footer: [h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, t('cancel')),
          h(Button, { key: 'purge', variant: 'danger-solid', disabled: !ack || action.busy, onClick: submit }, t('confirmPurge'))],
      },
        h(Banner, { kind: 'error' }, t('purgeWarning')),
        preview.status === 'error' ? h(Banner, { kind: 'error' }, errText(preview.error)) : null,
        preview.status === 'loading' && !preview.data ? h(Loading, { label: t('loading') }) : null,
        items.length > 0 ? h('div', { className: 'dg-plainlist' }, items.map((entry) =>
          h('div', { key: entry.id, className: 'dg-listitem' },
            h('div', { className: 'dg-strong' }, listOf(entry.titles).filter(Boolean).join(' / ') || entry.id),
            h('div', { className: 'dg-dim' },
              `${fmtBytes(entry.sizeBytes)} · ${t('filesCount')} ${fmtNum(entry.files)} · ${listOf(entry.paths).join(' ; ')}`)))) : null,
        h(KV, { label: t('totalBytes'), value: fmtBytes(data.totalBytes) }),
        h('div', { className: 'dg-hint' }, t('purgeAttachmentsSafe')),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        h(Checkbox, { checked: ack, onChange: setAck, label: t('purgeAck') }))
    }

    /* ==================================================================== *
     * Tab 3 — snapshots
     * ==================================================================== */

    const snapshotKind = (kind, t) =>
      kind === 'auto-before-restore' ? t('kindBeforeRestore')
        : kind === 'auto-with-backup' ? t('kindWithBackup')
          : kind === 'auto-before-import' ? t('kindBeforeImport') : t('kindManual')

    function SnapshotsTab({ ctx, t, nonce, onStatus }) {
      const list = useRequest(ctx, 'snapshot.list', {}, [nonce])
      const [label, setLabel] = useState('')
      const [modules, setModules] = useState({ pluginSources: true, skills: true, uiPrefs: true, credentials: false })
      const [diffId, setDiffId] = useState(null)
      const [restoring, setRestoring] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const action = useAction()
      useReportStatus(onStatus, list)

      const data = list.data || {}
      const items = listOf(data.items)
      const setModule = (key, value) => setModules((prev) => ({ ...prev, [key]: value }))

      async function create() {
        const payload = { include: { ...modules } }
        if (label.trim() !== '') payload.label = label.trim()
        const value = await action.run(async () => {
          const created = await callHost(ctx, 'snapshot.create', payload)
          await list.reload()
          return created
        }, t('snapshotCreated'))
        if (value) setLabel('')
      }

      async function confirmRestore() {
        const target = restoring
        setRestoring(null)
        if (!target) return
        await action.run(async () => {
          const result = await callHost(ctx, 'snapshot.restore', { id: target.id })
          await list.reload()
          return result
        }, (result) => (result && result.preRestoreSnapshotId
          ? `${t('restoredSnapshot')} · ${t('preRestoreSnapshot')}: ${result.preRestoreSnapshotId}`
          : t('restoredSnapshot')))
      }

      async function confirmDelete() {
        const target = deleting
        setDeleting(null)
        if (!target) return
        await action.run(async () => {
          await callHost(ctx, 'snapshot.delete', { id: target.id })
          await list.reload()
        }, t('snapshotDeleted'))
      }

      const rows = items.map((entry) => h('tr', { key: entry.id },
        h('td', null,
          h('div', { className: 'dg-strong' }, entry.label || entry.id),
          h('div', { className: 'dg-dim dg-mono' }, entry.id)),
        h('td', { className: 'dg-nowrap' }, fmtTime(entry.createdAt)),
        h('td', { className: 'dg-nowrap' }, snapshotKind(entry.kind, t)),
        h('td', { className: 'dg-num' }, fmtBytes(entry.bytes)),
        h('td', { className: 'dg-num' }, fmtNum(listOf(entry.files).length)),
        h('td', null, entry.includesSecrets ? h(Badge, { kind: 'danger' }, t('snapshotSecrets')) : h(Badge, null, t('no'))),
        h('td', null, h('div', { className: 'dg-actions-cell' },
          h(Button, { onClick: () => setDiffId(entry.id) }, t('snapshotDiff')),
          h(Button, { onClick: () => setRestoring(entry) }, t('snapshotRestore')),
          h(Button, { variant: 'danger', onClick: () => setDeleting(entry) }, t('snapshotDelete'))))))

      return h('div', null,
        h(Section, { title: t('snapshotNow'), extra: `${t('snapshotRetention')}: ${fmtNum(data.retention)}` },
          h('div', { className: 'dg-grid' },
            h(Field, { label: t('snapshotLabel') },
              h(Input, { value: label, onChange: setLabel, placeholder: t('snapshotLabelPlaceholder') })),
            h(Field, { label: t('snapshotModules') },
              h('div', { className: 'dg-inline-gap' },
                h(Checkbox, { checked: modules.pluginSources, onChange: (value) => setModule('pluginSources', value), label: t('modPluginSources') }),
                h(Checkbox, { checked: modules.skills, onChange: (value) => setModule('skills', value), label: t('modSkills') }),
                h(Checkbox, { checked: modules.uiPrefs, onChange: (value) => setModule('uiPrefs', value), label: t('modUiPrefs') }),
                h(Checkbox, { checked: modules.credentials, onChange: (value) => setModule('credentials', value), label: t('modCredentials') }))),
            modules.credentials ? h('div', { className: 'dg-hint dg-danger', style: { gridColumn: '1/-1' } }, t('credentialsNote')) : null),
          h('div', { style: { marginTop: '16px', display: 'flex', gap: '10px', alignItems: 'center' } },
            h(Button, { variant: 'primary', disabled: action.busy, onClick: create }, t('snapshotNow')),
            h(Button, { onClick: () => list.reload(), disabled: list.status === 'loading' }, t('refresh')))),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null,
        list.status === 'error' ? h(Banner, { kind: 'error' }, errText(list.error))
          : !list.data ? h(Loading, { label: t('loading') })
            : h(Table, {
              headers: [[t('snapshotLabel')], [t('snapshotTime'), '160px'], [t('snapshotKind'), '130px'], [t('size'), '100px', 'right'],
                [t('filesCount'), '88px', 'right'], [t('snapshotSecrets'), '96px'], ['', '260px']],
              empty: t('snapshotEmpty'), emptyHint: t('snapshotEmptyHint'), children: rows,
            }),
        diffId ? h(DiffDialog, { ctx, t, id: diffId, onClose: () => setDiffId(null) }) : null,
        restoring ? h(Confirm, {
          title: t('restoreTitle'), text: t('restoreBody'), confirmLabel: t('restoreConfirm'), cancelLabel: t('cancel'),
          destructive: true, busy: action.busy, onConfirm: confirmRestore, onClose: () => setRestoring(null),
          children: h('div', { className: 'dg-strong' }, restoring.label || restoring.id),
        }) : null,
        deleting ? h(Confirm, {
          title: t('deleteSnapshotTitle'), text: t('deleteSnapshotBody'), confirmLabel: t('snapshotDelete'),
          cancelLabel: t('cancel'), destructive: true, busy: action.busy, onConfirm: confirmDelete,
          onClose: () => setDeleting(null), children: h('div', { className: 'dg-strong' }, deleting.label || deleting.id),
        }) : null)
    }

    function DiffDialog({ ctx, t, id, onClose }) {
      const req = useRequest(ctx, 'snapshot.diff', { id }, [id])
      const [expanded, setExpanded] = useState([])
      const data = req.data || {}
      const files = listOf(data.files)
      const plugins = data.plugins || {}
      const counts = { added: 0, removed: 0, changed: 0 }
      for (const file of files) {
        if (file.kind === 'added') counts.added += 1
        else if (file.kind === 'removed') counts.removed += 1
        else counts.changed += 1
      }
      const pluginRows = [
        ...listOf(plugins.added).map((entry, index) => h('div', { key: `a${index}`, className: 'dg-dim' }, `+ ${entry}`)),
        ...listOf(plugins.removed).map((entry, index) => h('div', { key: `r${index}`, className: 'dg-dim' }, `- ${entry}`)),
        ...listOf(plugins.changed).map((entry, index) =>
          h('div', { key: `c${index}`, className: 'dg-dim' }, `~ ${entry && entry.id}: ${listOf(entry && entry.keys).join(', ')}`)),
      ]

      return h(Modal, {
        title: `${t('diffTitle')} · ${id}`, onClose,
        footer: [h(Button, { key: 'close', onClick: onClose }, t('close'))],
      },
        req.status === 'error' ? h(Banner, { kind: 'error' }, errText(req.error)) : null,
        req.status === 'loading' && !req.data ? h(Loading, { label: t('loading') }) : null,
        req.data ? h('div', null,
          h('div', { className: 'dg-totals' },
            h('span', null, `${t('diffAdded')}: `, h('b', null, fmtNum(counts.added))),
            h('span', null, `${t('diffRemoved')}: `, h('b', null, fmtNum(counts.removed))),
            h('span', null, `${t('diffChanged')}: `, h('b', null, fmtNum(counts.changed)))),
          data.currentIsNewer ? h(Banner, { kind: 'warn' }, t('diffCurrentNewer')) : null,
          pluginRows.length > 0 ? h(Section, { title: t('diffPlugins') }, pluginRows) : null,
          files.length === 0 ? h(EmptyState, { title: t('diffNoFiles') })
            : h('div', { className: 'dg-plainlist' }, files.map((file, index) => {
              const open = expanded.includes(index)
              return h('div', { key: `${file.path}:${index}`, className: 'dg-listitem' },
                h('div', { className: 'dg-rowline' },
                  h(Badge, { kind: file.kind === 'removed' ? 'danger' : file.kind === 'added' ? 'ok' : 'warn' }, file.kind),
                  h('span', { className: 'dg-mono', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' } }, file.path),
                  h('span', { className: 'dg-dim' }, `+${fmtNum(file.addedLines)} / -${fmtNum(file.removedLines)}`),
                  file.patch ? h(Button, {
                    variant: 'ghost',
                    onClick: () => setExpanded((prev) => (open ? prev.filter((entry) => entry !== index) : prev.concat(index))),
                  }, open ? t('patchHide') : t('patchShow')) : null),
                open && file.patch ? h('pre', { className: 'dg-pre' }, file.patch) : null)
            })))
          : null)
    }

    /* ==================================================================== *
     * Tab 4 — backups
     * ==================================================================== */

    function BackupsTab({ ctx, t, nonce, onStatus }) {
      const list = useRequest(ctx, 'backup.list', {}, [nonce])
      const [restoring, setRestoring] = useState(null)
      const [revealed, setRevealed] = useState(null)
      const action = useAction()
      useReportStatus(onStatus, list)

      const data = list.data || {}
      const items = listOf(data.items)
      const latest = items[0] || null
      const retention = data.retention || {}

      async function runBackup() {
        const value = await action.run(async () => {
          const entry = await callHost(ctx, 'backup.run', { kind: 'manual' })
          await list.reload()
          return entry
        }, t('backupCreated'))
        if (value) action.setNotice(`${t('backupCreated')} · ${fmtBytes(value.bytes)} · ${shortSha(value.sha256)}`)
      }

      async function openDirectory() {
        if (!latest) {
          action.setNotice(`${t('backupRoot')}: ${data.backupRoot || '—'}`)
          return
        }
        await action.run(async () => {
          const value = await callHost(ctx, 'backup.reveal', { id: latest.id })
          setRevealed(value)
          return value
        }, null)
      }

      async function verify(entry) {
        const value = await action.run(() => callHost(ctx, 'backup.verify', { id: entry.id }), null)
        if (value) {
          action.setNotice(value.ok ? `${t('verifyOk')} · ${shortSha(value.actual)}` : `${t('verifyFail')} · ${shortSha(value.actual)}`)
          list.reload()
        }
      }

      async function confirmRestore() {
        const target = restoring
        setRestoring(null)
        if (!target) return
        await action.run(async () => {
          const result = await callHost(ctx, 'backup.restore', { id: target.id, confirm: true })
          await list.reload()
          return result
        }, (result) => (result && result.rescanRequired ? `${t('backupRestored')} · ${t('rescanRequired')}` : t('backupRestored')))
      }

      const rows = items.map((entry) => h('tr', { key: entry.id },
        h('td', null,
          h('div', { className: 'dg-strong' }, fmtTime(entry.createdAt)),
          h('div', { className: 'dg-dim dg-mono' }, entry.path || entry.id)),
        h('td', { className: 'dg-nowrap' }, entry.kind === 'scheduled' ? t('backupScheduled') : t('backupManual')),
        h('td', { className: 'dg-num' }, fmtBytes(entry.bytes)),
        h('td', { className: 'dg-mono' }, shortSha(entry.sha256)),
        h('td', { className: 'dg-dim' },
          `${t('tabSessions')} ${fmtNum(entry.contents && entry.contents.sessions)} · ${t('tabSnapshots')} ${fmtNum(entry.contents && entry.contents.snapshots)} · ${t('attachments')} ${fmtNum(entry.contents && entry.contents.attachments)}`),
        h('td', null, entry.verified === true ? h(Badge, { kind: 'ok' }, t('verified'))
          : entry.verified === false ? h(Badge, { kind: 'danger' }, t('verifyFail')) : h(Badge, null, t('verifyNever'))),
        h('td', null, h('div', { className: 'dg-actions-cell' },
          h(Button, { onClick: () => verify(entry), disabled: action.busy }, t('verify')),
          h(Button, { variant: 'danger', onClick: () => setRestoring(entry) }, t('backupRestore'))))))

      return h('div', null,
        h('div', { className: 'dg-toolbar' },
          h(Button, { variant: 'primary', disabled: action.busy, onClick: runBackup }, action.busy ? t('backupRunning') : t('backupNow')),
          h(Button, { onClick: openDirectory }, t('openBackupDir')),
          h('div', { className: 'dg-spacer' }),
          h(Button, { onClick: () => list.reload(), disabled: list.status === 'loading' }, t('refresh'))),
        h('div', { className: 'dg-totals' },
          h('span', null, `${t('backupRoot')}: `, h('b', null, data.backupRoot || '—')),
          h('span', null, `${t('nextBackup')}: `, h('b', null, data.nextBackupAt ? fmtTime(data.nextBackupAt) : t('intervalOff'))),
          h('span', null, `${t('lastBackup')}: `, h('b', null, latest ? fmtRel(latest.createdAt, t) : t('never'))),
          h('span', null, `${t('backupRetention')}: `,
            h('b', null, `${t('settingsFullRetention')} ${fmtNum(retention.full)} · ${t('settingsSnapshotRetention')} ${fmtNum(retention.snapshots)}`))),
        h('div', { className: 'dg-dim', style: { marginBottom: '10px' } },
          `${t('rescuePath')}: `,
          h('span', { className: 'dg-code' }, (latest && latest.rescuePath) || t('rescueNone'))),
        revealed ? h(Banner, { kind: 'info' },
          `${t('backupRoot')}: ${revealed.path || '—'} · ${t('rescuePath')}: ${revealed.rescuePath || '—'}`) : null,
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null,
        list.status === 'error' ? h(Banner, { kind: 'error' }, errText(list.error))
          : !list.data ? h(Loading, { label: t('loading') })
            : h(Table, {
              headers: [[t('snapshotTime')], [t('backupKind'), '92px'], [t('size'), '100px', 'right'], [t('sha256'), '140px'],
                [t('backupContents')], [t('status'), '110px'], ['', '190px']],
              empty: t('backupEmpty'), emptyHint: t('backupEmptyHint'), children: rows,
            }),
        restoring ? h(Confirm, {
          title: t('backupRestoreTitle'), text: t('backupRestoreWarning'), confirmLabel: t('backupRestoreConfirm'),
          cancelLabel: t('cancel'), destructive: true, busy: action.busy, onConfirm: confirmRestore,
          onClose: () => setRestoring(null), children: h('div', { className: 'dg-strong' }, restoring.path || restoring.id),
        }) : null)
    }

    /* ==================================================================== *
     * Tab 5 — settings (+ audit)
     * ==================================================================== */

    const INTERVALS = [
      { value: '0', key: 'intervalOff' }, { value: '1', key: 'interval1h' }, { value: '6', key: 'interval6h' },
      { value: '12', key: 'interval12h' }, { value: '24', key: 'interval24h' }, { value: '168', key: 'interval7d' },
      { value: 'custom', key: 'intervalCustom' },
    ]

    function changedKeys(draft, baseline) {
      if (!draft || !baseline) return []
      const keys = new Set(Object.keys(draft).concat(Object.keys(baseline)))
      return [...keys].filter((key) => !(draft[key] === baseline[key] || (draft[key] == null && baseline[key] == null)))
    }

    function SettingsTab({ ctx, t, nonce, onStatus }) {
      const req = useRequest(ctx, 'settings.get', {}, [nonce])
      const [draft, setDraft] = useState(null)
      const [baseline, setBaseline] = useState(null)
      const [auditOpen, setAuditOpen] = useState(false)
      const [bypassOpen, setBypassOpen] = useState(false)
      const [browsing, setBrowsing] = useState(false)
      const action = useAction()
      useReportStatus(onStatus, req)

      useEffect(() => {
        const loaded = req.data && req.data.settings
        if (loaded) {
          setDraft({ ...loaded })
          setBaseline({ ...loaded })
        }
      }, [req.data])

      const changed = useMemo(() => changedKeys(draft, baseline), [draft, baseline])
      const update = (key, value) => setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))

      async function browseRoot() {
        if (!canPickDirectory(ctx)) { setBrowsing(true); return }
        try {
          const picked = await pickDirectory(ctx)
          if (picked) update('backupRoot', picked)
        } catch (error) { action.setError(error) }
      }

      async function save() {
        if (!draft) return
        if (changed.length === 0) { action.setNotice(t('settingsNoChanges')); return }
        const patch = {}
        for (const key of changed) patch[key] = draft[key]
        const value = await action.run(() => callHost(ctx, 'settings.update', { patch }), t('settingsSaved'))
        if (value && value.settings) {
          setDraft({ ...value.settings })
          setBaseline({ ...value.settings })
        }
      }

      async function setBypass(minutes) {
        await action.run(async () => {
          await callHost(ctx, 'settings.bypass', { minutes })
          await req.reload()
        }, minutes === 0 ? t('bypassDisabled') : t('bypassEnabled'))
      }

      if (req.status === 'error') {
        return h('div', null,
          h(Banner, { kind: 'error' }, `${t('settingsLoadFailed')}: ${errText(req.error)}`),
          h(Button, { onClick: () => req.reload() }, t('retry')))
      }
      if (!draft) return h(Loading, { label: t('loading') })

      const source = req.data || {}
      const known = ['0', '1', '6', '12', '24', '168']
      const intervalValue = draft.backupCron ? 'custom'
        : known.includes(String(draft.backupIntervalHours)) ? String(draft.backupIntervalHours) : 'custom'

      return h('div', null,
        h(Section, { title: t('settingsBackupRoot'), extra: `${changed.length} ${t('settingsChanged')}` },
          h('div', { className: 'dg-grid' },
            h(PathField, {
              t, label: t('settingsBackupRoot'), hint: t('settingsBackupRootHint'), span2: true,
              value: draft.backupRoot || '', onChange: (value) => update('backupRoot', value), onBrowse: browseRoot,
            }),
            source.resolvedBackupRoot
              ? h('div', { className: 'dg-hint', style: { gridColumn: '1/-1' } }, `${t('resolvedRoot')}: `, h('span', { className: 'dg-code' }, source.resolvedBackupRoot))
              : null,
            h(SelectField, {
              label: t('settingsInterval'), value: intervalValue,
              options: INTERVALS.map((option) => ({ value: option.value, label: t(option.key) })),
              onChange: (value) => {
                if (value === 'custom') update('backupCron', draft.backupCron || '0 */6 * * *')
                else { update('backupCron', null); update('backupIntervalHours', Number(value)) }
              },
            }),
            intervalValue === 'custom'
              ? h(Field, { label: t('intervalCustom') },
                h(Input, { value: draft.backupCron || '', onChange: (value) => update('backupCron', value), placeholder: t('cronPlaceholder') }))
              : null,
            h(NumField, { label: t('settingsFullRetention'), min: 1, value: draft.backupFullRetention ?? 7, onChange: (value) => update('backupFullRetention', value) }),
            h(NumField, { label: t('settingsSnapshotRetention'), min: 1, value: draft.backupSnapshotRetention ?? 30, onChange: (value) => update('backupSnapshotRetention', value) }),
            h(NumField, { label: t('settingsTrashRetention'), min: 0, hint: t('zeroNeverPurge'), value: draft.trashRetentionDays ?? 30, onChange: (value) => update('trashRetentionDays', value) }))),
        h(Section, { title: t('settingsInclude') },
          h('div', { className: 'dg-grid' },
            h(Switch, { checked: draft.includeSessions, onChange: (value) => update('includeSessions', value), label: t('incSessions') }),
            h(Switch, { checked: draft.includeConfig, onChange: (value) => update('includeConfig', value), label: t('incConfig') }),
            h(Switch, { checked: draft.includeAttachments, onChange: (value) => update('includeAttachments', value), label: t('incAttachments') }),
            h(Switch, {
              checked: draft.includeCredentials, onChange: (value) => update('includeCredentials', value),
              label: t('incCredentials'), danger: t('credentialsPrivacy'),
            }))),
        h(Section, { title: t('settingsSafety') },
          h('div', { className: 'dg-grid' },
            h(Switch, { checked: draft.safeDeleteEnabled, onChange: (value) => update('safeDeleteEnabled', value), label: t('safeDelete'), hint: t('safeDeleteHint') }),
            h(Switch, { checked: draft.fileTrashEnabled, onChange: (value) => update('fileTrashEnabled', value), label: t('fileTrash'), hint: t('fileTrashHint') }),
            h(Switch, { checked: draft.snapshotOnImport, onChange: (value) => update('snapshotOnImport', value), label: t('snapshotOnImport') })),
          h('div', { className: 'dg-bypass-row' },
            (() => {
              const until = Number(source.bypassUntil ?? 0)
              const active = until > Number(source.now ?? Date.now())
              return [
                h(Button, {
                  key: 'bypass',
                  variant: active ? 'ghost' : 'danger',
                  disabled: action.busy,
                  onClick: () => (active ? setBypass(0) : setBypassOpen(true)),
                }, active ? t('bypassBack') : t('bypassEnable')),
                h('span', { key: 'state', className: cx('dg-badge', active ? 'dg-danger' : 'dg-idle') },
                  active ? `${t('bypassActive')} ${fmtTime(until)}` : t('bypassIdle')),
                h('span', { key: 'hint', className: 'dg-hint' }, t('bypassHint')),
              ]
            })())),
        h(Section, {
          title: t('escapeHatch'),
          extra: h(Badge, { kind: source.envEscapeHatch ? 'danger' : 'idle' }, source.envEscapeHatch ? t('escapeOn') : t('escapeOff')),
        },
          h('div', { className: 'dg-hint' }, t('escapeHatchText'), ' ',
            h('span', { className: 'dg-code' }, 'DSH_GUARDIAN_FORCE_DELETE=1'))),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null,
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h(Button, { variant: 'primary', disabled: action.busy || changed.length === 0, onClick: save }, t('saveChanges')),
          h(Button, {
            variant: 'ghost',
            onClick: () => { if (source.defaults) setDraft({ ...draft, ...source.defaults }) },
          }, t('useDefaults')),
          h('span', { className: 'dg-hint' }, changed.length > 0 ? `${changed.length} ${t('settingsChanged')}` : t('saved'))),
        h('button', { type: 'button', className: 'dg-collapse', onClick: () => setAuditOpen(!auditOpen) },
          h('span', null, auditOpen ? '▾' : '▸'), h('span', null, t('audit')), h('span', { className: 'dg-hint' }, t('auditHint'))),
        auditOpen ? h(AuditSection, { ctx, t }) : null,
        bypassOpen ? h(Confirm, {
          title: t('bypassConfirmTitle'), text: t('bypassConfirmBody'),
          confirmLabel: t('bypassConfirmAction'), cancelLabel: t('cancel'),
          destructive: true, busy: action.busy,
          onConfirm: async () => { setBypassOpen(false); await setBypass(30) },
          onClose: () => setBypassOpen(false),
        }) : null,
        browsing ? h(FileBrowser, {
          ctx, t, mode: 'dir', startPath: draft.backupRoot || '',
          onPick: (picked) => { update('backupRoot', picked); setBrowsing(false) },
          onClose: () => setBrowsing(false),
        }) : null)
    }

    function AuditSection({ ctx, t }) {
      const req = useRequest(ctx, 'audit.list', { limit: 30 }, [])
      const items = listOf(req.data && req.data.items)
      return h(Section, { title: t('audit'), extra: t('auditHint') },
        req.status === 'error' ? h(Banner, { kind: 'error' }, errText(req.error))
          : req.status === 'loading' && !req.data ? h(Loading, { label: t('loading') })
            : items.length === 0 ? h(EmptyState, { title: t('auditEmpty') })
              : h('div', null,
                h('div', { className: 'dg-audit-row dg-dim' },
                  h('span', null, t('auditAt')), h('span', null, t('auditKind')), h('span', null, t('auditDetail'))),
                items.map((entry, index) => h('div', { key: index, className: 'dg-audit-row' },
                  h('span', { className: 'dg-dim' }, fmtTime(entry.at)),
                  h('span', null, String(entry.kind ?? '—')),
                  h('span', { className: 'dg-dim' },
                    typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail ?? null))))),
        h(Button, { variant: 'ghost', onClick: () => req.reload() }, t('refresh')))
    }

    /* ==================================================================== *
     * Panel shell
     * ==================================================================== */

    const TABS = [
      { id: 'sessions', label: 'tabSessions' },
      { id: 'trash', label: 'tabTrash' },
      { id: 'snapshots', label: 'tabSnapshots' },
      { id: 'backups', label: 'tabBackups' },
      { id: 'settings', label: 'tabSettings' },
    ]

    function GuardianPage({ ctx, t }) {
      const [tab, setTab] = useState('sessions')
      const [nonce, setNonce] = useState(0)
      const [status, setStatus] = useState({ status: 'idle', at: 0, error: null })
      const report = useCallback((info) => {
        setStatus((prev) => (prev.status === info.status && prev.at === info.at && prev.error === info.error ? prev : info))
      }, [])

      const tabProps = { ctx, t, nonce, onStatus: report }
      const body = tab === 'trash' ? h(TrashTab, tabProps)
        : tab === 'snapshots' ? h(SnapshotsTab, tabProps)
          : tab === 'backups' ? h(BackupsTab, tabProps)
            : tab === 'settings' ? h(SettingsTab, tabProps)
              : h(SessionsTab, tabProps)

      const statusText = status.error ? `${t('errorTitle')}: ${errText(status.error)}`
        : status.at ? `${t('lastRefresh')} ${fmtTime(status.at)}`
          : status.status === 'loading' ? t('loading') : t('empty')

      return h('div', { className: 'dg-root' },
        h('style', null, CSS),
        h('div', { className: 'dg-head' },
          h('div', null, h('h2', { className: 'dg-title' }, t('panel')), h('div', { className: 'dg-sub' }, t('subtitle'))),
          h('div', { className: 'dg-head-actions' },
            h('span', { className: cx('dg-status', status.error && 'dg-err'), title: statusText }, statusText),
            h(Button, { onClick: () => setNonce((value) => value + 1) }, t('refresh')))),
        h('div', { className: 'dg-tabs' }, TABS.map((entry) => h('button', {
          key: entry.id, type: 'button', className: 'dg-tab', 'data-active': tab === entry.id ? 'true' : undefined,
          onClick: () => setTab(entry.id),
        }, t(entry.label)))),
        h('div', { className: 'dg-body' },
          h(BodyBoundary, { t, key: tab }, body)))
    }

    /** The sidebar glyph from icon.svg, drawn in the theme's current text color. */
    function GuardianIcon({ size }) {
      return h('svg', {
        viewBox: '0 0 1024 1024', width: size, height: size, fill: 'currentColor',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('path', { d: 'M209.1 956.3c-65.5 0-118.9-53.3-118.9-118.8V185c0-65.5 53.3-118.8 118.9-118.8h482.7l240.6 240.5v530.7c0 65.5-53.3 118.8-118.9 118.8H209.1z m0-833.7c-34.4 0-62.4 28-62.4 62.4v652.4c0 34.4 28 62.4 62.4 62.4h604.4c34.4 0 62.4-28 62.4-62.4V394.5H722.8c-35.8 0-64.1-6.7-84.4-20-22.9-15-34.5-38.1-34.5-68.7 0-1.1-1.4-109.7-0.9-181.3v-2H209.1z m451.3 153.1c0 34.4 28 62.4 62.4 62.4h155.9L660.4 119.8v155.9z' }),
        h('path', { d: 'M330 563.5c-15.5 0-28.2-12.7-28.2-28.2s12.6-28.2 28.2-28.2h362.6c15.5 0 28.2 12.6 28.2 28.2s-12.6 28.2-28.2 28.2H330z' }),
        h('path', { d: 'M330 714.6c-15.5 0-28.2-12.7-28.2-28.2s12.6-28.2 28.2-28.2h362.6c15.5 0 28.2 12.6 28.2 28.2s-12.6 28.2-28.2 28.2H330z' }))
    }

    /* ==================================================================== *
     * Plugin entry
     * ==================================================================== */

    return {
      // `uiWorkspace` is resolved lazily through `ctx.get`, so an absent service
      // degrades to an inline banner instead of blocking panel activation.
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-guardian: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ ctx, t }) }, GuardianPage))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: () => t('panel'), locale: NS },
            GuardianIcon,
          ))
      },
    }
  },
})
