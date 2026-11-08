// 方案 B 的回归用例：本地环境锚定、未构建低级错误硬守卫、本地宿主接缝契约核对与 Peer 自适应。
// 全部零网络、零外部依赖。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import { auditPlugin, peerPatchFor, compatPatchFor } from '../plugin-audit.mjs'
import { cleanGitEnv } from '../lib/proc-env.mjs'

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

test('上游 #12322：package.json 带 UTF-8 BOM 仍能定位宿主，不静默退化成「找不到」', async () => {
  const { findGlobalDsh } = await import('../env-doctor.mjs')
  const dir = tmpPluginDir('env-host-bom')
  fs.writeFileSync(path.join(dir, 'package.json'), '\uFEFF' + JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.9-bom' }))

  const orig = process.env.DSH_HOST_PATH
  try {
    process.env.DSH_HOST_PATH = dir
    const found = findGlobalDsh()
    assert.strictEqual(found?.version, '0.2.9-bom', 'BOM 不该让 JSON.parse 失败后被吞成 null')
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

test('方案 B 工具链缺失：runner 不在 PATH 判 skipped 而非 fail（2026-11-07 dsh-files 实录）', () => {
  // 实录：dsh-files 声明了 typecheck script，本机只有 npm 没有 pnpm，
  // 旧逻辑把它判成「插件连编译都过不了」，把人推去修一个不存在的构建问题；
  // 实际补上 PATH 后同一命令立刻通过。工具链缺失必须与编译失败分开。
  const dir = tmpPluginDir('plan-b-toolchain-missing')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 't-toolchain', version: '1.0.0', scripts: { typecheck: 'node --version' } }),
  )
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '')
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n')

  // 造一个不含 pnpm 的 PATH：只留 node 所在目录与系统基础目录
  const nodeBin = path.dirname(process.execPath)
  const env = cleanGitEnv({ ...process.env, PATH: `${nodeBin}:/usr/bin:/bin` })
  const out = execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'run.mjs'), dir, '--offline', '--no-smoke', '--no-log', '--target', '0.2.1-rc.3'],
    { encoding: 'utf8', env },
  )
  const report = JSON.parse(out.slice(0, out.lastIndexOf('}') + 1))
  assert.strictEqual(report.typecheck.status, 'skipped', 'runner 缺失应判 skipped，不是 fail')
  assert.match(report.typecheck.reason, /不在 PATH/)
  assert.match(report.typecheck.hint, /环境缺件/, '应点明这是环境问题而非构建失败')
  assert.ok(!report.typecheck.hint.includes('连编译都过不了'), '不得再输出「编译不过」的误导结论')
})

test('方案 B 真冷启动不定论：tail 里的 missing-tools:dsh 应给出 PATH 补法', () => {
  // 实录：--real-smoke 首轮报 inconclusive，hint 只说「换 profile 重探还是环境缺件」，
  // 而真实原因是 dsh 不在 PATH——两个选项都不指向它。
  if (process.platform === 'win32') {
    process.stderr.write('  （跳过：--real-smoke 在 win32 直接 skipped）\n')
    return
  }
  const dir = tmpPluginDir('plan-b-realsmoke-envgap')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-envgap', version: '1.0.0' }))
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function apply() {}\n')

  const fakeDir = tmpPluginDir('verify-envgap')
  // 复刻 verify-runtime 在找不到 dsh 时的输出形态
  const script = path.join(fakeDir, 'verify-envgap.mjs')
  fs.writeFileSync(script, "console.log('verdict: missing-tools:dsh  status: inconclusive'); process.exit(2)\n")

  const env = cleanGitEnv({
    ...process.env,
    DSH_PFA_RUNS_DIR: path.join(fakeDir, 'runs'),
    PFA_VERIFY_RUNTIME: script,
  })
  // inconclusive 不进 exitFail（既有语义：只有 fail 才退 2），所以这里应正常返回退出码 0，
  // 但结论必须带可执行的补法，否则「退出码 0」会被读成「查干净了」。
  const out = execFileSync(
    process.execPath,
    [path.join(SCRIPTS, 'run.mjs'), dir, '--offline', '--no-smoke', '--no-typecheck', '--no-log', '--real-smoke'],
    { encoding: 'utf8', env },
  )
  const report = JSON.parse(out.slice(0, out.lastIndexOf('}') + 1))
  assert.strictEqual(report.realSmoke.status, 'inconclusive')
  assert.ok(report.realSmoke.hint, 'inconclusive 档应带 hint')
  assert.match(report.realSmoke.hint, /PATH/, '应直接给出 PATH 补法，而不是二选一的反问')
  assert.ok(!report.realSmoke.hint.includes('换 profile 重探'), '认出环境缺件后不应再给无关选项')
})

test('方案 1 & 2 修复：verified=present 枚举对齐与浏览器端 PLATFORM_MODULES 免误报', () => {
  const dir = tmpPluginDir('plan-b-client-primitives')
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 't-client-ui',
      version: '1.0.0',
      dsh: { client: { platform: 'web', external: ['@deepseek-ai/dsh-client-ui-primitives'] } },
    }),
  )
  fs.mkdirSync(path.join(dir, 'src', 'client'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'src', 'client', 'panel.tsx'),
    `import { Button } from '@deepseek-ai/dsh-client-ui-primitives'\nexport const P = () => Button\n`,
  )

  const mockHostRoot = tmpPluginDir('mock-host-primitives')
  const hostLocation = path.join(mockHostRoot, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(hostLocation, { recursive: true })
  fs.writeFileSync(path.join(hostLocation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-alpha.2' }))

  const scanResult = {
    findingCount: 1,
    window: { localVersion: '0.2.1-rc.1', targetVersion: '0.2.2-alpha.2' },
    findings: [
      {
        file: 'src/index.ts',
        line: 1,
        symbol: '@deepseek-ai/dsh-tools',
        kind: 'package',
        verified: 'present',
        guide: 'v0.2.1-alpha.1/tool-presentation-mode',
        title: 't',
      },
    ],
  }

  const report = auditPlugin(dir, {
    scanResult,
    targetVersion: '0.2.2-alpha.2',
    hostInfo: { location: hostLocation, version: '0.2.2-alpha.2' },
  })
  assert.ok(
    !report.findings.some((f) => f.severity === 'HIGH'),
    `浏览器端 PLATFORM_MODULES 与 verified=present 不应产出 HIGH 误报: ${JSON.stringify(report.findings)}`,
  )
  assert.strictEqual(report.scores.resilience, 100)
})

test('方案 2 物理契约门：compatPatchFor 准入账本与已移除 {{cwd}} 提示词变量检测', () => {
  const pkg = {
    name: 't-compat',
    version: '1.0.0',
    dsh: {
      compatibility: {
        dsh: '>=0.2.1-rc.2 <0.3.0',
        dshReleases: { '0.2.1-rc.4': 'compatible' },
      },
    },
    engines: { dsh: '^0.2.1-rc.2' },
  }
  const compatPatches = compatPatchFor(pkg, '0.2.2-alpha.2')
  assert.strictEqual(compatPatches.length, 3, '应同时识别 dsh.compatibility.dsh、dshReleases 与 engines.dsh 缺口')

  const dir = tmpPluginDir('plan-2-cwd-compat')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'prompt.js'), `export const tpl = '当前目录: {{cwd}}'\n`)

  const report = auditPlugin(dir, { targetVersion: '0.2.2-alpha.2' })
  assert.ok(report.findings.some((f) => f.title.includes('{{cwd}}') && f.severity === 'HIGH'), '应检出 {{cwd}} 模板变量风险')
  assert.ok(report.findings.some((f) => f.title.includes('准入账本')), '应检出 dsh.compatibility 准入账本缺口')
  assert.strictEqual(report.compatPatch.length, 3)
})

test('方案 1 & 2 环境层：parsePatchEntries 剥离深层 config 列表与 checkPrefixSplit 前缀分裂检测', async () => {
  const { parsePatchEntries, checkPrefixSplit } = await import('../env-doctor.mjs')
  const { overlayMountedNames } = await import('../lib/client-graph.mjs')
  const patchYml = [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '  config:',
    '    providers:',
    '      - id: deepseek',
    '        name: DeepSeek',
    '        models:',
    '          - id: glm-5.3',
    '            name: GLM 5.3',
    '- id: files',
    "  name: 'dsh-files'",
    '',
  ].join('\n')

  const entries = parsePatchEntries(patchYml)
  assert.ok(entries.some((e) => e.includes('dsh-files')), '顶层插件条目应保留')
  assert.ok(!entries.some((e) => e.includes('glm-5.3') || e.includes('DeepSeek')), 'config 下的模型与 provider 列表不应混入插件清单')

  const mounted = overlayMountedNames(patchYml)
  assert.ok(mounted.has('dsh-files'))
  assert.ok(!mounted.has('glm-5.3') && !mounted.has('DeepSeek'))

  const split = checkPrefixSplit({ version: '0.2.2-alpha.2', location: '/a' }, '0.2.1-rc.4')
  assert.strictEqual(split?.mismatch, true)
  assert.strictEqual(checkPrefixSplit({ version: '0.2.2-alpha.2' }, '0.2.2-alpha.2'), null)
})
