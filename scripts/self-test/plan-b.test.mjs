// 方案 B 的回归用例：本地环境锚定、未构建低级错误硬守卫、本地宿主接缝契约核对与 Peer 自适应。
// 全部零网络、零外部依赖。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import { auditPlugin, peerPatchFor } from '../plugin-audit.mjs'

const SCRIPTS = path.resolve(import.meta.dirname, '..')

test('方案 B 定版：默认以本地宿主为真源，0 外部网络请求', () => {
  const dir = tmpPluginDir('plan-b-local-target')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 't-local-target', version: '1.0.0', main: 'index.js' }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default {}')

  const out = execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'run.mjs'), dir, '--offline', '--no-smoke', '--no-typecheck', '--no-log'],
    { encoding: 'utf8' },
  )
  const report = JSON.parse(out)
  assert.strictEqual(report.version?.source, 'local-host')
  assert.match(report.version?.reason, /以本机已安装宿主为准/)
})

test('方案 B 低级错误硬拦截：未构建 TS 插件冒烟前精准拦截并提示构建', () => {
  const dir = tmpPluginDir('plan-b-unbuilt')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 't-unbuilt',
      version: '1.0.0',
      main: 'lib/index.js',
      scripts: { build: 'tsc' },
    }),
  )
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export default {}')

  const out = execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'run.mjs'), dir, '--offline', '--no-typecheck', '--no-log'],
    { encoding: 'utf8' },
  )
  const report = JSON.parse(out)
  assert.strictEqual(report.smoke?.status, 'error')
  assert.strictEqual(report.smoke?.stage, 'entry_resolution')
  assert.match(report.smoke?.error, /未找到构建入口产物: lib\/index\.js/)
  assert.match(report.smoke?.error, /请先执行构建/)
})

test('方案 B 本地套件接缝：引用物理缺失的宿主包产出 HIGH 警告与扣分', () => {
  const dir = tmpPluginDir('plan-b-seam-absent')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 't-seam', version: '1.0.0', main: 'index.js' }),
  )
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    "import { something } from '@deepseek-ai/dsh-ghost-package'\nexport default something",
  )

  // 构造模拟宿主环境：只有主包，无 dsh-ghost-package
  const mockHostRoot = tmpPluginDir('mock-host')
  const hostLocation = path.join(mockHostRoot, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(hostLocation, { recursive: true })
  fs.writeFileSync(path.join(hostLocation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-alpha.2' }))

  const report = auditPlugin(dir, {
    hostInfo: { location: hostLocation, version: '0.2.2-alpha.2' },
  })

  const absent = report.findings.find((f) => f.title.includes('@deepseek-ai/dsh-ghost-package'))
  assert.ok(absent, '应检测到不存在的套件包引用')
  assert.strictEqual(absent.severity, 'HIGH')
  assert.strictEqual(absent.dimension, 'resilience')
  assert.ok(report.scores.resilience < 100, '弹性维度应扣分')
})

test('方案 B Peer 依赖自适应：生成精确覆盖本地宿主版本的 caret 建议', () => {
  const pkg = {
    peerDependencies: {
      '@deepseek-ai/dsh': '^0.2.1-rc.1',
    },
  }
  const patches = peerPatchFor(pkg, '0.2.2-alpha.2')
  assert.strictEqual(patches.length, 1)
  assert.strictEqual(patches[0].package, '@deepseek-ai/dsh')
  assert.strictEqual(patches[0].to, '^0.2.2-alpha.2')
  assert.strictEqual(patches[0].verified, true)
})

test('方案 B 环境自适应：candidateGlobalRoots 包含移动端 Termux PREFIX 与自定义 npm 前缀', async () => {
  const { candidateGlobalRoots } = await import('../env-doctor.mjs')
  const roots = candidateGlobalRoots({
    platform: 'linux',
    env: { PREFIX: '/data/data/com.termux/files/usr', npm_config_prefix: '/opt/custom-npm' },
  })
  assert.ok(roots.includes('/data/data/com.termux/files/usr/lib/node_modules'), '应包含 Termux 模块路径')
  assert.ok(roots.includes('/opt/custom-npm/lib/node_modules'), '应包含自定义 npm 前缀路径')
  assert.ok(roots.includes('/usr/lib/node_modules'), '应包含标准 Linux 发行版路径')
})

test('方案 B 环境自适应：DSH_HOST_PATH 环境变量直接覆盖宿主定位', async () => {
  const { findGlobalDsh } = await import('../env-doctor.mjs')
  const dir = tmpPluginDir('env-host-override')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.9-ci' }))
  
  const orig = process.env.DSH_HOST_PATH
  try {
    process.env.DSH_HOST_PATH = dir
    const found = findGlobalDsh()
    assert.strictEqual(found?.version, '0.2.9-ci')
    assert.strictEqual(found?.source, 'env-override')
  } finally {
    if (orig !== undefined) process.env.DSH_HOST_PATH = orig
    else delete process.env.DSH_HOST_PATH
  }
})

test('方案 B 环境自适应：支持从工作区目录向上回溯探测本地依赖宿主', async () => {
  const { findGlobalDsh } = await import('../env-doctor.mjs')
  const workspaceRoot = tmpPluginDir('workspace-monorepo')
  const subPlugin = path.join(workspaceRoot, 'packages', 'my-plugin')
  fs.mkdirSync(subPlugin, { recursive: true })
  
  const localDsh = path.join(workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(localDsh, { recursive: true })
  fs.writeFileSync(path.join(localDsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-local' }))

  const found = findGlobalDsh(subPlugin)
  assert.strictEqual(found?.version, '0.2.2-local')
  assert.strictEqual(found?.source, 'local-ancestor-node_modules')
})
