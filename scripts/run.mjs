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
//        [--no-clone] [--no-smoke] [--no-typecheck] [--no-log]
//
// 安全边界：quick-smoke 与 typecheck 都会执行插件自有的代码/脚本，
// 只对自己的插件或审过的代码运行（与 SKILL.md 的冒烟边界一致）。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printJson, computeWindow } from './lib/scanner.mjs'
import { probeEnvironment } from './env-doctor.mjs'
import { auditPlugin } from './plugin-audit.mjs'
import { writeRunLog } from './lib/runlog.mjs'

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS_DIR = path.join(TOOL_DIR, 'scripts')
const SPAWN_SHELL = process.platform === 'win32'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name) => {
  const at = args.indexOf(`--${name}`)
  return at !== -1 ? args[at + 1] : null
}
const pluginDirArg = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')))
const pluginDir = path.resolve(pluginDirArg || process.cwd())

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
  profiles: env.profiles,
  overlayFindings: env.overlayFindings?.length ?? 0,
  runningProcesses: env.runningProcesses?.length ?? 0,
  activation: env.activation?.verdict ?? null,
}
const hostVersion = env.globalDsh?.version ?? null
if ((env.overlayFindings?.length ?? 0) > 0) {
  stages.env.warning = '覆盖层有旧包残留，先跑 env-heal 再谈适配（issue #263 类事故）。'
}

// 2. 定版本：宿主是否落后官方 + 扫描窗口
// --offline：跳过 guide-sync（自检零网络用），只保留 env/audit/typecheck/smoke
const offline = flag('offline')
const versionResult = hostVersion && !offline ? runStep('guide-sync.mjs', [hostVersion], 'version', stages) : null
const officialTarget = versionResult?.resolution?.target ?? null

// 扫描窗口：起点取插件在宿主包（@deepseek-ai/dsh 及 dsh-* 子包）上声明的
// peer 下限，适配走廊从声明底到目标；--from 可覆盖，终点 = --target 或宿主版本。
// cordis/schemastery 是独立版本线的库不算宿主包；倒挂（起点 > 终点）回退宿主
// 版本并留痕（2026-10-25 dsh-image-gen 实录：混入库版本线后窗口 3.18.4 →
// 0.2.1-rc.3 倒挂，扫描静默跳过还记满分）。
const windowInfo = computeWindow({
  peers: pluginPkg.peerDependencies || {},
  hostVersion,
  from: valueOf('from'),
  target: valueOf('target') || hostVersion || officialTarget,
})
const windowLocal = windowInfo.local
const windowTarget = windowInfo.target

// 3. 指南（优先本机缓存；upgrade-available 时拉目标版本）
let guideRoot = null
if (offline) {
  stages.guides = { status: 'skipped', reason: '--offline' }
} else if (windowLocal && windowTarget && !flag('no-clone')) {
  const cloned = runStep('guide-sync.mjs', [windowLocal, '--clone'], 'guides', stages)
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

// 6. 冒烟
let smokeResult = null
if (!flag('no-smoke')) {
  smokeResult = runStep('quick-smoke.mjs', [pluginDir], 'smoke', stages)
}

// 7. typecheck（默认开；执行插件自有的 typecheck script，与冒烟同信任级）
if (!flag('no-typecheck')) runTypecheck(pluginDir, stages)

const durationMs = Date.now() - startedAt
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
        findings: scanResult.findings,
      }
    : {
        findingCount: null,
        skipped: true,
        reason: stages.guides?.error
          ? `指南拉取失败: ${String(stages.guides.error).slice(0, 200)}`
          : stages.scan?.error
            ? `扫描执行失败: ${String(stages.scan.error).slice(0, 200)}`
            : '无指南根或无窗口',
        error: Boolean(stages.guides?.error || stages.scan?.error),
      },
  audit: auditReport
    ? { scores: auditReport.scores, overallScore: auditReport.overallScore, findings: auditReport.findings, versionAdvice: auditReport.versionAdvice ?? null, peerPatch: auditReport.peerPatch ?? null }
    : null,
  smoke: smokeResult
    ? { success: smokeResult.success, durationMs: smokeResult.durationMs, registeredToolsCount: smokeResult.registeredToolsCount, mockFallbacks: smokeResult.mockFallbacks }
    : { skipped: true },
  typecheck: stages.typecheck ?? { skipped: true },
  durationMs,
}

// 汇总结论（给人看的一屏话）
const criticalOrHigh = report.scan?.criticalOrHigh ?? 0
const verdictLines = []
verdictLines.push(`插件 ${pluginPkg.name}@${pluginPkg.version} × 宿主 ${hostVersion ?? '未知'}（窗口 ${windowLocal} → ${windowTarget}）`)
if (report.window.fallback) {
  verdictLines.push(`⚠ 扫描窗口倒挂（起点 ${report.window.fallback.rejectedFrom} > 终点 ${windowTarget}），已回退起点为宿主版本 ${report.window.fallback.to ?? '未知'}——peer 声明或 --from 有误，倒挂会让扫描静默跳过`)
}
if (report.host.versionVerdict === 'upgrade-available') verdictLines.push(`宿主可升级: 官方 ${officialTarget}（当前 ${hostVersion}）；本轮按在跑宿主适配，要跟新版重跑 --target ${officialTarget}`)
if (criticalOrHigh > 0) verdictLines.push(`⚠ critical/high 命中 ${criticalOrHigh} 处——先清零再做优化`)
else if (report.scan?.findingCount != null) verdictLines.push(`扫描命中 ${report.scan.findingCount} 处（无 critical/high）`)
if (report.audit) verdictLines.push(`体检 ${report.audit.overallScore}/100（性能 ${report.audit.scores.performance}/弹性 ${report.audit.scores.resilience}/预算 ${report.audit.scores.contextBudget}/生命周期 ${report.audit.scores.lifecycle}）`)
if (report.smoke?.success != null) verdictLines.push(report.smoke.success ? `冒烟通过（${report.smoke.registeredToolsCount} 工具，${report.smoke.durationMs}ms）` : '冒烟失败——看 smoke 段')
if (report.typecheck?.status === 'fail') verdictLines.push('typecheck 红——适配前先修构建')
else if (report.typecheck?.status === 'ok') verdictLines.push('typecheck 通过')
else if (report.typecheck?.status === 'skipped') verdictLines.push(`typecheck 跳过（${report.typecheck.reason}）`)

// 8. 日志（--no-log 跳过）
if (!flag('no-log')) {
  const logged = writeRunLog(report, { toolDir: TOOL_DIR })
  if (logged) verdictLines.push(`日志: ${logged.file}`)
}

printJson(report)
process.stderr.write(`\n${verdictLines.join('\n')}\n`)
process.exit(criticalOrHigh > 0 || report.typecheck?.status === 'fail' ? 2 : 0)
