#!/usr/bin/env node
// release-check.mjs —— 发布前预检：版本面、包内容、tag 与 npm 状态一次说清。
//
// 只读：不打 tag、不发布、不改版本号。把「本地看起来能发」与「外面确实是这一版」
// 之间的落差一次性列出来：package.json 与 plugin.json 版本是否一致、v<版本> tag
// 在不在、npm 上有没有这一版、npm pack 的内容是否含技能面必需文件且不夹带本地物。
//
// 用法: node scripts/release-check.mjs [--offline] [--skip-test]
// 退出码: 0 全部通过；1 有失败项；2 只有判定不了的项（网络/命令不可用）。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printJson } from './lib/scanner.mjs'
import {
  PKG_NAME,
  checkVersionSync,
  checkPackFiles,
  checkTag,
  checkNpm,
  checkWorktree,
  summarize,
  tail,
} from './lib/release-rules.mjs'

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPAWN_SHELL = process.platform === 'win32'

function run(cmd, args, { cwd = TOOL_DIR, timeout = 60_000 } = {}) {
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: SPAWN_SHELL, timeout, stdio: 'pipe' })
    return { ok: true, stdout, stderr: '', status: 0 }
  } catch (err) {
    return { ok: false, stdout: String(err.stdout || ''), stderr: String(err.stderr || err.message || ''), status: err.status ?? null }
  }
}

// ── 采集 ────────────────────────────────────────────────────────────────────

function readVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(TOOL_DIR, file), 'utf8')).version ?? null
  } catch {
    return null
  }
}

function packFiles() {
  const r = run('npm', ['pack', '--dry-run', '--json'], { timeout: 60_000 })
  if (!r.ok) return { error: r.stderr || r.stdout || 'npm pack 失败', files: [] }
  try {
    const parsed = JSON.parse(r.stdout)
    const entry = Array.isArray(parsed) ? parsed[0] : parsed
    return { files: (entry?.files ?? []).map((f) => f.path), count: entry?.entryCount ?? null, error: null }
  } catch (err) {
    return { error: `npm pack JSON 解析失败：${err.message}`, files: [] }
  }
}

function localTags() {
  const r = run('git', ['tag', '-l'], { timeout: 20_000 })
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
}

function remoteTags(timeout = 20_000) {
  const r = run('git', ['ls-remote', '--tags', 'origin'], { timeout })
  if (!r.ok) return { ok: false, tags: null }
  const tags = r.stdout
    .split('\n')
    .map((line) => line.split('\t')[1] ?? '')
    .map((ref) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''))
    .filter(Boolean)
  return { ok: true, tags }
}

function npmState(version) {
  const exact = run('npm', ['view', `${PKG_NAME}@${version}`, 'version'], { timeout: 30_000 })
  if (!exact.ok) {
    const err = exact.stderr || exact.stdout || ''
    // 版本不存在与网络失败要分开：前者是明确的「未发布」，后者是判定不了
    if (/E404|not found|No match found/i.test(err)) return { published: null, latest: null, error: null }
    return { published: null, latest: null, error: err }
  }
  const published = exact.stdout.trim() || null
  const latestRes = run('npm', ['view', PKG_NAME, 'dist-tags.latest'], { timeout: 30_000 })
  const latest = latestRes.ok ? latestRes.stdout.trim() || null : null
  return { published, latest, error: null }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write('用法: node scripts/release-check.mjs [--offline] [--skip-test]\n  --offline   跳过 npm 与远端 tag 查询\n  --skip-test 跳过自检\n')
  process.exit(0)
}
const unknown = argv.find((a) => a.startsWith('--') && !['--offline', '--skip-test'].includes(a))
if (unknown) {
  process.stderr.write(`未知参数「${unknown}」\n用法: node scripts/release-check.mjs [--offline] [--skip-test]\n`)
  process.exit(2)
}
const offline = argv.includes('--offline')
const skipTest = argv.includes('--skip-test')

const packageVersion = readVersion('package.json')
const manifestVersion = readVersion('.claude-plugin/plugin.json')
const checks = [checkVersionSync(packageVersion, manifestVersion)]

const pack = packFiles()
checks.push(
  pack.error
    ? { id: 'pack', status: 'fail', detail: `npm pack 失败：${tail(pack.error)}` }
    : checkPackFiles(pack.files),
)

const tagState = checkTag({
  version: packageVersion,
  localTags: localTags(),
  remoteTags: offline ? null : (() => {
    const r = remoteTags()
    return r.ok ? r.tags : null
  })(),
  offline,
})
checks.push(tagState)

if (offline) {
  checks.push(checkNpm({ version: packageVersion, offline: true }))
} else {
  const npm = npmState(packageVersion)
  checks.push(checkNpm({ version: packageVersion, ...npm }))
}

if (skipTest) {
  checks.push({ id: 'test', status: 'skip', detail: '--skip-test' })
} else {
  const t = run('npm', ['test'], { timeout: 180_000 })
  checks.push(
    t.ok
      ? { id: 'test', status: 'pass', detail: tail(t.stderr, 80).split('\n').pop() || '通过' }
      : { id: 'test', status: 'fail', detail: `自检失败：${tail(t.stderr || t.stdout, 240)}` },
  )
}

const clean = run('git', ['status', '--porcelain'], { timeout: 20_000 })
checks.push(checkWorktree(clean.ok ? clean.stdout : ''))

const summary = summarize(checks)
const report = { version: packageVersion, checks, summary, offline, skipTest }
printJson(report)

const icon = { pass: 'ok  ', fail: 'FAIL', skip: 'skip', unknown: '????', warn: 'warn' }
process.stderr.write(`\n发布预检 ${PKG_NAME}@${packageVersion}\n`)
for (const c of checks) process.stderr.write(`  ${icon[c.status] || c.status} ${c.id}: ${c.detail}\n`)
const advice =
  summary.verdict === 'ready'
    ? '可以发布（warn 项确认后处理）'
    : summary.verdict === 'not-ready'
      ? '未就绪——先修 FAIL 项；本工具只报告，不自动打 tag 或发布'
      : '判定不了——看 ???? 项，补网络或改用 --offline 只查本地'
process.stderr.write(`结论: ${advice}\n`)

process.exit(summary.fail > 0 ? 1 : summary.unknown > 0 ? 2 : 0)
