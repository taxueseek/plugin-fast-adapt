// review.test.mjs —— 方案二（Cordis 防御性门禁与 P0/P1 分级）与方案三（紧凑报告与原生插件）自检用例。
// 零外部依赖、零网络。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import { auditPlugin } from '../plugin-audit.mjs'
import * as nativePlugin from '../../lib/index.js'

const SCRIPTS = path.resolve(import.meta.dirname, '..')

test('audit：核心 peer 依赖写在 dependencies 报 P0 阻断', () => {
  const dir = tmpPluginDir('peer-pollute')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'polluted-plugin',
      version: '1.0.0',
      main: 'index.js',
      dependencies: {
        cordis: '^4.0.0',
        '@deepseek-ai/dsh': '^0.2.1',
      },
    }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}')

  const report = auditPlugin(dir)
  const finding = report.findings.find((f) => f.title.includes('核心 Peer 依赖被错误声明'))
  assert.ok(finding, '应命中 peer 依赖错误声明警告')
  assert.strictEqual(finding.priority, 'P0')
  assert.strictEqual(finding.severity, 'HIGH')
  assert.ok(report.priorityCounts.P0 >= 1, 'P0 计数应至少为 1')
  assert.ok(report.scores.resilience <= 80, '扣减 resilience 分数')
})

test('audit：顶层单例可变状态识别报 P2', () => {
  const dir = tmpPluginDir('top-state')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'dsh-plugin-state',
      version: '1.0.0',
      main: 'index.js',
      dsh: {},
      peerDependencies: { '@deepseek-ai/dsh': '^0.2.1' },
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `let sessionStore = new Map()
export function apply(ctx) {
  ctx.on('ready', () => {})
}
`,
  )

  const report = auditPlugin(dir)
  const finding = report.findings.find((f) => f.title.includes('模块顶层单例状态'))
  assert.ok(finding, '应命中顶层单例状态检查')
  assert.strictEqual(finding.priority, 'P2')
  assert.ok(report.priorityCounts.P2 >= 1, 'P2 计数应至少为 1')
})

test('audit --compact：支持轻量紧凑 JSON 输出', () => {
  const dir = tmpPluginDir('compact-audit')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'compact-plugin', version: '1.0.0', main: 'index.js' }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}')

  const stdout = execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'plugin-audit.mjs'), dir, '--compact'],
    { encoding: 'utf8' },
  )
  const parsed = JSON.parse(stdout)
  assert.strictEqual(parsed.plugin, 'compact-plugin@1.0.0')
  assert.ok(parsed.priorityCounts, '输出应包含 priorityCounts')
  assert.ok(Array.isArray(parsed.blockers), '输出应包含 blockers 数组')
})

test('run --compact：支持子 Agent 紧凑摘要输出', () => {
  const dir = tmpPluginDir('compact-run')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'compact-run-plugin', version: '1.0.0', main: 'index.js' }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}')

  const stdout = execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'run.mjs'), dir, '--offline', '--no-clone', '--compact'],
    { encoding: 'utf8' },
  )
  const parsed = JSON.parse(stdout)
  assert.strictEqual(parsed.plugin, 'compact-run-plugin@1.0.0')
  assert.ok(parsed.priorityCounts, '应包含 priorityCounts')
  assert.ok(Array.isArray(parsed.blockers), '应包含 blockers 数组')
  assert.ok(parsed.smoke, '应包含冒烟结论')
})

// --compact 的 stdout 必须是纯 JSON：账本直通/版本跃迁/帮助文本一旦走 stdout，
// 子 Agent 的 JSON.parse 直接崩，紧凑模式等于废掉。
test('run --compact：账本直通提示不污染 stdout', () => {
  const dir = tmpPluginDir('compact-ledger')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'compact-ledger-plugin', version: '1.0.0', main: 'index.js' }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}')

  // 先跑一次正常模式，写入成功运行日志
  execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'run.mjs'), dir, '--offline', '--no-clone', '--no-log'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  // 再跑一次带 --compact，命中账本直通
  const stdout = execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'run.mjs'), dir, '--offline', '--no-clone', '--compact'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const parsed = JSON.parse(stdout)
  assert.strictEqual(parsed.plugin, 'compact-ledger-plugin@1.0.0')
  assert.ok(parsed.verdict === 'PASS' || parsed.verdict === 'FAIL', '应有 verdict 字段')
})

test('原生 DSH 插件入口：lib/index.js 服务契约成立', () => {
  assert.strictEqual(nativePlugin.name, 'plugin-fast-adapt')
  assert.ok(nativePlugin.Config, '声明 Config Schema')

  let providedService = null
  const mockCtx = {
    provide: (name, s) => {
      if (name === 'fastAdapt') providedService = s
    },
    tools: { register: () => {} },
    command: () => ({ action: () => {} }),
  }
  nativePlugin.apply(mockCtx)
  assert.ok(providedService, '应提供 fastAdapt 服务')
  assert.strictEqual(typeof providedService.audit, 'function')
  assert.strictEqual(typeof providedService.doctor, 'function')
  assert.strictEqual(typeof providedService.smoke, 'function')
  assert.strictEqual(typeof providedService.fleet, 'function')
})

test('audit：postinstall 钩子报 P1 供应链风险', () => {
  const dir = tmpPluginDir('hook-plugin')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'dsh-plugin-hook',
      version: '1.0.0',
      main: 'index.js',
      dsh: {},
      scripts: { postinstall: 'node setup.js' },
    }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}')

  const report = auditPlugin(dir)
  const finding = report.findings.find((f) => f.title.includes('安装脚本钩子'))
  assert.ok(finding, '应命中 postinstall 供应链风险')
  assert.strictEqual(finding.priority, 'P1')
  assert.ok(report.scores.resilience <= 90)
})

test('audit：cordis.patch.yml 含 !!js 报 P0 阻断', () => {
  const dir = tmpPluginDir('js-patch-plugin')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'dsh-plugin-patch', version: '1.0.0', main: 'index.js' }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: test\n      disabled: !!js true\n')

  const report = auditPlugin(dir)
  const finding = report.findings.find((f) => f.title.includes('!!js 动态配置表达式'))
  assert.ok(finding, '应命中 !!js 静态阻断')
  assert.strictEqual(finding.priority, 'P0')
  assert.ok(report.scores.resilience <= 80)
})
