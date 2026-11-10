# dsh-guardian（DeepSeek Harness 守护者）

DSH 的「数据与配置总控」插件：在左侧栏提供一个统一入口，把**会话浏览与导出导入**、**误删拦截与回收站**、**配置快照与差异对比**、**定时自动备份与灾备救援**放进同一个面板。

> 设计原则：所有破坏性操作默认走「可恢复路径」。删除先进回收站；彻底删除必须二次确认并列出清单；备份永远带 sha256 与零依赖救援脚本。

- 左侧栏入口：**会话历史**（order 8，图标跟随主题明暗）
- 面板标签页：**会话 / 回收站 / 快照 / 备份 / 设置**

---

## 1. 安装与启用

本插件是一个标准 DSH bundle（`package.json` 里的 `dsh.bundle.patch` + `dsh.client`）。

```bash
# 在 DSH 里（或由 agent）执行：
plugin_manager install_bundle  target=<本仓库绝对路径>
# 已安装后重新加载 Host 半：
plugin_manager set_plugin      target=include:dsh-guardian  enabled=false
plugin_manager set_plugin      target=include:dsh-guardian  enabled=true
```

安装后**刷新浏览器页面**，左侧栏会出现「会话历史」图标；点击即打开面板。

Host 半依赖 `connection` 与 `webServer` 两个服务：面板通过 `/guardian/<endpoint>` 这个**需要登录 Cookie 的前缀路由**调用 Host（与 `/api` 相同的 Host/Origin 校验与浏览器认证），不依赖任何 Typert 代码生成。

---

## 2. 四个模块

### A. 会话总览 / 导出 / 导入

- 按工作区分组浏览会话：标题、消息数、大小（含子会话）、最后活动、归档/置顶/运行中状态、附件数。
- **跨工作区搜索**使用 `sessionQuery.filterEvents({ kind: 'text', text })`，对中英混合文本都能命中（不依赖 SQLite FTS 的 CJK 分词）。
- 行内操作：打开会话、重命名（持久化写入 `sessionTitle` 事件）、归档/取消归档、移入回收站。
- **导出**支持「整个工作区 / 选中会话 / 单会话」，子代理会话会跟随主会话一起打包。产物是可移植的 `.tar.gz`。
- **导入**必须先重新指定目标文件夹（包内 `cwd` 是源机器绝对路径），导入前展示预检（会话数、附件数、版本、警告），默认先做一次配置快照。

可移植包结构：

```
manifest.json                 格式、版本、DSH 版本、会话清单、附件清单
README.txt                    给人类看的说明
sessions/<id>/header.json     不可变会话头（cwd 会在导入时重写）
sessions/<id>/events.jsonl    完整事件日志，一行一个 JSON
attachments/<sha256>.<ext>    被引用附件的原始字节（内容寻址）
```

### B. 误删拦截与回收站

- **会话回收站**：`sessions/<projectKey>/<sessionId>/` 整个目录（含所有日志代际）一次性同盘 `rename` 到 `$DSH_HOME/guardian/trash/sessions/<entryId>/payload/`，不复制、不改写日志；子代理会话目录（可能在别的 projectKey 下）一起移动。
  移动前会：拒绝仍在运行的会话 → 归档会话（避免侧栏残留幽灵条目）→ `sessionPersistence.flush()` → 记录原相对路径（projectKey 是有损编码，不能由 `cwd` 反推）→ 移动投影缓存行。
- **文件回收站**：`safe_delete` 工具与 `trashPath` 把工作区文件/目录移入 `$DSH_HOME/guardian/trash/files/`。
- **恢复**：会话回到记录下来的**原始绝对路径**，同时恢复投影缓存并取消归档；文件回到原路径。
- **彻底删除**：先 `trash.previewPurge` 列出将被清理的路径/大小/文件数，再要求 `confirm: true`。**附件永远是内容寻址共享的，任何会话清理都不会删除附件对象。**
- **保留策略**：默认 30 天（可配，0 = 永不自动清理），到期条目在面板给出到期提醒，`trash.sweep` 静默清理。
- **工具层拦截**：`tools/pre-execute` 监听器拒绝 `bash/pwsh` 里出现 `rm` / `Remove-Item` / `del` / `erase` / `rmdir` / `rd /s` / `rimraf` / `rmSync/rmdirSync/unlinkSync` 的命令，并引导模型改用 `safe_delete`；每次拒绝写入审计日志。
- **逃生舱**：设置环境变量 `DSH_GUARDIAN_FORCE_DELETE=1` 后重启 DSH，可临时关闭工具层拦截（设置页会显示当前是否已生效）。

### C. 配置快照与差异对比

- 一键快照当前配置，写入 `$DSH_HOME/guardian/snapshots/<id>/`：
  - 固定：`$DSH_HOME/settings.yaml`、`storages/workspace.json`、`profiles/<profile>/cordis.patch.yml`、`cordis.yml`、`package.json`
  - 默认开：本地目录插件源码（`link:` 依赖的目录，跳过 `node_modules/.git/.research/backups` 等，单文件 ≤2MB、整树 ≤8MB）、`skills/` 目录
  - 默认关（需显式勾选并确认隐私提示）：`.credentials.yaml`、`.env`
- **差异对比**：恢复前展示「当前 → 快照」的逐文件差异（新增/删除/修改 + 行级 patch）与**插件行差异**（哪些 patch 行新增、消失、哪些字段变化）。
- **恢复**：先自动打一张「恢复前自动快照」，再写回文件；配置类文件写回后由 DSH 的 Loader 重新加载。
- 手动快照永久保留；自动快照按「快照保留份数」轮换。

### D. 定时备份与灾备出口

- 定时策略：关闭 / 1h / 6h / 12h / 24h / 7d（`backupIntervalHours`）；下次运行时间**持久化**在 `state.json`，DSH 重启后会按 due 时间补跑，不会因为重启而丢失计划。
- 每次备份内容：会话日志目录（字节级原样）、`storages/workspace.json`、附件（可关）、配置（`settings.yaml` + profile 的 patch/yml/package.json，凭证默认不含）、以及**同时间点的配置快照**。
- 轮换：默认保留最近 7 份完整备份 + 30 份自动快照，超出后删除最旧的一份（连同 `.sha256` 与索引 sidecar）。
- 完整性校验：每份备份生成 `.sha256`；面板可一键校验，损坏时标记为「不可用于恢复」并提示改用更早的备份。
- **零依赖救援脚本**：备份目录里始终生成 `rescue.mjs` + `rescue.cmd`（Windows 双击）+ `rescue.command`（macOS）。它只依赖 Node.js ≥18 内置模块，自行解析 tar.gz、校验 sha256、把 `sessions/`、`storages/`、`attachments/`、`config/`、`profile/` 还原到指定的 `$DSH_HOME`：

```bash
node rescue.mjs --list
node rescue.mjs --home "C:/Users/me/.dsh"                  # 默认还原本目录最新备份
node rescue.mjs --backup 2026....tar.gz --home <dir> --profile <profileDir>
node rescue.mjs --force                                    # 校验失败仍强行还原
```

- 备份默认目录：`~/Documents/dsh-guardian-backups`，可在设置页改成任意绝对路径（本机开发期用的是仓库内 `backups/`，已在 `.gitignore` 中忽略）。

---

## 3. 数据目录布局

```
$DSH_HOME/guardian/
  settings.json        插件设置（面板「设置」页写入）
  state.json           上次备份时间 / 下次备份时间 / 上次清理时间
  trash-index.json     回收站索引（可重建）
  backup-index.json    备份索引（可重建）
  audit.jsonl          审计日志（移动/恢复/彻底删除/工具拦截/备份/快照）
  trash/sessions/<entryId>/   payload/（会话目录） + cache/（投影缓存行） + entry.json
  trash/files/<entryId>/      payload/（文件或目录） + entry.json
  snapshots/<id>/             meta.json + files/<virtual path>
```

索引文件每次写入都是「临时文件 + `.bak` + rename」，损坏后也能通过扫描 `trash/*/entry.json` 与 `<backup>.guardian.json` 重建。

---

## 4. 诚实声明（已知限制）

1. **原子性依赖同一文件系统**：回收站位于 `$DSH_HOME/guardian/trash`（与会话日志同盘），正常情况是 O(1) 的 `rename`；跨盘时降级为「复制 → 逐文件校验大小 → 删除源」，中途失败会回滚。
2. **`rename` 不会因为会话还在写而失败**（Windows 打开句柄带 `FILE_SHARE_DELETE`），所以插件**显式**拒绝移动仍在运行的会话（`agents.get` 非空即拒绝），并在移动前 flush。恢复后不会出现「应用没确认过的事件」。
3. **当前 DSH 没有「删除会话」的原生入口**：侧栏只有归档与「移除工作区注册」（保留文件）。因此本插件提供的是「面板内删除 = 进回收站」+「工具层 `rm` 拦截」两条通道；如果将来宿主暴露删除 API，再挂对应钩子。
4. **附件是内容寻址且被多个会话共享**，插件不会删除附件对象；彻底删除会话只清理会话日志、投影缓存与目录本身。
5. **配置文件里的密钥不会自动脱敏**：默认备份与快照**排除** `.credentials.yaml` 与 `.env`；勾选「包含凭证与密钥」后才会复制，面板会显示风险提示。
6. **备份不是版本控制**：它提供时间点恢复，不提供逐行历史。需要细粒度变更追踪时请把 `cordis.patch.yml` 纳入 Git。
7. **插件自身的数据也可能损坏**：索引可重建（见上），审计日志是 append-only JSONL。
8. **导入通过 `sessionPersistence.create/append` 写回**，shell 无关地重建会话；不直接手写 `session.v*.jsonl.zstd`（zstd 帧格式要求首帧恰为单行 header，手写极易把会话写成不可 reopen）。因此导入的会话 `createdAt` 为导入时间，事件时间戳保留原值。
9. **计划任务使用插件自己的定时器 + 持久化 due 时间**，不是宿主 `schedule` 服务的任务行；因此它随 DSH 进程存活，进程不在线时不会触发（下次启动补跑一次）。
10. **界面验证**：面板在浏览器中渲染，自动化验证覆盖到「插件激活、槽位注册、RPC 往返、Host 集成测试」，视觉与交互细节需要人工过一遍。

---

## 5. 开发与测试

```bash
node --check index.js && node --check client.js     # 语法
node .research/tools/host-test.mjs                  # Host 集成测试（临时 $DSH_HOME，绝不碰真实数据）
node .research/tools/selftest.mjs                   # tar.gz 读写与 diff 自测
```

Host 集成测试覆盖：会话总览/搜索、重命名/归档、导出→预检→导入（cwd 重写、谱系保持）、回收站移动/恢复/彻底删除（附件存活）、文件回收站、快照/差异/恢复、备份/校验/恢复、救援脚本产物、删除命令识别、设置校验。

`.research/` 是本地调研与测试脚本目录，已在 `.gitignore` 中忽略。
