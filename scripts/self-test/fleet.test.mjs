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

  // 写用户 package.json 前必须备份，且与 codemod / fix-peer-deps 用同一个
  // .pfa-backup/<时间戳>/ 约定——批量治理不能是唯一无法回档的自动修补入口。
  // 返回形状与 codemod / fix-peer-deps 统一为 { backupDir, backupFiles, backupRel }。
  const ap = inspected.appliedPatches
  assert.ok(ap?.backupDir, '--apply-compat 落盘应返回备份目录（绝对路径）')
  assert.ok(ap?.backupRel, '--apply-compat 落盘应返回备份目录（相对路径）')
  assert.deepStrictEqual(ap.backupFiles, ['package.json'], '备份文件列表应含 package.json')
  const backupPath = path.join(realPluginDir, ap.backupRel, 'package.json')
  assert.ok(fs.existsSync(backupPath), '备份文件应真实存在')
  const originalPkg = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
  assert.strictEqual(originalPkg.peerDependencies['@deepseek-ai/dsh'], '^0.2.1-rc.1', '备份应是落盘前的原文')

  // 幂等验证：再次运行不应重复修改，也不该再生成第二份备份
  const second = applyCompatAndPeerPatch(realPluginDir, { targetVersion: '0.2.2-alpha.2' })
  assert.strictEqual(second.updated, false)
  assert.strictEqual(second.backupDir, '', '没改动时 backupDir 应是空串而不是 undefined')
  assert.deepStrictEqual(second.backupFiles, [], '没改动时 backupFiles 应是空数组')
})

test('checkBuild 三态：缺 package.json 是 N/A，带 BOM 的坏文件报 CORRUPTED 且点明 BOM', () => {
  const missing = tmpPluginDir('build-missing')
  try {
    assert.strictEqual(checkBuild(missing).status, 'N/A', '没有 package.json 是正常形态')
  } finally {
    fs.rmSync(missing, { recursive: true, force: true })
  }

  const bom = tmpPluginDir('build-bom')
  try {
    // 带 BOM 且 JSON 本身也坏——这才是「解析失败」的形态；BOM + 合法 JSON 会被
    // package-json.mjs 剥掉 BOM 后正常读出，不该判 CORRUPTED。
    fs.writeFileSync(path.join(bom, 'package.json'), '\uFEFF{ not json')
    const r = checkBuild(bom)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.status, 'CORRUPTED')
    assert.ok(/BOM/.test(r.reason), `坏文件的原因要点明 BOM，实际：${r.reason}`)
  } finally {
    fs.rmSync(bom, { recursive: true, force: true })
  }
})

test('集群治理：auditCache 复用同目录同版本结果，且识别 DeepSeek Harness.app 运行态', async () => {
  const { discoverAllPlugins } = await import('../fleet-sweep.mjs')
  const dir = tmpPluginDir('fleet-cache')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p-cache', version: '1.0.0', main: 'index.js' }))
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default {}')

  const cache = new Map()
  const first = inspectPlugin({ name: 'p-cache', dir, platform: 'web', state: 'ENABLED' }, { targetVersion: '0.2.2-rc.5', auditCache: cache })
  assert.strictEqual(cache.size, 1, '首次巡检应写入 auditCache')
  const second = inspectPlugin({ name: 'p-cache', dir, platform: 'desktop', state: 'DISABLED' }, { targetVersion: '0.2.2-rc.5', auditCache: cache })
  assert.strictEqual(second.score, first.score)
  assert.strictEqual(second.state, 'DISABLED', '复用审计结果时应保留各自条目元信息')

  const found = discoverAllPlugins([], {
    scanInstalled: true,
    scanWorkspace: false,
    envData: {
      dshDir: tmpPluginDir('mock-dsh-home'),
      runningProcesses: [{ command: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' }],
      installedPlugins: [{ profile: 'desktop', patchEntries: ['- my-desktop-plugin'] }],
    },
  })
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0].state, 'RUNNING', 'DeepSeek Harness.app 运行中应把 desktop profile 标为 RUNNING')
})

test('集群治理：工作区容器子目录（如 Deepseek/）下探发现、宿主日志异常关联与 asar 包集判定', async () => {
  const ws = tmpPluginDir('fleet-nested')
  const group = path.join(ws, 'Deepseek')
  const nestedPlugin = path.join(group, 'dsh-nested-demo')
  fs.mkdirSync(nestedPlugin, { recursive: true })
  fs.writeFileSync(
    path.join(nestedPlugin, 'package.json'),
    JSON.stringify({ name: 'dsh-nested-demo', version: '1.0.0', main: 'index.js', dsh: {} }),
  )
  fs.writeFileSync(
    path.join(nestedPlugin, 'index.js'),
    "import { foo } from '@deepseek-ai/dsh-asar-only'\nexport function apply() { return foo }\n",
  )

  const discovered = discoverPlugins([ws])
  assert.ok(discovered.includes(nestedPlugin), '应发现工作区分组子目录下的 DSH 插件')

  // 若走 npm 树会报不存在；走 asarPackages 时若包含该包则不误报，同时 logFailures 会标为 warning
  const inspected = inspectPlugin(
    { name: 'dsh-nested-demo', dir: nestedPlugin, platform: 'app', state: 'RUNNING', installed: true },
    {
      hostInfo: { location: tmpPluginDir('empty-npm-host'), version: '0.2.2-rc.5' },
      asarPackages: new Set(['@deepseek-ai/dsh-asar-only']),
      logFailures: new Map([['dsh-nested-demo', 'ERR_MODULE_NOT_FOUND']]),
    },
  )
  assert.strictEqual(inspected.healthStatus, 'warning')
  assert.ok(inspected.issues.some((i) => i.includes('宿主日志异常')), '应关联宿主日志异常')
})

test('seams：resolveGuideRoot 优先使用 harness-guides-branch 分支快照', async () => {
  const { resolveGuideRoot } = await import('../seams.mjs')
  const fakeCache = tmpPluginDir('seams-branch-cache')
  const oldTagGuide = path.join(fakeCache, 'harness-dsh-v0.2.1-rc.3', 'docs', 'upgrade-guide')
  const branchGuide = path.join(fakeCache, 'harness-guides-branch', 'docs', 'upgrade-guide')
  fs.mkdirSync(oldTagGuide, { recursive: true })
  fs.mkdirSync(branchGuide, { recursive: true })

  const prev = process.env.DSH_PFA_CACHE_DIR
  process.env.DSH_PFA_CACHE_DIR = fakeCache
  try {
    const res = resolveGuideRoot({ hostVersion: '0.2.2-rc.5' })
    assert.strictEqual(res.source, 'branch-snapshot')
    assert.strictEqual(res.root, branchGuide)
  } finally {
    if (prev === undefined) delete process.env.DSH_PFA_CACHE_DIR
    else process.env.DSH_PFA_CACHE_DIR = prev
  }
})

test('PR 基线守卫：识别 no-remote / ready / dirty / behind-upstream / npm-ahead 五态（零网络 bare 仓）', async () => {
  const { checkPrBaseline, PR_BASELINE_STATES } = await import('../lib/pr-gate.mjs')
  const { gitChildEnv } = await import('../lib/proc-env.mjs')
  const env = gitChildEnv().env
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  // 1. 非 git 目录 → no-remote
  const nonGit = tmpPluginDir('pr-nongit')
  assert.strictEqual(checkPrBaseline(nonGit).status, PR_BASELINE_STATES.NO_REMOTE)

  // 2. 本地 bare remote + clone（零网络）
  const bare = tmpPluginDir('pr-bare')
  fs.rmSync(bare, { recursive: true, force: true })
  fs.mkdirSync(bare, { recursive: true })
  execFileSync('git', ['init', '--bare', bare], { env, stdio: 'ignore' })

  const cloneA = tmpPluginDir('pr-clone-a')
  fs.rmSync(cloneA, { recursive: true, force: true })
  execFileSync('git', ['clone', bare, cloneA], { env, stdio: 'ignore' })
  git(cloneA, ['config', 'user.email', 'test@example.com'])
  git(cloneA, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(cloneA, 'package.json'), JSON.stringify({ name: 'pr-demo', version: '0.1.0', main: 'index.js' }))
  fs.writeFileSync(path.join(cloneA, 'index.js'), 'export default {}')
  git(cloneA, ['add', '.'])
  git(cloneA, ['commit', '-m', 'init'])
  git(cloneA, ['push', '-u', 'origin', 'HEAD'])

  // 2a. ready（npm 同版）
  const rReady = checkPrBaseline(cloneA, { npmVersionFetcher: () => '0.1.0' })
  assert.strictEqual(rReady.status, PR_BASELINE_STATES.READY)
  assert.strictEqual(rReady.ready, true)

  // 2b. npm-ahead（npm 有新版）
  const rNpmAhead = checkPrBaseline(cloneA, { npmVersionFetcher: () => '0.2.0' })
  assert.strictEqual(rNpmAhead.status, PR_BASELINE_STATES.NPM_AHEAD)
  assert.strictEqual(rNpmAhead.ready, false)

  // 2c. dirty（未提交改动）
  fs.writeFileSync(path.join(cloneA, 'index.js'), 'export default { dirty: true }')
  const rDirty = checkPrBaseline(cloneA, { npmVersionFetcher: () => '0.1.0' })
  assert.strictEqual(rDirty.status, PR_BASELINE_STATES.DIRTY)
  git(cloneA, ['checkout', '--', 'index.js'])

  // 2d. behind-upstream（另一份 clone 推了新提交）
  const cloneB = tmpPluginDir('pr-clone-b')
  fs.rmSync(cloneB, { recursive: true, force: true })
  execFileSync('git', ['clone', bare, cloneB], { env, stdio: 'ignore' })
  git(cloneB, ['config', 'user.email', 'test@example.com'])
  git(cloneB, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(cloneB, 'index.js'), 'export default { v: 2 }')
  git(cloneB, ['add', '.'])
  git(cloneB, ['commit', '-m', 'upstream update'])
  git(cloneB, ['push'])

  const rBehind = checkPrBaseline(cloneA, { npmVersionFetcher: () => '0.1.0' })
  assert.strictEqual(rBehind.status, PR_BASELINE_STATES.BEHIND_UPSTREAM)
  assert.strictEqual(rBehind.ready, false)
  assert.strictEqual(rBehind.action, 'git pull --ff-only')
})

test('fleet-sweep --pr-ready --offline --json：输出 prReadyPlugins 与 prBlockedPlugins', () => {
  const ws = tmpPluginDir('fleet-pr-ready')
  const p = path.join(ws, 'dsh-pr-dirty')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: 'dsh-pr-dirty', version: '1.0.0', main: 'index.js', dsh: {} }))
  fs.writeFileSync(path.join(p, 'index.js'), 'import x from "@deepseek-ai/dsh-nonexistent-pkg"; export default x')

  let stdout = ''
  try {
    stdout = execFileSync(process.execPath, [path.join(SCRIPTS, 'fleet-sweep.mjs'), ws, '--pr-ready', '--offline', '--json'], { encoding: 'utf8' })
  } catch (err) {
    stdout = err.stdout || ''
  }
  const report = JSON.parse(stdout)
  assert.strictEqual(report.prReadyCount, 0)
  assert.ok(Array.isArray(report.prReadyPlugins))
  assert.ok(Array.isArray(report.prBlockedPlugins))
  assert.ok(Array.isArray(report.upstreamUpdatablePlugins))
})

test('回归：APP asarPackages 缺失包必须真报 broken（消灭 exists/status 字段失配死代码）', () => {
  const dir = tmpPluginDir('asar-missing-pkg')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'asar-missing-demo', version: '1.0.0', main: 'index.js', dsh: {} }))
  fs.writeFileSync(path.join(dir, 'index.js'), "import { x } from '@deepseek-ai/dsh-removed-in-asar'\nexport function apply() { return x }\n")

  const inspected = inspectPlugin(
    { name: 'asar-missing-demo', dir, platform: 'app', state: 'ENABLED', installed: true },
    {
      hostInfo: { location: tmpPluginDir('empty-host-asar'), version: '0.2.2-rc.5' },
      asarPackages: new Set(['@deepseek-ai/dsh-base']),
    },
  )
  assert.strictEqual(inspected.healthStatus, 'broken', 'asar 中不存在的套件包必须判 broken')
  assert.ok(inspected.highCount >= 1, '缺失套件包应产生 HIGH 阻断')
})

test('回归：guide-sync fetchNpmMetadata 默认路径不抛 ReferenceError；seams 同版 tag 与分支并存时分支优先', async () => {
  const { fetchNpmMetadata } = await import('../guide-sync.mjs')
  const { resolveGuideRoot } = await import('../seams.mjs')
  const fakeCache = tmpPluginDir('guide-seams-reg')
  const sameTag = path.join(fakeCache, 'harness-dsh-v0.2.2-rc.5', 'docs', 'upgrade-guide')
  const branch = path.join(fakeCache, 'harness-guides-branch', 'docs', 'upgrade-guide')
  fs.mkdirSync(sameTag, { recursive: true })
  fs.mkdirSync(branch, { recursive: true })

  const prev = process.env.DSH_PFA_CACHE_DIR
  process.env.DSH_PFA_CACHE_DIR = fakeCache
  try {
    const meta = await fetchNpmMetadata({
      fetcher: async () => ({ ok: true, json: async () => ({ latest: '0.2.2-rc.5' }) }),
    })
    assert.strictEqual(meta['dist-tags'].latest, '0.2.2-rc.5')
    const rootRes = resolveGuideRoot({ hostVersion: '0.2.2-rc.5' })
    assert.strictEqual(rootRes.source, 'branch-snapshot', '同版本冻结 tag 与受管分支并存时必须优先分支快照')
    assert.strictEqual(rootRes.root, branch)
  } finally {
    if (prev === undefined) delete process.env.DSH_PFA_CACHE_DIR
    else process.env.DSH_PFA_CACHE_DIR = prev
  }
})

test('回归：pr-gate 支持 offline-clean、allowDirtyOnHead（本地适配后导出 PR）与 monorepo 子目录', async () => {
  const { checkPrBaseline, PR_BASELINE_STATES } = await import('../lib/pr-gate.mjs')
  const { gitChildEnv } = await import('../lib/proc-env.mjs')
  const env = gitChildEnv().env
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const bare = tmpPluginDir('pr-mono-bare')
  fs.rmSync(bare, { recursive: true, force: true })
  fs.mkdirSync(bare, { recursive: true })
  execFileSync('git', ['init', '--bare', bare], { env, stdio: 'ignore' })

  const mono = tmpPluginDir('pr-mono-ws')
  fs.rmSync(mono, { recursive: true, force: true })
  execFileSync('git', ['clone', bare, mono], { env, stdio: 'ignore' })
  git(mono, ['config', 'user.email', 'test@example.com'])
  git(mono, ['config', 'user.name', 'Test'])
  const sub = path.join(mono, 'packages', 'sub-plugin')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, 'package.json'), JSON.stringify({ name: 'sub-plugin', version: '0.1.0', main: 'index.js' }))
  fs.writeFileSync(path.join(sub, 'index.js'), 'export default {}')
  git(mono, ['add', '.'])
  git(mono, ['commit', '-m', 'init'])
  git(mono, ['push', '-u', 'origin', 'HEAD'])

  const rOffline = checkPrBaseline(sub, { offline: true })
  assert.strictEqual(rOffline.status, PR_BASELINE_STATES.OFFLINE_CLEAN)
  assert.strictEqual(rOffline.ready, true)
  assert.strictEqual(rOffline.verifiedRemote, false)

  fs.writeFileSync(path.join(sub, 'index.js'), 'export default { adapted: true }')
  const rLocalAdapted = checkPrBaseline(sub, { allowDirtyOnHead: true, npmVersionFetcher: () => '0.1.0' })
  assert.strictEqual(rLocalAdapted.status, PR_BASELINE_STATES.READY_WITH_LOCAL_CHANGES)
  assert.strictEqual(rLocalAdapted.ready, true)
  assert.ok(rLocalAdapted.diffStat && rLocalAdapted.diffStat.includes('index.js'), '应附带 git diff --stat 摘要')
})

test('回归：log-doctor 识别 ERR_PACKAGE_PATH_NOT_EXPORTED 并对重复未激活条目去重计数；run-log doctor 识别历史日志', async () => {
  const { diagnoseLogs } = await import('../log-doctor.mjs')
  const { correlateRuns } = await import('../run-log.mjs')
  const { writeRunLog } = await import('../lib/runlog.mjs')
  const logsDir = tmpPluginDir('log-dedup-test')
  const runsDir = tmpPluginDir('runs-stale-test')
  const repeatedBlock = [
    'dsh: warning: 1 entry did not activate',
    'web-ui-agents (@demo/dsh-agents): failed to import: Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath \'./internal\' is not defined',
    '    at importModule (file:///x.js:1:1)',
  ].join('\n')
  const logFile = path.join(logsDir, 'dsh-web.log')
  fs.writeFileSync(logFile, `${repeatedBlock}\n${repeatedBlock}\n${repeatedBlock}\n`)
  // 设日志 mtime 为 1 小时前，模拟历史旧日志
  const past = new Date(Date.now() - 3600_000)
  fs.utimesSync(logFile, past, past)

  const diag = diagnoseLogs({ logsDir, limit: 5, crashDir: tmpPluginDir('empty-crash') })
  assert.ok(diag.signalSummary.some((s) => s.id === 'package-subpath-not-exported'), '应检出 ERR_PACKAGE_PATH_NOT_EXPORTED 信号')
  assert.strictEqual(diag.runs[0].inactiveEntries.length, 1, '相同未激活条目应去重为 1 条')
  assert.strictEqual(diag.runs[0].inactiveEntries[0].count, 3, '去重条目应保留重复次数 3')

  const startupFile = path.join(logsDir, 'startup-old.log')
  fs.writeFileSync(
    startupFile,
    "  dshVersion: '0.2.2',\n  error: StartupError\n  Failed plugins (1):\n    stale-demo (required)\n      Package: stale-demo\n      Error: boom\n",
  )
  fs.utimesSync(startupFile, past, past)

  const prevRuns = process.env.DSH_PFA_RUNS_DIR
  process.env.DSH_PFA_RUNS_DIR = runsDir
  try {
    writeRunLog({
      time: new Date().toISOString(),
      plugin: { name: 'stale-demo', version: '1.0.0', dir: runsDir },
      scan: { findingCount: 0, criticalOrHigh: 0 },
      audit: { overallScore: 100 },
    })
    const corr = correlateRuns({ logsDir, limit: 5 })
    const item = corr.plugins.find((p) => p.plugin === 'stale-demo')
    assert.strictEqual(item?.verdict, 'host-log-stale', '早于最近干净扫描的宿主失败日志应判 host-log-stale')
  } finally {
    if (prevRuns === undefined) delete process.env.DSH_PFA_RUNS_DIR
    else process.env.DSH_PFA_RUNS_DIR = prevRuns
  }
})

test('回归：plugin-audit 静态拦截 exports 未公开子路径（P0），formatPrDraft 输出 Minimal 验证证据与分支指引', async () => {
  const { matchExportsSubpath } = await import('../lib/host-scope.mjs')
  const { formatPrDraft } = await import('../run-log.mjs')
  const { PR_BASELINE_STATES } = await import('../lib/pr-gate.mjs')

  assert.strictEqual(matchExportsSubpath({ '.': './index.js', './utils/*': './lib/utils/*.js', './internal': null }, './utils/a').exported, true)
  assert.strictEqual(matchExportsSubpath({ '.': './index.js', './internal': null }, './internal').exported, false)

  const hostRoot = tmpPluginDir('host-exports-test')
  const dshDir = path.join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const subPkgDir = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-subagent')
  fs.mkdirSync(subPkgDir, { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }))
  fs.writeFileSync(
    path.join(subPkgDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-subagent', version: '0.2.2-rc.5', exports: { '.': './lib/index.js', './types': './lib/types.js' } }),
  )

  const pluginDir = tmpPluginDir('plugin-bad-subpath')
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'bad-subpath-plugin', version: '1.0.0', main: 'index.js', dsh: {} }))
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    "import { x } from '@deepseek-ai/dsh-subagent/internal'\nimport { y } from '@deepseek-ai/dsh-subagent/types'\nexport function apply() { return [x, y] }\n",
  )

  const report = auditPlugin(pluginDir, { hostInfo: { location: dshDir, version: '0.2.2-rc.5' } })
  const bad = report.findings.find((f) => f.title.includes('@deepseek-ai/dsh-subagent/internal'))
  const ok = report.findings.find((f) => f.title.includes('@deepseek-ai/dsh-subagent/types'))
  assert.ok(bad && bad.priority === 'P0', '未公开子路径 ./internal 必须报 P0')
  assert.ok(!ok, '已公开子路径 ./types 不应误报')

  const draft = formatPrDraft(
    {
      plugin: { name: 'bad-subpath-plugin', version: '1.0.0' },
      host: { version: '0.2.2-rc.5' },
      window: { local: '0.2.1', target: '0.2.2-rc.5' },
      tool: { version: '0.4.4' },
      scan: { findingCount: 0, findings: [] },
      smoke: { success: true },
      typecheck: { status: 'ok' },
      audit: { overallScore: 100 },
    },
    { baseline: { status: PR_BASELINE_STATES.READY_WITH_LOCAL_CHANGES, ready: true, localHead: 'abcdef1234567', diffStat: ' index.js | 2 +-\n' } },
  )
  assert.ok(draft.includes('验证证据（Minimal 兼容闭环）'), 'PR 草稿应包含 Minimal 验证证据表')
  assert.ok(draft.includes('git checkout -b fix/dsh-0.2.2-rc.5-compat'), 'PR 草稿应包含 Minimal 分支创建指引')
})

test('回归：types-diff 零依赖 npm tarball 签名提取（extractSignatureFromTarballBuffer）', async () => {
  const zlib = await import('node:zlib')
  const { extractSignatureFromTarballBuffer } = await import('../lib/types-diff.mjs')

  // 构造标准 512 字节 POSIX ustar 头 + 内容块
  const makeTarEntry = (name, text) => {
    const body = Buffer.from(text, 'utf8')
    const header = Buffer.alloc(512, 0)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'utf8')
    header.write('0000000\0', 108, 8, 'utf8')
    header.write('0000000\0', 116, 8, 'utf8')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write('0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('00', 263, 2, 'utf8')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
    const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0)
    return Buffer.concat([header, body, pad])
  }

  const tar = Buffer.concat([
    makeTarEntry('package/package.json', JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '0.2.2-rc.3',
      types: './lib/index.d.ts',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
    })),
    makeTarEntry('package/lib/index.d.ts', 'export declare function createHost(): void;\nexport interface HostConfig {}\n'),
    Buffer.alloc(1024, 0),
  ])
  const sig = extractSignatureFromTarballBuffer(zlib.gzipSync(tar))
  assert.strictEqual(sig.version, '0.2.2-rc.3')
  const pkgSig = sig.packages['@deepseek-ai/dsh']
  assert.deepStrictEqual(pkgSig.subpaths, ['.', './client'])
  assert.ok(pkgSig.symbols.some((s) => s.name === 'createHost'))
  assert.ok(pkgSig.symbols.some((s) => s.name === 'HostConfig'))
})
