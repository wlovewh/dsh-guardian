# dsh-guardian — storage research (verified)

Researched by teammate `storage-researcher`. Read-only: nothing outside `.research/` was written; all log decoding was done on copies; copies deleted afterwards.
Evidence sources: live `$DSH_HOME` tree, the asar-shipped package sources (`E:\CodingAPP\DeepseekHarness\resources\app.asar\dsh\node_modules\…`, read-only extracted to `.research\tmp` for grepping), `cordis_inspect_query` host catalog, and the live composition (`dsh-base` / `dsh-web-app` `cordis.patch.yml`).

---

## 0. TL;DR facts that drive the design

| Fact | Consequence for the plugin |
|---|---|
| Session logs are **one file per session** at `$DSH_HOME/sessions/<projectDir>/<encodedId>/session.v4.jsonl.zstd` | move/backup = whole session **directory** (dir is "session-owned", may hold future artifacts + `session.lock` on POSIX) |
| Path is derived from **header.cwd + id**; the project dir key is **lossy** | never recompute the target path from the current workspace path — store the original relative path in the trash manifest |
| `listProjectDirs()` = **every** directory under the sessions root, unfiltered | a recycle bin **inside** `$DSH_HOME\sessions` would resurrect trashed sessions in `list()` and can trigger `duplicate JSONL session id` errors → **trash must live outside the root** |
| No delete/relocate API in `sessionPersistence` (README: "Nothing deletes session files … the seam has no deletion API") | guardian owns filesystem moves; Host services are used only for liveness/UI state |
| Attachments are **content-addressed and shared/deduped, never GC'd** | **never** delete attachments when trashing/purging a session |
| Projection cache rows are **rebuildable and stale-tolerant** ("a malformed or stale record reads as absent") | safe to move/delete with the session; do it to avoid an ahead-of-log projection |
| A shipped export already exists (`@deepseek-ai/dsh-session-log-export`, `/export`, `GET /api/session.export`) | reuse its ZIP layout for *shareable* export; there is **no import** anywhere → import is net-new |
| Windows: engine-asar shipped sources confirm first zstd frame = **exactly one header line** | an imported plaintext JSONL must be re-encoded as `[header frame][event frames…]`, not one blob |

---

## 1. Where session logs live, and the exact naming rule

### 1.1 Verified live tree (`C:\Users\20902\.dsh`)

```
C:\Users\20902\.dsh\
  .anonymous-user-id            37 B
  .credentials.yaml            513 B     ← SECRETS
  .env                          26 B     ← SECRETS
  settings.yaml              6,730 B
  settings.yaml.imported     6,730 B     (byte copy of the old settings doc)
  attachments\v1\objects\cc\cc79df003b84f9c130cabba8ce066943407ca8b93abb6669dcbdd0910338b4ea   5,505 B
  attachments\v1\tmp\                          (empty staging dir)
  sessions\                                    ← persistence root
    --D-Project-dsh-guardian--\
      db63674a-4ed2-454c-97ce-49dce4527623\session.v4.jsonl.zstd      24,325 B  09:23
      e86f708f-5b2a-4cfb-8f67-5c730cc1368b\session.v4.jsonl.zstd     196,130 B  09:31   (this teammate, live)
      session-6f2a89c0-ceae-427c-99ec-daf9bebceab4\session.v4.jsonl.zstd 340,162 B 09:30 (Lead, live)
    --D-ThisComputer-Documents-deepseek-harness-default-workspace--\
      session-6ce58cb6-bac8-4556-8ace-2b9ad7cee98b\session.v4.jsonl.zstd  1,229 B  09:11
      session-77b96794-f252-4b31-9dcd-acfab099adf0\session.v4.jsonl.zstd 1,561,598 B 09:08
  storages\
    workspace.json                                      1,143 B   ← workspace registry
    session_projcache\sessions\<sessionId>.json        6 files, 60,438 B
  profiles\desktop\
    cordis.yml 223, cordis.patch.yml 8,338, package.json 576,
    pnpm-lock.yaml 2,488, pnpm-workspace.yaml 61, .npmrc 151,
    .plugin-manager\logs\operation-*\pnpm.log (4 × ~210–360 B)
    node_modules\ (9 entries — exclude from any backup)
  dsh-runtimes\dsh-primary-runtime\dependencies\{node,python,pnpm}\   ← huge, exclude
```

There is **no** `session-logs\` dir, **no** sqlite index (`dsh-session-query-sqlite` is mounted with `path: ':memory:'`, `openAt: never`), and **no** `session.lock` files (Windows uses a named kernel semaphore, zero filesystem footprint).

### 1.2 The rule (authoritative, from shipped source)

`@deepseek-ai/dsh-session-persistence-jsonl` `lib/index.js`:

```js
// project dir key (lossy, human-navigable)
function projectKey(cwd) {
  // '/' '\' ':'  → '-'  (runs of separators collapse to ONE '-')
  // [A-Za-z0-9._-] kept literally
  // every other code unit → "~" + 4 uppercase hex
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
function projectDir(root, cwd) {
  if (cwd === void 0) return join(root, "_no-cwd");
  return join(root, projectKey(cwd));
}
// session dir
function encodeSegment(raw) {        // injective over all UTF-16 strings
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  // [A-Za-z0-9._-] kept; else "~" + 4 uppercase hex
}
function sessionDir(root, cwd, id) { return join(projectDir(root, cwd), encodeSegment(id)); }
function logPath(root, cwd, id, compression) {
  return join(sessionDir(root, cwd, id), generationLogFilename(SESSION_FORMAT_VERSION, compression));
}
// generationLogFilename → `session.v<version>.jsonl` + ('.zstd' | '')
```

Configuration that produces the root (`dsh-base/cordis.patch.yml`, id `session-persistence-jsonl`):

```yaml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')      # → C:\Users\20902\.dsh\sessions
```

Also `attachment-local` has **no** `root` config (defaults under `dshHomePath('attachments')`), `storage-json` → `dshHomePath('storages')`, `storage-domain` → `backend: json`.

### 1.3 Confirmation against the two real folders

| header.cwd | derived project dir | exists? |
|---|---|---|
| `D:\Project\dsh-guardian` | `--D-Project-dsh-guardian--` | ✅ (3 sessions) |
| `D:\ThisComputer\Documents\deepseek-harness\default-workspace` | `--D-ThisComputer-Documents-deepseek-harness-default-workspace--` | ✅ (2 sessions) |

Case is preserved (no lowercasing); `:` and `\` both become a single `-`; leading dashes stripped, then wrapped in `--…--`.

### 1.4 Current generation naming

Highest-numbered `session.vN.jsonl[.zstd]` wins (`resolveGenerationInDirectory` sorts by version desc). Live build writes **v4**: `session.v4.jsonl.zstd`. Retained predecessors (`session.jsonl.zstd`, `session.v1…v3`) may coexist in the same dir after migration; nothing deletes them → **move the entire session directory**, never just the newest file.

### 1.5 Header (decoded from copies — first zstd frame)

```json
{"type":"session","version":4,"id":"session-6f2a89c0-ceae-427c-99ec-daf9bebceab4","createdAt":1794273242736,
 "cwd":"D:\\Project\\dsh-guardian","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

Required keys: `type, version, id, createdAt, isSeeded, delegationDepth`.
Optional keys: `cwd, parentSession, origin, agentPreset`. Any other key is **rejected** (`HEADER_KEYS` is a closed set) → an import must not add fields to the header.

### 1.6 Subagent sessions: stored **separately**, same project dir

```json
{"type":"session","version":4,"id":"db63674a-4ed2-454c-97ce-49dce4527623",
 "cwd":"D:\\Project\\dsh-guardian","parentSession":"session-6f2a89c0-ceae-427c-99ec-daf9bebceab4",
 "isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"cordis"}
```

* Subagent ids are bare UUIDs (`db63674a…`, `e86f708f…`); root sessions created by the app carry a `session-` prefix. Do **not** rely on that — detect with `origin === 'subagent'` / `parentSession` / `delegationDepth > 0`.
* Each child is a **peer directory** under the same project dir (no nesting under the parent).
* First event of a child is `subagent/descriptor` (`{version, mode:"continuable", provider:"spawn", label, agentProvider, agentModel, agentReasoningEffort}`) — useful for the panel's child list.
* A child *could* live in a different project dir if it had a different `cwd`; treat "children" as a graph query over headers, not as a filesystem assumption.

### 1.7 `SessionLocation` / snapshot shape (`sessionPersistence.list() | stat(id)`)

```js
{ header, formatStatus, revision, sizeBytes, location: { kind: "jsonl", path: "<abs path of selected generation>" } }
```

Only `kind` observed/shipped for this backend is `"jsonl"`. Pending (created-but-never-materialized) sessions return `{header, revision}` with **no** `location`/`sizeBytes` — the panel must tolerate that. `sizeBytes` = bytes of the selected generation (exactly what the size column needs). `eventCount` is **not** in the snapshot; get it only by reading the log, or use the projcache row's `seq`.

---

## 2. Attachments

Layout (README `dsh-attachment-local`, matches disk):

```
C:\Users\20902\.dsh\attachments\v1\
  tmp\                                    staging; fsync then hard-link publish
  objects\<2-hex-prefix>\<sha256-hex>     IMAGES      (5,505 B object on disk: …\cc\cc79df00…)
  file-objects\<digest-prefix>\<digest>   generic FILES (none on this machine)
  files\<digest-prefix>\<digest>\<name>   read-only hard links to file-objects
```

* **Content-addressed**: object id = `sha256:<hex>`; equal bytes dedupe to one object. Path = `<home>/attachments/v1/objects/<first 2 hex chars>/<full hex>`.
* **Shared between sessions by construction** — dedupe means two sessions uploading the same image share one object. Nothing collects unreferenced objects ("Images are kept forever", "Retention and garbage collection are deferred because resumed and forked sessions may share immutable objects").
  → **Deleting/purging a session must never delete attachments.** An optional "orphan sweep" would have to scan every log *including trashed ones* and is unsafe by default.
* **Which attachments a session references**: grep the decoded log for `"attachmentId":"sha256:<hex>"` (also `"type":"file"` blocks with `attachment: {attachmentId, name, bytes}`). Verified on copies:

```
Lead session 6f2a: 1 distinct ref → sha256:cc79df003b84f9c130cabba8ce066943407ca8b93abb6669dcbdd0910338b4ea
                   ↑ exactly the object that exists at attachments\v1\objects\cc\cc79df…
77b9 session:      0 refs        s6ce: 0        db63: 0
```

  Worked extraction recipe (already validated): copy the log, walk zstd frames, decompress each frame, regex `/"attachmentId":"([^"]+)"/g` over the joined text. **`zlib.zstdDecompressSync(wholeFile)` decodes only the first frame** — frame walking is required for anything past the header.
* Export side reference: the shipped export ZIP stores images as `media/<attachmentId>.<ext>` and generic files as `files/<digest-prefix>/<digest>/<name>`.

---

## 3. Config surface to snapshot / back up

| Absolute path | Size | Role | Secrets? |
|---|---|---|---|
| `C:\Users\20902\.dsh\settings.yaml` | 6,730 B | Host settings doc (single top-level section `llm-pi-ai:` = provider/model catalog). This is the Models-page / settings.yaml UI store; **client UI prefs (theme, layout, sidebar) are not here** — they live in browser storage, not on disk | No secret values, only `apiKeyEnv:` **names** (`MAGPIE_GATEWAY_KEY`) |
| `C:\Users\20902\.dsh\settings.yaml.imported` | 6,730 B | one-time import copy of the previous settings doc | same as above |
| `C:\Users\20902\.dsh\.credentials.yaml` | 513 B | managed credential records: `client-connection/browser-session` (secret), `deepseek-account-platform/device` (id), `deepseek-account-platform/default` (token, issuer), `refs: MAGPIE_GATEWAY_KEY` | **YES — tokens/secrets** |
| `C:\Users\20902\.dsh\.env` | 26 B | `MAGPIE_GATEWAY_KEY=magpie` (literal provider key) | **YES** |
| `C:\Users\20902\.dsh\.anonymous-user-id` | 37 B | telemetry pseudo-id | mildly identifying |
| `…\.dsh\storages\workspace.json` | 1,143 B | workspace registry (see §5) | No |
| `…\.dsh\storages\session_projcache\sessions\*.json` | 60,438 B / 6 | projection cache (see §4) | No (contains titles/todos/paths) |
| `…\.dsh\profiles\desktop\cordis.yml` | 223 B | profile root: deliberately `[]`; tree comes from bundle patches | No |
| `…\.dsh\profiles\desktop\cordis.patch.yml` | 8,338 B | **the user's real composition** (models, subagent limits, UI plugin toggles) | No secrets (apiKeyEnv refs only) |
| `…\.dsh\profiles\desktop\package.json` | 576 B | `dsh.profile.bundles` list + 3 deps | No |
| `…\.dsh\profiles\desktop\pnpm-lock.yaml` / `pnpm-workspace.yaml` | 2,488 / 61 B | dependency resolution / `nodeLinker: hoisted` | No |
| `…\.dsh\profiles\desktop\.npmrc` | 151 B | registry + retry/timeouts (`registry.npmmirror.com`) — **no auth token on this machine** | usually token; here no |
| `…\.dsh\profiles\desktop\.plugin-manager\logs\operation-*\pnpm.log` | 4 × ~210–360 B | plugin install logs | No |
| `…\.dsh\profiles\desktop\node_modules\` | 9 dirs | installed plugins | exclude |
| `…\.dsh\dsh-runtimes\` | large | bundled node/python/pnpm + site-packages | exclude |

Not present on this machine: `mcp.json`/MCP config files, `skills\` directories, per-profile `settings.json`. MCP servers and skills, when used, are declared inside `cordis.patch.yml` (`.mcp` rows / prompt sections), so **`cordis.patch.yml` is the single config file worth backing up** besides settings/credentials.

Recommended backup set (small, this machine): `sessions\**` (2.2 MB), `storages\workspace.json`, `storages\session_projcache\**` (optional), `settings.yaml`, `settings.yaml.imported`, `.credentials.yaml` **(secret — encrypt or exclude by default)**, `.env` **(secret)**, `.anonymous-user-id`, `profiles\desktop\{cordis.yml,cordis.patch.yml,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,.npmrc}`, `attachments\**` (grows unbounded — separate policy).

---

## 4. Session projection cache

* Location: `C:\Users\20902\.dsh\storages\session_projcache\sessions\<sessionId>.json` — **flat, one document per session id, not under the project dir** (domain `session_projcache`, storage-json root `dshHomePath('storages')`, write-behind `writeEveryEvents: 200`, `writeIntervalMs: 5000`).
* Record shape: `{ "version": 7, "record": { identity: { formatVersion, createdAt, cwd, isSeeded, inheritedEventCount }, rows: { turnBoundary, sandboxMode, approvalState, tokenMeasurement, … } } }`.
* **Safe to move/delete with the session log**: "The session log remains authoritative… a crash can leave a checkpoint stale, but never ahead of committed events, and incompatible records are ignored or backed up"; "A malformed or stale record reads as absent, and consumers that require a cold value own any log refold." A missing/removed row simply forces a cold refold from the log.
* **But** the row's identity check is only `(formatVersion, createdAt, cwd, isSeeded, inheritedEventCount)`. If you restore an *older* copy of a log while a newer cache row survives, the projection can be **ahead of** the restored log (silent wrong counts/todos). → **Trash the cache row together with the log; on restore, drop the cache row again and let it refold.**
* Stale rows genuinely exist and are harmless: `storages\session_projcache\sessions\session-080e078e-4e79-45e0-b730-5cc1b733c809.json` (cwd `D:\Project\ComprehensiveAffairs`, last write 2026-11-09 22:51) has **no** session log anywhere under `sessions\` — a real orphan. 6 rows vs 5 logs.

---

## 5. Workspace registry

* Single file: `C:\Users\20902\.dsh\storages\workspace.json` (storage-json domain, unit `workspace` **version 2**), owned by `@deepseek-ai/dsh-workspace` (mounted at `dsh-web-app/cordis.patch.yml` id `workspace`).

```json
{ "unit": {"name":"workspace","version":2},
  "global": { "initialized": true,
              "defaultWorkspaceId": "076786c7-e913-40e3-b9cc-85e6a520a862",
              "workspaceIds": ["7ac34b12-…", "076786c7-…"],
              "archivedSessionIds": [], "pinnedSessionIds": [] },
  "tables": { "workspaces": {
    "076786c7-e913-40e3-b9cc-85e6a520a862": { "path":"D:\\ThisComputer\\Documents\\deepseek-harness\\default-workspace",
        "title":"default-workspace",
        "sessionIds":["session-6ce58cb6-…","session-77b96794-…"],
        "createdAt":"2026-11-09T14:52:02.628Z","updatedAt":"2026-11-09T15:41:03.534Z" },
    "7ac34b12-5d10-4907-a39c-ace11f84a4c1": { "path":"D:\\Project\\dsh-guardian","title":"dsh-guardian",
        "sessionIds":["session-6f2a89c0-…"], … } } } }
```

* **Readable directly** for "which root sessions belong to which workspace": `tables.workspaces[*].sessionIds` (+ `global.archivedSessionIds`, `global.pinnedSessionIds`, display order = `global.workspaceIds`).
* **Never write it directly.** The json backend keeps a coherent in-memory cache and rewrites the whole document through a per-unit write chain; a hand edit is lost/ignored or reverted. Use `ctx.workspaceRegistry` (`archiveSession`, `unarchiveSession`, `pinSession`, `unpinSession`) or the Remote namespace `ctx.remote.workspace.*`.
* `archiveSession(sessionId)` is also the **liveness gate**: it asks the `workspace/session-activity` waterfall (Agent registry = running turn, jobs, Subagent runtime = running descendants, Schedule plugin) and rejects with `WorkspaceActiveSessionError` listing activity families; `archiveSession(id, { stopActivity: true })` skips the check, writes the archive, then dispatches `workspace/session-stop`. Archiving clears the pin in the same durable write; unarchive does not restore it.
* Caveat for exact semantics: archived ids live in `global.archivedSessionIds` (and, per the README, archiving adjusts the workspace's ordered `sessionIds` account). Any guardian UI must read both lists.
* Note: subagent sessions are **not** in `sessionIds` — only roots are. Reconstruct "session → workspace" from `sessionIds`, then attach children by `parentSession`.

---

## 6. Safety analysis for an atomic-rename recycle bin

### 6.1 What must move for one root session to stay restorable

1. **The log directory** (whole dir, all retained generations): `<root>/<projectKey(cwd)>/<encodeSegment(id)>/`.
2. **Every subagent child log directory** (recursively, may be in other project dirs) — discovered via headers `parentSession`/`origin:'subagent'`, e.g. `db63674a…` and `e86f708f…` for `session-6f2a…`.
3. **Their projection-cache rows** `storages\session_projcache\sessions\<id>.json` (move or drop; see §4).
4. **Workspace/UI state**: hide it through `workspaceRegistry.archiveSession` — otherwise `workspace.json` keeps an id whose log is gone (a ghost sidebar entry after the next refresh/restart).
5. **Not** attachments (shared, content-addressed). **Not** `settings.yaml`/`credentials`. **Not** `session-query-sqlite` (in-memory here; if a deployment enables a durable index, that index must be dropped/refreshed too — it is not present on this machine).

### 6.2 Same-volume rename

`root` is `$DSH_HOME/sessions`; keep the bin under the same volume, e.g. `C:\Users\20902\.dsh\guardian\trash\…` → `MoveFileEx`/`rename()` is a metadata-only atomic same-volume operation, **no copy, O(1), crash-safe**.
Guard rails: (a) do **not** put the bin anywhere under `…\sessions\` (see §0/6.4); (b) do **not** put it under `…\storages\` (that tree is the storage-json domain root and a stray directory there is interpreted by that backend); (c) assert `path.parse(sessionPath).root === path.parse(binPath).root` and fall back to copy+fsync+unlink (with a durable manifest) only for cross-volume moves, i.e. `EXDEV`.

### 6.3 Live / open sessions — the real hazard

* `sessionPersistence` holds a per-session write handle + one-writer claim (in-process) and a kernel lock (`flock` on `session.lock` on POSIX; on Windows a **named semaphore derived from the log path**, no file). So ownership is per-path, not per-inode.
* **Do not rely on `rename` failing.** libuv opens files with `FILE_SHARE_READ|WRITE|DELETE`, so moving a file that a live writer holds will usually *succeed* on Windows and the writer keeps appending through its handle into the trashed path. That silently produces (i) a "deleted" session that keeps growing, and (ii) after restore, a log containing events the app never acknowledged. Cross-process safety therefore must be **explicit**, not inferred from the syscall:
  1. refuse if `ctx.agents.get(id)` exists (or `agents.list()` contains it), and refuse for any id whose header has a parent unless the parent is also being trashed;
  2. `await ctx.workspaceRegistry.archiveSession(id)` first — it rejects `WorkspaceActiveSessionError` while a turn/job/descendant/schedule is active, so it doubles as the liveness gate;
  3. `await ctx.sessionPersistence.flush()` so the last batch is durable;
  4. only then rename.
  Restore runs the reverse order: rename back → `unarchiveSession(id)`.
* Also refuse to trash the session that is currently executing the trash request (`ctx.agents` initiator), and any session in `ctx.subagents.listDescendants(...)` of a running root.

### 6.4 Why the bin cannot live inside the sessions root (verified)

```js
async listProjectDirs(signal) {                       // lib/index.js:3514
  const entries = await readdir(this.root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => join(this.root, e.name));   // NO name filter
}
async findLog(id) { … for (const project of await this.listProjectDirs()) { … }
  if (matches.length > 1) throw new Error(`duplicate JSONL session id "${id}" appears in multiple project directories`); }
```

A `trash\` directory under the root would be scanned as a project dir: `list()` would return the trashed sessions again (ghosts in the sidebar, wrong size totals) and any id present in both places makes `stat`/`open`/resume throw.

### 6.5 Recommended trash layout + manifest

```
C:\Users\20902\.dsh\guardian\
  trash\<yyyyMMddTHHmmssZ>-<rootSessionId>\
    manifest.json
    logs\--D-Project-dsh-guardian--\session-6f2a…\session.v4.jsonl.zstd
    logs\--D-Project-dsh-guardian--\db63674a…\session.v4.jsonl.zstd
    logs\--D-Project-dsh-guardian--\e86f708f…\session.v4.jsonl.zstd
    cache\session-6f2a….json   (optional; the cache row is droppable)
  backups\<yyyyMMddTHHmmssZ>\…
```

`manifest.json` (one document, written+fsynced **before** the first rename in a `*.pending` name, renamed to `manifest.json` after the last one, so a crash is always resolvable):

```json
{ "version": 1,
  "trashedAt": "2026-11-10T01:35:00.000Z",
  "workspaceId": "7ac34b12-5d10-4907-a39c-ace11f84a4c1",
  "rootSessionId": "session-6f2a89c0-ceae-427c-99ec-daf9bebceab4",
  "entries": [
    { "id": "session-6f2a…", "cwd": "D:\\Project\\dsh-guardian",
      "projectDir": "--D-Project-dsh-guardian--", "relPath": "--D-Project-dsh-guardian--\\session-6f2a…",
      "generations": ["session.v4.jsonl.zstd"], "sizeBytes": 340162,
      "headerSha256": "<sha256 of the header frame's plaintext line>",
      "role": "root" },
    { "id": "db63674a…", "relPath": "--D-Project-dsh-guardian--\\db63674a…", "role": "subagent",
      "parentSession": "session-6f2a…" }
  ],
  "attachments": ["sha256:cc79df…"] }
```

`relPath` is authoritative for restore: the project key is lossy/truncated at 251 chars, so recomputing from `cwd` after the fact can land in a different directory (and produce the duplicate-id error).

### 6.6 Restore algorithm (idempotent)

```
for each entry:  target = <root>\<entry.relPath>
  1. verify manifest + (optional) headerSha256 of the trashed file
  2. if target exists → refuse (or verify identical bytes and treat as done)
  3. flush(); rename(trash/…/logs/<relPath> → target)     # no-overwrite: use
       • Windows: fs.rename fails if target dir exists (EEXIST/EPERM) → safe
       • POSIX:   fs.link/renameat2 NOREPLACE, or mkdir target then rename the file inside
  4. delete storages\session_projcache\sessions\<id>.json (force cold refold)
  5. workspaceRegistry.unarchiveSession(id)   (unarchive tolerates a missing id — "a restore of an id that is not archived resolves without writing")
  6. mark manifest restored (keep the dir for audit, or prune per retention)
```

### 6.7 Purge (permanent)

Delete the trash entry's log dirs only. **Never** touch `attachments\`. Drop the session ids from `workspace.json` **through the service** (unarchive first, then the id simply has no log — the registry prunes invalid session candidates on the next mutation). Remove the cache rows.

---

## 7. Sizes / counts (measured 2026-11-10 09:34, while 2 sessions were live and growing)

| Bucket | Bytes | Files |
|---|---|---|
| `sessions\**` total | **2,201,489** (~2.10 MiB) | 5 |
| ├ `--D-Project-dsh-guardian--` | 638,662 | 3 (1 root + 2 subagents) |
| └ `--D-ThisComputer-…-default-workspace--` | 1,562,827 | 2 (2 roots) |
| `storages\**` (workspace.json 1,143 + 6 cache rows) | 61,581 | 7 |
| `attachments\**` | 5,505 | 1 object |
| `profiles\desktop\**` (excl. node_modules) | 12,965 | 10 |
| `settings.yaml*` + `.credentials.yaml` + `.env` + `.anonymous-user-id` | ~14,036 | 5 |
| `dsh-runtimes\**` | huge (bundled node+python) | — (exclude) |

Sessions: **5 logs = 3 roots + 2 subagents**; 2 project dirs; 1 live root is the largest (1.49 MiB). Logical event counts (decoded on copies): 77b96794 = 1,832 lines / 991 zstd frames; 6f2a = 307 / 161; e86f = 237 / 130; db63 = 20 / 5; 6ce = 15 / 8.
For the panel's size column use `sessionPersistence.list()` → `sizeBytes` per id (adds children to the root's row if you want a subtree total), or a `stat()` per row when listing is too chatty.

---

## 8. Notes for export / import / backup implementation

* **Reuse what ships**: `@deepseek-ai/dsh-session-log-export` is mounted (`dsh-web-app` patch, id `session-log-export`); it provides `/export`, `GET /api/session.export?sessionId=…` (+ HEAD), `GET /api/session.markdown`, a bounded ZIP stream (`session.vN.jsonl` plaintext per logical log incl. sub-session dirs, `media/<attachmentId>.<ext>`, `files/<digest-prefix>/<digest>/<name>`), plus a pure `formatSessionMarkdown(events, sourcePath?)`. It flushes a live root session before reading. A guardian "Export" can call the same route (or its own) instead of re-implementing ZIP; a guardian "final" export should instead archive the **raw `.zstd` bytes + manifest** (byte-identical, restorable by rename/copy).
* **Import is net-new** (no import anywhere in the shipped packages; `sessionPersistence` has no create-from-file API). To import a plaintext `session.v4.jsonl` into a zstd root you must re-encode:
  ```
  frame #1 = zstd(headerLine + "\n")              # assertZstdHeaderFrame: the first frame must be
                                                 # EXACTLY one header line, newline-terminated
  frame #2..n = zstd(batch of event lines)       # any split; one row per event; rows must be
                                                 # seq-contiguous (assertContiguous / assertStoredId)
  ```
  Then write it at `<root>/<projectKey(header.cwd)>/<encodeSegment(header.id)>/session.v4.jsonl.zstd` with an **exclusive** create (no-overwrite; on POSIX the engine uses hard-link publish, on Windows write-through rename without replacement — `fs.linkSync`/`COPYFILE_EXCL`-style semantics). Simplest robust import: copy the raw `.zstd` file verbatim (frames already canonical) and only ever re-encode when the source is a foreign/plaintext export.
* **Backup rotation**: whole data set is ~2.2 MB today, so full snapshots are fine (keep N daily + M weekly, hard-link unchanged files or just copy). Append-only logs mean an incremental backup can select by `sizeBytes`/`mtime` from `sessionPersistence.list()`; a per-run `manifest.json` with `{id, cwd, parentSession, sizeBytes, sha256}` makes verification and "what changed" cheap. Decide attachments policy separately (content-addressed → dedupe-friendly, unbounded growth, and **restoring a session without its attachment objects silently loses images**; the export package reads attachment bytes by declared refs).
* **Guardian should not invent new files under `$DSH_HOME\sessions\`, `$DSH_HOME\storages\`** — use `$DSH_HOME\guardian\` for trash/backup state. `DSH_HOME` may contain other profiles; scope paths to the live root + live profile dir.

---

### Verification methods used (reproducible)

1. `Get-ChildItem` walk of `C:\Users\20902\.dsh` (sizes/mtimes/dirs), skipping `node_modules`.
2. Asar header parse (read-only Node script) + `read` of shipped `README.md`/`lib/index.js`/`cordis.patch.yml`; the naming functions, `HEADER_KEYS`, `assertZstdHeaderFrame`, `listProjectDirs`, `findLog`, and snapshot construction quoted above are verbatim from `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` (v0.2.2-rc.1).
3. Copies of all 5 logs decoded frame-by-frame with `zlib.zstdDecompressSync` (Node 24.21) → headers, event counts, attachment refs; copies deleted.
4. `cordis_inspect_query` host catalog for `sessionPersistence`, `sessionQuery`, `sessionProjectionCache`, `attachments`, `workspaceRegistry`, `storage`, `storageDomain` signatures; live composition from `dsh-base`/`dsh-web-app` patches.
