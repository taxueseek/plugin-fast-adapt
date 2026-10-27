// 桌面 APP 与运行期诊断——从 self-test.mjs 拆出的一节。
//
// 覆盖四件事：APP 捆绑宿主版本读取（asar 头解析）、APP 崩溃报告解析、
// 宿主未激活条目的逐条抽取（含抢锁细分）、desktop 专用宿主包不进 web 名册。
// fixture 形状取自 app.asar lib/main.js renderCrashReport 与 dsh-app-boot
// activationDiagnostic（0.2.1-rc.3），不是臆造。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import { probeDesktopApp, listCrashReports, parseCrashReport } from '../lib/desktop-app.mjs'
import { parseInactiveEntries, diagnoseLogs } from '../log-doctor.mjs'
import { profileOnlyPackages, collectRoster } from '../lib/client-graph.mjs'

// 造一个最小 asar：16 字节头 + 文件表 JSON + 数据区
function writeAsar(file, entries) {
  const files = {}
  const bodies = []
  let offset = 0
  for (const [rel, content] of Object.entries(entries)) {
    const buf = Buffer.from(content)
    const segs = rel.split('/')
    let node = files
    for (const seg of segs.slice(0, -1)) {
      node[seg] ??= { files: {} }
      node = node[seg].files
    }
    node[segs.at(-1)] = { size: buf.length, offset: String(offset) }
    bodies.push(buf)
    offset += buf.length
  }
  const json = Buffer.from(JSON.stringify({ files }))
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(json.length + 8, 4)
  head.writeUInt32LE(json.length + 4, 8)
  head.writeUInt32LE(json.length, 12)
  fs.writeFileSync(file, Buffer.concat([head, json, ...bodies]))
}

test('probeDesktopApp：从 asar 头读出 APP 与捆绑宿主版本，没装 APP 返回 null', () => {
  const app = tmpPluginDir('desktop-app')
  const res = path.join(app, 'Contents', 'Resources')
  fs.mkdirSync(res, { recursive: true })
  writeAsar(path.join(res, 'app.asar'), {
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5' }),
    'dsh/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ version: '0.2.1-rc.5' }),
  })
  const r = probeDesktopApp({ appPath: app })
  assert.strictEqual(r.appVersion, '0.2.1-rc.5')
  assert.strictEqual(r.hostVersion, '0.2.1-rc.5')
  assert.strictEqual(probeDesktopApp({ appPath: path.join(app, 'nope') }), null, '没装 APP 不是错误')
})

const CRASH = `time: 2026-10-27T12:00:00.000Z
source: host
phase: startup
app: DeepSeek Harness 0.2.1-rc.3
platform: darwin arm64
electron: 40.0.0
node: 24.0.0
locale: zh-CN
shell pid: 4242

--- error ---
DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate

--- host diagnostic (as reported by the Host process) ---
StartupError: dsh: startup failed: 1 required plugin did not activate

  Failed plugins (1):
    webserver (required)
      Package: @deepseek-ai/dsh-host-webserver
      Error: listen EADDRINUSE: address already in use 127.0.0.1:3080

--- renderer console (error level, oldest first) ---
entry @x/dsh-foo did not load: cannot inject @deepseek-ai/dsh-client-ui-slots
`

test('崩溃报告：头部、宿主诊断、渲染进程报错三段都解析，失败插件与信号进 log-doctor', () => {
  const p = parseCrashReport(CRASH, 'crash-2026-10-27T12-00-00-000Z-host.log')
  assert.strictEqual(p.source, 'host')
  assert.strictEqual(p.phase, 'startup')
  assert.ok(p.hostDiagnostic.startsWith('StartupError'), '宿主诊断段应单独抽出')
  assert.ok(p.rendererConsole.includes('dsh-client-ui-slots'), '渲染进程报错是客户端半问题的主证据')

  const crashDir = tmpPluginDir('crash')
  const logsDir = tmpPluginDir('crash-logs')
  fs.writeFileSync(path.join(crashDir, 'crash-2026-10-27T12-00-00-000Z-host.log'), CRASH)
  fs.writeFileSync(path.join(crashDir, 'crash-2026-10-26T12-00-00-000Z-renderer.log'), CRASH.replace('source: host', 'source: renderer'))
  fs.writeFileSync(path.join(crashDir, 'not-a-crash.log'), 'x')
  assert.deepStrictEqual(listCrashReports(crashDir).map((r) => r.file), [
    'crash-2026-10-27T12-00-00-000Z-host.log',
    'crash-2026-10-26T12-00-00-000Z-renderer.log',
  ], '只认宿主命名规则的文件，新的在前')

  const report = diagnoseLogs({ logsDir, crashDir })
  assert.strictEqual(report.crashReports.length, 2)
  assert.strictEqual(report.verdict, 'host-failure', '有崩溃报告就是致命错误')
  const host = report.crashReports[0]
  assert.strictEqual(host.failedPlugins[0]?.package, '@deepseek-ai/dsh-host-webserver', '宿主诊断段复用 startup 解析抽失败插件')
  assert.ok(host.signals.some((s) => s.id === 'port-in-use'))
})

test('崩溃报告：渲染进程无报错时 rendererConsole 为空，无崩溃目录不报错', () => {
  const p = parseCrashReport(CRASH.replace(/--- renderer console[\s\S]*$/, '--- renderer console (error level, oldest first) ---\n(no error-level renderer console output was captured)\n'))
  assert.strictEqual(p.rendererConsole, '')
  assert.deepStrictEqual(listCrashReports(path.join(tmpPluginDir('crash-none'), 'missing')), [])
})

// dsh-web.log 实录形状（2026-10-27）：警告行 + 条目行 + 堆栈，之后是下一次启动的输出
const INACTIVE = `[dsh-files] attachment loop routes registered
dsh: warning: 2 entries did not activate
web-ui-task-board (@linxin666/dsh-client-ui-task-board): Error: task-board ledger is already owned by process 71813
    at HostTaskLedger.acquireLock (file:///x/lib/index.js:5631:12)
    at file:///x/#include
dsh-foo (dsh-foo): pending (waiting for service: webServer)
dsh web: http://127.0.0.1:3080/?token=x
`

test('未激活条目逐条抽取，抢锁单独成信号，不再一律指向客户端名册', () => {
  const entries = parseInactiveEntries(INACTIVE)
  assert.deepStrictEqual(entries.map((e) => e.id), ['web-ui-task-board', 'dsh-foo'], '跳过堆栈行，按声明条数收住')
  assert.strictEqual(entries[0].package, '@linxin666/dsh-client-ui-task-board')
  assert.ok(entries[1].error.startsWith('pending'), 'pending 条目也要抽出')

  const logsDir = tmpPluginDir('inactive-logs')
  fs.writeFileSync(path.join(logsDir, 'dsh-web.log'), INACTIVE)
  const report = diagnoseLogs({ logsDir, crashDir: path.join(logsDir, 'no-crash') })
  assert.strictEqual(report.runs[0].inactiveEntries.length, 2)
  const ids = report.signalSummary.map((s) => s.id)
  assert.ok(ids.includes('resource-locked'), `抢锁应单独成信号: ${ids}`)
  assert.ok(ids.includes('entry-not-activate'))
})

test('desktop 专用宿主包不进 web 名册，其余 profile 照常；判不了的 !!js 不排除', () => {
  const root = tmpPluginDir('roster-only')
  const scoped = path.join(root, '@deepseek-ai')
  const mk = (name, dsh) => {
    fs.mkdirSync(path.join(scoped, name), { recursive: true })
    fs.writeFileSync(path.join(scoped, name, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, dsh }))
  }
  const client = { client: { platform: 'web', inject: [] } }
  mk('dsh-client-ui-sidebar-browser', client)
  mk('dsh-client-ui-chat', client)
  mk('dsh-client-ui-odd', client)
  mk('dsh-web-app', { bundle: { patch: './cordis.patch.yml' } })
  fs.writeFileSync(path.join(scoped, 'dsh-web-app', 'cordis.patch.yml'), `- insert:
    - id: ui-sidebar-browser
      name: '@deepseek-ai/dsh-client-ui-sidebar-browser'
      disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"

    - id: ui-chat
      name: '@deepseek-ai/dsh-client-ui-chat'

    - id: ui-odd
      name: '@deepseek-ai/dsh-client-ui-odd'
      disabled: !!js "process.env.X === '1'"
`)
  assert.deepStrictEqual([...profileOnlyPackages([path.join(scoped, 'dsh-web-app')])], [['@deepseek-ai/dsh-client-ui-sidebar-browser', 'desktop']])
  const profiles = tmpPluginDir('roster-profiles')
  const rosterOf = (name) => {
    fs.mkdirSync(path.join(profiles, name), { recursive: true })
    return collectRoster({ hostRoots: [root], profileDir: path.join(profiles, name) }).roster
  }
  const web = rosterOf('web')
  const desktop = rosterOf('desktop')
  assert.ok(!web.has('@deepseek-ai/dsh-client-ui-sidebar-browser'), 'desktop 专用包不该算 web 的提供方')
  assert.ok(desktop.has('@deepseek-ai/dsh-client-ui-sidebar-browser'))
  assert.ok(web.has('@deepseek-ai/dsh-client-ui-chat'), '无条件的行两端都有')
  assert.ok(web.has('@deepseek-ai/dsh-client-ui-odd'), '判不了的 !!js 按两端都有处理，不猜')
})
