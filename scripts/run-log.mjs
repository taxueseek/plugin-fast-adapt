#!/usr/bin/env node
// run-log.mjs —— 运行日志的查看与脱敏导出。
//
//   node scripts/run-log.mjs list [--limit 20]      最近运行一览（读 index.jsonl）
//   node scripts/run-log.mjs show <id|路径>          单次运行全文
//   node scripts/run-log.mjs sanitize <id|路径|--latest> [--out 文件]
//                                                   脱敏后输出（对外反馈前必跑）
//
// 脱敏规则（lib/runlog.mjs sanitizeText）：home 前缀 → ~，用户名 → <user>，
// 机器名 → <host>，邮箱形态 → <email>。目录结构与文件名保留，方便对照排查。

import fs from 'node:fs'
import { listRuns, resolveRunFile, sanitizeRun, getLogRoot } from './lib/runlog.mjs'

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
    // phases 三态：scan/smoke/typecheck 各 ok|skipped|fail|error，? = 旧条目无此字段
    const phases = run.phases
      ? `scan=${run.phases.scan ?? '?'} smoke=${run.phases.smoke ?? '?'} typecheck=${run.phases.typecheck ?? '?'}`
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
    process.stderr.write('用法: node scripts/run-log.mjs sanitize <id|路径|--latest> [--out 文件]\n')
    process.exit(1)
  }
  const sanitized = sanitizeRun(file)
  const outAt = args.indexOf('--out')
  if (outAt !== -1 && args[outAt + 1]) {
    fs.writeFileSync(args[outAt + 1], sanitized)
    process.stderr.write(`脱敏完成 → ${args[outAt + 1]}\n`)
  } else {
    process.stdout.write(sanitized)
  }
  process.exit(0)
}

process.stderr.write('用法: run-log.mjs list | show <id> | sanitize <id|--latest> [--out 文件]\n')
process.exit(1)
