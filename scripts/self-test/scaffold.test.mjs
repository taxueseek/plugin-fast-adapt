// 创作脚手架与体检门（第 0 步）——从 self-test.mjs 拆出的一节。
//
// 生成物三重验证：结构断言（文件与 package.json 不变量）、冒烟闭环（零依赖
// 形态真跑 quick-smoke）、真基类装载（五形态用真实 @deepseek-ai/* 基类验契约）、
// 挂载层可被 env-doctor 的 parsePatchEntries 识别（「装了不生效」是 env-doctor
// 查的头号事故，生成的插件必须天然可挂载）。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir, trackTmpDir } from './harness.mjs'
import { parsePatchEntries, probeEnvironment } from '../env-doctor.mjs'
import { runQuickSmoke } from '../quick-smoke.mjs'
import { scaffoldPlugin, projectNames, detectHarnessVersion, UsageError } from '../scaffold.mjs'
import { runWriteGate } from '../write-gate.mjs'
import { resolveHostModules, verifyWithHostModules } from '../lib/host-modules.mjs'

// ── 创作脚手架（第 0 步）─────────────────────────────────────────────────────
// 生成物三重验证：结构断言（文件与 package.json 不变量）、冒烟闭环（零依赖
// 形态真跑 quick-smoke）、挂载层可被 env-doctor 的 parsePatchEntries 识别
// （「装了不生效」是 env-doctor 查的头号事故，生成的骨架必须天然可挂载）。

const SCAFFOLD_FORMS = ['tool', 'hook', 'service', 'config', 'llm-adapter']
async function scaffoldTo(name, options) {
  const dir = tmpPluginDir(`scaffold-${name}`)
  trackTmpDir(dir)
  return scaffoldPlugin({ outDir: dir, harnessVersion: '0.2.1-rc.3', ...options })
}

test('scaffold：tool 形态端到端——五件套生成＋冒烟注册工具＋挂载层可识别', async () => {
  const result = await scaffoldTo('tool', { coordinate: 'taxueseek/demo-tool', form: 'tool' })
  for (const f of ['package.json', 'lib/index.js', 'cordis.patch.yml', 'dsh-plugin.naming.json', 'README.md', '.gitignore']) {
    assert.ok(fs.existsSync(path.join(result.outDir, f)), `应生成 ${f}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(result.outDir, 'package.json'), 'utf8'))
  assert.strictEqual(pkg.type, 'module')
  assert.strictEqual(pkg.main, './lib/index.js')
  assert.strictEqual(pkg.exports['.'], './lib/index.js')
  assert.deepStrictEqual(pkg.files, ['lib', 'cordis.patch.yml'])
  assert.strictEqual(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.strictEqual(pkg.name, '@taxueseek/dsh-demo-tool')
  const manifest = JSON.parse(fs.readFileSync(path.join(result.outDir, 'dsh-plugin.naming.json'), 'utf8'))
  assert.deepStrictEqual(manifest.names.loaderIds, ['taxueseek-demo-tool'])
  assert.deepStrictEqual(manifest.names.tools, ['taxueseek_demo_tool_query'])
  const patch = fs.readFileSync(path.join(result.outDir, 'cordis.patch.yml'), 'utf8')
  const entries = parsePatchEntries(patch)
  assert.strictEqual(entries.length, 1, '挂载层应恰好一条活跃条目')
  assert.ok(entries[0].includes('@taxueseek/dsh-demo-tool') && entries[0].includes('taxueseek-demo-tool'), '条目应含包名与 loader id')
  assert.strictEqual(result.smoke.run, true)
  assert.strictEqual(result.smoke.success, true)
  assert.deepStrictEqual(result.smoke.registeredTools, ['taxueseek_demo_tool_query'])
  assert.strictEqual(result.smoke.mockFallbacks.length, 0, 'tool 骨架应零 Mock 兜底（register 与 inject 都被 Mock 覆盖）')
})

test('scaffold：hook 形态冒烟通过且不误注册工具', async () => {
  const result = await scaffoldTo('hook', { coordinate: 'taxueseek/demo-hook', form: 'hook' })
  assert.strictEqual(result.smoke.success, true)
  assert.deepStrictEqual(result.smoke.registeredTools, [])
})

test('scaffold：依赖宿主基类的三形态不跑零依赖冒烟，但入口结构完整', async () => {
  const expectations = {
    service: (src) => src.includes('extends Service'),
    config: (src) => src.includes('Schema.object'),
    'llm-adapter': (src) => src.includes('extends LlmAdapter') && src.includes('attributionHeaders'),
  }
  for (const form of ['service', 'config', 'llm-adapter']) {
    const result = await scaffoldTo(form, { coordinate: `taxueseek/demo-${form}`, form })
    assert.strictEqual(result.smoke, null, `${form} 不该跑零依赖冒烟（Mock 覆盖不了宿主基类）`)
    const src = fs.readFileSync(path.join(result.outDir, 'lib', 'index.js'), 'utf8')
    assert.ok(expectations[form](src), `${form} 入口缺关键结构`)
  }
})

test('scaffold：五形态真基类装载验证全绿（装了宿主时）', async () => {
  const host = resolveHostModules()
  if (!host) return process.stderr.write('  （跳过：本机未装 DSH 宿主）\n')
  for (const form of ['tool', 'hook', 'service', 'config', 'llm-adapter']) {
    const result = await scaffoldTo(form, { coordinate: `taxueseek/hv-${form}`, form })
    assert.strictEqual(result.hostVerify.available, true, `${form} 应做真基类装载验证`)
    assert.strictEqual(result.hostVerify.success, true, `${form} 真基类装载应全绿：${JSON.stringify(result.hostVerify.checks)}`)
  }
})

test('真基类装载验证抓得出坏插件（不继承基类 / 导出普通对象）', async () => {
  const host = resolveHostModules()
  if (!host) return process.stderr.write('  （跳过：本机未装 DSH 宿主）\n')

  const svcDir = tmpPluginDir('hv-bad-service')
  fs.mkdirSync(path.join(svcDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(svcDir, 'lib', 'index.js'), 'export default class Plain { constructor(ctx) { this.ctx = ctx } }\n')
  const svc = await verifyWithHostModules({ pluginDir: svcDir, entryFile: 'lib/index.js', form: 'service' })
  assert.strictEqual(svc.success, false, '不继承 Service 应被抓出')
  assert.ok(svc.checks.some((c) => !c.ok && c.name.includes('Service')), '失败项应点名 Service 继承')

  const cfgDir = tmpPluginDir('hv-bad-config')
  fs.mkdirSync(path.join(cfgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(cfgDir, 'lib', 'index.js'), "export const Config = { greeting: 'x' }\nexport function apply() {}\n")
  const cfg = await verifyWithHostModules({ pluginDir: cfgDir, entryFile: 'lib/index.js', form: 'config' })
  assert.strictEqual(cfg.success, false, 'Config 导出普通对象应被抓出')
  assert.ok(cfg.checks.some((c) => !c.ok && c.name.includes('Config')), '失败项应点명 Config')
})

test('真基类装载：入口缺失时不伪造通过', async () => {
  const host = resolveHostModules()
  if (!host) return process.stderr.write('  （跳过：本机未装 DSH 宿主）\n')
  const dir = tmpPluginDir('hv-no-entry')
  fs.mkdirSync(dir, { recursive: true })
  const result = await verifyWithHostModules({ pluginDir: dir, entryFile: 'lib/index.js', form: 'service' })
  assert.strictEqual(result.available, true, '装了宿主就该是 available')
  assert.strictEqual(result.success, false, '入口缺失必须判失败，不许伪造通过')
  assert.ok(result.error, '入口缺失必须报错')
})

test('scaffold：命名投影符合官方语法与 collision-resistant 规则', () => {
  const n = projectNames('alice', 'web-search')
  assert.strictEqual(n.coordinate, 'alice/web-search')
  assert.strictEqual(n.packageName, '@alice/dsh-web-search')
  assert.deepStrictEqual(n.loaderIds, ['alice-web-search'])
  assert.deepStrictEqual(n.services, ['aliceWebSearchIndex'])
  assert.deepStrictEqual(n.tools, ['alice_web_search_query'])
  assert.deepStrictEqual(n.events, ['alice-web-search/ready'])
  assert.deepStrictEqual(n.routes, [{ kind: 'exact', path: '/api/plugins/alice-web-search/query' }])
  const kebab = /^[a-z]([a-z0-9]*(-[a-z0-9]+)*)?$/
  for (const value of [...n.commands, ...n.skills, ...n.settingsNamespaces, ...n.skillProviders]) {
    assert.ok(kebab.test(value), `${value} 应为 kebab`)
  }
  assert.ok(kebab.test(n.pluginNames[0]), '插件名应为 kebab')
})

test('scaffold：非法输入拒绝且不落盘', async () => {
  const dir = tmpPluginDir('scaffold-reject')
  trackTmpDir(dir)
  for (const bad of [{ coordinate: 'Alice/tool' }, { coordinate: 'no-slash' }, { coordinate: 'a/b/c' }, { coordinate: 'taxueseek/demo-tool', form: 'widget' }]) {
    await assert.rejects(
      () => scaffoldPlugin({ outDir: dir, harnessVersion: '0.0.0', ...bad }),
      UsageError,
      `${JSON.stringify(bad)} 应被拒绝`
    )
  }
  assert.strictEqual(fs.readdirSync(dir).length, 0, '拒绝必须发生在写盘前')
})

test('scaffold：目标目录非空时拒绝覆盖', async () => {
  const dir = tmpPluginDir('scaffold-occupied')
  trackTmpDir(dir)
  fs.writeFileSync(path.join(dir, 'user-file.txt'), 'keep')
  await assert.rejects(
    () => scaffoldPlugin({ coordinate: 'taxueseek/demo-tool', form: 'tool', outDir: dir, harnessVersion: '0.0.0' }),
    UsageError
  )
  assert.strictEqual(fs.readFileSync(path.join(dir, 'user-file.txt'), 'utf8'), 'keep', '用户文件不能动')
})

test('scaffold：显式 harness 版本优先于本机探测', async () => {
  const result = await scaffoldTo('versioned', { coordinate: 'taxueseek/demo-ver', form: 'tool', harnessVersion: '9.9.9' })
  assert.strictEqual(result.harnessVersion, '9.9.9')
  const pkg = JSON.parse(fs.readFileSync(path.join(result.outDir, 'package.json'), 'utf8'))
  assert.ok(pkg.description.includes('9.9.9'), 'description 应记录目标宿主版本')
})

test('scaffold：Windows 模拟下宿主探测不依赖 POSIX 布局', () => {
  const winVersion = detectHarnessVersion({ platform: 'win32', env: { APPDATA: 'X:\\npm' } })
  assert.ok(winVersion === null || typeof winVersion === 'string', 'win 模拟探测应安全返回，不抛路径异常')
})

// ── 创作体检门（造完即验）────────────────────────────────────────────────────
// 核心设计是判定分层：硬门禁只有三条（entry/smoke/critical），fail 才判红；
// audit 分数、high/medium 命中、WARN 全部只透传进 discretion 不拍板。
// 断言围绕两件事：硬门禁真的拦得住，软指标真的不越权。

const gateEnvWithoutDsh = (dir) => {
  // 真实探测但抹掉宿主版本：指南自动发现必走不到缓存，code-scan 诚实跳过。
  // 自检因此不依赖本机 ~/.cache/dsh-plugin-fast-adapt/ 的状态，任何机器同绿。
  const env = probeEnvironment(dir)
  return { ...env, globalDsh: null }
}

test('write-gate：tool 骨架出生证——硬门禁全过、软指标只进裁量区', async () => {
  const result = await scaffoldTo('gate-pass', { coordinate: 'taxueseek/gate-pass', form: 'tool', harnessVersion: '0.2.1-rc.3' })
  const gate = await runWriteGate(result.outDir, { detectEnv: gateEnvWithoutDsh })
  assert.strictEqual(gate.verdict, 'pass')
  const gates = Object.fromEntries(gate.hardGates.map((g) => [g.gate, g]))
  assert.strictEqual(gates.entry.pass, true)
  assert.strictEqual(gates.smoke.pass, true)
  assert.ok(!('code-scan-critical' in gates), '无宿主版本时应不设 critical 门而非放行')
  assert.ok(gate.skipped.some((s) => s.step === 'code-scan'), 'code-scan 应诚实跳过并给补法')
  assert.ok(gate.discretion.some((d) => d.item === 'audit-scores'), 'audit 分数应在裁量区')
  assert.ok(gate.discretion.some((d) => d.item === 'not-installed'), '未挂载 profile 应报事实不判红')
})

test('write-gate：入口缺失硬门禁拦截', async () => {
  const result = await scaffoldTo('gate-broken', { coordinate: 'taxueseek/gate-broken', form: 'tool', harnessVersion: '0.2.1-rc.3' })
  fs.rmSync(path.join(result.outDir, 'lib', 'index.js'))
  const gate = await runWriteGate(result.outDir, { detectEnv: gateEnvWithoutDsh })
  assert.strictEqual(gate.verdict, 'fail')
  const gates = Object.fromEntries(gate.hardGates.map((g) => [g.gate, g]))
  assert.strictEqual(gates.entry.pass, false)
  assert.strictEqual(gates.smoke.pass, false)
})

test('write-gate：critical 命中（import 已移除包）拦截硬门禁', async () => {
  const result = await scaffoldTo('gate-critical', { coordinate: 'taxueseek/gate-critical', form: 'tool', harnessVersion: '0.2.1-rc.3' })
  fs.writeFileSync(
    path.join(result.outDir, 'lib', 'extra.js'),
    `import { x } from '@deepseek-ai/dsh-removed-in-history'\nexport const y = x\n`
  )
  // 假指南根：<guideRoot>/v<version>/<topic>/guide.md，锚点写已移除包
  const guideRoot = tmpPluginDir('gate-guides')
  trackTmpDir(guideRoot)
  const guideDir = path.join(guideRoot, 'v0.2.1-rc.3', 'package-removal')
  fs.mkdirSync(guideDir, { recursive: true })
  fs.writeFileSync(
    path.join(guideDir, 'guide.md'),
    [
      '---',
      'kind: upgrade-guide',
      'description: "test fixture"',
      '---',
      '# Removed package',
      '',
      '## Change',
      '',
      'The package @deepseek-ai/dsh-removed-in-history was removed.',
      '',
      '## Migration',
      '',
      '1. Remove the import of @deepseek-ai/dsh-removed-in-history.',
      '',
    ].join('\n')
  )
  const gate = await runWriteGate(result.outDir, { guideRoot, detectEnv: gateEnvWithoutDsh })
  assert.strictEqual(gate.verdict, 'fail', 'import 已移除包必须判红')
  const criticalGate = gate.hardGates.find((g) => g.gate === 'code-scan-critical')
  assert.ok(criticalGate, '显式 --guide 时应设 critical 门')
  assert.strictEqual(criticalGate.pass, false)
})

test('write-gate：audit 扣分不越权判红（软指标分层的关键回归）', async () => {
  const result = await scaffoldTo('gate-audit', { coordinate: 'taxueseek/gate-audit', form: 'tool', harnessVersion: '0.2.1-rc.3' })
  // 造一个 performance 会扣分的文件（同步 I/O），audit 分数必然 <100
  fs.writeFileSync(
    path.join(result.outDir, 'lib', 'heavy.js'),
    `import fs from 'node:fs'\nexport function readAll(p) { return fs.readFileSync(p, 'utf8') }\n`
  )
  const gate = await runWriteGate(result.outDir, { detectEnv: gateEnvWithoutDsh })
  const auditItem = gate.discretion.find((d) => d.item === 'audit-scores')
  assert.ok(auditItem.data.scores.performance < 100, 'fixture 应真的触发 audit 扣分，否则本断言失去对象')
  assert.strictEqual(gate.verdict, 'pass', 'audit 扣分是裁量项，不能影响硬门禁判定')
})

test('write-gate：--skip-smoke 跳过后 smoke 不进门禁且给原因', async () => {
  const result = await scaffoldTo('gate-skip', { coordinate: 'taxueseek/gate-skip', form: 'tool', harnessVersion: '0.2.1-rc.3' })
  const gate = await runWriteGate(result.outDir, { skipSmoke: true, detectEnv: gateEnvWithoutDsh })
  assert.ok(!gate.hardGates.some((g) => g.gate === 'smoke'), '跳过后不该有 smoke 门')
  assert.ok(gate.skipped.some((s) => s.step === 'smoke'), '跳过要给原因')
})

test('scaffold 衔接：nextSteps 与生成 README 都指向体检门', async () => {
  const result = await scaffoldTo('gate-link', { coordinate: 'taxueseek/gate-link', form: 'tool', harnessVersion: '0.2.1-rc.3' })
  assert.ok(result.nextSteps.some((s) => s.includes('write-gate.mjs')), 'nextSteps 应指向 write-gate')
  const readme = fs.readFileSync(path.join(result.outDir, 'README.md'), 'utf8')
  assert.ok(readme.includes('write-gate.mjs'), '生成的 README 应指向 write-gate')
  assert.ok(readme.includes('--skip-smoke'), 'README 应说明重复冒烟的免跑方式')
})
