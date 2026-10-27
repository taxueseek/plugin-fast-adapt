// 方案 A 的回归用例：指南来源、覆盖度未知态、入口解析单一真源、诊断输出瘦身与 CLI 边界。
// 全部零网络、零外部依赖；指南快照直接构造目录与 meta，不跑 git。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import { guideVersionFor, runGuideSync, syncBranchSnapshot } from '../guide-sync.mjs'
import { runQuickSmoke } from '../quick-smoke.mjs'
import { summarizeEnvironment } from '../env-doctor.mjs'

const SCRIPTS = path.resolve(import.meta.dirname, '..')

function writeSnapshot(cacheRoot, { version = 'v0.2.1-rc.3', fetchedAt = Date.now(), commit = 'abc1234' } = {}) {
  const dir = path.join(cacheRoot, 'harness-guides-branch')
  fs.mkdirSync(path.join(dir, 'docs', 'upgrade-guide', version), { recursive: true })
  fs.writeFileSync(path.join(dir, '.pfa-snapshot.json'), JSON.stringify({ commit, fetchedAt, branch: 'master' }))
  return dir
}

test('guideVersionFor：显式窗口目标优先于官方最新版本', () => {
  assert.strictEqual(
    guideVersionFor({ target: '0.2.1-rc.4' }, '0.2.1-rc.3', { latest: '0.2.1-rc.2' }, '0.2.1-rc.3'),
    '0.2.1-rc.3',
    'run.mjs 传了窗口终点时不能再去取官方最新版指南',
  )
  assert.strictEqual(guideVersionFor({ target: '0.2.1-rc.4' }, '0.2.1-rc.3', null), '0.2.1-rc.4', '不传时仍跟官方目标')
})

test('分支快照：TTL 内直接复用，不跑 git', () => {
  const cacheRoot = tmpPluginDir('snap-fresh')
  writeSnapshot(cacheRoot)
  const snap = syncBranchSnapshot({ cacheRoot })
  assert.strictEqual(snap.source, 'branch-snapshot')
  assert.strictEqual(snap.commit, 'abc1234')
  assert.deepStrictEqual(snap.versions, ['v0.2.1-rc.3'])
  assert.strictEqual(snap.stale, false)
})

test('分支快照：过期且禁止刷新时标 stale，不假装新鲜', () => {
  const cacheRoot = tmpPluginDir('snap-stale')
  writeSnapshot(cacheRoot, { fetchedAt: Date.now() - 2 * 60 * 60 * 1000 })
  const snap = syncBranchSnapshot({ cacheRoot, allowRefresh: false })
  assert.strictEqual(snap.source, 'branch-snapshot-stale')
  assert.strictEqual(snap.stale, true)
  assert.match(snap.error, /不允许刷新/)
})

test('分支快照：没有快照且禁止联网时诚实返回 unavailable', () => {
  const snap = syncBranchSnapshot({ cacheRoot: tmpPluginDir('snap-none'), allowRefresh: false })
  assert.strictEqual(snap.source, 'unavailable')
  assert.match(snap.error, /不允许联网/)
})

test('runGuideSync：显式目标版本取本机 clone，不再请求官方最新 tag', async () => {
  const clone = tmpPluginDir('local-clone')
  fs.mkdirSync(path.join(clone, 'docs', 'upgrade-guide', 'v0.2.1-rc.3'), { recursive: true })
  const cacheRoot = tmpPluginDir('guide-cache')
  const fetcher = async () => ({ ok: true, json: async () => ({ latest: '0.2.1-rc.2', next: '0.2.1-rc.4' }) })
  const result = await runGuideSync('0.2.1-rc.3', { fetcher, localClone: clone, cacheRoot, targetVersion: '0.2.1-rc.3' })
  assert.strictEqual(result.guideVersion, '0.2.1-rc.3')
  assert.strictEqual(result.guides.source, 'local-clone')
  assert.deepStrictEqual(result.guides.versions, ['v0.2.1-rc.3'])
})

test('quick-smoke：exports-only 入口按 Node 语义解析', async () => {
  const dir = tmpPluginDir('exports-only')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 't-exports', version: '1.0.0', type: 'module', exports: { '.': './dist/main.js' },
  }))
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'dist', 'main.js'), 'export function apply() { return 1 }\n')
  const result = await runQuickSmoke(dir)
  assert.ok(result.success, `exports-only 插件应能冒烟: ${result.error || ''}`)
  assert.strictEqual(result.entry, 'dist/main.js', '入口应取 exports 而不是回退 lib/index.js')
})

test('env-doctor --brief：patch 原文换计数，进程命令截断', () => {
  const report = {
    globalDsh: { version: '0.2.1-rc.3' },
    installedPlugins: [{ profile: 'web', patchFile: 'a', globalPatchFile: 'b', patchEntries: ['x', 'y'], globalPatchEntries: ['z'] }],
    runningProcesses: [{ pid: '1', elapsed: '00:01', command: 'x'.repeat(200) }],
    target: { dir: '/tmp/p' },
  }
  const brief = summarizeEnvironment(report)
  assert.strictEqual(brief.installedPlugins[0].patchEntryCount, 2)
  assert.strictEqual(brief.installedPlugins[0].globalPatchEntryCount, 1)
  assert.strictEqual('patchEntries' in brief.installedPlugins[0], false, 'brief 不应带 patch 行原文')
  assert.strictEqual(brief.runningProcesses[0].command.length, 121, '超长命令截断到 120 字符加省略号')
  assert.strictEqual(brief.target.dir, '/tmp/p', '其余字段原样保留')
})

test('run --strict：扫描没跑时退出 2 并明说没扫', () => {
  const dir = tmpPluginDir('strict-offline')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-strict', version: '1.0.0' }))
  let stderr = ''
  try {
    execFileSync(process.execPath, [path.join(SCRIPTS, 'run.mjs'), dir, '--offline', '--no-log', '--strict'], { encoding: 'utf8' })
    assert.fail('--strict 下扫描没跑应退出 2')
  } catch (err) {
    assert.strictEqual(err.status, 2)
    stderr = String(err.stderr || '')
  }
  assert.match(stderr, /没有扫描代码/)
  assert.match(stderr, /退出码 0 不代表干净/)
})

test('run：未知开关直接报错，不再静默照跑', () => {
  const dir = tmpPluginDir('unknown-flag')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-flag', version: '1.0.0' }))
  let stderr = ''
  try {
    execFileSync(process.execPath, [path.join(SCRIPTS, 'run.mjs'), dir, '--no-smoek'], { encoding: 'utf8' })
    assert.fail('未知开关应报错')
  } catch (err) {
    assert.strictEqual(err.status, 1)
    stderr = String(err.stderr || '')
  }
  assert.match(stderr, /未知参数: --no-smoek/)
})

test('cli --help：打印用法，不跑流水线', () => {
  const out = execFileSync(process.execPath, [path.join(SCRIPTS, 'cli.mjs'), '--help'], { encoding: 'utf8' })
  assert.match(out, /用法/)
  assert.match(out, /plugin-fast-adapt v/)
  assert.ok(!out.includes('"plugin"'), '--help 不应输出运行报告 JSON')
})
