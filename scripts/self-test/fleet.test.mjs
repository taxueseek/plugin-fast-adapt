// 集群治理（fleet-sweep）与上游吸纳项（退出码 143、Bundle Resolution Shadow）自检用例。
// 全部零网络、零外部依赖。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import { auditPlugin } from '../plugin-audit.mjs'
import { discoverPlugins, inspectPlugin, checkBuild } from '../fleet-sweep.mjs'

const SCRIPTS = path.resolve(import.meta.dirname, '..')

test('上游吸纳：Bundle Resolution Shadow 遮蔽风险检测', () => {
  const dir = tmpPluginDir('shadow-plugin')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-headless', version: '1.0.0', main: 'index.js' }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default {}')

  // 构造模拟宿主环境：官方根目录中包含同名包 @deepseek-ai/dsh-headless
  const mockHostRoot = tmpPluginDir('mock-host-shadow')
  const hostLocation = path.join(mockHostRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const officialHeadless = path.join(mockHostRoot, 'node_modules', '@deepseek-ai', 'dsh-headless')
  fs.mkdirSync(officialHeadless, { recursive: true })
  fs.writeFileSync(path.join(officialHeadless, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-headless', version: '0.2.1' }))
  fs.mkdirSync(hostLocation, { recursive: true })
  fs.writeFileSync(path.join(hostLocation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1' }))

  const report = auditPlugin(dir, {
    hostInfo: { location: hostLocation, version: '0.2.1' },
  })

  const shadowFinding = report.findings.find((f) => f.title.includes('Bundle Resolution Shadow'))
  assert.ok(shadowFinding, '应命中宿主安装位同名 Bundle 遮蔽警告')
  assert.strictEqual(shadowFinding.severity, 'HIGH')
  assert.strictEqual(shadowFinding.dimension, 'resilience')
})

test('集群治理：discoverPlugins 正确发现多插件工作区与子目录', () => {
  const workspace = tmpPluginDir('fleet-workspace')
  const p1 = path.join(workspace, 'packages', 'plugin-a')
  const p2 = path.join(workspace, 'packages', 'plugin-b')
  fs.mkdirSync(p1, { recursive: true })
  fs.mkdirSync(p2, { recursive: true })
  fs.writeFileSync(path.join(p1, 'package.json'), JSON.stringify({ name: 'plugin-a', version: '1.0.0' }))
  fs.writeFileSync(path.join(p2, 'package.json'), JSON.stringify({ name: 'plugin-b', version: '2.0.0' }))

  const found = discoverPlugins([workspace])
  assert.strictEqual(found.length, 2)
  assert.ok(found.includes(p1))
  assert.ok(found.includes(p2))
})

test('集群治理：inspectPlugin 识别未构建与健康状态', () => {
  const dirHealthy = tmpPluginDir('fleet-healthy')
  fs.writeFileSync(path.join(dirHealthy, 'package.json'), JSON.stringify({ name: 'p-healthy', version: '1.0.0', main: 'index.js' }))
  fs.writeFileSync(path.join(dirHealthy, 'index.js'), 'export default {}')

  const resHealthy = inspectPlugin(dirHealthy, { targetVersion: '0.2.2-alpha.2' })
  assert.strictEqual(resHealthy.status, 'healthy')
  assert.strictEqual(resHealthy.buildStatus, 'OK')

  const dirUnbuilt = tmpPluginDir('fleet-unbuilt')
  fs.writeFileSync(
    path.join(dirUnbuilt, 'package.json'),
    JSON.stringify({ name: 'p-unbuilt', version: '1.0.0', main: 'lib/index.js' }),
  )
  fs.writeFileSync(path.join(dirUnbuilt, 'tsconfig.json'), '{}')
  fs.mkdirSync(path.join(dirUnbuilt, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dirUnbuilt, 'src', 'index.ts'), 'export default {}')

  const resUnbuilt = inspectPlugin(dirUnbuilt, { targetVersion: '0.2.2-alpha.2' })
  assert.strictEqual(resUnbuilt.status, 'broken')
  assert.strictEqual(resUnbuilt.buildStatus, 'UNBUILT')
  assert.ok(resUnbuilt.issues.some((i) => i.includes('产物缺失')))
})

test('集群治理：fleet-sweep CLI --json 结构化输出与退出码', () => {
  const workspace = tmpPluginDir('fleet-cli-test')
  const p1 = path.join(workspace, 'dsh-plugin-good')
  fs.mkdirSync(p1, { recursive: true })
  fs.writeFileSync(
    path.join(p1, 'package.json'),
    JSON.stringify({ name: 'dsh-plugin-good', version: '1.0.0', main: 'index.js', dsh: {} }),
  )
  fs.writeFileSync(path.join(p1, 'index.js'), 'export default {}')

  const out = execFileSync(process.execPath, [path.join(SCRIPTS, 'fleet-sweep.mjs'), workspace, '--json'], { encoding: 'utf8' })
  const report = JSON.parse(out)
  assert.strictEqual(report.total, 1)
  assert.strictEqual(report.healthy, 1)
  assert.strictEqual(report.broken, 0)
})

test('集群治理：discoverAllPlugins 多维梳理 Web、APP 与运行中/已禁用生命周期', async () => {
  const { discoverAllPlugins } = await import('../fleet-sweep.mjs')
  const mockEnv = {
    runningProcesses: [{ command: 'node /bin/dsh web' }],
    installedPlugins: [
      {
        profile: 'web',
        patchEntries: ['- plugin-web-live', '- plugin-web-off'],
        globalPatchEntries: ['- plugin-web-off disabled: true'],
      },
      {
        profile: 'desktop',
        patchEntries: ['- plugin-desktop-idle'],
        globalPatchEntries: [],
      },
    ],
  }

  const items = discoverAllPlugins([], { scanInstalled: true, scanWorkspace: false, envData: mockEnv })
  const runningItem = items.find((x) => x.name === 'plugin-web-live')
  const disabledItem = items.find((x) => x.name === 'plugin-web-off')
  const desktopItem = items.find((x) => x.name === 'plugin-desktop-idle')

  assert.ok(runningItem, '应发现运行中的 Web 插件')
  assert.strictEqual(runningItem.platform, 'web')
  assert.strictEqual(runningItem.state, 'RUNNING')

  assert.ok(disabledItem, '应发现禁用的 Web 插件')
  assert.strictEqual(disabledItem.state, 'DISABLED')

  assert.ok(desktopItem, '应发现桌面端 (APP) 插件')
  assert.strictEqual(desktopItem.platform, 'app')
  assert.strictEqual(desktopItem.state, 'ENABLED')
})

test('方案 3 集群自动化适配：resolveInstalledPluginDir 解析真实路径与 applyCompatAndPeerPatch 批量写入账本', async () => {
  const { resolveInstalledPluginDir, applyCompatAndPeerPatch, inspectPlugin } = await import('../fleet-sweep.mjs')
  const fakeDsh = tmpPluginDir('fleet-dsh-home')
  const realPluginDir = tmpPluginDir('fleet-real-plugin')
  fs.writeFileSync(
    path.join(realPluginDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-demo-adapt',
      version: '1.0.0',
      main: 'index.js',
      peerDependencies: { '@deepseek-ai/dsh': '^0.2.1-rc.1' },
      dsh: {
        compatibility: {
          dsh: '^0.2.1-rc.1',
          dshReleases: { '0.2.1-rc.4': 'compatible' },
        },
      },
    }),
  )
  fs.writeFileSync(path.join(realPluginDir, 'index.js'), 'export default {}\n')

  const profileNm = path.join(fakeDsh, 'profiles', 'web', 'node_modules')
  fs.mkdirSync(profileNm, { recursive: true })
  fs.symlinkSync(
    realPluginDir,
    path.join(profileNm, 'dsh-demo-adapt'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  const resolved = resolveInstalledPluginDir('dsh-demo-adapt', 'web', fakeDsh)
  assert.strictEqual(resolved, fs.realpathSync(realPluginDir), '应透过 profile 软链解析到插件真实源码目录')

  // 执行批量兼容账本与 Peer 自动修补
  const inspected = inspectPlugin(realPluginDir, { targetVersion: '0.2.2-alpha.2', applyCompat: true })
  assert.strictEqual(inspected.appliedPatches?.updated, true, '0 代码阻断的插件应自动完成账本与 Peer 修补')
  assert.strictEqual(inspected.status, 'healthy', '修补后复检应恢复为 healthy')

  const updatedPkg = JSON.parse(fs.readFileSync(path.join(realPluginDir, 'package.json'), 'utf8'))
  assert.strictEqual(updatedPkg.peerDependencies['@deepseek-ai/dsh'], '^0.2.2-alpha.2')
  assert.strictEqual(updatedPkg.dsh.compatibility.dshReleases['0.2.2-alpha.2'], 'compatible')
  assert.ok(updatedPkg.dsh.compatibility.dsh.includes('^0.2.2-alpha.2'))

  // 幂等验证：再次运行不应重复修改
  const second = applyCompatAndPeerPatch(realPluginDir, { targetVersion: '0.2.2-alpha.2' })
  assert.strictEqual(second.updated, false)
})
