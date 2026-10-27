// 方案 C 的回归用例：发布预检的纯规则与 CLI 边界。
// 不跑 npm/git 网络命令；采集逻辑由 release-check 自己负责。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { test } from './harness.mjs'
import {
  REQUIRED_PACK,
  checkVersionSync,
  checkPackFiles,
  checkTag,
  checkNpm,
  checkWorktree,
  summarize,
} from '../lib/release-rules.mjs'

const SCRIPTS = path.resolve(import.meta.dirname, '..')

test('release-check：package.json 与 plugin.json 版本必须一致', () => {
  assert.strictEqual(checkVersionSync('0.2.1', '0.2.1').status, 'pass')
  assert.strictEqual(checkVersionSync('0.2.1', '0.2.0').status, 'fail')
  assert.strictEqual(checkVersionSync('0.2.1', null).status, 'fail')
})

test('release-check：包内容必需项全在且不夹带本机物', () => {
  const full = [...REQUIRED_PACK, 'scripts/lib/release-rules.mjs']
  assert.strictEqual(checkPackFiles(full).status, 'pass')
  const missing = checkPackFiles(full.filter((f) => f !== 'SKILL.md'))
  assert.strictEqual(missing.status, 'fail')
  assert.deepStrictEqual(missing.missing, ['SKILL.md'])
  const leaked = checkPackFiles([...full, 'node_modules/foo/index.js', 'tmp/x.json'])
  assert.strictEqual(leaked.status, 'fail')
  assert.deepStrictEqual(leaked.forbidden, ['node_modules/foo/index.js', 'tmp/x.json'])
})

test('release-check：tag 本地优先，远端只补位，都没有才是失败', () => {
  assert.strictEqual(checkTag({ version: '0.2.1', localTags: ['v0.2.1'] }).status, 'pass')
  assert.strictEqual(checkTag({ version: '0.2.1', localTags: [], remoteTags: ['v0.2.1'] }).status, 'pass')
  assert.strictEqual(checkTag({ version: '0.2.1', localTags: [], remoteTags: [] }).status, 'fail')
  assert.strictEqual(checkTag({ version: '0.2.1', localTags: [], offline: true }).status, 'unknown')
  assert.strictEqual(checkTag({ version: '0.2.1', localTags: [], remoteTags: null }).status, 'unknown')
})

test('release-check：npm 未发布是失败，查询失败只是判定不了', () => {
  assert.strictEqual(checkNpm({ version: '0.2.1', offline: true }).status, 'skip')
  assert.strictEqual(checkNpm({ version: '0.2.1', error: 'ECONNRESET' }).status, 'unknown')
  const unpublished = checkNpm({ version: '0.2.1', published: null, latest: '0.2.0' })
  assert.strictEqual(unpublished.status, 'fail')
  assert.match(unpublished.detail, /未发布.*0\.2\.0/)
  assert.strictEqual(checkNpm({ version: '0.2.1', published: '0.2.1', latest: '0.2.0' }).status, 'pass')
})

test('release-check：工作区脏只告警，汇总把失败与未知分开', () => {
  assert.strictEqual(checkWorktree('').status, 'pass')
  assert.strictEqual(checkWorktree(' M a.js\n?? b.js\n').status, 'warn')
  assert.strictEqual(summarize([{ status: 'pass' }, { status: 'fail' }]).verdict, 'not-ready')
  assert.strictEqual(summarize([{ status: 'pass' }, { status: 'unknown' }]).verdict, 'undetermined')
  assert.strictEqual(summarize([{ status: 'pass' }, { status: 'warn' }]).verdict, 'ready')
})

test('release-check：CLI 帮助与未知参数', () => {
  const help = spawnSync(process.execPath, [path.join(SCRIPTS, 'release-check.mjs'), '--help'], { encoding: 'utf8' })
  assert.strictEqual(help.status, 0)
  assert.match(help.stderr, /发布前预检|用法/)
  const bad = spawnSync(process.execPath, [path.join(SCRIPTS, 'release-check.mjs'), '--nope'], { encoding: 'utf8' })
  assert.strictEqual(bad.status, 2)
  assert.match(bad.stderr, /未知参数/)
})
