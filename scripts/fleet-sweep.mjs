#!/usr/bin/env node
// fleet-sweep.mjs —— DSH 插件集群批量治理与全域巡检入口。
//
// 职责：
//   全自动识别工作区源码插件与已安装环境插件，按平台（Web、APP 桌面端、核心服务端）
//   与生命周期状态（运行中、已启用、已禁用、工作区源码）分门别类梳理；
//   批量分析各分类下的关键问题（未构建、契约接缝断裂、Bundle 阴影、Peer 冲突、幽灵代际），
//   输出多维治理看板与结构化 JSON 报告，方便作者极速完成适配。
//
// 用法：
//   node scripts/fleet-sweep.mjs [目录...] [--installed] [--workspace] [--web] [--app] [--running] [--disabled] [--json] [--strict] [--target <版本>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printJson, isPluginForm } from './lib/scanner.mjs'
import { listInstalledPlugins, probeEnvironment } from './env-doctor.mjs'
import { auditPlugin, peerPatchFor, compatPatchFor } from './plugin-audit.mjs'
import { readPackageJson, readPackageJsonStrict, probePackageJson } from './lib/package-json.mjs'
import { NO_BACKUP, backupBeforeWrite } from './lib/backup.mjs'
import { diagnoseLogs } from './log-doctor.mjs'
import { isMainEntry } from './lib/main-entry.mjs'
import { listAsarDshPackages } from './lib/desktop-app.mjs'
import { checkPrBaselineAsync, PR_BASELINE_STATES } from './lib/pr-gate.mjs'
import { BUILD_STATUS, LIFECYCLE_STATE, HEALTH_STATUS, PKG_PROBE_STATUS, GHOST_HOST_VERDICT } from './lib/run-states.mjs'

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const dirs = []
  let installed = false
  let workspaceOnly = false
  let json = false
  let strict = false
  let target = null
  let filterWeb = false
  let filterApp = false
  let filterRunning = false
  let filterDisabled = false
  let adapt = false
  let applyCompat = false
  let includeOfficial = false
  let prReady = false
  let offline = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--installed') installed = true
    else if (a === '--workspace') workspaceOnly = true
    else if (a === '--web') filterWeb = true
    else if (a === '--app' || a === '--desktop') filterApp = true
    else if (a === '--running') filterRunning = true
    else if (a === '--disabled') filterDisabled = true
    else if (a === '--adapt') adapt = true
    else if (a === '--apply-compat') {
      adapt = true
      applyCompat = true
    } else if (a === '--include-official') includeOfficial = true
    else if (a === '--pr-ready') prReady = true
    else if (a === '--offline') offline = true
    else if (a === '--json') json = true
    else if (a === '--strict') strict = true
    else if (a === '--target') target = argv[++i] ?? null
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node scripts/fleet-sweep.mjs [目录...] [选项]\n\n' +
          '选项:\n' +
          '  [目录...]          扫描指定工作区目录（默认同时扫描当前工作区与安装环境）\n' +
          '  --installed        仅扫描本机 DSH profiles 中已安装的插件\n' +
          '  --workspace        仅扫描本地工作区源码插件\n' +
          '  --web              仅筛选 Web 平台插件\n' +
          '  --app / --desktop  仅筛选 Desktop (APP) 桌面端插件\n' +
          '  --running          仅筛选当前正在活跃运行中的插件\n' +
          '  --disabled         仅筛选已禁用或未启用的插件\n' +
          '  --adapt            批量评估目标版本准入账本与 Peer 修补建议\n' +
          '  --apply-compat     对 0 代码破坏性命中的插件自动写入 package.json 兼容账本与 Peer 范围\n' +
          '  --include-official 包含宿主官方内置 @deepseek-ai/dsh-* 组件\n' +
          '  --pr-ready         核对非健康工作区插件的 Git/npm 基线，筛出可安全提 PR 的目标\n' +
          '  --offline          配合 --pr-ready 使用，跳过远端 git ls-remote 与 npm 联网核对\n' +
          '  --json             输出完整结构化分类 JSON 报告\n' +
          '  --strict           存在任何 warning 或 broken 时以退出码 2 退出\n' +
          '  --target <版本>    指定目标宿主版本（默认取本机当前宿主）\n',
      )
      process.exit(0)
    } else if (!a.startsWith('--')) {
      dirs.push(path.resolve(a))
    }
  }

  return {
    dirs,
    installed,
    workspaceOnly,
    json,
    strict,
    target,
    filterWeb,
    filterApp,
    filterRunning,
    filterDisabled,
    adapt,
    applyCompat,
    includeOfficial,
    prReady,
    offline,
  }
}

export { discoverWorkspacePlugins as discoverPlugins, inspectPluginItem as inspectPlugin }

export function checkBuild(pluginRoot) {
  // 三态探测：missing 是正常形态（纯脚本目录），corrupt 是必须报出来的故障。
  // 旧实现把两者都吞成 null，BOM 或语法错误一律显示「解析失败」而不说为什么。
  const probe = probePackageJson(pluginRoot)
  if (probe.status === PKG_PROBE_STATUS.MISSING) return { ok: true, status: BUILD_STATUS.NOT_APPLICABLE }
  if (probe.status === PKG_PROBE_STATUS.CORRUPT) {
    return {
      ok: false,
      status: BUILD_STATUS.CORRUPTED,
      reason: `package.json 解析失败${probe.bom ? '（文件带 UTF-8 BOM）' : ''}: ${probe.error}`,
    }
  }
  const pkg = probe.pkg
  const hasTsConfig = fs.existsSync(path.join(pluginRoot, 'tsconfig.json'))
  const hasSrc = fs.existsSync(path.join(pluginRoot, 'src'))
  if (!hasTsConfig && !hasSrc) return { ok: true, status: BUILD_STATUS.OK }

  const entryRel =
    pkg.exports?.['.']?.default ||
    (typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : null) ||
    pkg.main ||
    'lib/index.js'
  const entryPath = path.resolve(pluginRoot, entryRel)
  if (!fs.existsSync(entryPath)) {
    return { ok: false, status: BUILD_STATUS.UNBUILT, entryRel, reason: `产物缺失: ${entryRel}` }
  }
  return { ok: true, status: BUILD_STATUS.OK, entryRel }
}

// 探测工作区候选插件
export function discoverWorkspacePlugins(roots = [process.cwd()]) {
  const candidates = new Set()
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const rootPkg = path.join(root, 'package.json')
    if (fs.existsSync(rootPkg)) {
      candidates.add(root)
    }

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
        const sub = path.join(root, e.name)
        const subPkg = path.join(sub, 'package.json')
        if (fs.existsSync(subPkg)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(subPkg, 'utf8'))
            if (isPluginForm(pkg)) candidates.add(sub)
          } catch {}
        }
        if (e.name === 'packages' || e.name === 'plugins') {
          for (const subEntry of fs.readdirSync(sub, { withFileTypes: true })) {
            if (!subEntry.isDirectory() || subEntry.name.startsWith('.')) continue
            const leaf = path.join(sub, subEntry.name)
            if (fs.existsSync(path.join(leaf, 'package.json'))) candidates.add(leaf)
          }
        } else if (!fs.existsSync(subPkg) && !/^\d{4}-\d{2}-\d{2}/.test(e.name)) {
          // 兼容类似 Deepseek/ 这种工作区分组目录：仅在子目录自身不是包时下探一层 DSH 插件
          try {
            for (const subEntry of fs.readdirSync(sub, { withFileTypes: true })) {
              if (!subEntry.isDirectory() || subEntry.name.startsWith('.') || subEntry.name === 'node_modules') continue
              const leaf = path.join(sub, subEntry.name)
              const leafPkg = readPackageJson(leaf)
              if (leafPkg && isPluginForm(leafPkg)) candidates.add(leaf)
            }
          } catch {}
        }
      }
    } catch {}
  }
  return [...candidates].sort()
}

// 解析已安装插件在磁盘上的真实目录（支持软链回溯到源码仓）
// realpath 规范化：软链安装（profiles node_modules 里的 pnpm link）与源码目录
// 是同一份文件，判定「同一插件」必须比较规范路径。/var 与 /private/var 同目录
// 异写也由 realpathSync 统一。
function realpathOf(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

// 包名反查表：profile node_modules 下「package.json#name → 目录」，进程内缓存。
// 为什么存在（2026-11-21 实测）：patch 条目名是插件 id，安装目录名是 npm 包名，
// 两者没有换算公式（id: turn-guard ↔ 包 dsh-turn-guard、save-token ↔ dsh-plugin-save-token）。
// 精确名落空时按包名反查一次；只对未解析条目惰性建表，不在热路径上白扫。
// 遍历同时收目录与软链（pnpm workspace 链接形态实测存在，如 @taxueseek/argo-dsh）。
const pkgNameIndexCache = new Map()
function packageNameIndex(baseHome, profile) {
  const key = `${baseHome}\0${profile || ''}`
  const hit = pkgNameIndexCache.get(key)
  if (hit) return hit
  const index = new Map()
  const roots = [
    profile ? path.join(baseHome, 'profiles', profile, 'node_modules') : null,
    path.join(baseHome, 'profiles', 'node_modules'),
  ].filter(Boolean)
  for (const root of roots) {
    let top
    try {
      top = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of top) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      if (e.name.startsWith('@')) {
        try {
          for (const s of fs.readdirSync(path.join(root, e.name), { withFileTypes: true })) {
            if (s.isDirectory() || s.isSymbolicLink()) {
              // 目录名即包名（node_modules 布局：目录名 = package.json#name，scoped 为 @scope/name）。
              // 这里不逐包读 package.json——实测逐包 probePackageJson（6 profile × 350 包）
              // 让全量巡检从 1.9s 涨到 4.7s；命中候选后由 resolveInstalledPluginDir
              // 统一过一次 package.json 存在性确认。
              const name = `${e.name}/${s.name}`
              if (!index.has(name)) index.set(name, path.join(root, e.name, s.name))
            }
          }
        } catch {}
      } else if (!index.has(e.name)) {
        index.set(e.name, path.join(root, e.name))
      }
    }
  }
  pkgNameIndexCache.set(key, index)
  return index
}

// 反查找目录：精确包名优先，其次段边界后缀匹配（条目 id: thoughtdag ↔ 包
// dsh-thoughtdag、save-token ↔ dsh-plugin-save-token），同名段匹配取最短者
// （最特异）；无匹配返回 null。
function resolveByPkgName(index, pkgName) {
  const exact = index.get(pkgName)
  if (exact) return exact
  const suffix = `-${pkgName}`
  let best = null
  for (const [name, dir] of index) {
    if (!name.endsWith(suffix)) continue
    if (best === null || name.length < best.length) best = name
  }
  return best === null ? null : index.get(best)
}

export function resolveInstalledPluginDir(pkgName, profile, dshHome = null) {
  if (!pkgName) return null
  const baseHome = dshHome || process.env.DSH_PFA_DSH_HOME || path.join(os.homedir(), '.dsh')
  const parts = pkgName.split('/')
  const candidates = [
    profile ? path.join(baseHome, 'profiles', profile, 'node_modules', ...parts) : null,
    path.join(baseHome, 'profiles', 'node_modules', ...parts),
    // 桌面端自有插件区（实测形态：~/.dsh/plugins/workbuddy-image）
    path.join(baseHome, 'plugins', ...parts),
  ].filter(Boolean)

  for (const cand of candidates) {
    try {
      if (fs.existsSync(path.join(cand, 'package.json'))) {
        try {
          return fs.realpathSync(cand)
        } catch {
          return cand
        }
      }
    } catch {}
  }
  const byName = resolveByPkgName(packageNameIndex(baseHome, profile), pkgName)
  if (byName && fs.existsSync(path.join(byName, 'package.json'))) {
    try {
      return fs.realpathSync(byName)
    } catch {
      return byName
    }
  }
  return null
}

// 批量应用 package.json 准入账本与 Peer 范围修补（仅用于 0 代码破坏性命中的插件）
export function applyCompatAndPeerPatch(pluginDir, { targetVersion = null, peerPatch = null, compatPatch = null } = {}) {
  const pkgPath = path.join(path.resolve(pluginDir), 'package.json')
  if (!fs.existsSync(pkgPath)) return { updated: false, changes: [], ...NO_BACKUP }
  const pkg = readPackageJsonStrict(pluginDir)
  const resolvedPeers = peerPatch ?? (targetVersion ? peerPatchFor(pkg, targetVersion) : [])
  const resolvedCompat = compatPatch ?? (targetVersion ? compatPatchFor(pkg, targetVersion) : [])
  const changes = []

  if (resolvedPeers.length > 0 && pkg.peerDependencies) {
    for (const p of resolvedPeers) {
      if (pkg.peerDependencies[p.package] !== undefined && pkg.peerDependencies[p.package] !== p.to) {
        pkg.peerDependencies[p.package] = p.to
        changes.push({ kind: 'peer', field: `peerDependencies.${p.package}`, from: p.from, to: p.to })
      }
    }
  }

  if (resolvedCompat.length > 0) {
    for (const c of resolvedCompat) {
      if (c.field === 'dsh.compatibility.dsh') {
        pkg.dsh = pkg.dsh || {}
        pkg.dsh.compatibility = pkg.dsh.compatibility || {}
        pkg.dsh.compatibility.dsh = c.to
        changes.push({ kind: 'compat', field: c.field, from: c.from, to: c.to })
      } else if (c.field.startsWith('dsh.compatibility.dshReleases.')) {
        const ver = c.field.slice('dsh.compatibility.dshReleases.'.length)
        pkg.dsh = pkg.dsh || {}
        pkg.dsh.compatibility = pkg.dsh.compatibility || {}
        pkg.dsh.compatibility.dshReleases = pkg.dsh.compatibility.dshReleases || {}
        pkg.dsh.compatibility.dshReleases[ver] = c.to
        changes.push({ kind: 'compat', field: c.field, from: c.from, to: c.to })
      } else if (c.field === 'engines.dsh') {
        pkg.engines = pkg.engines || {}
        pkg.engines.dsh = c.to
        changes.push({ kind: 'compat', field: c.field, from: c.from, to: c.to })
      }
    }
  }

  if (changes.length > 0) {
    // 与 codemod / fix-peer-deps 一致：写用户 package.json 属不可逆改动，落盘前
    // 先备份原文件到 <插件目录>/.pfa-backup/<时间戳>/，不备份就写会让批量治理
    // 成为唯一无法回档的自动修补入口。备份形状统一走 lib/backup.mjs。
    const backup = backupBeforeWrite(pluginDir, ['package.json'])
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    return { updated: true, changes, ...backup }
  }
  return { updated: false, changes, ...NO_BACKUP }
}

// 全域发现：区分来源、平台形态与挂载配置
export function discoverAllPlugins(
  targetDirs = [],
  { scanInstalled = true, scanWorkspace = true, envData = null, includeOfficial = false } = {},
) {
  const list = []
  const dshHome = envData?.dshDir || process.env.DSH_PFA_DSH_HOME || null
  const hostLoc = envData?.globalDsh?.location ? path.resolve(envData.globalDsh.location) : null

  // 1. 扫描安装环境中的插件
  if (scanInstalled && envData) {
    const installedProfiles = envData.installedPlugins || []
    // 找出当前活跃的 profile（如运行了 dsh web，则 runningProfile = 'web'；macOS 桌面端对应 desktop）
    const runningProfiles = new Set()
    for (const proc of envData.runningProcesses || []) {
      const m = proc.command?.match(/\bdsh\s+(web|desktop|serve|tui|headless)\b/)
      if (m) runningProfiles.add(m[1])
      else if (proc.command?.includes('DeepSeek Harness.app')) runningProfiles.add('desktop')
    }

    for (const group of installedProfiles) {
      const prof = group.profile
      const patchEntries = group.patchEntries || []
      const isRunningHost = runningProfiles.has(prof)
      const seenInProfile = new Set()

      for (const entry of patchEntries) {
        const m = entry.match(/^-\s+([^\s]+)/)
        if (!m) continue
        const pkgName = m[1]
        // 排除非插件的内部指令或服务别名
        if (pkgName.startsWith('-') || pkgName.includes(' ') || pkgName === 'insert:') continue
        if (seenInProfile.has(pkgName)) continue

        const resolvedDir = resolveInstalledPluginDir(pkgName, prof, dshHome)
        // 默认过滤官方内置 @deepseek-ai/dsh-* 服务条目（它们是宿主自带模块，除非用户显式 --include-official）。
        // 判据按「解析目录落在宿主包树内」而不是只按条目名前缀：宿主模块常以未带
        // scope 的条目 id 被引用（agent-default-model ↔ @deepseek-ai/dsh-agent-default-model），
        // 包名反查会把它解析进宿主包自己的 node_modules——不拦就会拿宿主的
        // package.json 去过用户插件审计，报出用户改不了的 peer 声明问题。
        const inHostTree = Boolean(
          resolvedDir && hostLoc && (resolvedDir === hostLoc || resolvedDir.startsWith(hostLoc + path.sep)),
        )
        if (!includeOfficial && (inHostTree || (!resolvedDir && pkgName.startsWith('@deepseek-ai/dsh-')))) {
          continue
        }

        seenInProfile.add(pkgName)

        let platform = 'core'
        if (prof === 'web') platform = 'web'
        else if (prof.includes('desktop')) platform = 'app'

        const isDisabled =
          entry.includes('disabled: true') ||
          group.globalPatchEntries?.some((e) => e.includes(pkgName) && e.includes('disabled: true'))

        let state = LIFECYCLE_STATE.ENABLED
        if (isDisabled) state = LIFECYCLE_STATE.DISABLED
        else if (isRunningHost) state = LIFECYCLE_STATE.RUNNING

        list.push({
          sourceType: 'INSTALLED',
          name: pkgName,
          dir: resolvedDir,
          profile: prof,
          platform,
          state,
          installed: true,
        })
      }
    }
  }

  // 2. 扫描工作区源码插件
  if (scanWorkspace) {
    const wsDirs = discoverWorkspacePlugins(targetDirs.length > 0 ? targetDirs : [process.cwd()])
    for (const dir of wsDirs) {
      const pkg = readPackageJson(dir)

      let platform = 'core'
      if (pkg?.dsh?.client?.platform === 'web' || fs.existsSync(path.join(dir, 'client'))) {
        platform = 'web'
      } else if (String(pkg?.name).includes('desktop') || fs.existsSync(path.join(dir, 'desktop'))) {
        platform = 'app'
      }

      list.push({
        sourceType: 'WORKSPACE',
        name: pkg?.name || path.basename(dir),
        dir,
        profile: 'workspace',
        platform,
        state: LIFECYCLE_STATE.WORKSPACE,
        installed: false,
      })
    }
  }

  return list
}

// 宿主日志点名兜底发现：patch 条目不是发现面的唯一真源。实测形态（2026-11-21）：
// @linxin666/dsh-agents 装在 profiles/{web,desktop}/node_modules、宿主每次启动都
// 尝试激活并失败（Failed plugins 段点名 Package），但它从未挂进任何 cordis.patch.yml
// ——只扫 patch 条目就永远看不见它。本函数把日志点名、现有清单没有的包补成
// HOST-LOG 项；目录能解析就交给 inspectPluginItem 真审计，解析不到也以
// 「目录未解析 + 宿主日志异常」双信号如实示警，不再静默。
export function discoverHostLogOnlyPlugins(runs, rawList, { dshHome = null, profiles = [], includeOfficial = false } = {}) {
  // 同一性去重按「解析目录 realpath」而不是名字：宿主日志按 package.json#name 点名
  // （dsh-suggest-actions），patch 条目按挂载名（dsh-suggestion-chips），两者指同一
  // 份目录——按名字去重会把同一插件列成两条。
  const known = new Set(rawList.map((i) => i.name))
  const knownDirs = new Set(rawList.map((i) => i.dir && realpathOf(i.dir)).filter(Boolean))
  const seen = new Set()
  const out = []
  for (const run of runs || []) {
    const failures = [
      ...(run.failedPlugins || []).map((fp) => ({ name: fp.package || fp.plugin, error: fp.error || '宿主启动失败' })),
      ...(run.inactiveEntries || []).map((ie) => ({ name: ie.package || ie.id, error: ie.error || '未激活' })),
    ]
    for (const f of failures) {
      if (!f.name || seen.has(f.name) || known.has(f.name)) continue
      seen.add(f.name)
      // 宿主自带模块不算用户插件（与 discoverAllPlugins 的内置过滤同一口径）
      if (!includeOfficial && f.name.startsWith('@deepseek-ai/')) continue
      let dir = null
      let foundProfile = null
      for (const prof of profiles.length ? profiles : [null]) {
        const d = resolveInstalledPluginDir(f.name, prof, dshHome)
        if (d) {
          dir = d
          foundProfile = prof
          break
        }
      }
      // 解析出的目录已在清单里（名字不同的同一插件）→ 不重复上榜，
      // 失败关联由 runFleetSweep 的 logFailuresByDir 按目录键补到既有条目上
      if (dir && knownDirs.has(realpathOf(dir))) continue
      let platform = 'core'
      if (foundProfile === 'web') platform = 'web'
      else if (foundProfile && foundProfile.includes('desktop')) platform = 'app'
      out.push({
        sourceType: 'HOST-LOG',
        name: f.name,
        dir,
        profile: foundProfile || 'host-log',
        platform,
        state: LIFECYCLE_STATE.ENABLED,
        installed: true,
      })
    }
  }
  return out
}

// 统一巡检与问题诊断
export function inspectPluginItem(
  rawItem,
  { hostInfo = null, targetVersion = null, envData = null, applyCompat = false, auditCache = null, asarPackages = null, logFailures = null, logFailuresByDir = null } = {},
) {
  const item = typeof rawItem === 'string'
    ? {
        name: path.basename(rawItem),
        dir: rawItem,
        profile: 'workspace',
        platform: 'core',
        state: LIFECYCLE_STATE.WORKSPACE,
        installed: false,
        sourceType: 'WORKSPACE',
      }
    : rawItem

  const dir = item.dir
  // 宿主自带模块按未带 scope 的条目 id 引用（实测：agent-default-model ↔
  // @deepseek-ai/dsh-agent-default-model，装在宿主包内或 APP asar 里）。目录
  // 归宿主管，不做体检也不算残留；@deepseek-ai/* 前缀是显式形态，一并算。
  const bareName = String(item.name || '').replace(/^@deepseek-ai\//, '')
  const suffix = `-${bareName}`
  const isHostBundled =
    item.installed &&
    !dir &&
    (String(item.name || '').startsWith('@deepseek-ai/') ||
      (asarPackages && [...asarPackages].some((p) => p === `@deepseek-ai/dsh-${bareName}` || p.endsWith(suffix))) ||
      (() => {
        const scopeDir = hostInfo?.location ? path.join(hostInfo.location, 'node_modules', '@deepseek-ai') : null
        if (!scopeDir) return false
        try {
          return fs
            .readdirSync(scopeDir)
            .some((p) => p === `dsh-${bareName}` || p.endsWith(suffix))
        } catch {
          return false
        }
      })())
  // 目录解析不到（2026-11-21 实测复盘）：过去 build 判 NOT_APPLICABLE ok:true、
  // audit 硬造 overallScore:100——残留被报成满分健康。经包名反查与宿主自带
  // 排除后仍解析不到的，如实降 WARNING：没体检就没有分数（score null，不伪造）。
  const isUnloadResidual = Boolean(item.installed && !dir && !isHostBundled)
  // 目标版本按平台分派：APP 桌面插件跑的是 APP 自捆的宿主，不是 npm 全局那份。
  // 两者错开时（2026-11-05 实测：APP 0.2.2-rc.1 vs npm 0.2.1-rc.5）用 npm 版本去判
  // APP 插件，会把「APP 新版里已移除的套件包」与「APP 新版才加的套件包」一起判错，
  // 而结论看起来和正常报告一模一样，只有把版本抄出来才看得出。
  const appHostVersion = envData?.desktopApp?.hostVersion || null
  const platformTarget = item.platform === 'app' && appHostVersion ? appHostVersion : null
  const effectiveTarget = targetVersion || platformTarget || hostInfo?.version || null
  let pkg = { name: item.name, version: '0.0.0' }
  if (dir) {
    pkg = readPackageJson(dir) ?? pkg
  }

  // 同一物理目录（软链复用）或同一已安装包版本（多 profile 独立拷贝，如 web/desktop/desktop-diag2）
  // 在同目标版本与同宿主包源下的只读构建检查与四维审计结果完全一致，缓存复用免去重复全量文件扫描。
  const useAsar = item.platform === 'app' && Boolean(asarPackages)
  const dirCacheKey = dir && !applyCompat && auditCache ? `${dir}\0${effectiveTarget || ''}\0${useAsar ? 'asar' : 'npm'}` : null
  const pkgCacheKey =
    dir && item.installed && !applyCompat && auditCache && pkg.name && pkg.version && pkg.version !== '0.0.0'
      ? `pkg:${pkg.name}@${pkg.version}\0${effectiveTarget || ''}\0${useAsar ? 'asar' : 'npm'}`
      : null
  const cached = (dirCacheKey && auditCache.get(dirCacheKey)) || (pkgCacheKey && auditCache.get(pkgCacheKey)) || null

  const build = cached ? cached.build : dir ? checkBuild(dir) : { ok: true, status: BUILD_STATUS.NOT_APPLICABLE }
  // 报告里那句「该包在当前本地宿主 (X) 中物理不存在」的 X 要与判定用的版本一致。
  // 当 APP 插件提供了 app.asar 包名集合时，直接按 asar 真实捆绑包判定，不再错用 npm 树。
  let platformHostInfo = platformTarget && hostInfo ? { ...hostInfo, version: platformTarget } : hostInfo
  if (useAsar && platformHostInfo) platformHostInfo = { ...platformHostInfo, asarPackages }
  let audit = cached ? cached.audit : null
  if (!audit) {
    if (dir) {
      try {
        audit = auditPlugin(dir, {
          hostInfo: platformHostInfo,
          targetVersion: effectiveTarget,
        })
      } catch (err) {
        audit = { overallScore: 0, scores: {}, findings: [{ severity: 'CRITICAL', title: err.message }] }
      }
    } else if (isHostBundled) {
      // 宿主自带模块（app asar / 宿主包内）：不体检不打分，也不算残留。
      audit = { overallScore: null, scores: {}, findings: [], peerPatch: [], compatPatch: [], hostBundled: true }
    } else if (isUnloadResidual) {
      // 目录解析不到（2026-11-21 实测复盘）：旧实现走到这里 build 判
      // NOT_APPLICABLE ok:true、audit 硬造 overallScore:100——残留被报成满分健康。
      // 经包名反查与宿主自带排除后仍解析不到的，如实降 WARNING：score 置 null
      // （没体检就没有分数，不伪造），用 MEDIUM 命中把 healthStatus 压到 WARNING。
      audit = {
        overallScore: null,
        scores: {},
        findings: [
          {
            severity: 'MEDIUM',
            title:
              '目录未解析: profile 已声明但按约定路径找不到插件目录（可能为卸载残留、条目 id 与包名不同名或装在约定外位置），无法体检',
          },
        ],
        peerPatch: [],
        compatPatch: [],
        unloadResidual: true,
      }
    } else {
      audit = {
        overallScore: 100,
        scores: { performance: 100, resilience: 100, contextBudget: 100, lifecycle: 100 },
        findings: [],
        peerPatch: [],
        compatPatch: [],
      }
    }
    if (dirCacheKey) auditCache.set(dirCacheKey, { build, audit })
    if (pkgCacheKey) auditCache.set(pkgCacheKey, { build, audit })
  }

  let findings = audit.findings || []
  let criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length
  let highCount = findings.filter((f) => f.severity === 'HIGH').length
  let mediumCount = findings.filter((f) => f.severity === 'MEDIUM').length
  let appliedPatches = null

  // 批量自适应修补：仅当无代码级 CRITICAL/HIGH 阻断且用户开启 applyCompat 时写入 package.json
  if (
    applyCompat &&
    dir &&
    criticalCount === 0 &&
    highCount === 0 &&
    ((audit.peerPatch?.length ?? 0) > 0 || (audit.compatPatch?.length ?? 0) > 0)
  ) {
    appliedPatches = applyCompatAndPeerPatch(dir, {
      targetVersion: effectiveTarget,
      peerPatch: audit.peerPatch,
      compatPatch: audit.compatPatch,
    })
    if (appliedPatches.updated) {
      // 重跑一次轻量审计，刷新准入账本与 Peer 得分
      try {
        audit = auditPlugin(dir, { hostInfo: platformHostInfo, targetVersion: effectiveTarget })
        findings = audit.findings || []
        criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length
        highCount = findings.filter((f) => f.severity === 'HIGH').length
        mediumCount = findings.filter((f) => f.severity === 'MEDIUM').length
      } catch {}
    }
  }

  let healthStatus = HEALTH_STATUS.HEALTHY
  const issues = []

  if (!build.ok) {
    healthStatus = HEALTH_STATUS.BROKEN
    issues.push(build.reason || '未构建')
  }

  if (criticalCount > 0 || highCount > 0) {
    healthStatus = HEALTH_STATUS.BROKEN
    const highTitles = findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').map((f) => f.title)
    issues.push(...highTitles)
  } else if (mediumCount > 0 || (typeof audit.overallScore === 'number' && audit.overallScore < 85)) {
    if (healthStatus !== HEALTH_STATUS.BROKEN) healthStatus = HEALTH_STATUS.WARNING
    const medTitles = findings.filter((f) => f.severity === 'MEDIUM').map((f) => f.title)
    issues.push(...medTitles)
  }

  // 运行中幽灵代际关联
  if (item.state === LIFECYCLE_STATE.RUNNING && envData?.ghostHost?.verdict === GHOST_HOST_VERDICT.STALE) {
    issues.push(`幽灵代际风险: ${envData.ghostHost.reason}`)
    if (healthStatus === HEALTH_STATUS.HEALTHY) healthStatus = HEALTH_STATUS.WARNING
  }

  // 宿主运行时日志故障关联（来自 ~/.dsh/logs 的最近失败记录）。
  // 名字键优先（日志点名 = 包名或挂载名），目录键兜底（两个名字不同名的同一插件，
  // 2026-11-21 实录：日志 dsh-suggest-actions ↔ patch 条目 dsh-suggestion-chips）。
  const hostLogHit =
    logFailures?.get(pkg.name || item.name) ?? (dir ? logFailuresByDir?.get(realpathOf(dir)) : null) ?? null
  if (item.installed && item.state !== LIFECYCLE_STATE.DISABLED && hostLogHit) {
    issues.push(`宿主日志异常: ${hostLogHit}`)
    if (healthStatus === HEALTH_STATUS.HEALTHY) healthStatus = HEALTH_STATUS.WARNING
  }

  return {
    ...item,
    name: pkg.name || item.name,
    version: pkg.version || '0.0.0',
    buildStatus: build.status,
    score: audit.overallScore,
    status: healthStatus,
    healthStatus,
    criticalCount,
    highCount,
    mediumCount,
    issues,
    findingsCount: findings.length,
    peerPatch: audit.peerPatch || [],
    compatPatch: audit.compatPatch || [],
    ...(audit.unloadResidual ? { unloadResidual: true } : {}),
    ...(audit.hostBundled ? { hostBundled: true } : {}),
    ...(appliedPatches ? { appliedPatches } : {}),
  }
}

export async function runFleetSweep(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const envData = probeEnvironment(process.cwd(), { skipTsconfig: true, skipActivation: true })
  const hostInfo = envData.globalDsh
  const targetVer = args.target || hostInfo?.version || '0.2.1'

  // 判定扫描范围：默认工作区 + 安装环境全域梳理；若显式指定了目录且未加 --installed 则只扫描指定目录
  const scanInstalled = args.installed || (!args.workspaceOnly && args.dirs.length === 0)
  const scanWorkspace = !args.installed

  const rawList = discoverAllPlugins(args.dirs, {
    scanInstalled,
    scanWorkspace,
    envData,
    includeOfficial: args.includeOfficial,
  })
  const asarPackages = listAsarDshPackages()
  const logFailures = new Map()
  let logFailuresByDir = new Map()
  let diagRuns = []
  if (scanInstalled) {
    try {
      // 优先匹配宿主运行与启动日志，防止每日 maintain-*.log / env-sweeper-*.log 把 dsh-web.log 顶出窗口
      const diag = diagnoseLogs({ limit: 5, pattern: '^(?:startup-|dsh-web)' })
      diagRuns = diag.runs || []
      for (const r of diagRuns) {
        for (const fp of r.failedPlugins || []) {
          const k = fp.package || fp.plugin
          if (k && !logFailures.has(k)) logFailures.set(k, fp.error || '启动失败')
        }
        for (const ie of r.inactiveEntries || []) {
          if (ie.package && !logFailures.has(ie.package)) logFailures.set(ie.package, ie.error || '未激活')
        }
      }
    } catch {}
    // 宿主日志点名兜底发现（2026-11-21 实录：@linxin666/dsh-agents 装在 profiles
    // node_modules、宿主反复激活失败，却因从未挂进任何 patch 层而进不了发现面——
    // 发现面不能只认 patch 条目这一张网）。日志点名、现有清单没有的包在这里补进。
    const dshHome = envData?.dshDir || process.env.DSH_PFA_DSH_HOME || path.join(os.homedir(), '.dsh')
    const logProfiles = [...new Set((envData.installedPlugins || []).map((g) => g.profile).filter(Boolean))]
    // 失败关联不能只按名字：宿主日志按 package.json#name 点名（dsh-suggest-actions），
    // patch 条目按挂载名（dsh-suggestion-chips）。目录键是两个名字共用的同一性。
    logFailuresByDir = new Map()
    for (const [k, err] of logFailures) {
      for (const prof of logProfiles.length ? logProfiles : [null]) {
        const d = resolveInstalledPluginDir(k, prof, dshHome)
        if (d) {
          logFailuresByDir.set(realpathOf(d), err)
          break
        }
      }
    }
    rawList.push(
      ...discoverHostLogOnlyPlugins(diagRuns, rawList, {
        dshHome,
        profiles: logProfiles,
        includeOfficial: args.includeOfficial,
      }),
    )
  }
  const auditCache = new Map()
  let items = rawList.map((item) =>
    inspectPluginItem(item, {
      hostInfo,
      targetVersion: targetVer,
      envData,
      applyCompat: args.applyCompat,
      auditCache,
      asarPackages,
      logFailures,
      logFailuresByDir,
    }),
  )

  // 条件筛选过滤
  if (args.filterWeb) items = items.filter((x) => x.platform === 'web')
  if (args.filterApp) items = items.filter((x) => x.platform === 'app')
  if (args.filterRunning) items = items.filter((x) => x.state === LIFECYCLE_STATE.RUNNING)
  if (args.filterDisabled) items = items.filter((x) => x.state === LIFECYCLE_STATE.DISABLED)
  if (args.workspaceOnly) items = items.filter((x) => x.sourceType === 'WORKSPACE')

  // 分类统计
  const total = items.length
  const healthy = items.filter((r) => r.healthStatus === HEALTH_STATUS.HEALTHY).length
  const warning = items.filter((r) => r.healthStatus === HEALTH_STATUS.WARNING).length
  const broken = items.filter((r) => r.healthStatus === HEALTH_STATUS.BROKEN).length

  const byPlatform = {
    web: items.filter((x) => x.platform === 'web'),
    app: items.filter((x) => x.platform === 'app'),
    core: items.filter((x) => x.platform === 'core'),
  }

  const byState = {
    running: items.filter((x) => x.state === LIFECYCLE_STATE.RUNNING),
    enabled: items.filter((x) => x.state === LIFECYCLE_STATE.ENABLED),
    disabled: items.filter((x) => x.state === LIFECYCLE_STATE.DISABLED),
    workspace: items.filter((x) => x.sourceType === 'WORKSPACE'),
  }

  const summary = {
    total,
    healthy,
    warning,
    broken,
    hostVersion: hostInfo?.version || null,
    targetVersion: targetVer,
    // APP 与 npm 宿主错开时，报告里必须能看出「APP 那批是按哪个版本判的」
    desktopHostVersion: envData?.desktopApp?.hostVersion || null,
    targetVersionByPlatform: { app: envData?.desktopApp?.hostVersion || targetVer, web: targetVer },
    activeHostProcesses: (envData.runningProcesses || []).length,
    byPlatform: {
      webCount: byPlatform.web.length,
      appCount: byPlatform.app.length,
      coreCount: byPlatform.core.length,
    },
    byState: {
      runningCount: byState.running.length,
      enabledCount: byState.enabled.length,
      disabledCount: byState.disabled.length,
      workspaceCount: byState.workspace.length,
    },
    plugins: items,
  }

  let prReadyList = []
  let prBlockedList = []
  let upstreamUpdatableList = []
  if (args.prReady) {
    const uniqueDirs = [...new Set(items.filter((i) => i.healthStatus !== HEALTH_STATUS.HEALTHY && i.dir).map((i) => i.dir))]
    const baselineCache = new Map()
    await Promise.all(
      uniqueDirs.map(async (dir) => {
        const res = await checkPrBaselineAsync(dir, { offline: args.offline, checkNpm: !args.offline })
        baselineCache.set(dir, res)
      }),
    )
    for (const item of items) {
      if (item.healthStatus === HEALTH_STATUS.HEALTHY || !item.dir) continue
      const baseline = baselineCache.get(item.dir)
      item.prBaseline = baseline
      if (baseline.ready) prReadyList.push(item)
      else if (baseline.upstreamUpdated) upstreamUpdatableList.push(item)
      else if (baseline.status !== PR_BASELINE_STATES.NO_REMOTE) prBlockedList.push(item)
    }
    summary.prReadyCount = prReadyList.length
    summary.upstreamUpdatableCount = upstreamUpdatableList.length
    summary.prReadyPlugins = prReadyList.map((p) => ({ name: p.name, version: p.version, dir: p.dir, remote: p.prBaseline.remote }))
    summary.upstreamUpdatablePlugins = upstreamUpdatableList.map((p) => ({
      name: p.name,
      version: p.version,
      dir: p.dir,
      status: p.prBaseline.status,
      npmVersion: p.prBaseline.npmVersion ?? null,
      reason: p.prBaseline.reason,
      action: p.prBaseline.action,
    }))
    summary.prBlockedPlugins = prBlockedList.map((p) => ({ name: p.name, version: p.version, dir: p.dir, status: p.prBaseline.status, reason: p.prBaseline.reason }))
  }

  if (args.json) {
    printJson(summary)
    process.exitCode = broken > 0 || (args.strict && warning > 0) ? 2 : 0
    return
  }

  // 格式化看板呈现
  process.stdout.write(`\n================================================================================\n`)
  process.stdout.write(`             DSH 插件全域集群治理看板 (目标宿主: ${targetVer})\n`)
  process.stdout.write(`================================================================================\n`)
  process.stdout.write(
    `【宿主状态】全局 DSH: ${hostInfo?.version || '未知'} | 活跃进程: ${(envData.runningProcesses || []).length} 个 | 幽灵代际: ${envData.ghostHost?.verdict || 'unknown'}\n\n`,
  )

  // 健康态 → 中文标签。展示层映射放这里，不放 lib/run-states.mjs——
// 那个文件只收词表与纯判定，混进展示映射就会让「加一个状态」要改两处。
const healthLabel = (status) =>
  status === HEALTH_STATUS.HEALTHY ? '健康' : status === HEALTH_STATUS.WARNING ? '警告' : '高危'

const printSection = (title, list) => {
    if (!list.length) return
    process.stdout.write(`\n┌─ ${title} (共 ${list.length} 个) ${'─'.repeat(Math.max(0, 70 - title.length))}\n`)
    process.stdout.write(
      `│ ${'插件名称'.padEnd(28)} ${'平台'.padEnd(8)} ${'状态'.padEnd(10)} ${'构建'.padEnd(8)} ${'评分'.padEnd(6)} 关键问题诊断\n`,
    )
    process.stdout.write(`├${'─'.repeat(78)}\n`)
    for (const r of list) {
      const issueText = r.issues.length > 0 ? r.issues[0].slice(0, 26) : '正常健康'
      const statusTag = healthLabel(r.healthStatus)
      process.stdout.write(
        `│ ${r.name.slice(0, 26).padEnd(28)} ${r.platform.padEnd(8)} ${(r.state + '/' + statusTag).padEnd(10)} ${r.buildStatus.padEnd(8)} ${(r.score === null ? 'n/a' : String(r.score)) + '/100'} ${issueText}\n`,
      )
    }
    process.stdout.write(`└${'─'.repeat(78)}\n`)
  }

  // 1. 正在运行中的插件
  printSection('一、正在运行中的插件 (RUNNING)', byState.running)

  // 2. 本地工作区源码插件
  printSection('二、本地工作区源码插件 (WORKSPACE)', byState.workspace)

  // 3. Web 平台已安装插件
  printSection('三、已安装 Web 插件 (INSTALLED / WEB)', byPlatform.web.filter((x) => x.sourceType !== 'WORKSPACE'))

  // 4. Desktop (APP) 平台插件
  printSection('四、已安装 Desktop (APP) 插件 (INSTALLED / APP)', byPlatform.app.filter((x) => x.sourceType !== 'WORKSPACE'))

  // 5. 已禁用或未启用的插件
  printSection('五、已禁用或未启用插件 (DISABLED / INACTIVE)', byState.disabled)

  process.stdout.write(
    `\n【全域统计】共 ${total} 个 | 运行中: ${byState.running.length} | 工作区: ${byState.workspace.length} | Web: ${byPlatform.web.length} | APP: ${byPlatform.app.length} | 未启用: ${byState.disabled.length}\n`,
  )
  process.stdout.write(`【健康结论】健康: ${healthy} | 需优化: ${warning} | 故障高危: ${broken}\n`)

  if (broken > 0) {
    process.stdout.write(`\n下一步指路: 存在 ${broken} 个故障插件，请使用单兵深度适配进行修复:\n`)
    for (const r of items.filter((x) => x.healthStatus === HEALTH_STATUS.BROKEN && x.dir)) {
      process.stdout.write(`  node scripts/run.mjs ${r.dir}\n`)
    }
  }

  if (args.prReady) {
    process.stdout.write(
      `\n【PR 基线筛选】可安全建 PR 分支: ${prReadyList.length} 个 | 上游已有更新(免重工): ${upstreamUpdatableList.length} 个 | 被拦截(脏/不可达): ${prBlockedList.length} 个\n`,
    )
    for (const p of upstreamUpdatableList) {
      process.stdout.write(`  [UPDATE]  ${p.name}@${p.version} (${p.prBaseline.status}: ${p.prBaseline.reason} → ${p.prBaseline.action || '更新上游'})\n`)
    }
    for (const p of prReadyList) {
      process.stdout.write(`  [READY]   ${p.name}@${p.version} (${p.prBaseline.remote})\n`)
    }
    for (const p of prBlockedList) {
      process.stdout.write(`  [BLOCKED] ${p.name}@${p.version} (${p.prBaseline.status}: ${p.prBaseline.reason})\n`)
    }
  }

  const exitCode = broken > 0 || (args.strict && warning > 0) ? 2 : 0
  process.exit(exitCode)
}

if (isMainEntry(import.meta.url)) {
  runFleetSweep()
}
