#!/usr/bin/env node
// run-log.mjs —— 运行日志的查看、交叉核对与脱敏导出。
//
//   node scripts/run-log.mjs list [--limit 20]      最近运行一览（读 index.jsonl）
//   node scripts/run-log.mjs show <id|路径>          单次运行全文
//   node scripts/run-log.mjs sanitize <id|路径|--latest> [--out 文件]
//                                                   脱敏后输出（对外反馈前必跑）
//   node scripts/run-log.mjs doctor [--logs <目录>] [--limit 20]
//                                                   运行日志 × 宿主启动日志交叉核对
//
// 脱敏规则（lib/runlog.mjs sanitizeText）：home 前缀 → ~，用户名 → <user>，
// 机器名 → <host>，邮箱形态 → <email>。目录结构与文件名保留，方便对照排查。
//
// doctor 回答的问题是「插件装了没生效/宿主报错，到底哪边的事」：
// 运行日志（run.mjs 的 phases/命中/体检）说代码侧状态，宿主 startup 日志的
// failedPlugins/waitingForServices 说装载侧状态，两边以前要各跑一个命令再人肉对。

import fs from 'node:fs'
import { STAGE_STATUS, CORRELATE_VERDICT } from './lib/run-states.mjs'
import path from 'node:path'
import { listRuns, resolveRunFile, sanitizeRun, sanitizeText, getLogRoot } from './lib/runlog.mjs'
import { checkPrBaseline } from './lib/pr-gate.mjs'
import { diagnoseLogs, DEFAULT_LOGS_DIR } from './log-doctor.mjs'
import { printJson } from './lib/scanner.mjs'
import { isMainEntry } from './lib/main-entry.mjs'

const args = process.argv.slice(2)
const command = args[0]

function findId(argList) {
  const latest = argList.includes('--latest')
  if (latest) {
    const runs = listRuns(1)
    return runs[0]?.file ?? null
  }
  const at = argList.findIndex((a) => !a.startsWith('--') && a !== command)
  return at !== -1 ? argList[at] : null
}

// ── doctor：运行日志 × 宿主启动日志交叉核对 ────────────────────────────────
// runsDir 可注入（自检走 DSH_PFA_RUNS_DIR，listRuns 已读同一环境变量），
// logsDir 可注入（自检传临时目录，线上默认 ~/.dsh/logs）。
export function correlateRuns({ limit = 20, logsDir = DEFAULT_LOGS_DIR } = {}) {
  const runs = listRuns(limit)
  // runs 新的在前；每个插件取最近一次运行
  const latestByPlugin = new Map()
  for (const run of runs) {
    if (!run.plugin || latestByPlugin.has(run.plugin)) continue
    latestByPlugin.set(run.plugin, run)
  }

  const diag = diagnoseLogs({ logsDir, limit: 20, pattern: null })
  const plugins = [...latestByPlugin.entries()].map(([name, run]) => {
    const runTimeMs = run.time ? Date.parse(run.time) : NaN
    const hits = []
    for (const logRun of diag.runs) {
      for (const fp of logRun.failedPlugins || []) {
        if (fp.plugin === name || fp.package === name) {
          hits.push({ log: logRun.file, mtimeMs: logRun.mtimeMs ?? 0, what: 'failed-plugin', detail: fp.error || fp.plugin })
        }
      }
      for (const w of logRun.waitingForServices || []) {
        if (w.plugin === name) hits.push({ log: logRun.file, mtimeMs: logRun.mtimeMs ?? 0, what: 'waiting-services', detail: w.missing })
      }
      for (const em of logRun.errorMessages || []) {
        const text = em.args.join(' ')
        if (text.includes(name)) hits.push({ log: logRun.file, mtimeMs: logRun.mtimeMs ?? 0, what: 'error-message', detail: text.slice(0, 200) })
      }
    }
    const codeSideClean = run.phases?.scan === STAGE_STATUS.OK && !(run.criticalOrHigh > 0)
    // 扫描没跑（skipped/error/旧条目无 phases）时代码侧是未知，不能与宿主日志干净合成「一致」
    const codeSideUnknown = run.phases?.scan !== STAGE_STATUS.OK
    // 宿主日志早于最近一次干净扫描时，属历史遗留日志，不应误判当前代码或当前装载异常
    const allHitsOlderThanRun = hits.length > 0 && Number.isFinite(runTimeMs) && hits.every((h) => h.mtimeMs > 0 && h.mtimeMs < runTimeMs)
    const verdict = hits.length === 0
      ? codeSideUnknown ? CORRELATE_VERDICT.HOST_LOG_CLEAN_SCAN_UNKNOWN : CORRELATE_VERDICT.HOST_LOG_CLEAN
      : codeSideClean
        ? allHitsOlderThanRun ? CORRELATE_VERDICT.HOST_LOG_STALE : CORRELATE_VERDICT.LOG_HIT_SCAN_CLEAN
        : CORRELATE_VERDICT.LOG_HIT_SCAN_HIT
    return {
      plugin: name,
      latestRun: {
        time: run.time ?? null,
        toolVersion: run.toolVersion ?? null,
        phases: run.phases ?? null,
        findings: run.findings ?? null,
        criticalOrHigh: run.criticalOrHigh ?? null,
        auditScore: run.auditScore ?? null,
      },
      hostLogHits: hits,
      verdict,
      advice:
        verdict === CORRELATE_VERDICT.HOST_LOG_CLEAN
          ? '宿主日志无该插件的失败记录——状态一致，无事可做'
          : verdict === CORRELATE_VERDICT.HOST_LOG_CLEAN_SCAN_UNKNOWN
            ? '宿主日志无该插件的失败记录，但最近一次 run 没跑扫描（看 scan.reason）——代码侧未核查，不算一致'
            : verdict === CORRELATE_VERDICT.HOST_LOG_STALE
              ? '宿主日志的失败记录早于最近一次干净扫描——属历史遗留日志，重启宿主后如无新错即可忽略'
              : verdict === CORRELATE_VERDICT.LOG_HIT_SCAN_CLEAN
                ? '宿主日志报了它、但最近一次 run 的扫描干净——嫌疑在装载/挂载/环境侧（env-doctor 看 activation 双半），不在代码踩雷'
                : '宿主日志与最近一次 run 都有问题——先按 run 的命中清代码，再回来看宿主日志是否消停',
    }
  })

  return {
    logsDir,
    runsConsidered: runs.length,
    plugins,
    host: { verdict: diag.verdict, signalSummary: diag.signalSummary },
  }
}

function printDoctorText(report) {
  process.stderr.write(`\n交叉核对: ${report.runsConsidered} 次运行 × ${report.logsDir}\n`)
  process.stderr.write(`宿主日志总判: ${report.host.verdict}\n`)
  for (const p of report.plugins) {
    process.stderr.write(`\n${p.plugin}（最近运行 ${p.latestRun.time ?? '?'}）\n`)
    const ph = p.latestRun.phases
    process.stderr.write(
      `  代码侧: ${ph ? `scan=${ph.scan ?? '?'} smoke=${ph.smoke ?? '?'} typecheck=${ph.typecheck ?? '?'}` : '?'}，命中 ${p.latestRun.findings ?? '?'}，体检 ${p.latestRun.auditScore ?? '?'}\n`
    )
    process.stderr.write(`  宿主侧: ${p.hostLogHits.length === 0 ? '无失败记录' : p.hostLogHits.map((h) => `${h.log} ${h.what}`).join('；')}\n`)
    process.stderr.write(`  判定: ${p.verdict}——${p.advice}\n`)
    for (const h of p.hostLogHits.slice(0, 3)) {
      process.stderr.write(`    ${h.log} [${h.what}] ${h.detail}\n`)
    }
  }
  process.stderr.write('\n边界: 交叉核对只对齐两边的文本记录，不替人拍板；宿主日志无记录不等于装载正常（可能没轮到它启动）。\n')
}

export function formatPrDraft(runData, { baseline = null } = {}) {
  const plugin = `${runData?.plugin?.name || 'unknown'} v${runData?.plugin?.version || '?'}`
  const host = runData?.host?.version || 'unknown'
  const win = runData?.window ? `${runData.window.local || '?'} → ${runData.window.target || '?'}` : '?'
  const docGaps = runData?.scan?.docGapSymbols || []
  const blockers = (runData?.scan?.findings || []).filter((f) => {
    const s = String(f.severity || '').toLowerCase()
    return s === 'critical' || s === 'high'
  })
  const peers = runData?.audit?.peerPatch || []
  const compats = runData?.audit?.compatPatch || []

  const lines = []
  if (baseline && !baseline.ready) {
    lines.push(
      `> [!CAUTION]`,
      `> **PR 基线未就绪（${baseline.status}）**：${baseline.reason}${baseline.action ? `（建议先执行 \`${baseline.action}\`）` : ''}`,
      '',
    )
  }
  const phases = runData?.phases || {
    scan: runData?.scan?.skipped ? 'skipped' : runData?.scan ? 'ok' : null,
    smoke: runData?.smoke?.skipped ? 'skipped' : runData?.smoke?.success === true ? 'ok' : runData?.smoke?.success === false ? 'fail' : null,
    typecheck: runData?.typecheck?.status ?? (runData?.typecheck?.skipped ? 'skipped' : null),
  }
  lines.push(
    `## DSH 适配反馈：${plugin} × ${host}`,
    '',
    `- **适配窗口**：\`${win}\``,
    `- **工具版本**：\`plugin-fast-adapt v${runData?.tool?.version || '?'}\``,
    `- **体检得分**：\`${runData?.audit?.overallScore ?? '?'}/100\``,
    ...(baseline?.ready ? [`- **PR 基线**：\`${baseline.status}\`（\`${baseline.localHead?.slice(0, 7) || '?'}\`）`] : []),
    '',
    '### 验证证据（Minimal 兼容闭环）',
    '',
    '| 核验项 | 结果 |',
    '| --- | --- |',
    `| 代码扫描 (\`code-scan\`) | \`${phases.scan ?? '?'}\`（Critical/High 命中: \`${blockers.length}\`） |`,
    `| 内存冒烟 (\`quick-smoke\`) | \`${phases.smoke ?? '?'}\` |`,
    `| 类型检查 (\`typecheck\`) | \`${phases.typecheck ?? '?'}\` |`,
    `| 架构体检 (\`plugin-audit\`) | \`${runData?.audit?.overallScore ?? '?'}/100\` |`,
    '',
  )
  if (docGaps.length > 0) {
    lines.push('### 上游文档缺口（doc-gap，包面差分补报）')
    for (const sym of docGaps) lines.push(`- \`${sym}\``)
    lines.push('')
  }
  if (blockers.length > 0) {
    lines.push('### 代码破坏性命中（Critical / High）')
    for (const b of blockers.slice(0, 10)) {
      lines.push(`- [${b.severity}] \`${b.symbol || b.file || '?'}\`: ${b.message || b.detail || ''}`)
    }
    lines.push('')
  }
  if (peers.length > 0 || compats.length > 0) {
    lines.push('### 建议修补（package.json）')
    for (const p of peers) lines.push(`- \`peerDependencies.${p.package}\`: \`${p.from}\` → \`${p.to}\``)
    for (const c of compats) lines.push(`- \`${c.field}\`: \`${c.from ?? 'null'}\` → \`${c.to}\``)
    lines.push('')
  }
  if (baseline?.diffStat) {
    const safeHost = String(host).replace(/[^a-zA-Z0-9._-]/g, '-')
    lines.push(
      '### 本地适配改动摘要（git diff --stat）',
      '```',
      baseline.diffStat,
      '```',
      '',
      '### Minimal PR 提交指引（请保持仅含兼容修复，不夹带无关重构）',
      '```sh',
      `git checkout -b fix/dsh-${safeHost}-compat`,
      'git status -s',
      `git commit -am "fix: adapt to @deepseek-ai/dsh ${host}"`,
      '```',
      '',
    )
  }
  if (docGaps.length === 0 && blockers.length === 0 && peers.length === 0 && compats.length === 0 && !baseline?.diffStat) {
    lines.push('本轮运行未发现 doc-gap、阻断命中或待修补声明。', '')
  }
  return sanitizeText(lines.join('\n'))
}

// CLI（带主模块守卫：被 self-test import 时不执行。isMainEntry 两侧过 realpath，
// 软链技能根直跑不会静默 no-op——2026-11-21 实测，见 lib/main-entry.mjs 头注）
if (isMainEntry(import.meta.url)) {
if (command === 'list') {
  const limitAt = args.indexOf('--limit')
  const limit = limitAt !== -1 ? Number(args[limitAt + 1]) || 20 : 20
  const runs = listRuns(limit)
  if (runs.length === 0) {
    process.stdout.write(`暂无运行日志（${getLogRoot()}）\n`)
    process.exit(0)
  }
  for (const run of runs) {
    // tool 版本后的 * = 工具仓当时有未提交改动（版本号与 commit 可能拆对）
    // phases 三态：scan/smoke/typecheck/realSmoke 各 ok|skipped|fail|error，? = 旧条目无此字段
    const phases = run.phases
      ? `scan=${run.phases.scan ?? '?'} smoke=${run.phases.smoke ?? '?'} typecheck=${run.phases.typecheck ?? '?'}${
          run.phases.realSmoke ? ` real=${run.phases.realSmoke}` : ''
        }`
      : ''
    const line = [
      run.time,
      `tool=${run.toolVersion ?? '?'}${run.toolDirty ? '*' : ''}${run.toolCommit ? `@${run.toolCommit}` : ''}`,
      `${run.plugin ?? '?'}@${run.pluginVersion ?? '?'}`,
      `host=${run.hostVersion ?? '?'}`,
      `命中=${run.findings ?? '?'}${run.criticalOrHigh ? `(c/h ${run.criticalOrHigh})` : ''}`,
      `体检=${run.auditScore ?? '?'}`,
      phases,
      `${run.durationMs ?? '?'}ms`,
    ].filter(Boolean)
    process.stdout.write(`${line.join('  ')}\n    ${run.file}\n`)
  }
  process.exit(0)
}

if (command === 'show') {
  const id = findId(args)
  const file = id && resolveRunFile(id)
  if (!file) {
    process.stderr.write('用法: node scripts/run-log.mjs show <id|路径|--latest>\n')
    process.exit(1)
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'))
  process.exit(0)
}

if (command === 'sanitize') {
  const id = findId(args)
  const file = id && resolveRunFile(id)
  if (!file) {
    process.stderr.write('用法: node scripts/run-log.mjs sanitize <id|路径|--latest> [--pr-draft] [--offline] [--force] [--out 文件]\n')
    process.exit(1)
  }
  const prDraft = args.includes('--pr-draft')
  let baseline = null
  let sanitized = ''
  if (prDraft) {
    const runData = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (runData?.plugin?.dir) {
      baseline = checkPrBaseline(runData.plugin.dir, { offline: args.includes('--offline'), allowDirtyOnHead: true })
    }
    sanitized = formatPrDraft(runData, { baseline })
  } else {
    sanitized = sanitizeRun(file)
  }
  const outAt = args.indexOf('--out')
  if (outAt !== -1 && args[outAt + 1]) {
    fs.writeFileSync(args[outAt + 1], sanitized)
    process.stderr.write(`脱敏完成 → ${args[outAt + 1]}\n`)
  } else {
    process.stdout.write(sanitized)
  }
  if (prDraft && baseline && !baseline.ready && !args.includes('--force')) {
    process.stderr.write(`\n[PR 守卫拦截] ${baseline.status}: ${baseline.reason}${baseline.action ? `（先执行: ${baseline.action}；强行生成加 --force）` : ''}\n`)
    process.exit(2)
  }
  process.exit(0)
}

if (command === 'doctor') {
  const logsAt = args.indexOf('--logs')
  const limitAt = args.indexOf('--limit')
  const report = correlateRuns({
    logsDir: logsAt !== -1 && args[logsAt + 1] ? args[logsAt + 1] : DEFAULT_LOGS_DIR,
    limit: limitAt !== -1 ? Number(args[limitAt + 1]) || 20 : 20,
  })
  if (report.plugins.length === 0) {
    process.stderr.write(`暂无运行日志可核对（${getLogRoot()}）\n`)
    process.exit(0)
  }
  printJson(report)
  printDoctorText(report)
  process.exit(0)
}

process.stderr.write('用法: run-log.mjs list | show <id> | sanitize <id|--latest> [--out 文件] | doctor [--logs <目录>]\n')
process.exit(1)
}
