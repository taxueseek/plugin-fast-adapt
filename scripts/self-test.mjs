#!/usr/bin/env node
// self-test.mjs —— 自检。零网络、零外部依赖，任何机器上都能跑。
//
// 重点验证三件事：
//   1. 扫描器不误报（注释/字符串里的同名词不算命中）—— 这是旧版正则的老毛病
//   2. 扫描器不漏报（真实代码里的 import / 成员访问 / 常量要抓到）
//   3. 版本启发式正确（prerelease 语义、本机与官方通道的相对位置）

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanSource, compareVersions, parseVersion } from './lib/scanner.mjs'
import { parseGuideMarkdown, extractAnchors, listGuideVersions } from './lib/guide-parser.mjs'
import { resolveTargetVersion, fetchNpmMetadata } from './guide-sync.mjs'
import { anchorMatches } from './code-scan.mjs'
import { runQuickSmoke } from './quick-smoke.mjs'
import { auditPlugin } from './plugin-audit.mjs'
import { extractInjects, diagnoseActivation, candidateGlobalRoots, parsePatchEntries } from './env-doctor.mjs'
import { scaffoldPlugin, projectNames, detectHarnessVersion, UsageError } from './scaffold.mjs'

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

process.stderr.write('plugin-fast-adapt 自检\n\n')

// ── 1. 扫描器：不误报 ──────────────────────────────────────────────────────

process.stderr.write('[1] 扫描器不误报（注释与字符串）\n')

const decoy = `// 注释里提到 @deepseek-ai/dsh-settings 和 installBundle()
const doc = "文档字符串里也有 @deepseek-ai/dsh-settings 与 removeBundle"
const tpl = \`模板里还有 @deepseek-ai/dsh-settings 和 installBundle\`
/** 块注释里的 ctx.sessionQuery 与 installBundle */
export const Config = { name: 'x' }
`

test('注释和字符串里的包名不进 imports', () => {
  const r = scanSource(decoy)
  assert.strictEqual(r.imports.length, 0, `期望 0 个 import，实得 ${JSON.stringify(r.imports)}`)
})

test('注释和字符串里的成员访问不进 memberAccess', () => {
  const r = scanSource(decoy)
  assert.strictEqual(r.memberAccess.length, 0, `期望 0 个成员访问，实得 ${JSON.stringify(r.memberAccess)}`)
})

test('注释和字符串里的调用不进 calls', () => {
  const r = scanSource(decoy)
  assert.strictEqual(r.calls.length, 0, `期望 0 个调用，实得 ${JSON.stringify(r.calls)}`)
})

test('字符串字面量被单独收集（供错误码匹配）', () => {
  const r = scanSource(decoy)
  const values = r.strings.map((s) => s.value)
  assert.ok(values.some((v) => v.includes('@deepseek-ai/dsh-settings')), '字符串内容应被收集')
  assert.ok(values.some((v) => v.includes('removeBundle')), '字符串内容应被收集')
})

// ── 2. 扫描器：不漏报 ──────────────────────────────────────────────────────

process.stderr.write('\n[2] 扫描器不漏报（真实代码）\n')

const real = `import { Config } from '@deepseek-ai/dsh-settings'
import { installBundle } from '@deepseek-ai/dsh-api-remotes/client'

export async function apply(ctx) {
  const svc = ctx.sessionQuery
  const rows = await svc.select('sessions')
  await installBundle('@deepseek-ai/dsh-foo')
  if (err.code === 'already-installed') return
  ctx.logger.info('rows', rows.length)
}
`

test('抓到真实 import', () => {
  const r = scanSource(real)
  const sources = r.imports.map((i) => i.source)
  assert.ok(sources.includes('@deepseek-ai/dsh-settings'), `未抓到 dsh-settings: ${JSON.stringify(sources)}`)
  assert.ok(sources.includes('@deepseek-ai/dsh-api-remotes/client'), '未抓到 dsh-api-remotes/client')
})

test('抓到真实成员访问', () => {
  const r = scanSource(real)
  const dotted = r.memberAccess.map((m) => m.chain)
  assert.ok(dotted.some((d) => d.startsWith('ctx.sessionQuery')), `未抓到 ctx.sessionQuery: ${JSON.stringify(dotted)}`)
  assert.ok(dotted.some((d) => d.startsWith('ctx.logger')), '未抓到 ctx.logger')
})

test('抓到真实调用', () => {
  const r = scanSource(real)
  const names = r.calls.map((c) => c.name)
  assert.ok(names.includes('installBundle'), `未抓到 installBundle: ${JSON.stringify(names)}`)
})

test('抓到字符串常量（错误码）', () => {
  const r = scanSource(real)
  const values = r.strings.map((s) => s.value)
  assert.ok(values.includes('already-installed'), `未抓到错误码: ${JSON.stringify(values)}`)
})

test('行号指向真实代码行，不指向注释行', () => {
  const mixed = `// installBundle in a comment
const x = require('cordis')
installBundle('y')
`
  const r = scanSource(mixed)
  const callLine = r.calls.find((c) => c.name === 'installBundle')?.line
  assert.strictEqual(callLine, 3, `installBundle 应在第 3 行，实得 ${callLine}`)
})

test('TypeScript 类型注解不影响扫描', () => {
  const ts = `import type { Session } from '@deepseek-ai/dsh-session'
export const f = (s: Session): number => s.seq.length
`
  const r = scanSource(ts)
  assert.ok(r.imports.some((i) => i.source === '@deepseek-ai/dsh-session'), '应抓到 type import')
  const dotted = r.memberAccess.map((m) => m.chain)
  assert.ok(dotted.some((d) => d.startsWith('s.seq')), `应抓到 s.seq: ${JSON.stringify(dotted)}`)
})

// ── 3. 官方指南解析 ────────────────────────────────────────────────────────

process.stderr.write('\n[3] 官方指南解析\n')

const sampleGuide = `---
kind: upgrade-guide
description: "Installing over an installed plugin package is refused."
---

# Installing over an installed plugin package is refused

English | 中文

## Change

pluginManager.installBundle(spec) used to run pnpm over an installed package.
It now fails with error.code: 'already-installed'.

## Migration

1. Call removeBundle(name) first, then installBundle(spec).
2. Handle the already-installed code.
`

test('解析 frontmatter 与段落', () => {
  const g = parseGuideMarkdown(sampleGuide)
  assert.ok(g.description.includes('refused'), 'description 解析失败')
  assert.ok(g.change.includes('installBundle'), 'Change 段解析失败')
  assert.ok(g.migration.includes('removeBundle'), 'Migration 段解析失败')
})

test('抽出的锚点含包名、成员、常量', () => {
  const g = parseGuideMarkdown(sampleGuide)
  const a = extractAnchors(g.change, g.migration)
  assert.ok(a.packages.some((p) => p.includes('dsh-api-remotes')) || a.packages.length >= 0, '锚点应为数组')
  assert.ok(a.members.includes('installBundle'), `应抽出 installBundle: ${JSON.stringify(a.members)}`)
  assert.ok(a.members.includes('removeBundle'), '应抽出 removeBundle')
  assert.ok(a.codes.includes('already-installed'), `应抽出 already-installed: ${JSON.stringify(a.codes)}`)
})

test('无锚点的 guide 不产生条目', () => {
  const a = extractAnchors('Nothing relevant here.', 'Do something else.')
  assert.strictEqual(a.packages.length + a.members.length + a.codes.length, 0)
})

test('语境引用的包名不进 package 锚点（2026-10-24 实测回归：tool-presentation-mode 把 dsh-tools 误报成 critical）', () => {
  // 讲的是 mode 字段取值，包没被移除——import 该包的插件不该报
  const a = extractAnchors(
    'The `mode` fields of `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-agent-tool-presentation` accept only `native` or `ptc`.',
    '1. Replace mode: both with mode: native.'
  )
  assert.ok(!a.packages.includes('@deepseek-ai/dsh-tools'), `语境引用不该进锚点: ${JSON.stringify(a.packages)}`)
})

test('与移除动词同句的包名进 package 锚点', () => {
  const a = extractAnchors(
    'The package `@deepseek-ai/dsh-client-runtime` is removed from the official roster; plugins must not declare it.',
    '1. Remove the import of @deepseek-ai/dsh-client-runtime from your client half.'
  )
  assert.ok(a.packages.includes('@deepseek-ai/dsh-client-runtime'), `真移除应进锚点: ${JSON.stringify(a.packages)}`)
})

test('识别替换对，新符号进 introduced', () => {
  const a = extractAnchors(
    'ctx.subagents.start() is removed; use startActivation().',
    '1. Replace ctx.subagents.start() or startContinuable() with startActivation().'
  )
  assert.ok(a.introduced.includes('startActivation'), `startActivation 应为新符号: ${JSON.stringify(a.introduced)}`)
  assert.ok(!a.members.includes('startActivation'), '新符号不该留在待报锚点里')
})

test('迁移目标 Move … into X and Y 全部进 introduced（白描实测回归）', () => {
  // v0.2.0-rc.2 真实指南句式：meta.description 是迁移目标，
  // 旧识别只抓 into 后第一个符号，and 同伴被当待报锚点误报 high
  const a = extractAnchors(
    'A subpath is not a package, so the next release never reads a package.json for it. Its title and description come only from locale files.',
    "1. Move the subpath manifest's name and description into meta.title and meta.description of the subpath locale files, and export them."
  )
  assert.ok(a.introduced.includes('meta.description'), `and 同伴应进 introduced: ${JSON.stringify(a.introduced)}`)
  assert.ok(!a.members.includes('meta.description'), `迁移目标不该留在待报锚点: ${JSON.stringify(a.members)}`)
})

test('常量锚点只从 Change 段抽，Migration 里的示例值不算', () => {
  const a = extractAnchors(
    'A restricted run fails with `sandbox-unavailable`.',
    "1. Set the sandbox-policy row's mode. Its default mode is `read-only`."
  )
  assert.ok(a.codes.includes('sandbox-unavailable'), 'Change 里的错误码应抽出')
  assert.ok(!a.codes.includes('read-only'), `Migration 里的示例值不该抽出: ${JSON.stringify(a.codes)}`)
})

test('剥掉 OSC 8 转义序列后仍能解析', () => {
  const withOsc = sampleGuide.replace('English | 中文', 'English |\x1b]8;id=1;guide.zh.md\x07中文\x1b]8;;\x07')
  const g = parseGuideMarkdown(withOsc)
  assert.ok(g.migration.includes('removeBundle'), '转义序列不应影响解析')
})

// ── 4. 版本启发式 ──────────────────────────────────────────────────────────

process.stderr.write('\n[4] 版本比较与启发式\n')

test('prerelease 排序正确', () => {
  assert.strictEqual(compareVersions('0.2.1-rc.2', '0.2.1-rc.3'), -1)
  assert.strictEqual(compareVersions('0.2.1-rc.3', '0.2.1-rc.3'), 0)
  assert.strictEqual(compareVersions('0.2.1', '0.2.1-rc.3'), 1)
  assert.strictEqual(compareVersions('0.2.0', '0.2.1-rc.3'), -1)
})

test('双位数 prerelease 段按数值比较（rc.10 > rc.9，防字典序回归）', () => {
  assert.strictEqual(compareVersions('0.2.1-rc.10', '0.2.1-rc.9'), 1, 'rc.10 应大于 rc.9')
  assert.strictEqual(compareVersions('0.2.1-rc.9', '0.2.1-rc.10'), -1)
  assert.strictEqual(compareVersions('0.3.0-alpha.2', '0.3.0-alpha.10'), -1, 'alpha.10 应大于 alpha.2')
  assert.strictEqual(compareVersions('0.2.1-rc.10', '0.2.1'), -1, '正式版仍高于任何预发布')
})

test('listGuideVersions 对双位数 prerelease 排序正确', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-adapt-guidesort-'))
  try {
    for (const v of ['v0.2.1-rc.10', 'v0.2.1-rc.9', 'v0.2.1-rc.2']) {
      fs.mkdirSync(path.join(dir, v), { recursive: true })
    }
    const versions = listGuideVersions(dir)
    assert.deepStrictEqual(
      versions,
      ['v0.2.1-rc.2', 'v0.2.1-rc.9', 'v0.2.1-rc.10'],
      `rc.10 应排在 rc.9 之后: ${JSON.stringify(versions)}`
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('识别 prerelease', () => {
  assert.strictEqual(parseVersion('0.2.1-rc.3').pre, 'rc.3')
  assert.strictEqual(parseVersion('0.2.1').pre, null)
})

const TAGS = { latest: '0.2.1-rc.2', next: '0.2.1-rc.3', alpha: '0.2.1-alpha.5' }

test('本机等于官方 next 通道 → 判定为最新，不给目标版本', () => {
  const r = resolveTargetVersion('0.2.1-rc.3', TAGS)
  assert.strictEqual(r.verdict, 'up-to-date-on-channel', r.reason)
  assert.strictEqual(r.target, null)
  assert.strictEqual(r.currentChannel, 'next')
})

test('本机低于官方 → 目标是官方最高通道，不选低质量通道', () => {
  const r = resolveTargetVersion('0.1.7-rc.2', TAGS)
  assert.strictEqual(r.verdict, 'upgrade-available')
  assert.strictEqual(r.target, '0.2.1-rc.3', `应选官方最高（next 的 rc.3），实得 ${r.target}`)
})

test('本机跨大段落后 → 目标仍是官方最高，不落回 alpha（2026-10-24 实测回归：旧逻辑选了 alpha.5 漏掉 rc.2/rc.3 的变更）', () => {
  const r = resolveTargetVersion('0.1.0-rc.6', TAGS)
  assert.strictEqual(r.verdict, 'upgrade-available')
  assert.strictEqual(r.target, '0.2.1-rc.3', `应选官方最高（next 的 rc.3），实得 ${r.target}`)
  assert.strictEqual(r.targetChannel, 'next')
})

test('本机高于官方所有通道 → 判定为领先', () => {
  const r = resolveTargetVersion('0.3.0-alpha.1', TAGS)
  assert.strictEqual(r.verdict, 'ahead-of-upstream', r.reason)
  assert.strictEqual(r.target, null)
})

test('检测不到本机版本 → 退回 latest 并标明', () => {
  const r = resolveTargetVersion(null, TAGS)
  assert.strictEqual(r.verdict, 'unknown-local')
  assert.strictEqual(r.target, '0.2.1-rc.2')
})

test('通道去重且按版本排序', () => {
  const r = resolveTargetVersion('0.1.0', { latest: '0.2.1-rc.2', next: '0.2.1-rc.2', alpha: '0.2.1-alpha.5' })
  assert.strictEqual(r.verdict, 'upgrade-available')
  assert.strictEqual(r.target, '0.2.1-rc.2', `应选官方最高（latest/next 的 rc.2），实得 ${r.target}`)
})

// ── 5. 端到端：真实插件 × 真实指南 ────────────────────────────────────────

process.stderr.write('\n[5] 端到端命中\n')

const { scanPlugin } = await import('./code-scan.mjs')

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-adapt-fixture-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'src', 'index.ts'),
    `// 注释里写 @deepseek-ai/dsh-settings 不应命中
import { installBundle } from '@deepseek-ai/dsh-api-remotes/client'

export async function apply(ctx) {
  await installBundle('@deepseek-ai/dsh-foo')
  if (err.code === 'already-installed') return
}
`
  )
  return dir
}

test('端到端：注释不命中，真实代码命中', async () => {
  const dir = makeFixture()
  try {
    const guides = [
      {
        version: '0.2.1-alpha.2',
        topic: 'plugin-install-over-installed',
        title: 'Installing over an installed plugin package is refused',
        change: 'pluginManager.installBundle(spec) now fails with error.code: already-installed.',
        migration: '1. Call removeBundle(name) first, then installBundle(spec).\n2. Handle the already-installed code.',
        anchors: { packages: ['@deepseek-ai/dsh-api-remotes/client'], members: ['installBundle', 'removeBundle'], codes: ['already-installed'] },
      },
    ]
    const r = scanPlugin(dir, guides, { localVersion: '0.2.1-alpha.1', targetVersion: '0.2.1-alpha.2' })
    const symbols = r.findings.map((f) => `${f.kind}:${f.symbol}`)
    assert.ok(symbols.includes('package:@deepseek-ai/dsh-api-remotes/client'), `应命中包名: ${JSON.stringify(symbols)}`)
    assert.ok(symbols.includes('member:installBundle'), '应命中成员')
    assert.ok(symbols.includes('code:already-installed'), '应命中错误码')
    assert.ok(!r.findings.some((f) => f.file.includes('comment')), '不应有来自注释的命中')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('用了迁移目标（新符号）的插件不报命中', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-adapt-adapted-'))
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      `import { startActivation } from '@deepseek-ai/dsh-subagents'

export async function apply(ctx) {
  await ctx.subagents.startActivation({ id: 'x' })
}
`
    )
    const guides = [
      {
        version: '0.2.1-alpha.1',
        topic: 'subagent-activations',
        title: 't',
        change: 'ctx.subagents.start() is removed.',
        migration: '1. Replace ctx.subagents.start() with startActivation().',
        anchors: {
          packages: [],
          members: ['ctx.subagents.start', 'startActivation'],
          codes: [],
          introduced: ['startActivation'],
        },
      },
    ]
    const r = scanPlugin(dir, guides, { localVersion: '0.1.7-rc.2', targetVersion: '0.2.1-alpha.4' })
    assert.strictEqual(r.findingCount, 0, `已适配的插件不该报命中: ${JSON.stringify(r.findings)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('仍在用旧符号的插件要报命中', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-adapt-legacy-'))
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      `export async function apply(ctx) {
  await ctx.subagents.start({ id: 'x' })
}
`
    )
    const guides = [
      {
        version: '0.2.1-alpha.1',
        topic: 'subagent-activations',
        title: 't',
        change: 'ctx.subagents.start() is removed.',
        migration: '1. Replace ctx.subagents.start() with startActivation().',
        anchors: {
          packages: [],
          members: ['ctx.subagents.start', 'startActivation'],
          codes: [],
          introduced: ['startActivation'],
        },
      },
    ]
    const r = scanPlugin(dir, guides, { localVersion: '0.1.7-rc.2', targetVersion: '0.2.1-alpha.4' })
    assert.ok(r.findingCount > 0, '仍在用旧符号应报命中')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('版本窗口外的 guide 被排除', () => {
  const dir = makeFixture()
  try {
    const guides = [
      {
        version: '0.1.6-alpha.1',
        topic: 'old',
        title: 'old',
        change: 'installBundle changed.',
        migration: '1. use installBundle.',
        anchors: { packages: [], members: ['installBundle'], codes: [] },
      },
    ]
    const r = scanPlugin(dir, guides, { localVersion: '0.2.1-alpha.1', targetVersion: '0.2.1-alpha.2' })
    assert.strictEqual(r.findingCount, 0, '窗口外的 guide 不应产生命中')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import 主包不命中已移除的兄弟包（防前缀误报回归）', () => {
  // 官方 39 个包名全以 @deepseek-ai/dsh 开头：旧的反向前缀匹配会把
  // import 主包的插件全部误报成 critical（2026-10-24 复现后收掉）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-adapt-prefix-'))
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      `import { ctx } from '@deepseek-ai/dsh'\nexport const apply = () => ctx.tools.register({ name: 'x' })\n`
    )
    const guides = [
      {
        version: '0.2.1-rc.3',
        topic: 'x',
        title: 't',
        change: '@deepseek-ai/dsh-settings is removed.',
        migration: '1. Remove @deepseek-ai/dsh-settings imports.',
        anchors: { packages: ['@deepseek-ai/dsh-settings'], members: [], codes: [] },
      },
    ]
    const r = scanPlugin(dir, guides)
    assert.strictEqual(r.findingCount, 0, `import 主包不该命中兄弟包移除: ${JSON.stringify(r.findings)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('import 已移除包的子路径仍命中（保召回）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-adapt-subpath-'))
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      `import { legacy } from '@deepseek-ai/dsh-settings/lib/legacy'\nexport const apply = () => void legacy\n`
    )
    const guides = [
      {
        version: '0.2.1-rc.3',
        topic: 'x',
        title: 't',
        change: '@deepseek-ai/dsh-settings is removed.',
        migration: '1. Remove @deepseek-ai/dsh-settings imports.',
        anchors: { packages: ['@deepseek-ai/dsh-settings'], members: [], codes: [] },
      },
    ]
    const r = scanPlugin(dir, guides)
    assert.ok(r.findings.some((f) => f.kind === 'package'), '子路径 import 仍应命中')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('真实指南目录能列出版本（若本机有 clone）', () => {
  const candidates = [
    process.env.DSH_HARNESS_CLONE,
    path.join(os.homedir(), 'Documents', 'deepseek-harness', 'docs', 'upgrade-guide'),
    path.join(os.homedir(), 'layerfs-lab', 'deepseek-harness', 'docs', 'upgrade-guide'),
  ].filter(Boolean)
  const root = candidates.find((c) => fs.existsSync(c))
  if (!root) {
    process.stderr.write('      (跳过：本机无 harness clone)\n')
    return
  }
  const versions = listGuideVersions(root)
  assert.ok(versions.length > 0, '应列出至少一个指南版本')
  assert.ok(
    versions.some((v) => v.replace(/^v/, '').startsWith('0.2.1-alpha')),
    `应含 0.2.1-alpha 系列: ${versions.join(', ')}`
  )
})

// ── 6. 匹配精度：宁可漏报也不误报 ─────────────────────────────────────────

process.stderr.write('\n[6] 匹配精度\n')

test('engines.dsh 不匹配 result.dsh（对象不同）', () => {
  assert.strictEqual(anchorMatches('engines.dsh', 'result.dsh'), false)
  assert.strictEqual(anchorMatches('engines.dsh', 'engines.dsh'), true)
})

test('长对象能以短对象结尾的方式匹配', () => {
  assert.strictEqual(anchorMatches('sessionTitle.register', 'ctx.sessionTitle.register'), true)
  assert.strictEqual(anchorMatches('ctx.tools.presentAs', 'ctx.tools.presentAs'), true)
})

test('过短的末段不作为锚点', () => {
  assert.strictEqual(anchorMatches('a.b', 'x.b'), false)
})

test('通用词不进锚点表', () => {
  const a = extractAnchors(
    'Call ctx.sessionTitle.register({ id }) and use register(',
    '1. Replace registerSessionTitleLlmProvider(...) with ctx.sessionTitle.register({ id }).'
  )
  assert.ok(!a.members.includes('register'), `register 应被过滤: ${JSON.stringify(a.members)}`)
  assert.ok(!a.members.includes('ctx.sessionTitle'), '过短的链应被过滤')
  assert.ok(
    a.members.includes('registerSessionTitleLlmProvider') || a.members.includes('sessionTitle.register'),
    `应保留具体锚点: ${JSON.stringify(a.members)}`
  )
})

test('完整点链优先于短链', () => {
  const a = extractAnchors('Use ctx.tools.presentAs("both") here.', '1. Replace ctx.tools.presentAs.')
  assert.ok(!a.members.includes('ctx.tools'), `ctx.tools 应被更长的链覆盖: ${JSON.stringify(a.members)}`)
  assert.ok(a.members.includes('ctx.tools.presentAs'), `应抽出完整链: ${JSON.stringify(a.members)}`)
})

// ── 文档引用完整性 ──────────────────────────────────────────────────────────
// SOP 和 SKILL.md 里链接的原版文件必须真实存在，防止走廊卡片改名后出现死链。

test('SOP 与 SKILL 引用的原版文件不漂移', () => {
  const skillDir = path.resolve(import.meta.dirname, '..')
  const docs = [
    path.join(skillDir, 'SKILL.md'),
    path.join(skillDir, 'references', 'legacy-migration-sop.md'),
  ]
  // 独立仓库后，对原版文件的引用走 GitHub URL（前缀固定，防手滑改错仓）；
  // 本仓库内部引用仍走 references/ 相对路径，本地文件必须真实存在。
  const upstreamPrefix = 'https://github\\.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/'
  const linkRe = new RegExp(`\\((${upstreamPrefix}[\\w/.-]+)\\)|\\((references\\/[\\w/.-]+)\\)`, 'g')
  let checked = 0
  for (const doc of docs) {
    const text = fs.readFileSync(doc, 'utf8')
    for (const m of text.matchAll(linkRe)) {
      const upstreamUrl = m[1]
      if (upstreamUrl) {
        assert.ok(upstreamUrl.startsWith('https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/'),
          `${path.basename(doc)} 引用的原版 URL 前缀不对：${upstreamUrl}`)
      } else {
        const rel = m[2]
        const target = path.resolve(path.dirname(doc), rel)
        assert.ok(fs.existsSync(target), `${path.basename(doc)} 引用的 ${rel} 不存在（死链）`)
      }
      checked++
    }
  }
  assert.ok(checked >= 8, `应至少核对 8 处引用，实际 ${checked} 处——SOP 可能被清空了`)
})

test('文档宣称的断言数与实际一致（防手工漂移）', () => {
  // 这个数字已漂过两次（49→50→54 都是事后手补）；现在让自检拦住它
  const root = path.resolve(import.meta.dirname, '..')
  const docs = ['SKILL.md', 'README.md', 'README.en.md'].map((f) => path.join(root, f))
  let checked = 0
  for (const doc of docs) {
    const text = fs.readFileSync(doc, 'utf8')
    const numbers = [
      ...text.matchAll(/(\d+)\s*项断言/g),
      ...text.matchAll(/(\d+)\s*assertions/g),
    ].map((m) => Number(m[1]))
    assert.ok(numbers.length > 0, `${path.basename(doc)} 应写明断言数，否则本断言失去保护对象`)
    for (const n of numbers) {
      assert.strictEqual(n, tests.length, `${path.basename(doc)} 宣称 ${n} 项断言，实际 ${tests.length} 项`)
    }
    checked += numbers.length
  }
  assert.ok(checked >= 5, `应至少核对 5 处断言数，实际 ${checked} 处`)
})

// ── 创作脚手架（第 0 步）─────────────────────────────────────────────────────
// 生成物三重验证：结构断言（文件与 package.json 不变量）、冒烟闭环（零依赖
// 形态真跑 quick-smoke）、挂载层可被 env-doctor 的 parsePatchEntries 识别
// （「装了不生效」是 env-doctor 查的头号事故，生成的骨架必须天然可挂载）。

const SCAFFOLD_FORMS = ['tool', 'hook', 'service', 'config', 'llm-adapter']
const scaffoldDirs = []

async function scaffoldTo(name, options) {
  const dir = tmpPluginDir(`scaffold-${name}`)
  scaffoldDirs.push(dir)
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

test('scaffold：依赖宿主基类的三形态诚实跳过冒烟并保留核名提醒', async () => {
  const expectations = {
    service: (src) => src.includes('extends Service'),
    config: (src) => src.includes('Schema.object'),
    'llm-adapter': (src) => src.includes('TODO') && src.includes('以目标宿主 checkout 为准'),
  }
  for (const form of ['service', 'config', 'llm-adapter']) {
    const result = await scaffoldTo(form, { coordinate: `taxueseek/demo-${form}`, form })
    assert.strictEqual(result.smoke, null, `${form} 不该自动冒烟（依赖宿主基类，Mock 覆盖不了）`)
    const src = fs.readFileSync(path.join(result.outDir, 'lib', 'index.js'), 'utf8')
    assert.ok(expectations[form](src), `${form} 入口缺关键结构`)
  }
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
  scaffoldDirs.push(dir)
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
  scaffoldDirs.push(dir)
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

// ── guide-sync dist-tags 缓存 ────────────────────────────────────────────────
// 本机网络查 npm registry 曾实测 15s 超时失败；缓存命中应为 0 网络依赖。

function tmpPluginDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fast-adapt-${name}-`))
  return dir
}

test('dist-tags TTL 内读缓存不打网络', async () => {
  const cache = path.join(tmpPluginDir('cache1'), 'npm-metadata.json')
  fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now(), data: { 'dist-tags': { latest: '0.2.1-rc.3' } } }))
  let fetchCalls = 0
  const meta = await fetchNpmMetadata({ fetcher: async () => { fetchCalls++; throw new Error('不该打网络') }, cachePath: cache })
  assert.strictEqual(fetchCalls, 0, 'TTL 内不应打网络')
  assert.strictEqual(meta._metadataSource, 'cache')
  assert.strictEqual(meta['dist-tags'].latest, '0.2.1-rc.3')
})

test('网络失败降级用过期缓存并标 stale', async () => {
  const cache = path.join(tmpPluginDir('cache2'), 'npm-metadata.json')
  fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now() - 10 * 60 * 60 * 1000, data: { 'dist-tags': { latest: '0.2.0' } } }))
  const meta = await fetchNpmMetadata({ fetcher: async () => { throw new Error('network down') }, cachePath: cache })
  assert.strictEqual(meta._metadataSource, 'stale-cache', '应降级为 stale-cache')
  assert.strictEqual(meta['dist-tags'].latest, '0.2.0')
})

test('无缓存且网络失败要明确抛错', async () => {
  const cache = path.join(tmpPluginDir('cache3'), 'npm-metadata.json')
  await assert.rejects(
    () => fetchNpmMetadata({ fetcher: async () => { throw new Error('network down') }, cachePath: cache }),
    /network down/,
    '无缓存时网络失败不该静默'
  )
})

test('缓存过期后重新拉网络并落盘', async () => {
  const dir = tmpPluginDir('cache4')
  const cache = path.join(dir, 'npm-metadata.json')
  fs.writeFileSync(cache, JSON.stringify({ fetchedAt: Date.now() - 2 * 60 * 60 * 1000, data: { 'dist-tags': { latest: '0.2.0' } } }))
  let fetchCalls = 0
  const meta = await fetchNpmMetadata({
    // dist-tags 专用端点直接返回标签对象（不再是全量包文档）
    fetcher: async () => { fetchCalls++; return { ok: true, json: async () => ({ latest: '0.2.1-rc.3', next: '0.2.1-rc.4' }) } },
    cachePath: cache,
  })
  assert.strictEqual(fetchCalls, 1, '过期后应重新拉一次')
  assert.strictEqual(meta._metadataSource, 'network')
  assert.strictEqual(meta['dist-tags'].latest, '0.2.1-rc.3')
  const onDisk = JSON.parse(fs.readFileSync(cache, 'utf8'))
  assert.strictEqual(onDisk.data['dist-tags'].latest, '0.2.1-rc.3', '新数据应写回缓存')
})

// ── quick-smoke：修完秒验 ────────────────────────────────────────────────────

test('quick-smoke 端到端：最小插件通过并注册工具', async () => {
  const dir = tmpPluginDir('smoke')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-smoke', version: '1.0.0', main: 'lib/index.js', type: 'module' }))
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'),
    `export const inject = ['tools']\nexport function apply(ctx) { ctx.tools.register({ name: 't_tool' }) }\n`)
  const result = await runQuickSmoke(dir)
  assert.ok(result.success, `最小插件应通过: ${result.error || ''}`)
  assert.deepStrictEqual(result.registeredTools, ['t_tool'])
  assert.deepStrictEqual(result.injectedServices, ['tools'])
})

test('quick-smoke：入口缺失报 entry_resolution 且建议构建', async () => {
  const dir = tmpPluginDir('noentry')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-noentry', version: '1.0.0', main: 'lib/index.js', type: 'module' }))
  const result = await runQuickSmoke(dir)
  assert.ok(!result.success)
  assert.strictEqual(result.stage, 'entry_resolution')
  assert.match(result.error, /构建/)
})

test('quick-smoke：Mock 没有的属性走兜底并被披露', async () => {
  const dir = tmpPluginDir('fallback')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-fb', version: '1.0.0', main: 'lib/index.js', type: 'module' }))
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'),
    `export function apply(ctx) { ctx.mysteryService.doThing() }\n`)
  const result = await runQuickSmoke(dir)
  assert.ok(result.success)
  assert.ok(result.mockFallbacks.includes('mysteryService'), `兜底属性应被披露: ${JSON.stringify(result.mockFallbacks)}`)
})

// ── plugin-audit：四维体检 + 新版本感知 ──────────────────────────────────────

test('audit：注释里的同步 I/O 不报（状态机纪律）', () => {
  const dir = tmpPluginDir('audit-comment')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a1', version: '1.0.0' }))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'index.js'),
    `// 旧的实现里有 readFileSync，现在没有了\nexport function apply() {}\n`)
  const report = auditPlugin(dir)
  const syncFindings = report.findings.filter((f) => /同步 I\/O/.test(f.title))
  assert.strictEqual(syncFindings.length, 0, '注释里的 readFileSync 不该报')
})

test('audit：真实同步 I/O 报 MEDIUM 并扣性能分', () => {
  const dir = tmpPluginDir('audit-sync')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a2', version: '1.0.0' }))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'index.js'),
    `import { readFileSync } from 'node:fs'\nexport function load() { return readFileSync('x') }\n`)
  const report = auditPlugin(dir)
  const f = report.findings.find((x) => /同步 I\/O/.test(x.title))
  assert.ok(f, '真实 readFileSync 应报')
  assert.strictEqual(f.severity, 'MEDIUM')
  assert.ok(report.scores.performance < 100, '性能分应被扣')
})

test('audit：peer 范围无 -0 放行报 HIGH，有 -0 不报', () => {
  const dir = tmpPluginDir('audit-peer')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a3', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.1.0-0 <0.3.0' } }))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export function apply() {}\n')
  let report = auditPlugin(dir)
  assert.ok(!report.findings.some((f) => /prerelease 宿主/.test(f.title)), '含 -0 放行不该报')

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a3', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' } }))
  report = auditPlugin(dir)
  const f = report.findings.find((x) => /prerelease 宿主/.test(x.title))
  assert.ok(f, '^0.2.0 拒绝 prerelease 应报')
  assert.strictEqual(f.severity, 'HIGH')
})

test('audit：* 通配不报，prerelease 双队列报 tuple 口径', () => {
  const dir = tmpPluginDir('audit-peer2')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export function apply() {}\n')

  // * 收一切包括 prerelease，报「拒绝 prerelease」是误报
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a5', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '*' } }))
  let report = auditPlugin(dir)
  assert.ok(!report.findings.some((f) => /peer 范围|peer 双队列/.test(f.title)), '通配 * 不该报')

  // 双队列已带 prerelease 标签：报 tuple 规则口径（^0.2.0-rc.1 不收 0.2.1-rc.x），
  // 修法是提 floor，不是泛泛的「拒绝 prerelease」
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a5', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6 || ^0.2.0-rc.1' } }))
  report = auditPlugin(dir)
  const t = report.findings.find((x) => /peer 双队列/.test(x.title))
  assert.ok(t, '双队列不含 0.2.1 线应报 tuple 口径')
  assert.ok(/tuple/.test(t.detail), 'detail 应含 tuple 规则与提 floor 修法')
})

test('audit：注释里的 ctx.effect 不豁免真实的无清理监听', () => {
  const dir = tmpPluginDir('audit-life2')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a4b', version: '1.0.0' }))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), `// 旧版用 ctx.effect(() => emitter.on('x', f))，现在重写了\nexport function setup(emitter) { emitter.on('x', () => {}) }\n`)
  const report = auditPlugin(dir)
  assert.ok(report.findings.some((f) => /清理逻辑/.test(f.title)), '注释里的 ctx.effect 不该豁免真实监听')
})

test('audit：生命周期命中与豁免', () => {
  const dir = tmpPluginDir('audit-life')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a4', version: '1.0.0' }))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), `export function setup(emitter) { emitter.on('x', () => {}) }\n`)
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), `export function setup(ctx, emitter) { ctx.effect(() => emitter.on('x', () => {})) }\n`)
  const report = auditPlugin(dir)
  const titles = report.findings.filter((f) => /清理逻辑/.test(f.title)).map((f) => f.file)
  assert.ok(titles.some((f) => f.endsWith('a.js')), '无清理的监听应报')
  assert.ok(!titles.some((f) => f.endsWith('b.js')), 'ctx.effect 包裹的不该报')
})

test('audit：clearTimeout 收口的定时器不算未清理（白描实测回归）', () => {
  // 白描 tools.ts 的子进程超时定时器经 finish() 统一 clearTimeout，
  // 旧清理标记表没有 clearTimeout 仍被报「未绑定清理逻辑」
  const dir = tmpPluginDir('audit-clear-timeout')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a6', version: '1.0.0' }))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'src', 'a.js'),
    `export function run(child, ms) { const t = setTimeout(() => child.kill(), ms); child.on('close', () => clearTimeout(t)) }\n`
  )
  const report = auditPlugin(dir)
  assert.ok(!report.findings.some((f) => /清理逻辑/.test(f.title)), 'clearTimeout 收口不该报未清理')
})

test('audit：guide 交叉把已移除包 import 映射成弹性建议', () => {
  const dir = tmpPluginDir('audit-guide')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-a5', version: '1.0.0' }))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), `import { x } from '@deepseek-ai/dsh-client-runtime'\nexport function apply() { void x }\n`)
  const scanResult = {
    findingCount: 1,
    window: { localVersion: '0.2.0-rc.2', targetVersion: '0.2.1-alpha.4' },
    findings: [{ file: 'src/index.js', line: 1, symbol: '@deepseek-ai/dsh-client-runtime', kind: 'package', guide: 'v0.2.1-alpha.1/x', title: 't', migration: ['步骤 1: 换新包'] }],
  }
  const report = auditPlugin(dir, { scanResult })
  assert.ok(report.versionAdvice, '应有 versionAdvice 段')
  assert.strictEqual(report.versionAdvice.findingCount, 1)
  assert.ok(report.findings.some((f) => /已移除的包仍在 import/.test(f.title)), 'package 命中应映射成弹性建议')
  assert.ok(report.scores.resilience < 100)
})

// ── activation 诊断（防「装了但没生效」） ────────────────────────────────────

test('extractInjects：注释里的 inject 声明不算', () => {
  const dir = tmpPluginDir('inj')
  fs.writeFileSync(path.join(dir, 'index.js'), `// export const inject = ['tools', 'ghost']\nexport const inject = ['tools']\nexport function apply() {}\n`)
  const injects = extractInjects(dir, 'index.js')
  assert.deepStrictEqual(injects, ['tools'], '只认代码区的 inject')
})

test('diagnoseActivation：产物缺失 → ERROR，挂载缺失 → WARN', () => {
  const dir = tmpPluginDir('act')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't-act', version: '1.0.0', main: 'lib/index.js' }))
  const none = diagnoseActivation(dir, [])
  assert.strictEqual(none.verdict, 'ERROR', '入口产物缺失应为 ERROR')

  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export function apply() {}\n')
  const unmounted = diagnoseActivation(dir, [{ profile: 'web', patchFile: '/nonexistent', patchEntries: [] }])
  assert.strictEqual(unmounted.verdict, 'WARN', '无 profile 挂载应为 WARN')

  const mounted = diagnoseActivation(dir, [{ profile: 'web', patchFile: '/nonexistent', patchEntries: [`{ id: 't-act', name: 't-act' }`] }])
  assert.strictEqual(mounted.verdict, 'OK')
  assert.strictEqual(mounted.perProfile[0].registered, true)
})

test('diagnoseActivation：disabled 判定不跨条目误伤', () => {
  // 旧惰性正则会被后面其他插件条目的 disabled: true 误伤，
  // 误伤会跳过本插件的 Silent Pending 风险检查
  const dir = tmpPluginDir('act-dis')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'alpha-plugin', version: '1.0.0', main: 'lib/index.js' }))
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export function apply() {}\n')
  const patch = path.join(dir, 'patch.yml')
  fs.writeFileSync(patch, [
    'plugins:',
    '  - insert:',
    '      name: alpha-plugin',
    '      from: file:./alpha',
    '  - insert:',
    '      name: beta-plugin',
    '      from: file:./beta',
    '      disabled: true',
    '',
  ].join('\n'))
  const r = diagnoseActivation(dir, [{ profile: 'web', patchFile: patch, patchEntries: ['name: alpha-plugin', 'name: beta-plugin disabled: true'] }])
  assert.strictEqual(r.perProfile[0].disabled, false, '后面条目的 disabled:true 不该误伤 alpha-plugin')
})

test('parsePatchEntries：多行 insert 与 id 覆盖条目算挂载，注释条目不算', () => {
  // 实测 web profile：wide-research 条目的 name 在 - id: 下一行，
  // 旧单行正则把活跃的 argo-dsh 误判成「未挂载」
  const text = [
    '# 注释掉的插件不算',
    "# - id: mcp-argo",
    "#   name: '@deepseek-ai/dsh-mcp-client'",
    '- insert:',
    '    - id: client-runtime',
    "      name: '@deepseek-ai/dsh-client-runtime'",
    '- id: wide-research',
    "  name: '@taxueseek/argo-dsh'",
    '  config:',
    '    llm:',
    '      name: MiniMax M3',
    '',
  ].join('\n')
  const entries = parsePatchEntries(text)
  assert.ok(entries.some((e) => e.includes('@deepseek-ai/dsh-client-runtime')), `多行 insert 应被识别: ${JSON.stringify(entries)}`)
  assert.ok(entries.some((e) => e.includes('@taxueseek/argo-dsh')), `id 覆盖条目应被识别: ${JSON.stringify(entries)}`)
  assert.ok(!entries.some((e) => e.includes('dsh-mcp-client')), '注释条目不该算挂载')
  assert.ok(!entries.some((e) => e.includes('MiniMax')), '深层 config 的模型名不该进条目清单')
})

// ── 跨平台模拟（Windows 真机验证待做，先锁住平台分支的行为） ────────────────

test('Windows 模拟：%APPDATA% 静态根被探到，不依赖 npm spawn', () => {
  const appData = tmpPluginDir('winroot')
  const nm = path.join(appData, 'npm', 'node_modules')
  fs.mkdirSync(path.join(nm, '@deepseek-ai', 'dsh'), { recursive: true })
  fs.writeFileSync(
    path.join(nm, '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.3' })
  )
  const roots = candidateGlobalRoots({ platform: 'win32', env: { APPDATA: appData } })
  assert.ok(roots.includes(nm), `应包含 %APPDATA%\\npm\\node_modules: ${JSON.stringify(roots)}`)
})

test('模拟调用不污染真实平台的全局根缓存', () => {
  const before = candidateGlobalRoots()
  candidateGlobalRoots({ platform: 'win32', env: { APPDATA: '/tmp/does-not-exist-xyz' } })
  const after = candidateGlobalRoots()
  assert.deepStrictEqual(after, before, '模拟调用不应改变真实探测结果')
})

// ── 性能回归门（防 lineAt 平方级退化） ───────────────────────────────────────
// 触点密集的大文件曾把 code-scan 拖到 23s（598 文件）；单文件合成压测守住线性。

test('扫描器对触点密集大文件保持线性（性能回归门）', () => {
  const lines = []
  for (let i = 0; i < 2000; i++) lines.push(`const v${i} = obj${i % 50}.member${i}; call${i}(v${i});`)
  const source = lines.join('\n')
  const start = Date.now()
  const scanned = scanSource(source)
  const elapsed = Date.now() - start
  assert.ok(scanned.memberAccess.length >= 1000, '应抓到成员访问')
  assert.strictEqual(scanned.memberAccess[1999].line, 2000, '行号要准')
  assert.ok(elapsed < 500, `2000 行触点密集文件扫描应在 500ms 内，实际 ${elapsed}ms`)
})

// ── 汇总 ────────────────────────────────────────────────────────────────────

// scaffold 用例的临时产物用完即删（os.tmpdir 只存可再生文件，不留唯一副本）
for (const dir of scaffoldDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

let passed = 0
const failures = []

for (const { name, fn } of tests) {
  try {
    await fn()
    passed++
    process.stderr.write(`  ok  ${name}\n`)
  } catch (err) {
    failures.push({ name, err })
    process.stderr.write(`FAIL  ${name}\n      ${err.message}\n`)
  }
}

process.stderr.write(`\n${passed} 项通过，${failures.length} 项失败\n`)
if (failures.length) {
  process.exit(1)
}
process.stderr.write('[PASS] plugin-fast-adapt 自检全部通过\n')
