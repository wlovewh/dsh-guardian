/**
 * dsh-guardian — Client half.
 *
 * Registers the sidebar entry (`sidebar.panellist`) and the main panel (`main`).
 * Every piece of data comes from the Host half through the Connection RPC channel
 * (`POST /guardian/<endpoint>`); see `.research/contract.md`.
 *
 * Sections: transport · formatting · locale · styles · atoms · hooks · file browser
 *           · sessions tab · recycle bin tab · snapshots tab · backups tab
 *           · settings tab (with audit) · panel shell · plugin entry.
 *
 * The file is loaded as-is by the browser module loader: no JSX, no imports, only
 * `require('react')`.
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

    // Remembered picker locations (session-scoped; the panel remounts often).
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
        if (ctx && typeof ctx.get === 'function') return ctx.get(name)
      } catch (error) {
        /* not injected / not provided — treated as unavailable */
      }
      return undefined
    }

    /** Human readable text for one thrown Host error. */
    function errText(error) {
      if (!error) return ''
      const message = String(error.message || error)
      return error.code ? `${message} (${error.code})` : message
    }

    /* ==================================================================== *
     * Formatting helpers
     * ==================================================================== */

    const pad2 = (value) => String(value).padStart(2, '0')

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
      const diff = Math.max(0, Date.now() - ms)
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return t('justNow')
      if (minutes < 60) return `${minutes}${t('unitMin')}`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}${t('unitHour')}`
      const days = Math.floor(hours / 24)
      return `${days}${t('unitDay')}`
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

    function fmtNum(value) {
      const number = Number(value)
      return Number.isFinite(number) ? String(number) : '0'
    }

    function shortSha(value) {
      return typeof value === 'string' && value.length > 0 ? value.slice(0, 12) : '—'
    }

    function listOf(value) {
      return Array.isArray(value) ? value : []
    }

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
      useDefaults: ['使用默认值', 'Use defaults'],
      sourcePanel: ['面板', 'Panel'],
      sourceSafeDelete: ['安全删除', 'Safe delete'],
      sourceImportGuard: ['导入保护', 'Import guard'],
      sourceManual: ['手动', 'Manual'],
      kindManual: ['手动', 'Manual'],
      kindBeforeRestore: ['恢复前自动', 'Auto before restore'],
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
      lastActivity: ['最后活动', 'Last activity'],
      status: ['状态', 'Status'],
      badgeSubagent: ['子会话', 'Sub'],
      badgeArchived: ['归档', 'Archived'],
      badgeLive: ['运行中', 'Live'],
      badgeTrash: ['回收站', 'Trash'],
      noSessions: ['该工作区没有会话', 'No sessions in this workspace'],
      noSessionsHint: ['换一个工作区，或清除搜索条件。', 'Pick another workspace or clear the search.'],
      renamePlaceholder: ['会话标题', 'Session title'],
      renamed: ['标题已更新', 'Title updated'],
      archivedMsg: ['已归档', 'Archived'],
      unarchivedMsg: ['已取消归档', 'Unarchived'],
      movedToTrash: ['已移入回收站，可随时恢复', 'Moved to the recycle bin; it stays recoverable'],
      trashConfirmTitle: ['移入回收站', 'Move to recycle bin'],
      trashConfirmBody: [
        '该会话（含子会话）会被移动到 guardian 回收站，不会从磁盘物理删除。你可以在「回收站」标签页里恢复它。',
        'This session (with its sub-sessions) is moved to the guardian recycle bin and is not deleted from disk. Restore it from the Recycle bin tab.',
      ],
      openError: ['无法打开会话：uiWorkspace 服务不可用', 'Cannot open session: uiWorkspace is unavailable'],
      sessionsSelected: ['已选', 'selected'],
      rename: ['重命名', 'Rename'],
      archive: ['归档', 'Archive'],
      unarchive: ['取消归档', 'Unarchive'],
      trash: ['移入回收站', 'Move to recycle bin'],
      no: ['否', 'No'],

      // export
      export: ['导出', 'Export'],
      exportTitle: ['导出会话', 'Export sessions'],
      exportScope: ['导出范围', 'Scope'],
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

      // import
      import: ['导入', 'Import'],
      importTitle: ['导入会话', 'Import sessions'],
      packagePath: ['可移植包路径', 'Portable package path'],
      inspect: ['检查', 'Inspect'],
      importVersion: ['DSH 版本', 'DSH version'],
      importCompatible: ['兼容', 'Compatible'],
      importIncompatible: ['不兼容', 'Incompatible'],
      importSessions: ['包内会话', 'Sessions in package'],
      importAttachments: ['附件', 'Attachments'],
      importWarnings: ['警告', 'Warnings'],
      targetPath: ['目标目录', 'Target folder'],
      targetPathHint: ['默认使用所选工作区的路径', 'Defaults to the selected workspace path'],
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
        '移入回收站的会话会保留原路径，恢复时按原路径放回；附件是内容寻址的共享对象，本页任何操作都不会删除它们。',
        'Trashed sessions keep their original paths and are restored in place. Attachments are content-addressed and shared — nothing on this page ever deletes them.',
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
        '仅这些会话的日志与投影缓存会被清理；被其他会话共享的附件不会被删除。',
        'Only these sessions’ logs and projection cache are removed; attachments shared with other sessions are never deleted.',
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
      snapshotFiles: ['文件', 'Files'],
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
      safeDelete: ['安全删除开关', 'Safe delete guard'],
      safeDeleteHint: ['拦截工具调用中的 rm / Remove-Item，改为移入回收站。', 'Intercepts rm / Remove-Item in tool calls and moves the targets to the recycle bin.'],
      fileTrash: ['文件级安全删除', 'File-level safe delete'],
      fileTrashHint: ['让 safe_delete 工具对工作区文件生效。', 'Enables the safe_delete tool for workspace files.'],
      snapshotOnImport: ['导入前自动快照', 'Snapshot before import'],
      settingsSaved: ['设置已保存', 'Settings saved'],
      settingsNoChanges: ['没有需要保存的修改', 'No changes to save'],
      settingsChanged: ['项待保存', 'pending changes'],
      saveChanges: ['保存修改', 'Save changes'],
      escapeHatch: ['逃生舱', 'Escape hatch'],
      escapeHatchText: [
        '设置 DSH_GUARDIAN_FORCE_DELETE=1 可以临时绕过删除拦截，绕过动作会写入审计日志。当前状态：',
        'Setting DSH_GUARDIAN_FORCE_DELETE=1 temporarily bypasses delete interception; bypassed deletions are written to the audit log. Current state:',
      ],
      escapeOn: ['已启用', 'Enabled'],
      escapeOff: ['未启用', 'Not enabled'],
      audit: ['审计日志', 'Audit log'],
      auditHint: ['最近的永久删除与恢复事件。', 'Recent permanent-delete and restore events.'],
      auditEmpty: ['没有审计记录', 'No audit records'],
      auditAt: ['时间', 'Time'],
      auditKind: ['事件', 'Event'],
      auditDetail: ['详情', 'Detail'],
      suggestedRoots: ['建议目录', 'Suggested folders'],
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
.dg-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:400 13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
.dg-root *{box-sizing:border-box;}
.dg-head{display:flex;align-items:flex-start;gap:12px;padding:12px 16px 8px;}
.dg-title{margin:0;font-size:14px;font-weight:600;line-height:20px;}
.dg-sub{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex:0 0 auto;}
.dg-status{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dg-status.dg-err{color:var(--dsw-alias-state-error-primary);}
.dg-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dg-tab{height:32px;padding:0 10px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;}
.dg-tab:hover{color:var(--dsw-alias-label-primary);}
.dg-tab[data-active="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500;}
.dg-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 24px;}
.dg-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px;}
.dg-toolbar .dg-hint{margin:0;}
.dg-spacer{flex:1 1 auto;}
.dg-btn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:26px;cursor:pointer;white-space:nowrap;}
.dg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}
.dg-btn:disabled{opacity:.45;cursor:default;}
.dg-btn.dg-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.dg-btn.dg-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9;}
.dg-btn.dg-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:transparent;}
.dg-btn.dg-danger-solid{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);}
.dg-btn.dg-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);}
.dg-btn.dg-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dg-input,.dg-select{height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;min-width:0;}
.dg-input::placeholder{color:var(--dsw-alias-label-secondary);}
.dg-input:focus,.dg-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
.dg-input.dg-grow{flex:1 1 220px;}
.dg-input.dg-inline{height:22px;width:100%;}
.dg-field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.dg-field > label{font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-field.dg-span2{grid-column:1/-1;}
.dg-hint{font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-hint.dg-warn{color:var(--dsw-alias-state-warn-primary);}
.dg-hint.dg-danger{color:var(--dsw-alias-state-error-primary);}
.dg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;}
.dg-rowline{display:flex;align-items:center;gap:8px;min-width:0;}
.dg-rowline .dg-input{flex:1 1 auto;}
.dg-totals{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:10px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-totals b{font-weight:600;color:var(--dsw-alias-label-primary);}
.dg-split{display:flex;gap:12px;align-items:flex-start;}
.dg-side{flex:0 0 250px;width:250px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.dg-side-head{padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);}
.dg-side-list{max-height:min(56vh,540px);overflow:auto;padding:4px;}
.dg-side-row{display:block;width:100%;text-align:left;border:0;border-radius:6px;background:transparent;padding:6px 8px;cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;}
.dg-side-row:hover{background:var(--dsw-alias-bg-layer-2);}
.dg-side-row[data-active="true"]{background:var(--dsw-alias-bg-layer-2);}
.dg-side-title{display:flex;justify-content:space-between;gap:8px;font-size:13px;}
.dg-side-path{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dg-count{font-size:12px;color:var(--dsw-alias-label-secondary);flex:0 0 auto;}
.dg-main{flex:1 1 auto;min-width:0;}
.dg-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.dg-rowhead{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;font-size:12px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);}
.dg-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dg-row:last-child{border-bottom:0;}
.dg-row:hover{background:var(--dsw-alias-bg-layer-2);}
.dg-cell-title{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;}
.dg-cell-title > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dg-col-num{flex:0 0 62px;width:62px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-col-size{flex:0 0 78px;width:78px;text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-col-time{flex:0 0 92px;width:92px;text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-col-badges{flex:0 0 auto;display:flex;gap:4px;align-items:center;}
.dg-actions{display:flex;gap:4px;flex:0 0 auto;opacity:0;transition:opacity .12s;}
.dg-row:hover .dg-actions,.dg-row:focus-within .dg-actions{opacity:1;}
.dg-actions .dg-btn{height:22px;line-height:20px;font-size:12px;padding:0 6px;}
.dg-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dg-badge.dg-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}
.dg-badge.dg-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}
.dg-badge.dg-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}
.dg-badge.dg-idle{border-color:var(--dsw-alias-state-idle-primary);color:var(--dsw-alias-state-idle-primary);}
.dg-badge.dg-brand{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dg-tablewrap{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:auto;}
.dg-table{width:100%;border-collapse:collapse;font-size:13px;}
.dg-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1);text-align:left;font-weight:500;font-size:12px;color:var(--dsw-alias-label-secondary);padding:0 8px;height:30px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;}
.dg-table td{height:32px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle;}
.dg-table tbody tr:last-child td{border-bottom:0;}
.dg-table tbody tr:hover td{background:var(--dsw-alias-bg-layer-2);}
.dg-table .dg-num{text-align:right;font-variant-numeric:tabular-nums;}
.dg-table .dg-nowrap{white-space:nowrap;}
.dg-table .dg-btn{height:22px;line-height:20px;font-size:12px;padding:0 8px;}
.dg-table .dg-actions-cell{display:flex;gap:4px;justify-content:flex-end;}
.dg-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12px;}
.dg-strong{font-weight:500;}
.dg-snippet{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:520px;}
.dg-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;}
.dg-check input{accent-color:var(--dsw-alias-brand-primary);margin:0;cursor:pointer;}
.dg-switch{display:flex;align-items:flex-start;gap:10px;padding:6px 0;cursor:pointer;}
.dg-switch > div{flex:1 1 auto;min-width:0;}
.dg-switch-label{font-size:13px;}
.dg-switch input{appearance:none;-webkit-appearance:none;flex:0 0 auto;width:30px;height:16px;margin:2px 0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;transition:background .12s;}
.dg-switch input::after{content:"";position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .12s;}
.dg-switch input:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}
.dg-switch input:checked::after{transform:translateX(14px);}
.dg-radios{display:flex;flex-wrap:wrap;gap:12px;}
.dg-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-overlay);}
.dg-modal{width:min(680px,100%);max-height:min(84vh,760px);display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.dg-modal-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dg-modal-title{margin:0;font-size:13px;font-weight:600;flex:1 1 auto;}
.dg-modal-body{padding:14px;overflow:auto;display:flex;flex-direction:column;gap:10px;}
.dg-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);}
.dg-banner{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;}
.dg-banner > div{flex:1 1 auto;min-width:0;word-break:break-all;}
.dg-banner.dg-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}
.dg-banner.dg-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}
.dg-banner.dg-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);}
.dg-banner.dg-info{color:var(--dsw-alias-label-secondary);}
.dg-empty{padding:26px 12px;text-align:center;}
.dg-empty-title{font-size:13px;color:var(--dsw-alias-label-primary);}
.dg-empty-hint{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-kv{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dg-kv b{font-weight:500;color:var(--dsw-alias-label-primary);}
.dg-code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Consolas,monospace;font-size:12px;}
.dg-pre{margin:0;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);overflow:auto;max-height:300px;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre;color:var(--dsw-alias-label-secondary);}
.dg-section{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:12px;margin-bottom:10px;}
.dg-section-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.dg-section-title{margin:0;font-size:13px;font-weight:600;flex:1 1 auto;}
.dg-plainlist{display:flex;flex-direction:column;gap:6px;}
.dg-listitem{padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;}
.dg-browser-list{max-height:min(44vh,360px);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;}
.dg-browser-row{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;}
.dg-browser-row:last-child{border-bottom:0;}
.dg-browser-row:hover{background:var(--dsw-alias-bg-layer-2);}
.dg-browser-row > span:first-child{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dg-audit-row{display:grid;grid-template-columns:150px 120px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;}
.dg-audit-row:last-child{border-bottom:0;}
.dg-collapse{display:flex;align-items:center;gap:6px;width:100%;padding:8px 0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;text-align:left;}
.dg-chiprow{display:flex;flex-wrap:wrap;gap:6px;}
.dg-chip{height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}
.dg-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);}
.dg-dim{color:var(--dsw-alias-label-secondary);font-size:12px;}
.dg-inline-gap{display:flex;flex-wrap:wrap;gap:16px;align-items:center;}
`

    /* ==================================================================== *
     * Shared UI atoms
     * ==================================================================== */

    function Button({ variant, disabled, onClick, title, children }) { const className = `dg-btn${variant ? ` dg-${variant}` : ''}`
      return h('button', { type: 'button', className, disabled: disabled === true, title, onClick: disabled === true ? undefined : onClick }, children,)
    }

    function Field({ label, hint, dangerHint, span2, children }) { return h('div', { className: `dg-field${span2 ? ' dg-span2' : ''}` },
        label ? h('label', null, label) : null, children, hint ? h('div', { className: 'dg-hint' }, hint) : null,
        dangerHint ? h('div', { className: 'dg-hint dg-danger' }, dangerHint) : null,)
    }

    function Checkbox({ checked, onChange, label, disabled }) { return h('label', { className: 'dg-check' },
        h('input', { type: 'checkbox', checked: checked === true, disabled: disabled === true, onChange: (event) => onChange(event.target.checked) }),
        h('span', null, label),)
    }

    function Switch({ checked, onChange, label, hint, dangerHint }) { return h('label', { className: 'dg-switch' },
        h('input', { type: 'checkbox', checked: checked === true, onChange: (event) => onChange(event.target.checked) }), h('div', null,
          h('div', { className: 'dg-switch-label' }, label), hint ? h('div', { className: 'dg-hint' }, hint) : null,
          dangerHint ? h('div', { className: 'dg-hint dg-danger' }, dangerHint) : null,),)
    }

    function Badge({ kind, children }) { return h('span', { className: `dg-badge${kind ? ` dg-${kind}` : ''}` }, children)
    }

    function Banner({ kind, children, onDismiss, dismissLabel }) { return h('div', { className: `dg-banner${kind ? ` dg-${kind}` : ' dg-info'}` },
        h('div', null, children), onDismiss ? h(Button, { variant: 'ghost', onClick: onDismiss }, dismissLabel || '✕') : null,)
    }

    function EmptyState({ title, hint, action }) { return h('div', { className: 'dg-empty' }, h('div', { className: 'dg-empty-title' }, title),
        hint ? h('div', { className: 'dg-empty-hint' }, hint) : null, action ? h('div', { style: { marginTop: '10px' } }, action) : null,)
    }

    function LoadingState({ label }) { return h(EmptyState, { title: label })
    }

    function DataTable({ headers, children, empty, emptyHint }) { if (empty) return h(EmptyState, { title: empty, hint: emptyHint })
      return h('div', { className: 'dg-tablewrap' }, h('table', { className: 'dg-table' }, h('thead', null, h('tr', null, headers.map((column, index) =>
                h('th', { key: index, style: column.width ? { width: column.width } : undefined }, column.label),),),), h('tbody', null, children),),)
    }

    function Modal({ title, onClose, children, footer, closeLabel }) { useEffect(() => { function onKeyDown(event) {
          if (event.key === 'Escape' || event.key === 'Esc') { event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])
      return h('div', { className: 'dg-mask', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose()
          }, }, h('div', { className: 'dg-modal', role: 'dialog', 'aria-modal': 'true' }, h('div', { className: 'dg-modal-head' },
            h('h3', { className: 'dg-modal-title' }, title), h(Button, { variant: 'ghost', onClick: onClose, title: 'Esc' }, closeLabel || '✕'),),
          h('div', { className: 'dg-modal-body' }, children), footer ? h('div', { className: 'dg-modal-foot' }, footer) : null,),)
    }

    function ConfirmDialog(props) { const { title, text, children, confirmLabel, cancelLabel, destructive, busy, onConfirm, onClose } = props
      return h(Modal, { title, onClose, footer: [h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, cancelLabel), h(Button,
              { key: 'ok', variant: destructive ? 'danger-solid' : 'primary', disabled: busy === true, onClick: onConfirm }, confirmLabel,),], },
        text ? h(Banner, { kind: destructive ? 'error' : 'info' }, text) : null, children,)
    }

    /* ==================================================================== *
     * Hooks — one request shape for every tab, one action shape for mutations
     * ==================================================================== */

    /**
     * `useRequest(ctx, endpoint | loader, args, deps, { enabled })`
     * → `{ status: idle|loading|ok|error, data, error, at, reload(overrideArgs) }`
     */
    function useRequest(ctx, method, args, deps, options) { const opts = options || {}
      const enabled = opts.enabled !== false
      const argsRef = useRef(args)
      argsRef.current = args
      const callRef = useRef(null)
      callRef.current = typeof method === 'function' ? method : (payload) => callHost(ctx, method, payload)
      const [state, setState] = useState({ status: enabled ? 'loading' : 'idle', data: undefined, error: null, at: 0 })
      const seq = useRef(0)
      const mounted = useRef(true)

      useEffect(() => () => { mounted.current = false
        }, [],)

      const reload = useCallback(async (override) => { const ticket = seq.current + 1
        seq.current = ticket
        setState((prev) => ({ status: 'loading', data: prev.data, error: null, at: prev.at }))
        try { const data = await callRef.current(override !== undefined ? override : argsRef.current)
          if (mounted.current && seq.current === ticket) setState({ status: 'ok', data, error: null, at: Date.now() })
          return data
        } catch (error) { if (mounted.current && seq.current === ticket) setState({ status: 'error', data: undefined, error, at: Date.now() })
          return undefined
        }
      }, [])

      const depList = Array.isArray(deps) ? deps : []
      useEffect(() => { if (!enabled) { setState((prev) => (prev.status === 'idle' ? prev : { status: 'idle', data: undefined, error: null, at: 0 }))
          return
        }
        reload()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [enabled, reload].concat(depList))

      return { status: state.status, data: state.data, error: state.error, at: state.at, reload }
    }

    /** Mutation helper: `{ busy, error, notice, setError, setNotice, run(fn, okText) }`. */
    function useAction() { const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const run = useCallback(async (work, okText) => { setBusy(true)
        setError(null)
        try { const value = await work()
          if (okText !== undefined && okText !== null) setNotice(typeof okText === 'function' ? okText(value) : okText)
          return value
        } catch (cause) { setError(cause)
          return undefined
        } finally { setBusy(false)
        }
      }, [])
      return { busy, error, notice, setError, setNotice, run }
    }

    /* ==================================================================== *
     * uiWorkspace bridges (optional service — absence degrades to a banner)
     * ==================================================================== */

    function pathOf(value) { if (!value) return null
      if (typeof value === 'string') return value
      if (typeof value === 'object') { if (typeof value.path === 'string') return value.path
        if (typeof value.directory === 'string') return value.directory
        if (typeof value.dir === 'string') return value.dir
        if (Array.isArray(value.paths) && typeof value.paths[0] === 'string') return value.paths[0]
      }
      return null
    }

    async function pickDirectory(ctx) { const workspace = service(ctx, 'uiWorkspace')
      if (!workspace || typeof workspace.pickDirectory !== 'function') return null
      return pathOf(await workspace.pickDirectory())
    }

    function canPickDirectory(ctx) { const workspace = service(ctx, 'uiWorkspace')
      return Boolean(workspace && typeof workspace.pickDirectory === 'function')
    }

    function normalizeListing(raw) { const listing = { path: '', parent: null, dirs: [], files: [] }
      if (!raw || typeof raw !== 'object') return listing
      listing.path = typeof raw.path === 'string' ? raw.path : ''
      if (typeof raw.parent === 'string' || raw.parent === null) listing.parent = raw.parent
      const dirList = listOf(raw.dirs)
      const fileList = listOf(raw.files)
      for (const entry of dirList) { const name = typeof entry === 'string' ? nameOfPath(entry) : entry?.name || nameOfPath(entry?.path)
        const path = typeof entry === 'string' ? entry : entry?.path || entry?.name
        if (path) listing.dirs.push({ name: name || path, path })
      }
      for (const entry of fileList) { const name = typeof entry === 'string' ? nameOfPath(entry) : entry?.name || nameOfPath(entry?.path)
        const path = typeof entry === 'string' ? entry : entry?.path || entry?.name
        if (path) listing.files.push({ name: name || path, path, bytes: Number(entry?.bytes) || 0 })
      }
      const entries = listOf(raw.entries)
      for (const entry of entries) { if (!entry) continue
        const isDir =
          entry.kind === 'directory' || entry.kind === 'dir' || entry.isDirectory === true || entry.type === 'directory'
        const path = entry.path || entry.name
        if (!path) continue
        const name = entry.name || nameOfPath(path)
        if (isDir) listing.dirs.push({ name, path })
        else listing.files.push({ name, path, bytes: Number(entry.bytes) || 0 })
      }
      return listing
    }

    /** List one directory: uiWorkspace first, Host `fs.list` as the fallback. */
    async function listDirectory(ctx, path) { const workspace = service(ctx, 'uiWorkspace')
      if (workspace && typeof workspace.listDirectory === 'function') { try { return normalizeListing(await workspace.listDirectory(path))
        } catch (error) {
          /* fall through to the Host endpoint */
        }
      }
      return normalizeListing(await callHost(ctx, 'fs.list', path ? { path } : {}))
    }

    function FileBrowser(props) { const { ctx, t, mode, startPath, onPick, onClose } = props
      const [path, setPath] = useState(startPath || '')
      const [typed, setTyped] = useState(startPath || '')
      const [nonce, setNonce] = useState(0)
      const req = useRequest(ctx, (payload) => listDirectory(ctx, payload.path), { path }, [path, nonce])
      const listing = normalizeListing(req.data)

      useEffect(() => { setTyped(path)
      }, [path])

      const dirRows = listing.dirs.map((entry) =>
        h('button', { key: `d:${entry.path}`, type: 'button', className: 'dg-browser-row', onClick: () => setPath(entry.path) },
          h('span', null, `▸ ${entry.name}`), h('span', { className: 'dg-dim' }, ''),),)
      const fileRows = listing.files.map((entry) =>
        h('button', { key: `f:${entry.path}`, type: 'button', className: 'dg-browser-row', title: entry.path, onClick: () => {
              if (mode === 'file') onPick(entry.path)
              else onPick(entry.path)
            }, }, h('span', null, `· ${entry.name}`), h('span', { className: 'dg-dim' }, fmtBytes(entry.bytes)),),)

      return h(Modal, { title: mode === 'file' ? t('chooseFile') : t('chooseDir'), onClose, footer: [
            h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, t('cancel')), mode === 'dir'
              ? h(Button, { key: 'pick', variant: 'primary', onClick: () => onPick(path), disabled: !path }, t('chooseDir'))
              : null,], }, h('div', { className: 'dg-rowline' },
          h(Button, { onClick: () => setPath(listing.parent || path), disabled: !listing.parent }, t('parentDir')), h('input', { className: 'dg-input',
            value: typed, placeholder: t('goPlaceholder'), onChange: (event) => setTyped(event.target.value), onKeyDown: (event) => {
              if (event.key === 'Enter') setPath(typed.trim())
            }, }), h(Button, { onClick: () => setPath(typed.trim()) }, t('go')), h(Button, { onClick: () => setNonce(nonce + 1) }, t('refresh')),),
        req.status === 'error' ? h(Banner, { kind: 'error' }, errText(req.error)) : null,
        req.status === 'loading' && !req.data ? h(LoadingState, { label: t('loading') }) : null, req.data && dirRows.length + fileRows.length === 0
          ? h(EmptyState, { title: t('emptyDir') })
          : h('div', { className: 'dg-browser-list' }, dirRows, fileRows),)
    }

    /* ==================================================================== *
     * Tab 1 — sessions
     * ==================================================================== */

    function SessionsTab(props) { const { ctx, t, nonce, onStatus } = props
      const [query, setQuery] = useState('')
      const [debounced, setDebounced] = useState('')
      const [workspaceId, setWorkspaceId] = useState('')
      const [selectedIds, setSelectedIds] = useState([])
      const [renaming, setRenaming] = useState(null)
      const [trashing, setTrashing] = useState(null)
      const [exportOpen, setExportOpen] = useState(false)
      const [importOpen, setImportOpen] = useState(false)
      const action = useAction()

      useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 350)
        return () => clearTimeout(timer)
      }, [query])

      const list = useRequest(ctx, 'sessions.list', {}, [nonce])
      const searching = debounced.length > 0
      const search = useRequest(ctx, 'sessions.search', { query: debounced, limit: 100 }, [debounced, nonce], { enabled: searching, })

      const busy = list.status === 'loading' || (searching && search.status === 'loading')
      const primaryError = search.error || list.error
      useEffect(() => { onStatus({ status: primaryError ? 'error' : busy ? 'loading' : 'ok', at: Math.max(list.at || 0, search.at || 0),
          error: primaryError || null, })
      }, [onStatus, primaryError, busy, list.at, search.at])

      const data = list.data || {}
      const workspaces = listOf(data.workspaces)
      const sessions = listOf(data.sessions)
      const totals = data.totals || {}
      const activeWorkspace = workspaces.find((entry) => entry.id === workspaceId) || null
      const visible = useMemo(() => { const filtered = workspaceId ? sessions.filter((entry) => entry.workspaceId === workspaceId) : sessions
        return filtered.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      }, [sessions, workspaceId])

      const searchData = search.data || {}
      const hits = listOf(searchData.items)

      function toggleSelected(id) { setSelectedIds((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : prev.concat(id)))
      }

      async function openSession(session) { const workspace = service(ctx, 'uiWorkspace')
        if (!workspace || typeof workspace.openSession !== 'function') { action.setError(new Error(t('openError')))
          return
        }
        try { const result = workspace.openSession({ kind: 'session', sessionId: session.id })
          if (result && typeof result.catch === 'function') result.catch((error) => action.setError(error))
        } catch (error) { action.setError(error)
        }
      }

      async function submitRename(session) { const title = (renaming && renaming.id === session.id ? renaming.value : '').trim()
        setRenaming(null)
        if (!title) return
        await action.run(async () => { await callHost(ctx, 'sessions.rename', { sessionId: session.id, title })
          await list.reload()
        }, t('renamed'))
      }

      async function toggleArchive(session) { const archived = !session.archived
        await action.run(async () => { await callHost(ctx, 'sessions.archive', { sessionId: session.id, archived })
          await list.reload()
        }, archived ? t('archivedMsg') : t('unarchivedMsg'))
      }

      async function confirmTrash() { const session = trashing
        setTrashing(null)
        if (!session) return
        await action.run(async () => { await callHost(ctx, 'sessions.trash', { sessionIds: [session.id] })
          await list.reload()
        }, t('movedToTrash'))
      }

      const badgeNodes = (session) => { const nodes = []
        if (session.isSubagent) nodes.push(h(Badge, { key: 'sub', kind: 'idle' }, t('badgeSubagent')))
        if (session.archived) nodes.push(h(Badge, { key: 'arch', kind: 'warn' }, t('badgeArchived')))
        if (session.live) nodes.push(h(Badge, { key: 'live', kind: 'ok' }, t('badgeLive')))
        if (session.inTrash) nodes.push(h(Badge, { key: 'trash', kind: 'danger' }, t('badgeTrash')))
        return nodes
      }

      const rowActions = (session) => { if (renaming && renaming.id === session.id) { return h('div', { className: 'dg-actions', style: { opacity: 1 } },
            h(Button, { variant: 'primary', onClick: () => submitRename(session) }, t('save')),
            h(Button, { variant: 'ghost', onClick: () => setRenaming(null) }, t('cancel')),)
        }
        return h('div', { className: 'dg-actions' }, h(Button, { onClick: () => openSession(session) }, t('open')),
          h(Button, { onClick: () => setRenaming({ id: session.id, value: session.title || '' }) }, t('rename')),
          h(Button, { onClick: () => toggleArchive(session) }, session.archived ? t('unarchive') : t('archive')),
          h(Button, { variant: 'danger', onClick: () => setTrashing(session) }, t('trash')),)
      }

      const sessionRow = (session) =>
        h('div', { className: 'dg-row', key: session.id, title: session.cwd || undefined }, h('div', { className: 'dg-cell-title' },
            renaming && renaming.id === session.id
              ? h('input', { className: 'dg-input dg-inline', autoFocus: true, value: renaming.value, placeholder: t('renamePlaceholder'),
                  onChange: (event) => setRenaming({ id: session.id, value: event.target.value }), onKeyDown: (event) => {
                    if (event.key === 'Enter') submitRename(session)
                    if (event.key === 'Escape') setRenaming(null)
                  }, })
              : h('span', null, session.title || t('untitled')), h('label', { className: 'dg-check', title: t('export') }, h('input', { type: 'checkbox',
                checked: selectedIds.includes(session.id), onChange: () => toggleSelected(session.id), }),),),
          h('div', { className: 'dg-col-badges' }, badgeNodes(session)), h('div', { className: 'dg-col-num' }, fmtNum(session.messageCount)),
          h('div', { className: 'dg-col-size' }, fmtBytes(session.sizeBytes)), h('div', { className: 'dg-col-time' }, fmtRel(session.updatedAt, t)),
          rowActions(session),)

      const hitRow = (hit) =>
        h('tr', { key: hit.id, title: hit.snippet || undefined }, h('td', null, h('div', { className: 'dg-strong' }, hit.title || t('untitled'))),
          h('td', null, h('div', { className: 'dg-snippet' }, hit.snippet || '')), h('td', { className: 'dg-nowrap' }, fmtRel(hit.time, t)), h('td', null, h(
              'div', { className: 'dg-actions-cell' }, h(Button, { onClick: () => openSession(hit) }, t('open')),),),)

      const header = h('div', { className: 'dg-toolbar' }, h('input', { className: 'dg-input dg-grow', value: query, placeholder: t('searchPlaceholder'),
          'aria-label': t('search'), onChange: (event) => setQuery(event.target.value), }),
        searching ? h(Button, { variant: 'ghost', onClick: () => setQuery('') }, t('clearSearch')) : null, h('div', { className: 'dg-spacer' }),
        h(Button, { onClick: () => setExportOpen(true) }, t('export')), h(Button, { onClick: () => setImportOpen(true) }, t('import')),
        h(Button, { onClick: () => list.reload(), disabled: busy }, t('refresh')),)

      const totalsLine = h('div', { className: 'dg-totals' }, h('span', null, `${t('sessionCount')}: `, h('b', null, fmtNum(totals.sessions))),
        h('span', null, `${t('subagentCount')}: `, h('b', null, fmtNum(totals.subagents))),
        h('span', null, `${t('diskUsage')}: `, h('b', null, fmtBytes(totals.bytes))), selectedIds.length > 0
          ? h('span', null, `${t('sessionsSelected')}: `, h('b', null, fmtNum(selectedIds.length)))
          : null,)

      const sideList = h('div', { className: 'dg-side' }, h('div', { className: 'dg-side-head' }, t('workspaces')), h('div', { className: 'dg-side-list' },
          h('button', { type: 'button', className: 'dg-side-row', 'data-active': workspaceId === '' ? 'true' : undefined, onClick: () => setWorkspaceId(''), },
            h('div', { className: 'dg-side-title' }, h('span', null, t('allSessions')), h('span', { className: 'dg-count' }, fmtNum(sessions.length))),
            h('div', { className: 'dg-side-path' }, '—'),), workspaces.map((workspace) =>
            h('button', { key: workspace.id, type: 'button', className: 'dg-side-row', 'data-active': workspaceId === workspace.id ? 'true' : undefined,
                title: workspace.path || undefined, onClick: () => setWorkspaceId(workspace.id), }, h('div', { className: 'dg-side-title' },
                h('span', null, workspace.title || t('untitled')), h('span', { className: 'dg-count' }, fmtNum(listOf(workspace.sessionIds).length)),),
              h('div', { className: 'dg-side-path' }, workspace.path || '—'),),),),)

      const listHead = h('div', { className: 'dg-rowhead' }, h('div', { className: 'dg-cell-title' }, t('title')),
        h('div', { className: 'dg-col-badges' }, t('status')), h('div', { className: 'dg-col-num' }, t('messages')),
        h('div', { className: 'dg-col-size' }, t('size')), h('div', { className: 'dg-col-time' }, t('lastActivity')), h('div', { className: 'dg-actions' }),)

      const sessionList =
        list.status === 'error'
          ? h(Banner, { kind: 'error' }, errText(list.error))
          : !list.data
            ? h(LoadingState, { label: t('loading') })
            : visible.length === 0
              ? h('div', { className: 'dg-panel' }, listHead, h(EmptyState, { title: t('noSessions'), hint: t('noSessionsHint') }),)
              : h('div', { className: 'dg-panel' }, listHead, visible.map(sessionRow))

      const searchList = h('div', null, search.status === 'error' ? h(Banner, { kind: 'error' }, errText(search.error)) : null,
        search.status === 'loading' && !search.data ? h(LoadingState, { label: t('loading') }) : null, search.data
          ? h('div', null, h('div', { className: 'dg-totals' }, h('span', null, `${t('searchScanned')}: `, h('b', null, fmtNum(searchData.scanned))),
                h('span', null, `${t('title')}: `, h('b', null, fmtNum(hits.length))), searchData.truncated ? h(Badge, { kind: 'warn' }, t('searchTruncated')) : null,
              ), h(DataTable, { headers: [{ label: t('title'), width: '40%' }, { label: t('snippet') }, { label: t('lastActivity'), width: '110px' },
                  { label: '', width: '80px' },], children: hits.map(hitRow), empty: t('empty'), emptyHint: t('emptyHint'), }),)
          : null,)

      return h('div', null, header, totalsLine, action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null, searching
          ? searchList
          : h('div', { className: 'dg-split' }, sideList, h('div', { className: 'dg-main' }, sessionList)), trashing
          ? h(ConfirmDialog, { title: t('trashConfirmTitle'), text: t('trashConfirmBody'), confirmLabel: t('trash'), cancelLabel: t('cancel'),
              destructive: false, busy: action.busy, onConfirm: confirmTrash, onClose: () => setTrashing(null),
              children: h('div', { className: 'dg-strong' }, trashing.title || t('untitled')), })
          : null, exportOpen
          ? h(ExportDialog, { ctx, t, sessions, activeWorkspace, selectedIds, onClose: () => setExportOpen(false), })
          : null, importOpen
          ? h(ImportDialog, { ctx, t, activeWorkspace, onClose: () => setImportOpen(false), onImported: () => { list.reload()
                search.reload()
              }, })
          : null,)
    }

    /* ---- export dialog ---- */

    function ExportDialog(props) { const { ctx, t, sessions, activeWorkspace, selectedIds, onClose } = props
      const [scope, setScope] = useState(activeWorkspace ? 'workspace' : 'all')
      const [outDir, setOutDir] = useState(MEMORY.exportDir || '')
      const [fileName, setFileName] = useState('')
      const [includeAttachments, setIncludeAttachments] = useState(true)
      const [result, setResult] = useState(null)
      const [browsing, setBrowsing] = useState(false)
      const action = useAction()

      async function browse() { if (!canPickDirectory(ctx)) { setBrowsing(true)
          return
        }
        try { const picked = await pickDirectory(ctx)
          if (picked) { setOutDir(picked)
            MEMORY.exportDir = picked
          }
        } catch (error) { action.setError(error)
        }
      }

      async function submit() { const dir = outDir.trim()
        if (!dir) { action.setError(new Error(t('needOutDir')))
          return
        }
        const payload = { scope, outDir: dir, includeAttachments }
        if (fileName.trim()) payload.fileName = fileName.trim()
        if (scope === 'workspace') { if (!activeWorkspace) { action.setError(new Error(t('needWorkspace')))
            return
          }
          payload.scope = 'workspace'
          payload.workspaceId = activeWorkspace.id
        } else if (scope === 'selected') { if (selectedIds.length === 0) { action.setError(new Error(t('needSelection')))
            return
          }
          payload.scope = 'sessions'
          payload.sessionIds = selectedIds.slice()
        } else { payload.scope = 'sessions'
          payload.sessionIds = sessions.map((entry) => entry.id)
        }
        const value = await action.run(() => callHost(ctx, 'export.run', payload), null)
        if (value) { setResult(value)
          MEMORY.exportDir = dir
        }
      }

      return h(Modal, { title: t('exportTitle'), onClose, footer: [h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, t('cancel')),
            h(Button, { key: 'run', variant: 'primary', disabled: action.busy, onClick: submit }, t('runExport')),], },
        h(Banner, { kind: 'info' }, `${t('exportScope')}: ${t('scopeWorkspace')} / ${t('scopeSelected')} / ${t('scopeAll')}`), h('div',
          { className: 'dg-radios' }, h('label', { className: 'dg-check' }, h('input', { type: 'radio', name: 'dg-export-scope', checked: scope === 'workspace',
              onChange: () => setScope('workspace'), }), h('span', null, `${t('scopeWorkspace')}${activeWorkspace ? ` · ${activeWorkspace.title}` : ''}`),), h(
            'label', { className: 'dg-check' }, h('input', { type: 'radio', name: 'dg-export-scope', checked: scope === 'selected',
              onChange: () => setScope('selected'), }), h('span', null, `${t('scopeSelected')} (${selectedIds.length})`),), h('label', { className: 'dg-check' },
            h('input', { type: 'radio', name: 'dg-export-scope', checked: scope === 'all', onChange: () => setScope('all'), }),
            h('span', null, `${t('scopeAll')} (${sessions.length})`),),), h(Field, { label: t('outDir') }, h('div', { className: 'dg-rowline' }, h('input', {
              className: 'dg-input', value: outDir, placeholder: 'D:\\dsh-exports', onChange: (event) => setOutDir(event.target.value), }),
            h(Button, { onClick: browse }, t('browse')),),), h(Field, { label: t('fileName'), hint: t('fileNameHint') }, h('input', { className: 'dg-input',
          value: fileName, onChange: (event) => setFileName(event.target.value), })),
        h(Checkbox, { checked: includeAttachments, onChange: setIncludeAttachments, label: t('includeAttachments') }),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null, result
          ? h(Banner, { kind: 'ok' }, h('div', null, t('exportDone')), h('div', null, `${t('exportPath')}: ${result.path || '—'}`), h('div', null,
                `${t('size')}: ${fmtBytes(result.bytes)} · ${t('sessionCount')}: ${fmtNum(result.sessions)} · ${t('importAttachments')}: ${fmtNum(result.attachments)}`,
              ),)
          : null, browsing
          ? h(FileBrowser, { ctx, t, mode: 'dir', startPath: outDir, onPick: (picked) => { setOutDir(picked)
                MEMORY.exportDir = picked
                setBrowsing(false)
              }, onClose: () => setBrowsing(false), })
          : null,)
    }

    /* ---- import dialog ---- */

    function ImportDialog(props) { const { ctx, t, activeWorkspace, onClose, onImported } = props
      const [filePath, setFilePath] = useState(MEMORY.importFile || '')
      const [targetPath, setTargetPath] = useState(MEMORY.importTarget || (activeWorkspace ? activeWorkspace.path : '') || '')
      const [snapshot, setSnapshot] = useState(true)
      const [inspectResult, setInspectResult] = useState(null)
      const [runResult, setRunResult] = useState(null)
      const [browsing, setBrowsing] = useState(null)
      const action = useAction()

      async function inspect() { if (!filePath.trim()) { action.setError(new Error(t('needPackage')))
          return
        }
        setRunResult(null)
        const value = await action.run(() => callHost(ctx, 'import.inspect', { filePath: filePath.trim() }), null)
        if (value) { setInspectResult(value)
          MEMORY.importFile = filePath.trim()
        }
      }

      async function submit() { if (!filePath.trim()) { action.setError(new Error(t('needPackage')))
          return
        }
        if (!targetPath.trim()) { action.setError(new Error(t('needTarget')))
          return
        }
        const value = await action.run(() => callHost(ctx, 'import.run', { filePath: filePath.trim(), targetPath: targetPath.trim(), snapshot }), null,)
        if (value) { setRunResult(value)
          MEMORY.importTarget = targetPath.trim()
          if (typeof onImported === 'function') onImported()
        }
      }

      const inspected = inspectResult || {}
      const imported = listOf(runResult && runResult.imported)

      return h(Modal, { title: t('importTitle'), onClose, footer: [h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, t('cancel')),
            h(Button, { key: 'inspect', disabled: action.busy, onClick: inspect }, t('inspect')),
            h(Button, { key: 'run', variant: 'primary', disabled: action.busy, onClick: submit }, t('runImport')),], }, h(Field, { label: t('packagePath') }, h(
            'div', { className: 'dg-rowline' }, h('input', { className: 'dg-input', value: filePath, placeholder: 'D:\\dsh-exports\\session.zip',
              onChange: (event) => setFilePath(event.target.value), }), h(Button, { onClick: () => setBrowsing('file') }, t('browse')),),), inspectResult
          ? h('div', { className: 'dg-section' }, h('div', { className: 'dg-section-head' }, h('h4', { className: 'dg-section-title' }, t('inspect')),
                h(Badge, { kind: inspected.compatible ? 'ok' : 'danger' }, inspected.compatible ? t('importCompatible') : t('importIncompatible')),), h('div',
                { className: 'dg-kv' }, h('span', null, t('importVersion')), h('b', null, inspected.dshVersion || '—'),), h('div', { className: 'dg-kv' },
                h('span', null, t('importSessions')), h('b', null, fmtNum(listOf(inspected.sessions).length)),), h('div', { className: 'dg-kv' },
                h('span', null, t('importAttachments')), h('b', null, fmtNum(inspected.attachments)),), listOf(inspected.warnings).length > 0
                ? h(Banner, { kind: 'warn' }, h('div', null, t('importWarnings')),
                    listOf(inspected.warnings).map((warning, index) => h('div', { key: index }, `· ${warning}`)),)
                : null, h('div', { className: 'dg-plainlist' }, listOf(inspected.sessions).map((entry, index) =>
                  h('div', { key: index, className: 'dg-listitem' }, h('div', { className: 'dg-strong' }, entry.title || entry.id), h('div', { className: 'dg-dim' },
                      `${t('messages')}: ${fmtNum(entry.messageCount)} · ${t('importAttachments')}: ${fmtNum(entry.attachmentCount)}`,),),),),)
          : null, h(Field, { label: t('targetPath'), hint: t('targetPathHint') }, h('div', { className: 'dg-rowline' }, h('input', { className: 'dg-input',
              value: targetPath, onChange: (event) => setTargetPath(event.target.value), }), h(Button, { onClick: () => setBrowsing('dir') }, t('browse')),),),
        h(Checkbox, { checked: snapshot, onChange: setSnapshot, label: t('snapshotBefore') }),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null, runResult
          ? h('div', { className: 'dg-section' }, h('div', { className: 'dg-section-head' }, h('h4', { className: 'dg-section-title' }, t('importResult'))),
              runResult.snapshotId
                ? h('div', { className: 'dg-dim' }, `${t('snapshotTaken')}: ${runResult.snapshotId}`)
                : null, imported.length === 0
                ? h(EmptyState, { title: t('importNoResult') })
                : h(DataTable, { headers: [{ label: t('sourceId') }, { label: t('newId') }, { label: t('title') }], children: imported.map((entry) =>
                        h('tr', { key: `${entry.sourceId}:${entry.newId}` }, h('td', { className: 'dg-mono' }, entry.sourceId || '—'),
                          h('td', { className: 'dg-mono' }, entry.newId || '—'), h('td', null, entry.title || '—'),),), },), listOf(runResult.skipped).length > 0
                ? h(Banner, { kind: 'warn' }, h('div', null, t('skipped')), listOf(runResult.skipped).map((entry, index) => h('div', { key: index }, `· ${entry}`)),)
                : null,)
          : null, browsing
          ? h(FileBrowser, { ctx, t, mode: browsing, startPath: browsing === 'file' ? filePath : targetPath, onPick: (picked) => { if (browsing === 'file') {
                  setFilePath(picked)
                  MEMORY.importFile = picked
                } else { setTargetPath(picked)
                  MEMORY.importTarget = picked
                }
                setBrowsing(null)
              }, onClose: () => setBrowsing(null), })
          : null,)
    }

    /* ==================================================================== *
     * Tab 2 — recycle bin
     * ==================================================================== */

    function sourceLabel(source, t) { if (source === 'safe-delete') return t('sourceSafeDelete')
      if (source === 'import-guard') return t('sourceImportGuard')
      if (source === 'manual') return t('sourceManual')
      return t('sourcePanel')
    }

    function TrashTab(props) { const { ctx, t, nonce, onStatus } = props
      const list = useRequest(ctx, 'trash.list', {}, [nonce])
      const [checked, setChecked] = useState([])
      const [purging, setPurging] = useState(null)
      const action = useAction()

      useEffect(() => { onStatus({ status: list.error ? 'error' : list.status, at: list.at || 0, error: list.error || null })
      }, [onStatus, list.error, list.status, list.at])

      const data = list.data || {}
      const items = listOf(data.items)
      const allChecked = items.length > 0 && checked.length === items.length

      function toggle(id) { setChecked((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : prev.concat(id)))
      }

      async function restoreSelected() { if (checked.length === 0) return
        await action.run(async () => { const result = await callHost(ctx, 'trash.restore', { ids: checked.slice() })
          setChecked([])
          await list.reload()
          return result
        }, t('restoreDone'))
      }

      async function sweep() { await action.run(async () => { const result = await callHost(ctx, 'trash.sweep', {})
          await list.reload()
          return result
        }, (result) => `${t('swept')}: ${fmtNum(listOf(result && result.purged).length)}`)
      }

      const rows = items.map((entry) =>
        h('tr', { key: entry.id }, h('td', { style: { width: '28px' } }, h('input', { type: 'checkbox', checked: checked.includes(entry.id),
              onChange: () => toggle(entry.id), 'aria-label': entry.id, style: { accentColor: 'var(--dsw-alias-brand-primary)' }, }),), h('td', null,
            h('div', { className: 'dg-strong' }, listOf(entry.titles).filter(Boolean).join(' / ') || t('untitled')), h('div', { className: 'dg-dim' },
              `${t('sessionEntries')}: ${fmtNum(listOf(entry.sessionIds).length)} · ${listOf(entry.originalPaths).join(' ; ') || '—'}`,),),
          h('td', { className: 'dg-nowrap' }, sourceLabel(entry.source, t)), h('td', { className: 'dg-num' }, fmtBytes(entry.sizeBytes)),
          h('td', { className: 'dg-nowrap' }, fmtTime(entry.movedAt)),
          h('td', { className: 'dg-nowrap' }, entry.expiresAt ? fmtDay(entry.expiresAt) : t('forever')),),)

      return h('div', null, h(Banner, { kind: 'info' }, t('trashHint')), h('div', { className: 'dg-toolbar', style: { marginTop: '10px' } },
          h(Button, { variant: 'primary', disabled: checked.length === 0 || action.busy, onClick: restoreSelected }, `${t('restoreSelected')} (${checked.length})`),
          h(Button, { variant: 'danger', disabled: checked.length === 0, onClick: () => setPurging(checked.slice()) }, `${t('purgeSelected')} (${checked.length})`),
          h(Button, { onClick: sweep, disabled: action.busy }, t('sweep')), h('div', { className: 'dg-spacer' }),
          h('span', { className: 'dg-hint' }, `${t('retentionDays')}: ${fmtNum(data.retentionDays)}`),
          h('span', { className: 'dg-hint' }, `${t('dueCount')}: ${fmtNum(data.dueCount)}`),
          h('span', { className: 'dg-hint' }, `${t('totalBytes')}: ${fmtBytes(data.totalBytes)}`),
          h(Button, { onClick: () => list.reload(), disabled: list.status === 'loading' }, t('refresh')),),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null, list.status === 'error'
          ? h(Banner, { kind: 'error' }, errText(list.error))
          : !list.data
            ? h(LoadingState, { label: t('loading') })
            : h(DataTable, { headers: [{ label: h('input', { type: 'checkbox', checked: allChecked,
                        onChange: (event) => setChecked(event.target.checked ? items.map((entry) => entry.id) : []), style: { accentColor: 'var(--dsw-alias-brand-primary)' },
                      }), width: '28px', }, { label: t('title') }, { label: t('trashSource'), width: '96px' }, { label: t('size'), width: '90px' },
                    { label: t('movedAt'), width: '150px' }, { label: t('expiresAt'), width: '110px' },], empty: t('trashEmpty'), emptyHint: t('trashEmptyHint'),
                  children: rows, },), purging
          ? h(PurgeDialog, { ctx, t, ids: purging, onClose: () => setPurging(null), onDone: (result) => { setPurging(null)
                setChecked([])
                action.setNotice(`${t('purgedDone')} · ${t('freedBytes')}: ${fmtBytes(result && result.freedBytes)}`)
                list.reload()
              }, })
          : null,)
    }

    function PurgeDialog(props) { const { ctx, t, ids, onClose, onDone } = props
      const preview = useRequest(ctx, 'trash.previewPurge', { ids }, [ids.join('|')])
      const [ack, setAck] = useState(false)
      const action = useAction()
      const data = preview.data || {}
      const items = listOf(data.items)

      async function submit() { const value = await action.run(() => callHost(ctx, 'trash.purge', { ids, confirm: true }), null)
        if (value) onDone(value)
      }

      return h(Modal, { title: t('purgeTitle'), onClose, footer: [h(Button, { key: 'cancel', variant: 'ghost', onClick: onClose }, t('cancel')), h(Button,
              { key: 'purge', variant: 'danger-solid', disabled: !ack || action.busy, onClick: submit }, t('confirmPurge'),),], },
        h(Banner, { kind: 'error' }, t('purgeWarning')), preview.status === 'error' ? h(Banner, { kind: 'error' }, errText(preview.error)) : null,
        preview.status === 'loading' && !preview.data ? h(LoadingState, { label: t('loading') }) : null, items.length > 0
          ? h('div', { className: 'dg-plainlist' }, items.map((entry) =>
                h('div', { key: entry.id, className: 'dg-listitem' },
                  h('div', { className: 'dg-strong' }, listOf(entry.titles).filter(Boolean).join(' / ') || entry.id),
                  h('div', { className: 'dg-dim' }, `${fmtBytes(entry.sizeBytes)} · ${listOf(entry.paths).join(' ; ')}`),),),)
          : null, h('div', { className: 'dg-kv' }, h('span', null, t('totalBytes')), h('b', null, fmtBytes(data.totalBytes))),
        h('div', { className: 'dg-hint' }, t('purgeAttachmentsSafe')), action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        h(Checkbox, { checked: ack, onChange: setAck, label: t('purgeAck') }),)
    }

    /* ==================================================================== *
     * Tab 3 — snapshots
     * ==================================================================== */

    function snapshotKindLabel(kind, t) { if (kind === 'auto-before-restore') return t('kindBeforeRestore')
      if (kind === 'auto-with-backup') return t('kindWithBackup')
      return t('kindManual')
    }

    function SnapshotsTab(props) { const { ctx, t, nonce, onStatus } = props
      const list = useRequest(ctx, 'snapshot.list', {}, [nonce])
      const [label, setLabel] = useState('')
      const [modules, setModules] = useState({ pluginSources: true, skills: true, uiPrefs: true, credentials: false })
      const [diffId, setDiffId] = useState(null)
      const [restoring, setRestoring] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const action = useAction()

      useEffect(() => { onStatus({ status: list.error ? 'error' : list.status, at: list.at || 0, error: list.error || null })
      }, [onStatus, list.error, list.status, list.at])

      const data = list.data || {}
      const items = listOf(data.items)

      function setModule(key, value) { setModules((prev) => ({ ...prev, [key]: value }))
      }

      async function create() { const payload = { include: { ...modules } }
        if (label.trim()) payload.label = label.trim()
        const value = await action.run(async () => { const created = await callHost(ctx, 'snapshot.create', payload)
          await list.reload()
          return created
        }, t('snapshotCreated'))
        if (value) setLabel('')
      }

      async function confirmRestore() { const target = restoring
        setRestoring(null)
        if (!target) return
        await action.run(async () => { const result = await callHost(ctx, 'snapshot.restore', { id: target.id })
          await list.reload()
          return result
        }, (result) =>
          result && result.preRestoreSnapshotId
            ? `${t('restoredSnapshot')} · ${t('preRestoreSnapshot')}: ${result.preRestoreSnapshotId}`
            : t('restoredSnapshot'),)
      }

      async function confirmDelete() { const target = deleting
        setDeleting(null)
        if (!target) return
        await action.run(async () => { await callHost(ctx, 'snapshot.delete', { id: target.id })
          await list.reload()
        }, t('snapshotDeleted'))
      }

      const rows = items.map((entry) =>
        h('tr', { key: entry.id }, h('td', null, h('div', { className: 'dg-strong' }, entry.label || entry.id),
            h('div', { className: 'dg-dim dg-mono' }, entry.id),), h('td', { className: 'dg-nowrap' }, fmtTime(entry.createdAt)),
          h('td', { className: 'dg-nowrap' }, snapshotKindLabel(entry.kind, t)), h('td', { className: 'dg-num' }, fmtBytes(entry.bytes)),
          h('td', { className: 'dg-num' }, fmtNum(listOf(entry.files).length)), h('td', null,
            entry.includesSecrets ? h(Badge, { kind: 'danger' }, t('snapshotSecrets')) : h(Badge, null, t('no')),), h('td', null, h('div',
              { className: 'dg-actions-cell' }, h(Button, { onClick: () => setDiffId(entry.id) }, t('snapshotDiff')),
              h(Button, { onClick: () => setRestoring(entry) }, t('snapshotRestore')),
              h(Button, { variant: 'danger', onClick: () => setDeleting(entry) }, t('snapshotDelete')),),),),)

      return h('div', null, h('div', { className: 'dg-section' }, h('div', { className: 'dg-section-head' },
            h('h4', { className: 'dg-section-title' }, t('snapshotNow')),
            h('span', { className: 'dg-hint' }, `${t('snapshotRetention')}: ${fmtNum(data.retention)}`),), h('div', { className: 'dg-grid' }, h(Field,
              { label: t('snapshotLabel') }, h('input', { className: 'dg-input', value: label, placeholder: t('snapshotLabelPlaceholder'),
                onChange: (event) => setLabel(event.target.value), }),), h(Field, { label: t('snapshotModules') }, h('div', { className: 'dg-inline-gap' },
                h(Checkbox, { checked: modules.pluginSources, onChange: (value) => setModule('pluginSources', value), label: t('modPluginSources'), }), h(Checkbox, {
                  checked: modules.skills, onChange: (value) => setModule('skills', value), label: t('modSkills'), }), h(Checkbox, { checked: modules.uiPrefs,
                  onChange: (value) => setModule('uiPrefs', value), label: t('modUiPrefs'), }), h(Checkbox, { checked: modules.credentials,
                  onChange: (value) => setModule('credentials', value), label: t('modCredentials'), }),),), modules.credentials
              ? h('div', { className: 'dg-hint dg-danger dg-span2' }, t('credentialsNote'))
              : null,), h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } },
            h(Button, { variant: 'primary', disabled: action.busy, onClick: create }, t('snapshotNow')),
            h(Button, { onClick: () => list.reload(), disabled: list.status === 'loading' }, t('refresh')),),),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null, list.status === 'error'
          ? h(Banner, { kind: 'error' }, errText(list.error))
          : !list.data
            ? h(LoadingState, { label: t('loading') })
            : h(DataTable, { headers: [{ label: t('snapshotLabel') }, { label: t('snapshotTime'), width: '150px' }, { label: t('snapshotKind'), width: '120px' },
                    { label: t('size'), width: '90px' }, { label: t('snapshotFiles'), width: '80px' }, { label: t('snapshotSecrets'), width: '90px' },
                    { label: '', width: '250px' },], empty: t('snapshotEmpty'), emptyHint: t('snapshotEmptyHint'), children: rows, },),
        diffId ? h(SnapshotDiffDialog, { ctx, t, id: diffId, onClose: () => setDiffId(null) }) : null, restoring
          ? h(ConfirmDialog, { title: t('restoreTitle'), text: t('restoreBody'), confirmLabel: t('restoreConfirm'), cancelLabel: t('cancel'), destructive: true,
              busy: action.busy, onConfirm: confirmRestore, onClose: () => setRestoring(null),
              children: h('div', { className: 'dg-strong' }, restoring.label || restoring.id), })
          : null, deleting
          ? h(ConfirmDialog, { title: t('deleteSnapshotTitle'), text: t('deleteSnapshotBody'), confirmLabel: t('snapshotDelete'), cancelLabel: t('cancel'),
              destructive: true, busy: action.busy, onConfirm: confirmDelete, onClose: () => setDeleting(null),
              children: h('div', { className: 'dg-strong' }, deleting.label || deleting.id), })
          : null,)
    }

    function SnapshotDiffDialog(props) { const { ctx, t, id, onClose } = props
      const req = useRequest(ctx, 'snapshot.diff', { id }, [id])
      const [expanded, setExpanded] = useState([])
      const data = req.data || {}
      const files = listOf(data.files)
      const plugins = data.plugins || { added: [], removed: [], changed: [] }
      const counts = { added: 0, removed: 0, changed: 0 }
      for (const file of files) { if (file.kind === 'added') counts.added += 1
        else if (file.kind === 'removed') counts.removed += 1
        else counts.changed += 1
      }

      return h(Modal, { title: `${t('diffTitle')} · ${id}`, onClose, footer: [h(Button, { key: 'close', onClick: onClose }, t('close'))], },
        req.status === 'error' ? h(Banner, { kind: 'error' }, errText(req.error)) : null,
        req.status === 'loading' && !req.data ? h(LoadingState, { label: t('loading') }) : null, req.data
          ? h('div', null, h('div', { className: 'dg-totals', style: { marginBottom: '8px' } },
                h('span', null, `${t('diffAdded')}: `, h('b', null, fmtNum(counts.added))),
                h('span', null, `${t('diffRemoved')}: `, h('b', null, fmtNum(counts.removed))),
                h('span', null, `${t('diffChanged')}: `, h('b', null, fmtNum(counts.changed))),),
              data.currentIsNewer ? h(Banner, { kind: 'warn' }, t('diffCurrentNewer')) : null,
              listOf(plugins.added).length + listOf(plugins.removed).length + listOf(plugins.changed).length > 0
                ? h('div', { className: 'dg-section' }, h('div', { className: 'dg-section-title' }, t('diffPlugins')),
                    listOf(plugins.added).map((entry, index) => h('div', { key: `pa${index}`, className: 'dg-dim' }, `+ ${entry}`)),
                    listOf(plugins.removed).map((entry, index) => h('div', { key: `pr${index}`, className: 'dg-dim' }, `- ${entry}`)),
                    listOf(plugins.changed).map((entry, index) =>
                      h('div', { key: `pc${index}`, className: 'dg-dim' }, `~ ${entry && entry.id}: ${listOf(entry && entry.keys).join(', ')}`),),)
                : null, files.length === 0
                ? h(EmptyState, { title: t('diffNoFiles') })
                : h('div', { className: 'dg-plainlist' }, files.map((file, index) => { const open = expanded.includes(index)
                      return h('div', { key: `${file.path}:${index}`, className: 'dg-listitem' }, h('div', { className: 'dg-rowline' },
                          h(Badge, { kind: file.kind === 'removed' ? 'danger' : file.kind === 'added' ? 'ok' : 'warn' }, file.kind),
                          h('span', { className: 'dg-mono', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' } }, file.path),
                          h('span', { className: 'dg-dim' }, `+${fmtNum(file.addedLines)} / -${fmtNum(file.removedLines)}`), file.patch
                            ? h(Button, { variant: 'ghost', onClick: () =>
                                    setExpanded((prev) => (open ? prev.filter((entry) => entry !== index) : prev.concat(index))), }, open ? t('patchHide') : t('patchShow'),)
                            : null,), open && file.patch ? h('pre', { className: 'dg-pre' }, file.patch) : null,)
                    }),),)
          : null,)
    }

    /* ==================================================================== *
     * Tab 4 — backups
     * ==================================================================== */

    function BackupsTab(props) { const { ctx, t, nonce, onStatus } = props
      const list = useRequest(ctx, 'backup.list', {}, [nonce])
      const status = useRequest(ctx, 'status', {}, [nonce])
      const [restoring, setRestoring] = useState(null)
      const [revealed, setRevealed] = useState(null)
      const action = useAction()

      useEffect(() => { onStatus({ status: list.error ? 'error' : list.status, at: Math.max(list.at || 0, status.at || 0), error: list.error || null, })
      }, [onStatus, list.error, list.status, list.at, status.at])

      const data = list.data || {}
      const items = listOf(data.items)
      const latest = items[0] || null
      const st = status.data || {}
      const retention = data.retention || {}

      async function runBackup() { const value = await action.run(async () => { const entry = await callHost(ctx, 'backup.run', { kind: 'manual' })
          await list.reload()
          status.reload()
          return entry
        }, t('backupCreated'))
        if (value) action.setNotice(`${t('backupCreated')} · ${fmtBytes(value.bytes)} · ${shortSha(value.sha256)}`)
      }

      async function openDirectory() { const target = latest
        if (!target) { action.setNotice(`${t('backupRoot')}: ${data.backupRoot || st.backupRoot || '—'}`)
          return
        }
        await action.run(async () => { const result = await callHost(ctx, 'backup.reveal', { id: target.id })
          setRevealed(result)
          return result
        }, null)
      }

      async function verify(entry) { const value = await action.run(() => callHost(ctx, 'backup.verify', { id: entry.id }), null)
        if (value) { action.setNotice(value.ok ? `${t('verifyOk')} · ${shortSha(value.actual)}` : `${t('verifyFail')} · ${shortSha(value.actual)}`)
          list.reload()
        }
      }

      async function confirmRestore() { const target = restoring
        setRestoring(null)
        if (!target) return
        await action.run(async () => { const result = await callHost(ctx, 'backup.restore', { id: target.id, confirm: true })
          await list.reload()
          status.reload()
          return result
        }, (result) =>
          result && result.rescanRequired
            ? `${t('backupRestored')} · ${t('rescanRequired')}`
            : t('backupRestored'),)
      }

      const rows = items.map((entry) =>
        h('tr', { key: entry.id }, h('td', null, h('div', { className: 'dg-strong' }, fmtTime(entry.createdAt)),
            h('div', { className: 'dg-dim dg-mono' }, entry.path || entry.id),),
          h('td', { className: 'dg-nowrap' }, entry.kind === 'scheduled' ? t('backupScheduled') : t('backupManual')),
          h('td', { className: 'dg-num' }, fmtBytes(entry.bytes)), h('td', { className: 'dg-mono' }, shortSha(entry.sha256)), h('td', { className: 'dg-dim' },
            `${t('tabSessions')} ${fmtNum(entry.contents && entry.contents.sessions)} · ${t('tabSnapshots')} ${fmtNum(entry.contents && entry.contents.snapshots)} · ${t('importAttachments')} ${fmtNum(entry.contents && entry.contents.attachments)}`,
          ), h('td', null, entry.verified === true
              ? h(Badge, { kind: 'ok' }, t('verified'))
              : entry.verified === false
                ? h(Badge, { kind: 'danger' }, t('verifyFail'))
                : h(Badge, null, t('verifyNever')),), h('td', null, h('div', { className: 'dg-actions-cell' },
              h(Button, { onClick: () => verify(entry), disabled: action.busy }, t('verify')),
              h(Button, { variant: 'danger', onClick: () => setRestoring(entry) }, t('backupRestore')),),),),)

      return h('div', null, h('div', { className: 'dg-toolbar' },
          h(Button, { variant: 'primary', disabled: action.busy, onClick: runBackup }, action.busy ? t('backupRunning') : t('backupNow')),
          h(Button, { onClick: openDirectory }, t('openBackupDir')), h('div', { className: 'dg-spacer' }),
          h(Button, { onClick: () => list.reload(), disabled: list.status === 'loading' }, t('refresh')),), h('div', { className: 'dg-totals' },
          h('span', null, `${t('backupRoot')}: `, h('b', null, data.backupRoot || st.backupRoot || '—')),
          h('span', null, `${t('nextBackup')}: `, h('b', null, st.nextBackupAt ? fmtTime(st.nextBackupAt) : t('intervalOff'))),
          h('span', null, `${t('lastBackup')}: `, h('b', null, st.lastBackupAt ? fmtRel(st.lastBackupAt, t) : t('never'))), h('span', null,
            `${t('backupRetention')}: `,
            h('b', null, `${t('settingsFullRetention')} ${fmtNum(retention.full)} · ${t('settingsSnapshotRetention')} ${fmtNum(retention.snapshots)}`),),), h(
          'div', { className: 'dg-dim', style: { marginBottom: '10px' } }, `${t('rescuePath')}: `,
          h('span', { className: 'dg-code' }, (latest && latest.rescuePath) || t('rescueNone')),),
        revealed ? h(Banner, { kind: 'info' }, `${t('backupRoot')}: ${revealed.path || '—'} · ${t('rescuePath')}: ${revealed.rescuePath || '—'}`) : null,
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null, list.status === 'error'
          ? h(Banner, { kind: 'error' }, errText(list.error))
          : !list.data
            ? h(LoadingState, { label: t('loading') })
            : h(DataTable, { headers: [{ label: t('snapshotTime') }, { label: t('backupKind'), width: '80px' }, { label: t('size'), width: '90px' },
                    { label: t('sha256'), width: '130px' }, { label: t('backupContents') }, { label: t('status'), width: '110px' }, { label: '', width: '180px' },],
                  empty: t('backupEmpty'), emptyHint: t('backupEmptyHint'), children: rows, },), restoring
          ? h(ConfirmDialog, { title: t('backupRestoreTitle'), text: t('backupRestoreWarning'), confirmLabel: t('backupRestoreConfirm'),
              cancelLabel: t('cancel'), destructive: true, busy: action.busy, onConfirm: confirmRestore, onClose: () => setRestoring(null),
              children: h('div', { className: 'dg-strong' }, restoring.path || restoring.id), })
          : null,)
    }

    /* ==================================================================== *
     * Tab 5 — settings (+ audit)
     * ==================================================================== */

    const INTERVAL_OPTIONS = [{ value: '0', key: 'intervalOff' }, { value: '1', key: 'interval1h' }, { value: '6', key: 'interval6h' },
      { value: '12', key: 'interval12h' }, { value: '24', key: 'interval24h' }, { value: '168', key: 'interval7d' },
      { value: 'custom', key: 'intervalCustom' },]

    function changedKeys(draft, baseline) { if (!draft || !baseline) return []
      const keys = new Set(Object.keys(draft).concat(Object.keys(baseline)))
      const changed = []
      keys.forEach((key) => { const next = draft[key]
        const prev = baseline[key]
        if (!(next === prev || (next == null && prev == null))) changed.push(key)
      })
      return changed
    }

    function SettingsTab(props) { const { ctx, t, nonce, onStatus } = props
      const req = useRequest(ctx, 'settings.get', {}, [nonce])
      const [draft, setDraft] = useState(null)
      const [baseline, setBaseline] = useState(null)
      const [auditOpen, setAuditOpen] = useState(false)
      const [browsing, setBrowsing] = useState(false)
      const action = useAction()

      useEffect(() => { onStatus({ status: req.error ? 'error' : req.status, at: req.at || 0, error: req.error || null })
      }, [onStatus, req.error, req.status, req.at])

      useEffect(() => { const loaded = req.data && req.data.settings
        if (loaded) { setDraft({ ...loaded })
          setBaseline({ ...loaded })
        }
      }, [req.data])

      const changed = useMemo(() => changedKeys(draft, baseline), [draft, baseline])
      const known = ['0', '1', '6', '12', '24', '168']

      function update(key, value) { setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
      }

      async function browseRoot() { if (!canPickDirectory(ctx)) { setBrowsing(true)
          return
        }
        try { const picked = await pickDirectory(ctx)
          if (picked) update('backupRoot', picked)
        } catch (error) { action.setError(error)
        }
      }

      async function save() { if (!draft) return
        if (changed.length === 0) { action.setNotice(t('settingsNoChanges'))
          return
        }
        const patch = {}
        for (const key of changed) patch[key] = draft[key]
        const value = await action.run(() => callHost(ctx, 'settings.update', { patch }), t('settingsSaved'))
        if (value && value.settings) { setDraft({ ...value.settings })
          setBaseline({ ...value.settings })
        } else if (value) { setBaseline({ ...draft })
        }
      }

      if (req.status === 'error') { return h('div', null, h(Banner, { kind: 'error' }, `${t('settingsLoadFailed')}: ${errText(req.error)}`),
          h(Button, { onClick: () => req.reload() }, t('retry')),)
      }
      if (!draft) return h(LoadingState, { label: t('loading') })

      const source = req.data || {}
      const intervalValue = draft.backupCron
        ? 'custom'
        : known.includes(String(draft.backupIntervalHours))
          ? String(draft.backupIntervalHours)
          : 'custom'

      return h('div', null, h('div', { className: 'dg-section' },
          h('div', { className: 'dg-section-head' }, h('h4', { className: 'dg-section-title' }, t('settingsBackupRoot')), h('span', { className: 'dg-hint' }, `${changed.length} ${t('settingsChanged')}`)),
          h('div', { className: 'dg-grid' }, h(Field, { label: t('settingsBackupRoot'), hint: t('settingsBackupRootHint'), span2: true }, h('div',
                { className: 'dg-rowline' }, h('input', { className: 'dg-input', value: draft.backupRoot || '',
                  onChange: (event) => update('backupRoot', event.target.value), }), h(Button, { onClick: browseRoot }, t('browse')),),),
            listOf(source.backupRoots).length > 0
              ? h(Field, { label: t('suggestedRoots'), span2: true }, h('div', { className: 'dg-chiprow' }, listOf(source.backupRoots).map((root, index) =>
                      h('button', { key: index, type: 'button', className: 'dg-chip', title: root, onClick: () => update('backupRoot', root) }, root),),),)
              : null, h(Field, { label: t('settingsInterval') }, h('select', { className: 'dg-select', value: intervalValue, onChange: (event) => {
                    const value = event.target.value
                    if (value === 'custom') { update('backupCron', draft.backupCron || '0 */6 * * *')
                    } else { update('backupCron', null)
                      update('backupIntervalHours', Number(value))
                    }
                  }, }, INTERVAL_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, t(option.key))),),), intervalValue === 'custom'
              ? h(Field, { label: t('intervalCustom') }, h('input', { className: 'dg-input', value: draft.backupCron || '', placeholder: t('cronPlaceholder'),
                    onChange: (event) => update('backupCron', event.target.value), }),)
              : null, h(Field, { label: t('settingsFullRetention') }, h('input', { className: 'dg-input', type: 'number', min: 1,
                value: draft.backupFullRetention ?? 7, onChange: (event) => update('backupFullRetention', Number(event.target.value)), }),), h(Field,
              { label: t('settingsSnapshotRetention') }, h('input', { className: 'dg-input', type: 'number', min: 1, value: draft.backupSnapshotRetention ?? 30,
                onChange: (event) => update('backupSnapshotRetention', Number(event.target.value)), }),), h(Field,
              { label: t('settingsTrashRetention'), hint: t('zeroNeverPurge') }, h('input', { className: 'dg-input', type: 'number', min: 0,
                value: draft.trashRetentionDays ?? 30, onChange: (event) => update('trashRetentionDays', Number(event.target.value)), }),),),), h('div',
          { className: 'dg-section' }, h('div', { className: 'dg-section-head' }, h('h4', { className: 'dg-section-title' }, t('settingsInclude'))), h('div',
            { className: 'dg-grid' },
            h(Switch, { checked: draft.includeSessions, onChange: (value) => update('includeSessions', value), label: t('incSessions') }),
            h(Switch, { checked: draft.includeConfig, onChange: (value) => update('includeConfig', value), label: t('incConfig') }),
            h(Switch, { checked: draft.includeAttachments, onChange: (value) => update('includeAttachments', value), label: t('incAttachments') }), h(Switch, {
              checked: draft.includeCredentials, onChange: (value) => update('includeCredentials', value), label: t('incCredentials'),
              dangerHint: t('credentialsPrivacy'), }),),), h('div', { className: 'dg-section' },
          h('div', { className: 'dg-section-head' }, h('h4', { className: 'dg-section-title' }, t('settingsSafety'))), h('div', { className: 'dg-grid' },
            h(Switch, { checked: draft.safeDeleteEnabled, onChange: (value) => update('safeDeleteEnabled', value), label: t('safeDelete'),
              hint: t('safeDeleteHint'), }), h(Switch, { checked: draft.fileTrashEnabled, onChange: (value) => update('fileTrashEnabled', value),
              label: t('fileTrash'), hint: t('fileTrashHint'), }), h(Switch, { checked: draft.snapshotOnImport,
              onChange: (value) => update('snapshotOnImport', value), label: t('snapshotOnImport'), }),),), h('div', { className: 'dg-section' }, h('div',
            { className: 'dg-section-head' }, h('h4', { className: 'dg-section-title' }, t('escapeHatch')), h(Badge,
              { kind: source.envEscapeHatch ? 'danger' : 'idle' }, source.envEscapeHatch ? t('escapeOn') : t('escapeOff'),),),
          h('div', { className: 'dg-hint' }, t('escapeHatchText')),
          h('div', { className: 'dg-hint' }, h('span', { className: 'dg-code' }, 'DSH_GUARDIAN_FORCE_DELETE=1')),),
        action.error ? h(Banner, { kind: 'error' }, errText(action.error)) : null,
        action.notice ? h(Banner, { kind: 'ok', onDismiss: () => action.setNotice(null) }, action.notice) : null, h('div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h(Button, { variant: 'primary', disabled: action.busy || changed.length === 0, onClick: save }, t('saveChanges')), h(Button, { variant: 'ghost',
            onClick: () => { if (source.defaults) setDraft({ ...draft, ...source.defaults })
            }, }, t('useDefaults')), h('span', { className: 'dg-hint' }, changed.length > 0 ? `${changed.length} ${t('settingsChanged')}` : t('saved')),), h(
          'button', { type: 'button', className: 'dg-collapse', onClick: () => setAuditOpen(!auditOpen) }, h('span', null, auditOpen ? '▾' : '▸'),
          h('span', null, t('audit')), h('span', { className: 'dg-hint' }, t('auditHint')),), auditOpen ? h(AuditSection, { ctx, t }) : null, browsing
          ? h(FileBrowser, { ctx, t, mode: 'dir', startPath: draft.backupRoot || '', onPick: (picked) => { update('backupRoot', picked)
                setBrowsing(false)
              }, onClose: () => setBrowsing(false), })
          : null,)
    }

    function AuditSection(props) { const { ctx, t } = props
      const req = useRequest(ctx, 'audit.list', { limit: 30 }, [])
      const items = listOf(req.data && req.data.items)

      return h('div', { className: 'dg-section' }, req.status === 'error'
          ? h(Banner, { kind: 'error' }, errText(req.error))
          : req.status === 'loading' && !req.data
            ? h(LoadingState, { label: t('loading') })
            : items.length === 0
              ? h(EmptyState, { title: t('auditEmpty') })
              : h('div', null, h('div', { className: 'dg-audit-row dg-dim' }, h('span', null, t('auditAt')), h('span', null, t('auditKind')),
                    h('span', null, t('auditDetail')),), items.map((entry, index) =>
                    h('div', { key: index, className: 'dg-audit-row' }, h('span', { className: 'dg-dim' }, fmtTime(entry.at)), h('span', null, String(entry.kind ?? '—')),
                      h('span', { className: 'dg-dim', title: typeof entry.detail === 'string' ? entry.detail : undefined },
                        typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail ?? null),),),),),
        h(Button, { variant: 'ghost', onClick: () => req.reload() }, t('refresh')),)
    }

    /* ==================================================================== *
     * Panel shell
     * ==================================================================== */

    const TABS = [{ id: 'sessions', label: 'tabSessions' }, { id: 'trash', label: 'tabTrash' }, { id: 'snapshots', label: 'tabSnapshots' },
      { id: 'backups', label: 'tabBackups' }, { id: 'settings', label: 'tabSettings' },]

    function GuardianPage(props) { const { ctx, t } = props
      const [tab, setTab] = useState('sessions')
      const [nonce, setNonce] = useState(0)
      const [status, setStatus] = useState({ status: 'idle', at: 0, error: null })

      const reportStatus = useCallback((info) => { setStatus((prev) =>
          prev.status === info.status && prev.at === info.at && prev.error === info.error ? prev : info,)
      }, [])

      const tabProps = { ctx, t, nonce, onStatus: reportStatus }
      let body = null
      if (tab === 'trash') body = h(TrashTab, tabProps)
      else if (tab === 'snapshots') body = h(SnapshotsTab, tabProps)
      else if (tab === 'backups') body = h(BackupsTab, tabProps)
      else if (tab === 'settings') body = h(SettingsTab, tabProps)
      else body = h(SessionsTab, tabProps)

      const statusText = status.error
        ? `${t('errorTitle')}: ${errText(status.error)}`
        : status.at
          ? `${t('lastRefresh')} ${fmtTime(status.at)}`
          : status.status === 'loading'
            ? t('loading')
            : t('empty')

      return h('div', { className: 'dg-root' }, h('style', null, CSS), h('div', { className: 'dg-head' }, h('div', null,
            h('h2', { className: 'dg-title' }, t('panel')), h('div', { className: 'dg-sub' }, t('subtitle')),), h('div', { className: 'dg-head-actions' },
            h('span', { className: `dg-status${status.error ? ' dg-err' : ''}`, title: statusText }, statusText), h(Button, { onClick: () => {
                  setNonce((value) => value + 1)
                }, }, t('refresh'),),),), h('div', { className: 'dg-tabs' }, TABS.map((entry) =>
            h('button', { key: entry.id, type: 'button', className: 'dg-tab', 'data-active': tab === entry.id ? 'true' : undefined,
                onClick: () => setTab(entry.id), }, t(entry.label),),),), h('div', { className: 'dg-body' }, body),)
    }

    /** The sidebar glyph from icon.svg, drawn in the theme's current text color. */
    function GuardianIcon({ size }) {
      return h(
        'svg',
        {
          viewBox: '0 0 1024 1024',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M209.1 956.3c-65.5 0-118.9-53.3-118.9-118.8V185c0-65.5 53.3-118.8 118.9-118.8h482.7l240.6 240.5v530.7c0 65.5-53.3 118.8-118.9 118.8H209.1z m0-833.7c-34.4 0-62.4 28-62.4 62.4v652.4c0 34.4 28 62.4 62.4 62.4h604.4c34.4 0 62.4-28 62.4-62.4V394.5H722.8c-35.8 0-64.1-6.7-84.4-20-22.9-15-34.5-38.1-34.5-68.7 0-1.1-1.4-109.7-0.9-181.3v-2H209.1z m451.3 153.1c0 34.4 28 62.4 62.4 62.4h155.9L660.4 119.8v155.9z',
        }),
        h('path', {
          d: 'M330 563.5c-15.5 0-28.2-12.7-28.2-28.2s12.6-28.2 28.2-28.2h362.6c15.5 0 28.2 12.6 28.2 28.2s-12.6 28.2-28.2 28.2H330z',
        }),
        h('path', {
          d: 'M330 714.6c-15.5 0-28.2-12.7-28.2-28.2s12.6-28.2 28.2-28.2h362.6c15.5 0 28.2 12.6 28.2 28.2s-12.6 28.2-28.2 28.2H330z',
        }),
      )
    }

    /* ==================================================================== *
     * Plugin entry
     * ==================================================================== */

    return {
      // `uiWorkspace` is resolved lazily through `ctx.get` so a missing service
      // degrades to an inline banner instead of blocking panel activation.
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-guardian: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ ctx, t }) }, GuardianPage),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: () => t('panel'), locale: NS },
            GuardianIcon,
          ),
        )

        // Transport probe kept from the verified slice: proves the browser half can
        // still reach the Host channel after a reload (result lands in bridge.log).
        setTimeout(() => {
          callHost(ctx, 'ping', { from: 'panel-activation', at: Date.now() })
            .then((value) => callHost(ctx, 'diag', { ok: true, value }))
            .catch((error) => callHost(ctx, 'diag', { ok: false, message: String(error?.message ?? error) }))
            .catch(() => {})
        }, 1500)
      },
    }
  },
})
