// hardening.test.mjs —— 2026-11-08 代码审查发现项的回归用例。
//
// 这一节钉的是「同一类问题只修了一处」这个反复出现的失败模式：
//   1. package.json 读取：BOM 只堵了宿主那一侧，插件那一侧十处各写各的
//   2. 缓存根：四个文件各写一遍，只有一处支持注入，自检写真实用户缓存
//   3. 备份：三个自动修补入口三种返回形状
//   4. 发布门禁：.pfa-backup 会被 npm pack 打进包，FORBIDDEN_PACK 不拦
// 每条都断言「整类收口」，不是断言某一个字符串没了。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import { readPackageJson, readPackageJsonStrict, probePackageJson, hasBom } from '../lib/package-json.mjs'
import { cacheRoot, cacheSubdir } from '../lib/cache-root.mjs'
import { NO_BACKUP, backupBeforeWrite, backupStamp, BACKUP_DIR_NAME } from '../lib/backup.mjs'
import { checkPackFiles, FORBIDDEN_PACK } from '../lib/release-rules.mjs'
import { extractAnchors } from '../lib/guide-parser.mjs'

const SCRIPTS = path.resolve(import.meta.dirname, '..')

// ── 1. package.json 唯一真源 ────────────────────────────────────────────────

test('package.json 读取：BOM 在宽松/严格/三态三条路径上都被剥掉', () => {
  const dir = tmpPluginDir('pkg-bom')
  try {
    const body = JSON.stringify({ name: 'bom-plugin', version: '1.2.3' })
    fs.writeFileSync(path.join(dir, 'package.json'), '\uFEFF' + body)

    assert.strictEqual(hasBom(path.join(dir, 'package.json')), true, 'BOM 应被识别为事实')
    assert.strictEqual(readPackageJson(dir)?.version, '1.2.3', '宽松读应剥 BOM')
    assert.strictEqual(readPackageJsonStrict(dir).version, '1.2.3', '严格读应剥 BOM')

    const probe = probePackageJson(dir)
    assert.strictEqual(probe.status, 'ok', '带 BOM 的合法 JSON 应判 ok 而不是 corrupt')
    assert.strictEqual(probe.bom, true, '三态探测应把 BOM 作为事实报出')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('package.json 读取：三态区分「没有」与「坏了」，严格读对坏文件抛错并点明 BOM', () => {
  const missing = tmpPluginDir('pkg-missing')
  try {
    assert.strictEqual(probePackageJson(missing).status, 'missing', '没有 package.json 是 missing 不是 corrupt')
    assert.strictEqual(readPackageJson(missing), null, '宽松读对缺失返回 null')
    assert.throws(() => readPackageJsonStrict(missing), /读不到/, '严格读对缺失应抛错')
  } finally {
    fs.rmSync(missing, { recursive: true, force: true })
  }

  const broken = tmpPluginDir('pkg-broken')
  try {
    fs.writeFileSync(path.join(broken, 'package.json'), '\uFEFF{ not json')
    const probe = probePackageJson(broken)
    assert.strictEqual(probe.status, 'corrupt')
    assert.strictEqual(probe.bom, true)
    assert.throws(() => readPackageJsonStrict(broken), /UTF-8 BOM/, '坏文件且带 BOM 时错误信息要点明 BOM')
  } finally {
    fs.rmSync(broken, { recursive: true, force: true })
  }
})

test('package.json 读取：全仓不再有裸 JSON.parse(fs.readFileSync(...package.json))', () => {
  // 这条是「同型扫」的机器版：新增一处绕过唯一真源的读取就会红。
  const offenders = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'self-test') continue
        walk(p)
      } else if (e.name.endsWith('.mjs')) {
        const text = fs.readFileSync(p, 'utf8')
        // 允许 package-json.mjs 自己实现，其余文件一律走它
        if (path.basename(p) === 'package-json.mjs') continue
        for (const line of text.split('\n')) {
          if (/JSON\.parse\(\s*fs\.readFileSync\([^)]*package\.json/.test(line)) {
            offenders.push(`${path.relative(SCRIPTS, p)}: ${line.trim()}`)
          }
        }
      }
    }
  }
  walk(SCRIPTS)
  assert.deepStrictEqual(offenders, [], `这些位置绕过了 lib/package-json.mjs：\n${offenders.join('\n')}`)
})

// ── 2. 缓存根唯一真源与可注入 ──────────────────────────────────────────────

test('缓存根：DSH_PFA_CACHE_DIR 优先，其次 DSH_CACHE_DIR、XDG_CACHE_HOME，最后 ~/.cache', () => {
  assert.strictEqual(cacheRoot({ DSH_PFA_CACHE_DIR: '/a' }), '/a', 'DSH_PFA_CACHE_DIR 优先级最高')
  assert.strictEqual(cacheRoot({ DSH_PFA_CACHE_DIR: '/a', DSH_CACHE_DIR: '/b' }), '/a')
  assert.strictEqual(cacheRoot({ DSH_CACHE_DIR: '/b' }), '/b', '旧名 DSH_CACHE_DIR 仍兼容')
  assert.strictEqual(cacheRoot({ XDG_CACHE_HOME: '/x' }), path.join('/x', 'dsh-plugin-fast-adapt'))
  assert.ok(cacheRoot({}).endsWith(path.join('.cache', 'dsh-plugin-fast-adapt')), '无覆盖时落 ~/.cache')
  assert.strictEqual(cacheSubdir('signatures', { DSH_PFA_CACHE_DIR: '/a' }), path.join('/a', 'signatures'))
})

test('缓存根：自检进程已把 DSH_PFA_CACHE_DIR 指向临时目录，不写真实用户缓存', () => {
  const root = cacheRoot()
  assert.ok(process.env.DSH_PFA_CACHE_DIR, '自检必须设置 DSH_PFA_CACHE_DIR')
  assert.strictEqual(root, process.env.DSH_PFA_CACHE_DIR, '默认缓存根应等于自检临时根')
  assert.ok(!root.includes(path.join('.cache', 'dsh-plugin-fast-adapt')), `缓存根不该是真实用户缓存：${root}`)
})

// ── 3. 备份形状统一 ────────────────────────────────────────────────────────

test('备份：三个自动修补入口共用同一形状，没改动时返回 NO_BACKUP 而不是 undefined', () => {
  const dir = tmpPluginDir('backup-shape')
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'b', version: '1.0.0' }))

    const res = backupBeforeWrite(dir, ['package.json', 'missing-file.js'])
    assert.ok(res.backupDir.startsWith(dir), 'backupDir 应是绝对路径')
    // backupRel 是报告字符串，统一 posix 分隔符（Windows 上也不出现反斜杠）
    assert.strictEqual(res.backupRel, path.posix.join(BACKUP_DIR_NAME, path.basename(res.backupDir)))
    assert.deepStrictEqual(res.backupFiles, ['package.json'], '不存在的源文件跳过，不报错也不进列表')
    assert.ok(fs.existsSync(path.join(res.backupDir, 'package.json')))

    assert.deepStrictEqual({ ...NO_BACKUP }, { backupDir: '', backupFiles: [], backupRel: '' })
    assert.ok(Object.isFrozen(NO_BACKUP), 'NO_BACKUP 应冻结，防止被就地改写')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('脱敏：home 的 realpath 形态也被替换（macOS /private 前缀不泄漏）', async () => {
  const { sanitizeText } = await import('../lib/runlog.mjs')
  const home = os.homedir()
  let real = home
  try {
    real = fs.realpathSync(home)
  } catch {}
  assert.strictEqual(sanitizeText(`${home}/a/b`), '~/a/b', '字面量 home 应替换为 ~')
  assert.strictEqual(sanitizeText(`${real}/a/b`), '~/a/b', 'realpath 形态也应替换为 ~（顺序按长度降序，否则被切成 /private~）')
})

test('脱敏：homePathForms 覆盖的所有形态都不出现在脱敏输出里（Windows 8.3 短名不泄漏）', async () => {
  const { sanitizeText, homePathForms } = await import('../lib/runlog.mjs')
  const forms = homePathForms()
  assert.ok(forms.length >= 1, `至少应有字面量形态，实际 ${forms.length}`)
  // Windows 上 Temp 常以 8.3 短名出现（RUNNER~1），字面量与 realpath 都是长名；
  // 少了短名形态，脱敏后仍带真实用户名前缀。CI 的 TEMP 正是短名，真机钉住。
  assert.ok(process.platform !== 'win32' || forms.length >= 2, `Windows 应把 8.3 短名形态收进清单，实际 ${forms.length}`)
  const sample = forms.map((f) => path.join(f, 'notes', 'run-1.json')).join('\n')
  const sanitized = sanitizeText(sample)
  for (const form of forms) {
    assert.ok(!sanitized.includes(form), `脱敏后不应包含 home 形态 ${form}`)
  }
  assert.ok(sanitized.split('\n').every((l) => l.startsWith('~')), '每个形态都应替换为 ~ 前缀')
})

test('备份：时间戳目录名不含冒号与点（Windows 非法文件名字符）', () => {
  const stamp = backupStamp(new Date('2026-11-08T10:02:16.123Z'))
  assert.ok(!stamp.includes(':'), `时间戳不该含冒号：${stamp}`)
  assert.ok(!stamp.includes('.'), `时间戳不该含点：${stamp}`)
  assert.strictEqual(stamp, '2026-11-08T10-02-16-123Z')
})

// ── 4. 发布门禁拦 .pfa-backup ──────────────────────────────────────────────

test('发布门禁：.pfa-backup 进 FORBIDDEN_PACK，实测 npm pack 会把它打进包', () => {
  assert.ok(
    FORBIDDEN_PACK.some((re) => re.test('.pfa-backup/2026-11-08T10-00-00-000Z/package.json')),
    'FORBIDDEN_PACK 应拦 .pfa-backup 下的文件',
  )
  const base = [
    'package.json', 'LICENSE', 'SKILL.md', 'README.md', 'README.zh-CN.md', 'README.ja.md',
    'sub-skills/adapt/SKILL.md', 'sub-skills/build/SKILL.md', 'sub-skills/diagnose/SKILL.md',
    'scripts/run.mjs', 'scripts/guide-sync.mjs', 'scripts/release-check.mjs',
    'scripts/lib/release-rules.mjs', 'scripts/lib/scanner.mjs',
  ]
  assert.strictEqual(checkPackFiles(base).status, 'pass', '干净包应通过')
  const dirty = checkPackFiles([...base, '.pfa-backup/2026-11-08T10-00-00-000Z/package.json'])
  assert.strictEqual(dirty.status, 'fail', '带备份目录的包必须判 fail')
  assert.ok(dirty.forbidden?.length, '应列出夹带项')
})

test('发布门禁：工具自身与 scaffold 生成的 .gitignore 都忽略 .pfa-backup', () => {
  const ownPath = path.join(SCRIPTS, '..', '.gitignore')
  // 安装副本不含 .gitignore（files 白名单刻意不带本机物）。缺失时诚实跳过，
  // 不报成「工具自身没忽略」——那是把「包里没这个文件」误报成「门禁失守」。
  if (!fs.existsSync(ownPath)) return { skipped: '安装副本不含 .gitignore（files 白名单刻意不带本机物）' }
  const own = fs.readFileSync(ownPath, 'utf8')
  assert.ok(/^\.pfa-backup\/$/m.test(own), '工具自身 .gitignore 应忽略 .pfa-backup/')

  const scaffoldSrc = fs.readFileSync(path.join(SCRIPTS, 'scaffold.mjs'), 'utf8')
  assert.ok(
    /\.gitignore', 'node_modules\/\\n\.pfa-backup\/\\n'/.test(scaffoldSrc),
    'scaffold 生成的 .gitignore 应同时忽略 node_modules 与 .pfa-backup',
  )
})

test('指南解析：v0.2.2-rc.2 表格子路径移除精确提取且不误伤 /types 迁移目标', () => {
  const change = [
    'Upgrading from v0.2.2-rc.2 removes the seven package subpaths below.',
    '',
    '| Removed subpath | Type import or supported replacement |',
    '|---|---|',
    '| `@deepseek-ai/dsh-commands/brand` | `@deepseek-ai/dsh-commands/types` |',
    '| `@deepseek-ai/dsh-tools/presentation` | Type imports from `@deepseek-ai/dsh-tools` |',
  ].join('\n')
  const migration = '1. Move identifier type imports to `@deepseek-ai/dsh-commands/types`.'
  const a = extractAnchors(change, migration)
  assert.ok(a.packages.includes('@deepseek-ai/dsh-commands/brand'), '应提取子路径 /brand')
  assert.ok(a.packages.includes('@deepseek-ai/dsh-tools/presentation'), '应提取子路径 /presentation')
  assert.ok(!a.packages.includes('@deepseek-ai/dsh-commands/types'), '迁移目标 /types 不应进移除包锚点')
  assert.ok(!a.packages.includes('@deepseek-ai/dsh-tools'), '替换列根包不应进移除包锚点')
})

test('指南解析：v0.2.2-rc.2 Cordis 4.0 成员链不漏报且新符号不误伤 ctx.root', () => {
  const change = [
    '- `ctx.root` no longer exists. The root context is now `ctx[Context.root]`.',
    '- `Service.config` becomes `Service.metadata`.',
    '- `[Service.resolveConfig](base?, head?)` becomes `[Service.resolveIntercept]()`.',
    '- `Config.merge` hooks on services are no longer called.',
  ].join('\n')
  const migration = [
    '1. Replace every `ctx.root` with `ctx[Context.root]`.',
    '2. In service classes, rename `declare [Service.config]` to `declare [Service.metadata]` and calls of `[Service.resolveConfig]()` to `[Service.resolveIntercept]()`.',
    '3. Move a `Config.merge` implementation to a `[Service.mergeIntercept](...values)` method.',
    '4. Run your TypeScript build: references to `ctx.root`, `Service.config` and `Service.resolveConfig` fail to compile.',
  ].join('\n')
  const a = extractAnchors(change, migration)
  for (const sym of ['ctx.root', 'Service.config', 'Service.resolveConfig', 'Config.merge']) {
    assert.ok(a.members.includes(sym), `应保留旧符号 ${sym}: ${JSON.stringify(a.members)}`)
  }
  for (const sym of ['Context.root', 'Service.metadata', 'Service.resolveIntercept', 'Service.mergeIntercept']) {
    assert.ok(!a.members.includes(sym), `新符号 ${sym} 不应留在待报锚点`)
  }
  assert.ok(!a.introduced.includes('the') && !a.introduced.includes('ctx.root'), `introduced 不应含停用词或旧符号: ${JSON.stringify(a.introduced)}`)
})
