#!/usr/bin/env node
// env-doctor.mjs —— 第 1 步：探测本机 DSH 环境。
//
// 只读，不写任何东西。回答三个问题：
//   1. 本机装的 DSH 是什么版本？（全局 + 各 profile）
//   2. profiles 覆盖层里有没有和主安装脱节的包？（issue #263 那一类）
//   3. 当前有哪些插件，它们的 peer 声明覆盖哪个版本窗口？
//
// 输出 JSON，供后续步骤和人不读散文也能用。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { printJson, isDshPackage, packageBase, parseVersion, compareVersions, peerFloor, maskSource, CODE } from './lib/scanner.mjs'

const HOME = os.homedir()
const DSH_DIR = path.join(HOME, '.dsh')

// ── 全局安装发现（不写死单一路径） ─────────────────────────────────────────

// 全局 node_modules 候选根。spawn 一次 npm root -g 要 60-120ms，旧实现每次
// 探测都 spawn（一个进程里跑两遍），是 env-doctor 的主要耗时。这里静态路径
// 零成本先行，全都探不到 @deepseek-ai 目录时才问 npm 兜底（自定义 prefix、
// volta、asdf 一类安装位），结果缓存供整个进程复用。
// Windows 下 npm/dsh 是 .cmd 批处理，spawn 必须走 shell 才找得到（Node 官方
// 文档：.bat/.cmd 需 shell 选项）；POSIX 保持 shell:false 不变。
const SPAWN_SHELL = process.platform === 'win32' ? true : false

let globalRootsCache = null

// platform/env 可注入，供自检做 Windows 模拟；带注入的调用不写缓存，
// 模拟结果不会污染本进程后续的真实探测。
export function candidateGlobalRoots({ platform = process.platform, env = process.env } = {}) {
  const simulated = platform !== process.platform || env !== process.env
  if (globalRootsCache && !simulated) return globalRootsCache
  const roots = [
    path.join(HOME, '.local', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ]
  // Windows npm 默认前缀是 %APPDATA%\npm，node_modules 在其下；
  // 先探这里可以免掉一次 npm spawn
  if (platform === 'win32' && env.APPDATA) {
    roots.push(path.join(env.APPDATA, 'npm', 'node_modules'))
  }
  try {
    const nvmDir = env.NVM_DIR || path.join(HOME, '.nvm')
    const versions = path.join(nvmDir, 'versions', 'node')
    if (fs.existsSync(versions)) {
      for (const v of fs.readdirSync(versions)) {
        roots.push(path.join(versions, v, 'lib', 'node_modules'))
      }
    }
  } catch {}
  if (!roots.some((r) => fs.existsSync(path.join(r, '@deepseek-ai')))) {
    try {
      const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: SPAWN_SHELL }).trim()
      if (npmRoot) roots.push(npmRoot)
    } catch {}
  }
  const result = [...new Set(roots.filter(Boolean))]
  if (!simulated) globalRootsCache = result
  return result
}

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function findGlobalDsh() {
  for (const root of candidateGlobalRoots()) {
    const pkg = readPackageJson(path.join(root, '@deepseek-ai', 'dsh'))
    if (pkg?.version) {
      return { version: pkg.version, location: path.join(root, '@deepseek-ai', 'dsh'), source: 'node_modules' }
    }
  }
  try {
    const out = execFileSync('dsh', ['--version'], { encoding: 'utf8', shell: SPAWN_SHELL }).trim()
    const m = out.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)
    if (m) return { version: m[1], location: null, source: 'dsh --version' }
  } catch {}
  return null
}

// ── profiles 覆盖层 ────────────────────────────────────────────────────────

function listProfiles() {
  const dir = path.join(DSH_DIR, 'profiles')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // profiles/ 下会混进 node_modules 之类的目录，不是 profile
    .filter((name) => !name.startsWith('.') && name !== 'node_modules')
}

function scanOverlay(profile, globalVersion) {
  const nodeModules = path.join(DSH_DIR, 'profiles', profile, 'node_modules', '@deepseek-ai')
  if (!fs.existsSync(nodeModules)) return []

  const packages = []
  for (const name of fs.readdirSync(nodeModules)) {
    const pkg = readPackageJson(path.join(nodeModules, name))
    if (!pkg?.version) continue
    packages.push({ name: `@deepseek-ai/${name}`, version: pkg.version, dir: path.join(nodeModules, name) })
  }

  const findings = []
  for (const pkg of packages) {
    const reasons = []
    let severity = null

    if (RETIRED_PACKAGES.has(pkg.name)) {
      reasons.push('上游宿主已移除该包，留在覆盖层会导致运行时装载冲突')
      severity = 'critical'
    }

    const globalSibling = findGlobalPackageVersion(pkg.name)
    if (globalSibling && compareVersions(pkg.version, globalSibling) !== 0) {
      reasons.push(`覆盖层版本 (${pkg.version}) 与全局宿主所带版本 (${globalSibling}) 不一致，优先解析会引发接口破坏`)
      severity = 'critical'
    }

    if (globalVersion) {
      const shortBase = pkg.name.replace('@deepseek-ai/', '')
      if (DSH_SUITE_PACKAGES.has(shortBase) || pkg.name === '@deepseek-ai/dsh') {
        const pv = parseVersion(pkg.version)
        const gv = parseVersion(globalVersion)
        if (pv.major !== gv.major || pv.minor !== gv.minor) {
          reasons.push(`DSH 套件子包版本 (${pkg.version}) 与全局宿主版本 (${globalVersion}) 跨 minor 脱节`)
          severity = severity || 'high'
        }
      }
    }

    if (reasons.length) {
      findings.push({ profile, package: pkg.name, version: pkg.version, severity, reasons, path: pkg.dir })
    }
  }

  return findings
}

// 上游已移除、不该再出现在覆盖层的包
const RETIRED_PACKAGES = new Set([
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-report',
])

// 版本号跟随宿主走的套件子包（用于识别跨 minor 脱节）
const DSH_SUITE_PACKAGES = new Set([
  'dsh-tools', 'dsh-invariants', 'dsh-session', 'dsh-client-ui-primitives',
  'dsh-user-questions', 'dsh-schedule', 'dsh-attachments', 'dsh-subagent-claude-code',
  'dsh-subagent-codex', 'dsh-experimental-code-runtime-python',
])

let globalPackageCache = null
function findGlobalPackageVersion(name) {
  if (!globalPackageCache) {
    globalPackageCache = new Map()
    for (const root of candidateGlobalRoots()) {
      const dir = path.join(root, '@deepseek-ai')
      if (!fs.existsSync(dir)) continue
      for (const sub of fs.readdirSync(dir)) {
        const pkg = readPackageJson(path.join(dir, sub))
        if (pkg?.version) globalPackageCache.set(`@deepseek-ai/${sub}`, pkg.version)
      }
    }
  }
  return globalPackageCache.get(name)
}

// ── 已装插件清单 ───────────────────────────────────────────────────────────

// 解析 patch 层条目。多行 YAML 是常态（- insert: / - id: 换行后才是 name），
// 单行正则会把活跃插件整个漏掉——实测 web profile 的 wide-research 条目
// name 在 - id: 的下一行，argo-dsh 被误判成「未挂载」。
// 注释掉的条目不算挂载；只看条目头部，深层 config.name 是模型名不是插件名。
export function parsePatchEntries(text) {
  const entries = []
  for (const block of text.split(/(?=^\s*-\s)/m)) {
    const live = block.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
    if (!/^\s*-\s/.test(live)) continue
    const header = live.split('\n').slice(0, 5).join('\n')
    const name = header.match(/name:\s*['"]?([\w@/.-]+)['"]?/)
    const id = header.match(/id:\s*['"]?([\w@/.-]+)['"]?/)
    const inlineInsert = header.match(/^\s*-\s*insert:\s*(\S+)/m)
    const parts = [...new Set([name?.[1], id?.[1], inlineInsert?.[1]].filter(Boolean))]
    if (parts.length) entries.push(`- ${parts.join(' ')}`)
  }
  return entries
}

function listInstalledPlugins() {
  const plugins = []
  for (const profile of listProfiles()) {
    const patchFile = path.join(DSH_DIR, 'profiles', profile, 'cordis.patch.yml')
    const patchEntries = []
    if (fs.existsSync(patchFile)) {
      patchEntries.push(...parsePatchEntries(fs.readFileSync(patchFile, 'utf8')))
    }
    plugins.push({ profile, patchFile, patchEntries })
  }
  return plugins
}

// ── 插件启用就绪度（防「装了但没生效」） ──────────────────────────────────
// 三件事：构建产物在不在、各 profile 有没有挂载、声明的 inject 服务
// 在 profile 里有没有提供方特征。最后一条是 Cordis 的静默陷阱：
// 强 inject 一个不存在的服务，插件不报错，只是永远 pending。

export function extractInjects(root, entryFile) {
  const candidates = [entryFile, 'src/index.ts', 'src/index.js', 'src/index.mjs'].map((f) => path.join(root, f))
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    const mask = maskSource(text)
    // 只认代码区的 inject 声明；注释里的不算
    for (const m of text.matchAll(/inject\s*=\s*\[([^\]]*)\]/g)) {
      if (mask[m.index] !== CODE) continue
      const list = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
      if (list.length) return list
    }
  }
  return []
}

// profile 里常见宿主服务的文本特征。这是特征级推断，不是服务解析器：
// 报「有风险」让人去确认，不报「一定挂」。
const SERVICE_SIGNATURES = [
  { name: 'sessionQuery', pattern: /dsh-session-query/ },
  { name: 'llm', pattern: /dsh-llm/ },
  { name: 'tools', pattern: /dsh-tool|\btools\b/ },
  { name: 'webServer', pattern: /web|server/ },
]

export function diagnoseActivation(targetDir, installedPlugins) {
  const root = path.resolve(targetDir)
  const pkg = readPackageJson(targetDir)
  if (!pkg) return { checked: false, reason: '目标目录没有 package.json' }

  const main = pkg.main || 'lib/index.js'
  const entryReady = fs.existsSync(path.join(root, main))
  const injects = extractInjects(root, main)

  const perProfile = installedPlugins.map(({ profile, patchFile, patchEntries }) => {
    let disabled = false
    try {
      const text = fs.readFileSync(patchFile, 'utf8')
      const nameEsc = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // 判定 disabled 限定在同一个条目块内：按列表项「- 」为界切块，
      // 防止本插件条目被后面其他插件条目的 disabled: true 跨条目误伤
      // （误伤会跳过 Silent Pending 风险检查，把该报的吞掉）。
      const nameRe = new RegExp(`name:\\s*['"]?${nameEsc}['"]?`)
      disabled = text
        .split(/(?=^\s*-\s)/m)
        .some((block) => nameRe.test(block) && /disabled:\s*true/.test(block))
    } catch {}
    const registered = patchEntries.some((e) => e.includes(pkg.name))
    return { profile, registered, disabled }
  })

  const pendingRisks = []
  if (injects.length && perProfile.some((p) => p.registered && !p.disabled)) {
    for (const { profile, registered, disabled } of perProfile) {
      if (!registered || disabled) continue
      let patchText = ''
      try {
        patchText = fs.readFileSync(path.join(DSH_DIR, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
      } catch {}
      const available = SERVICE_SIGNATURES.filter((s) => s.pattern.test(patchText)).map((s) => s.name)
      for (const inj of injects) {
        const known = SERVICE_SIGNATURES.find((s) => s.name === inj)
        if (known && !available.includes(inj)) {
          pendingRisks.push({
            profile,
            service: inj,
            reason: `插件声明强制注入 "${inj}"，但该 profile 的组合里没有它的提供方特征`,
            solution: `确认宿主确实提供该服务，或改用弱依赖 ctx.get('${inj}') 探测降级`,
          })
        }
      }
    }
  }

  let verdict = 'OK'
  if (!entryReady) verdict = 'ERROR'
  else if (pendingRisks.length || perProfile.every((p) => !p.registered)) verdict = 'WARN'

  return {
    checked: true,
    package: pkg.name,
    entry: { file: main, ready: entryReady },
    injects,
    perProfile,
    pendingRisks,
    verdict,
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

export function probeEnvironment(targetDir = process.cwd()) {
  const globalDsh = findGlobalDsh()
  const profiles = listProfiles()
  const overlay = []
  for (const profile of profiles) {
    overlay.push(...scanOverlay(profile, globalDsh?.version))
  }

  const installedPlugins = listInstalledPlugins()

  const running = []
  try {
    // ps 是 POSIX 命令；Windows 上没有，try/catch 退化为空清单（不误报）
    const ps = execFileSync('ps', ['-eo', 'pid,etime,command'], { encoding: 'utf8' })
    for (const line of ps.split('\n')) {
      if (/\bdsh\b/.test(line) && /web|desktop|serve/.test(line) && !/ps -eo/.test(line)) {
        const [pid, etime, ...rest] = line.trim().split(/\s+/)
        running.push({ pid, elapsed: etime, command: rest.join(' ') })
      }
    }
  } catch {}

  // 目标插件自身的信息
  const pluginPkg = readPackageJson(targetDir)
  const peers = pluginPkg?.peerDependencies || {}
  const peerWindows = Object.entries(peers)
    .filter(([name]) => isDshPackage(name))
    .map(([name, range]) => ({ package: name, range, floor: peerFloor(range) }))

  const activation = diagnoseActivation(targetDir, installedPlugins)

  return {
    timestamp: new Date().toISOString(),
    globalDsh,
    profiles,
    overlayFindings: overlay,
    runningProcesses: running,
    installedPlugins,
    activation,
    target: {
      dir: path.resolve(targetDir),
      package: pluginPkg?.name || null,
      version: pluginPkg?.version || null,
      peerWindows,
    },
    home: HOME,
    dshDir: DSH_DIR,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const target = process.argv[2] || process.cwd()
  const report = probeEnvironment(target)
  printJson(report)

  const overlayCount = report.overlayFindings.length
  process.stderr.write(
    `\n全局 DSH: ${report.globalDsh?.version || '未检测到'} (${report.globalDsh?.source || 'n/a'})\n` +
    `profiles: ${report.profiles.join(', ') || '无'}\n` +
    `覆盖层问题: ${overlayCount} 处\n` +
    `运行中宿主进程: ${report.runningProcesses.length} 个\n` +
    (report.activation?.checked
      ? `目标插件启用就绪: ${report.activation.verdict}${report.activation.pendingRisks.length ? `（Silent Pending 风险 ${report.activation.pendingRisks.length} 处）` : ''}\n`
      : '')
  )
}
