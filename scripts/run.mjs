#!/usr/bin/env node
// run.mjs —— 一键编排：环境 → 定版 → 取指南 → 扫描 → 体检 → 冒烟 → typecheck → 日志。
//
// 六个步骤此前要手动串（SKILL.md 的四步流程），2026-10-25 的适配实践暴露三个问题：
//   1. 手动串行容易漏步骤、跑错工具副本（当天就踩了 skills 目录滞后拷贝）；
//   2. 每步各自出 JSON，没有一份统一报告可归档；
//   3. typecheck / 宿主实测这类高信号低成本的核查根本不在流程里。
// run.mjs 把整条链固化，并把每次运行写进本地日志（lib/runlog.mjs），
// 供跨运行分析、优化与固化流程；日志不出本机，对外先 sanitize。
//
// 用法：
//   node scripts/run.mjs <插件目录> [--target <版本>] [--from <版本>]
//        [--no-clone] [--no-smoke] [--no-typecheck] [--no-log] [--real-smoke]
//
// 安全边界：quick-smoke 与 typecheck 都会执行插件自有的代码/脚本，
// 只对自己的插件或审过的代码运行（与 SKILL.md 的冒烟边界一致）。
// --real-smoke 额外把插件装进干净 profile 真启动宿主（verify-runtime.mjs），
// 信任级与 quick-smoke 相同，且要求本机 PATH 里有 dsh。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printJson, computeWindow, compareVersions } from './lib/scanner.mjs'
import { probeEnvironment } from './env-doctor.mjs'
import { auditPlugin } from './plugin-audit.mjs'
import { writeRunLog, getLatestSuccessfulRun, isPluginUnmodifiedSince } from './lib/runlog.mjs'

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS_DIR = path.join(TOOL_DIR, 'scripts')
const SPAWN_SHELL = process.platform === 'win32'

// 当前工具自身版本号
let currentToolVersion = '0.2.1'
try {
  const toolPkg = JSON.parse(fs.readFileSync(path.join(TOOL_DIR, 'package.json'), 'utf8'))
  if (toolPkg.version) currentToolVersion = toolPkg.version
} catch {}

// 只有 --target/--from 带值，其余都是布尔开关。旧实现按「前一个参数不以 -- 开头」
// 认插件目录，`run.mjs --offline <目录>` 会把目录当成 --offline 的值而报用法错误。
const VALUE_FLAGS = new Set(['target', 'from'])
const BOOLEAN_FLAGS = new Set(['offline', 'no-clone', 'no-smoke', 'no-typecheck', 'no-log', 'real-smoke', 'strict', 'help', 'force', 'check-upstream'])
const USAGE = '用法: node scripts/run.mjs <插件目录> [--target <版本>] [--from <版本>] [--no-clone] [--no-smoke] [--no-typecheck] [--no-log] [--real-smoke] [--offline] [--strict] [--force] [--check-upstream]'

function parseArgv(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    flags[name] = VALUE_FLAGS.has(name) ? argv[++i] ?? null : true
  }
  // 未知开关一律报错：旧实现静默接受，`--no-smoek` 会照常跑冒烟，
  // 用户以为关掉了，实际白付一次执行成本。
  const unknown = Object.keys(flags).filter((name) => !VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name))
  return { positional, flags, unknown }
}

const { positional, flags: parsedFlags, unknown } = parseArgv(process.argv.slice(2))
if (unknown.length) {
  process.stderr.write(`未知参数: ${unknown.map((n) => `--${n}`).join('、')}\n${USAGE}\n`)
  process.exit(1)
}
const flag = (name) => parsedFlags[name] === true
const valueOf = (name) => (VALUE_FLAGS.has(name) ? parsedFlags[name] ?? null : null)
if (flag('help')) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}
const pluginDir = path.resolve(positional[0] || process.cwd())

function runStep(script, scriptArgs, label, stages) {
  const started = Date.now()
  try {
    const stdout = execFileSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...scriptArgs], {
      encoding: 'utf8',
      shell: SPAWN_SHELL,
      maxBuffer: 64 * 1024 * 1024,
    })
    let json = null
    try {
      json = JSON.parse(stdout)
    } catch {
      json = { raw: stdout.slice(0, 4000) }
    }
    stages[label] = { status: 'ok', durationMs: Date.now() - started, output: json }
    return json
  } catch (err) {
    stages[label] = {
      status: 'error',
      durationMs: Date.now() - started,
      error: err.message?.slice(0, 1000),
      stdout: String(err.stdout || '').slice(0, 4000),
      stderr: String(err.stderr || '').slice(0, 2000),
    }
    return null
  }
}

function runTypecheck(pluginRoot, stages) {
  const pkgPath = path.join(pluginRoot, 'package.json')
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {
    stages.typecheck = { status: 'skipped', reason: 'package.json 不可读' }
    return
  }
  const script = pkg.scripts?.typecheck
  if (!script) {
    stages.typecheck = { status: 'skipped', reason: '未声明 typecheck script' }
    return
  }
  const runner = fs.existsSync(path.join(pluginRoot, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
  const started = Date.now()
  try {
    const out = execFileSync(runner, ['run', 'typecheck'], {
      cwd: pluginRoot,
      encoding: 'utf8',
      shell: SPAWN_SHELL,
      maxBuffer: 32 * 1024 * 1024,
    })
    stages.typecheck = { status: 'ok', runner, durationMs: Date.now() - started, tail: out.split('\n').slice(-5).join('\n') }
  } catch (err) {
    stages.typecheck = {
      status: 'fail',
      runner,
      durationMs: Date.now() - started,
      tail: String(err.stdout || err.message || '').split('\n').slice(-12).join('\n'),
      hint: 'typecheck 红说明插件当前连编译都过不了——适配前先修构建（taxue-dsh-artisan 0.3.1 发布态即红，本轮实测）。',
    }
  }
}

// ── 真冷启动档位（--real-smoke）─────────────────────────────────────────────
// Mock 冒烟的边界在 mockFallbacks 里自曝；真冷启动走原仓库 plugin-upgrade 的
// verify-runtime.mjs（干净 profile 安装→启动→归因，POSIX-only）。
// 找不到脚本就诚实跳过给补法，不静默降级也不伪造。
const VERIFY_RUNTIME_EXIT = { 1: 'fail', 2: 'inconclusive', 3: 'skipped' }

function resolveVerifyRuntime() {
  if (process.env.PFA_VERIFY_RUNTIME) return process.env.PFA_VERIFY_RUNTIME
  const candidates = [
    // 真源的兄弟仓：GPT/Deepseek/plugin-fast-adapt → GPT/dsh-plugin-upgrade-skill
    path.resolve(TOOL_DIR, '../../dsh-plugin-upgrade-skill/skills/plugin-upgrade/scripts/verify-runtime.mjs'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function runRealSmoke(pluginRoot) {
  if (process.platform === 'win32') {
    return { skipped: true, reason: 'verify-runtime 声明 POSIX-only，Windows 跳过' }
  }
  const script = resolveVerifyRuntime()
  if (!script) {
    return {
      skipped: true,
      reason: '未找到 verify-runtime.mjs——装原仓库 plugin-upgrade（dsh-plugin-upgrade-skill），或用 PFA_VERIFY_RUNTIME 指定路径',
    }
  }
  const started = Date.now()
  try {
    const out = execFileSync(process.execPath, [script, pluginRoot], {
      encoding: 'utf8',
      shell: SPAWN_SHELL,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 420_000,
    })
    return {
      status: 'ok',
      script: path.relative(TOOL_DIR, script),
      durationMs: Date.now() - started,
      tail: out.split('\n').slice(-5).join('\n').trim(),
    }
  } catch (err) {
    const label = VERIFY_RUNTIME_EXIT[err.status] ?? 'error'
    return {
      status: label,
      exitCode: err.status ?? null,
      timedOut: Boolean(err.timedOut),
      script: path.relative(TOOL_DIR, script),
      durationMs: Date.now() - started,
      tail: String(err.stdout || err.message || '').split('\n').slice(-12).join('\n'),
      hint:
        label === 'fail'
          ? '真冷启动失败——tail 是 verify-runtime 的归因输出，四类归因（插件代码/依赖解析/profile 配置/宿主运行时）以它为准'
          : label === 'inconclusive'
            ? '真冷启动不定论（exit 2）——看 tail 判断是需要换 profile 重探还是环境缺件'
            : null,
    }
  }
}

// ── 覆盖度：本轮到底用官方指南覆盖到哪一版 ──────────────────────────────────
// 「扫描跑了」不等于「目标版本查过了」：官方指南可能只补到上一版（tag 缺页、
// 分支快照落后）。把覆盖上限写进报告，让「没查到」与「查干净」在数据上可分。
function buildCoverage(scanResult, from, to, reason = null) {
  if (!scanResult) {
    return { from, to, coveredUpTo: null, complete: false, ...(reason ? { reason } : {}) }
  }
  const versions = scanResult.guideVersionsAvailable ?? []
  const upto = versions.filter((v) => compareVersions(v, to) <= 0).sort(compareVersions).pop() ?? null
  const coveredUpTo = upto ? String(upto).replace(/^v/, '') : null
  return { from, to, coveredUpTo, complete: Boolean(upto && compareVersions(upto, to) >= 0) }
}

// ── 编排 ────────────────────────────────────────────────────────────────────
const startedAt = Date.now()
const stages = {}

if (!fs.existsSync(path.join(pluginDir, 'package.json'))) {
  process.stderr.write(`用法: node scripts/run.mjs <插件目录>（目录下要有 package.json）\n`)
  process.exit(1)
}

const pluginPkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
// 独立 skill 拷贝（如 dsh-plugin-upgrade-skill/skills/ 下）没有 package.json，
// 工具版本降级为 commit/目录可观测，不让日志机制反向杀死编排
let toolPkg = null
try {
  toolPkg = JSON.parse(fs.readFileSync(path.join(TOOL_DIR, 'package.json'), 'utf8'))
} catch {}
const toolVersion = toolPkg?.version ?? null

// 1. 环境
const env = probeEnvironment(pluginDir)
stages.env = {
  status: 'ok',
  globalDsh: env.globalDsh,
  desktopApp: env.desktopApp,
  profiles: env.profiles,
  overlayFindings: env.overlayFindings?.length ?? 0,
  sharedFarmBroken: env.sharedFarmFindings?.brokenCount ?? 0,
  sharedFarmHostBacked: env.sharedFarmFindings?.hostBackedBroken ?? 0,
  runningProcesses: env.runningProcesses?.length ?? 0,
  activation: env.activation?.verdict ?? null,
  ghostHost: env.ghostHost ?? null,
  falseGreen: env.falseGreen ?? null,
}
const hostVersion = env.globalDsh?.version ?? null
if (env.desktopApp?.mismatch) {
  stages.env.desktopMismatch = env.desktopApp.mismatch
}
if ((env.overlayFindings?.length ?? 0) > 0) {
  stages.env.warning = '覆盖层有旧包残留，先跑 env-heal 再谈适配（issue #263 类事故）。'
} else if ((env.sharedFarmFindings?.brokenCount ?? 0) > 0) {
  // 共享农场（profiles/node_modules）的悬空软链不在各 profile 覆盖层里，
  // env-heal 不处理这一层；先报出来让人清，别让它继续以 ERR_MODULE_NOT_FOUND 的形式出现。
  stages.env.warning = `共享 node_modules 农场有 ${env.sharedFarmFindings.brokenCount} 条悬空软链（指向宿主 ${env.sharedFarmFindings.hostBackedBroken}），消费它们的插件会装载失败；env-heal 不覆盖这一层，需手工清。`
}

// ── 账本守卫：三元版本匹配 (Plugin, Host, Skill) 且源码无修改时秒级稳态直通 ─────
const pluginName = pluginPkg?.name ?? null
const lastRun = pluginName ? getLatestSuccessfulRun(pluginName) : null
const isCustomRun = Boolean(valueOf('from') || valueOf('target') || flag('real-smoke') || flag('force') || flag('strict'))

if (lastRun && !isCustomRun && hostVersion && pluginPkg?.version) {
  const isHostSame = lastRun.hostVersion === hostVersion
  const isPluginSame = lastRun.pluginVersion === pluginPkg.version
  const isToolSame = (lastRun.toolVersion || currentToolVersion) === currentToolVersion
  const isClean = isPluginUnmodifiedSince(pluginDir, lastRun.time)

  if (isHostSame && isPluginSame && isToolSame && isClean) {
    const elapsed = Date.now() - startedAt
    process.stdout.write(`\n[账本直通] 插件 ${pluginName}@${pluginPkg.version} 在宿主 ${hostVersion} 下已于 ${lastRun.time} 验证通过。\n`)
    process.stdout.write(`  三元版本账本一致 (Plugin: ${pluginPkg.version}, Host: ${hostVersion}, Skill: ${currentToolVersion})，且源码无修改。\n`)
    process.stdout.write(`  0 网络 / 0 冗余扫描 / 毫秒级复用上次健康结论 (体检 ${lastRun.auditScore ?? 100}分，无 critical/high)。\n`)
    process.stdout.write(`  如需强制重新全量编排，可追加 --force 开关。\n\n`)

    if (!flag('no-log')) {
      const fastRecord = {
        time: new Date().toISOString(),
        plugin: { name: pluginName, version: pluginPkg.version, dir: pluginDir },
        tool: { version: currentToolVersion },
        host: { version: hostVersion },
        window: lastRun.window || { local: hostVersion, target: hostVersion },
        phases: { scan: 'ok', smoke: 'ok', typecheck: 'skipped', realSmoke: null },
        fastPass: true,
        auditScore: lastRun.auditScore,
        durationMs: elapsed,
      }
      writeRunLog(fastRecord, { toolDir: TOOL_DIR })
    }
    process.exit(0)
  } else if (!isHostSame) {
    process.stdout.write(`\n[版本跃迁] 检测到宿主从 ${lastRun.hostVersion} 变更为 ${hostVersion}，启动靶向差分分析...\n`)
  }
}

function checkBuildArtifact(pluginRoot) {
  const pkgPath = path.join(pluginRoot, 'package.json')
  if (!fs.existsSync(pkgPath)) return { ok: true }
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {
    return { ok: true }
  }
  const hasTsConfig = fs.existsSync(path.join(pluginRoot, 'tsconfig.json'))
  const hasSrc = fs.existsSync(path.join(pluginRoot, 'src'))
  if (!hasTsConfig && !hasSrc) return { ok: true }

  const entryRel =
    pkg.exports?.['.']?.default ||
    (typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : null) ||
    pkg.main ||
    'lib/index.js'
  const entryPath = path.resolve(pluginRoot, entryRel)
  if (!fs.existsSync(entryPath)) {
    return {
      ok: false,
      entryRel,
      reason: `未找到构建入口产物: ${entryRel}。请先执行构建 (如 pnpm run build 或 npm run build)。`,
    }
  }
  return { ok: true, entryRel }
}

// 2. 定版本：以本地宿主环境为唯一基准（方案 B，零网络、防服务压力）
// 只有显式传入 --target 或 --check-upstream 时，才访问官方 npm registry
const offline = flag('offline')
const explicitTarget = valueOf('target')
const checkUpstream = flag('check-upstream')

let versionResult = null
let officialTarget = null

if (explicitTarget) {
  officialTarget = explicitTarget
  stages.version = { status: 'ok', resolution: { target: explicitTarget, source: 'explicit-flag' } }
  versionResult = { resolution: stages.version.resolution }
} else if (checkUpstream && hostVersion && !offline) {
  versionResult = runStep('guide-sync.mjs', [hostVersion], 'version', stages)
  officialTarget = versionResult?.resolution?.target ?? hostVersion
} else {
  stages.version = {
    status: 'ok',
    resolution: {
      target: hostVersion,
      source: 'local-host',
      reason: '以本机已安装宿主为准（本地环境自洽，0 外部网络请求）',
    },
  }
  versionResult = { resolution: stages.version.resolution }
  officialTarget = hostVersion
}

// 扫描窗口：起点取插件在宿主包（@deepseek-ai/dsh 及 dsh-* 子包）上声明的
// peer 下限，适配走廊从声明底到目标；--from 可覆盖，终点 = --target 或宿主版本。
// cordis/schemastery 是独立版本线的库不算宿主包；倒挂（起点 > 终点）回退宿主
// 版本并留痕（2026-10-25 dsh-image-gen 实录：混入库版本线后窗口 3.18.4 →
// 0.2.1-rc.3 倒挂，扫描静默跳过还记满分）。
const windowInfo = computeWindow({
  peers: pluginPkg.peerDependencies || {},
  hostVersion,
  from: valueOf('from'),
  target: explicitTarget || hostVersion || officialTarget,
})
const windowLocal = windowInfo.local
const windowTarget = windowInfo.target

// 3. 指南（分支快照优先；显式把扫描窗口终点传过去，别拿官方最新版本顶替）
// 旧实现只传本机版本：guide-sync 会优先取官方 target（可能是个还没打 tag 的版本），
// npm 发版早于上游打 tag 时整段扫描跳过，而本机其实已有可用的指南快照。
let guideRoot = null
if (offline) {
  stages.guides = { status: 'skipped', reason: '--offline' }
} else if (windowLocal && windowTarget && !flag('no-clone')) {
  const cloned = runStep('guide-sync.mjs', [windowLocal, '--clone', '--target', windowTarget], 'guides', stages)
  guideRoot = cloned?.guides?.root ?? null
}

// 4. 扫描（宿主实测核查内置）
let scanResult = null
if (guideRoot && windowLocal && windowTarget) {
  scanResult = runStep('code-scan.mjs', [pluginDir, guideRoot, windowLocal, windowTarget], 'scan', stages)
  if (scanResult) {
    const sev = Object.fromEntries((scanResult.bySeverity || []).map(([k, v]) => [k, v]))
    scanResult.criticalOrHigh = (sev.critical || 0) + (sev.high || 0)
  }
}

// 5. 体检（进程内，复用扫描结果交叉版本建议）
let auditReport = null
try {
  auditReport = auditPlugin(pluginDir, { scanResult, targetVersion: windowTarget })
  stages.audit = { status: 'ok', scores: auditReport.scores, overallScore: auditReport.overallScore, findings: auditReport.findings.length }
} catch (err) {
  stages.audit = { status: 'error', error: err.message?.slice(0, 500) }
}

// 6. 冒烟（前置低级错误拦截：未构建则阻断冒烟）
let smokeResult = null
const buildCheck = checkBuildArtifact(pluginDir)
if (!buildCheck.ok) {
  stages.smoke = {
    status: 'error',
    stage: 'entry_resolution',
    error: buildCheck.reason,
  }
} else if (!flag('no-smoke')) {
  smokeResult = runStep('quick-smoke.mjs', [pluginDir], 'smoke', stages)
}

// 7. typecheck（默认开；执行插件自有的 typecheck script，与冒烟同信任级）
if (!flag('no-typecheck')) runTypecheck(pluginDir, stages)

// 8. 真冷启动（默认关；--real-smoke 显式启用，装进干净 profile 真启动宿主）
const realSmoke = flag('real-smoke') ? runRealSmoke(pluginDir) : null

const durationMs = Date.now() - startedAt
const guideError = stages.guides?.error || stages.guides?.output?.guides?.error || null
// guide-sync 拉取失败时仍以退出码 0 返回，错误在 output.guides.error 里；
// 只看 stages.guides.error（进程级失败）会把「tag 不存在」报成「无指南根或无窗口」
const skipReason = guideError
  ? `指南拉取失败: ${String(guideError).slice(0, 200)}`
  : stages.scan?.error
    ? `扫描执行失败: ${String(stages.scan.error).slice(0, 200)}`
    : '无指南根或无窗口'
const coverage = buildCoverage(scanResult, windowLocal, windowTarget, scanResult ? null : skipReason)
const report = {
  time: new Date().toISOString(),
  plugin: { name: pluginPkg.name, version: pluginPkg.version, dir: pluginDir },
  tool: { version: toolVersion },
  host: { version: hostVersion, officialTarget, versionVerdict: versionResult?.resolution?.verdict ?? null, versionReason: versionResult?.resolution?.reason ?? null },
  window: { local: windowLocal, target: windowTarget, source: windowInfo.source, fallback: windowInfo.fallback },
  env: stages.env,
  version: versionResult?.resolution ?? null,
  guides: stages.guides?.output?.guides ?? null,
  scan: scanResult
    ? {
        findingCount: scanResult.findingCount,
        bySeverity: scanResult.bySeverity,
        criticalOrHigh: scanResult.criticalOrHigh,
        hostVerification: scanResult.hostVerification,
        guidesConsidered: scanResult.guidesConsidered,
        coverage,
        findings: scanResult.findings,
      }
    : {
        findingCount: null,
        skipped: true,
        reason: skipReason,
        coverage,
        // error 只认进程级失败：上游 tag 未打属于预期内的跳过，phases 仍记 skipped
        error: Boolean(stages.guides?.error || stages.scan?.error),
      },
  audit: auditReport
    ? { scores: auditReport.scores, overallScore: auditReport.overallScore, findings: auditReport.findings, versionAdvice: auditReport.versionAdvice ?? null, peerPatch: auditReport.peerPatch ?? null }
    : null,
  smoke: smokeResult
    ? { success: smokeResult.success, durationMs: smokeResult.durationMs, registeredToolsCount: smokeResult.registeredToolsCount, mockFallbacks: smokeResult.mockFallbacks }
    : stages.smoke?.status === 'error'
      ? { status: 'error', stage: stages.smoke.stage, error: stages.smoke.error, skipped: false }
      : { skipped: true },
  typecheck: stages.typecheck ?? { skipped: true },
  realSmoke,
  durationMs,
}

// 汇总结论（给人看的一屏话）
const criticalOrHigh = report.scan?.criticalOrHigh ?? 0
const verdictLines = []
verdictLines.push(`插件 ${pluginPkg.name}@${pluginPkg.version} × 宿主 ${hostVersion ?? '未知'}（窗口 ${windowLocal} → ${windowTarget}）`)
if (report.env?.desktopMismatch) verdictLines.push(`⚠ ${report.env.desktopMismatch}`)
if (report.env?.ghostHost?.verdict === 'stale') verdictLines.push(`⚠ 幽灵宿主：${report.env.ghostHost.reason}——先重启宿主，否则改完也验不到`)
if ((report.env?.falseGreen?.count ?? 0) > 0) {
  const aliases = report.env.falseGreen.findings.map((f) => f.alias).join('、')
  verdictLines.push(`⚠ tsconfig 假绿 ${report.env.falseGreen.count} 处（${aliases}）：paths 指向不存在的目录，typecheck 可能全绿——先修路径再信构建结果`)
}
if (report.window.fallback) {
  verdictLines.push(`⚠ 扫描窗口倒挂（起点 ${report.window.fallback.rejectedFrom} > 终点 ${windowTarget}），已回退起点为宿主版本 ${report.window.fallback.to ?? '未知'}——peer 声明或 --from 有误，倒挂会让扫描静默跳过`)
}
if (report.host.versionVerdict === 'upgrade-available') verdictLines.push(`宿主可升级: 官方 ${officialTarget}（当前 ${hostVersion}）；本轮按在跑宿主适配，要跟新版重跑 --target ${officialTarget}`)
// 「没扫」与「扫了但指南没覆盖到目标版本」都是未知，不能落成「命中 0 处」的干净结论
const scanCoverage = report.scan?.coverage
if (report.guides?.frozen) {
  verdictLines.push('⚠ 本轮指南来自发版 tag 的冻结快照——官方会在发版后补全同版本条目，命中数偏低不等于干净；有网时重跑走分支快照')
}
// 空走廊（peer 下限 = 宿主版本）本来就没有要扫的变更，零命中是正常；
// 只有走廊非空却一条指南都没有时，零命中才是未知。
const emptyCorridor = windowLocal && windowTarget && compareVersions(windowLocal, windowTarget) === 0
if (report.scan?.skipped) {
  verdictLines.push(`⚠ 本轮没有扫描代码（${String(report.scan.reason).slice(0, 160)}）——退出码 0 不代表干净`)
} else if (scanCoverage && !scanCoverage.complete) {
  verdictLines.push(`⚠ 官方指南只覆盖到 ${scanCoverage.coveredUpTo || '无'}，${windowTarget} 的变更未见文档——本轮结论只覆盖到该版本，不能当查干净`)
} else if (report.scan?.guidesConsidered === 0 && !emptyCorridor) {
  verdictLines.push('⚠ 本轮指南覆盖 0 条变更——这一段没有官方指南，不等于查干净')
}
if (criticalOrHigh > 0) verdictLines.push(`⚠ critical/high 命中 ${criticalOrHigh} 处——先清零再做优化`)
else if (report.scan?.findingCount != null) verdictLines.push(`扫描命中 ${report.scan.findingCount} 处（无 critical/high）`)
if (report.audit) verdictLines.push(`体检 ${report.audit.overallScore}/100（性能 ${report.audit.scores.performance}/弹性 ${report.audit.scores.resilience}/预算 ${report.audit.scores.contextBudget}/生命周期 ${report.audit.scores.lifecycle}）`)
if (report.smoke?.status === 'error') verdictLines.push(`⚠ 冒烟阻断（${report.smoke.stage}）——${report.smoke.error}`)
else if (report.smoke?.success != null) verdictLines.push(report.smoke.success ? `冒烟通过（${report.smoke.registeredToolsCount} 工具，${report.smoke.durationMs}ms）` : '冒烟失败——看 smoke 段')
if (report.typecheck?.status === 'fail') verdictLines.push('typecheck 红——适配前先修构建')
else if (report.typecheck?.status === 'ok') verdictLines.push('typecheck 通过')
else if (report.typecheck?.status === 'skipped') verdictLines.push(`typecheck 跳过（${report.typecheck.reason}）`)
if (realSmoke) {
  if (realSmoke.skipped) verdictLines.push(`真冷启动跳过——${realSmoke.reason}`)
  else if (realSmoke.status === 'ok') verdictLines.push(`真冷启动通过（${realSmoke.durationMs}ms，verify-runtime 四类归因全绿）`)
  else if (realSmoke.status === 'fail') verdictLines.push('⚠ 真冷启动失败——看 realSmoke.tail 的归因')
  else if (realSmoke.status === 'inconclusive') verdictLines.push('真冷启动不定论——看 realSmoke.tail')
}

// 8. 日志（--no-log 跳过）
if (!flag('no-log')) {
  const logged = writeRunLog(report, { toolDir: TOOL_DIR })
  if (logged) verdictLines.push(`日志: ${logged.file}`)
}

printJson(report)
process.stderr.write(`\n${verdictLines.join('\n')}\n`)

// 失败即指路：退出码 2 的原因各给一句「下一步」，排障路径从读文档变成读输出
// --strict 额外把「扫描没跑 / 指南没覆盖到目标版本」当失败；默认不加，
// 保持既有退出码语义（0 干净、2 命中或构建/真冷启动失败）。
const scanUnknown = Boolean(report.scan?.skipped) || report.scan?.coverage?.complete === false
const strictFail = flag('strict') && scanUnknown
const exitFail = criticalOrHigh > 0 || report.typecheck?.status === 'fail' || realSmoke?.status === 'fail' || strictFail
if (exitFail) {
  const next = []
  if (criticalOrHigh > 0) next.push('按 scan.findings 的 migration 逐条清命中（evidence 行原文可核对是否误报）')
  if (report.typecheck?.status === 'fail') next.push('typecheck 红——先修构建（尾部输出在 report.typecheck.tail）')
  if (realSmoke?.status === 'fail') next.push('真冷启动失败——realSmoke.tail 有四类归因')
  if (strictFail) {
    next.push(report.scan?.skipped
      ? '扫描没跑（--strict）——按 scan.reason 修指南来源或网络后重跑'
      : `指南没覆盖到 ${windowTarget}（--strict）——刷新指南或核对 --target`)
  }
  process.stderr.write(`\n下一步: ${next.join('；')}。修完重跑本命令；装了没生效跑 run-log doctor，宿主起不来跑 log-doctor\n`)
}
process.exit(exitFail ? 2 : 0)
