// desktop-app.mjs —— 桌面 APP（DeepSeek Harness.app）的两处一手事实。
//
// 为什么需要它：APP 不用 npm 全局装的宿主，跑的是自己 app.asar 里捆的那份
// （进程实测：.../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host），
// 而且 APP 有自动更新，两份宿主版本迟早错开。错开时 desktop profile 的名册、
// 扫描窗口按 npm 那份算就是错的，所以要单独读出 APP 捆的版本对照。
//
// 第二处是 APP 的日志：主进程 stdout/stderr 接 /dev/null，宿主 stderr 只在内存
// 留 64KB 尾巴，唯一落盘的是致命错误时 Electron 写的崩溃报告：
//   ~/Library/Logs/DeepSeek Harness/crash-<ISO 时间>-<host|web-boot|renderer|main>.log
// 只留最近 10 份。APP 不崩就不落盘，那时也没有要追溯的故障（用户确认）。
// 报告格式取自 app.asar 的 lib/main.js renderCrashReport（0.2.1-rc.3），不是臆造：
//   头部 `key: value` 行 → `--- error ---` → 可选 `--- host diagnostic ... ---`
//   → `--- renderer console (error level, oldest first) ---`。
//
// 只读：asar 只读头部和一个 package.json 的字节段，不解包、不依赖 @electron/asar。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_APP_PATH = '/Applications/DeepSeek Harness.app'
export const DEFAULT_CRASH_DIR = path.join(os.homedir(), 'Library', 'Logs', 'DeepSeek Harness')
export const CRASH_REPORT_NAME = /^crash-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(host|web-boot|renderer|main)\.log$/

// ── asar：读捆绑宿主版本 ────────────────────────────────────────────────────

// asar 布局：16 字节头（[4]=pickle 头长度、[12]=JSON 长度），随后是文件表 JSON，
// 文件数据区从 8 + 头长度 开始，条目 offset 为字符串形式的十进制偏移。
function readAsarFile(asarPath, segments) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    fs.readSync(fd, json, 0, jsonSize, 16)
    let node = JSON.parse(json.toString('utf8'))
    for (const seg of segments) {
      node = node?.files?.[seg]
      if (!node) return null
    }
    if (typeof node.size !== 'number' || node.offset === undefined) return null
    const body = Buffer.alloc(node.size)
    fs.readSync(fd, body, 0, node.size, 8 + headerSize + Number(node.offset))
    return body.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// 返回 null = 本机没装 APP（不是错误）；error 字段 = 装了但读不出，如实报。
export function probeDesktopApp({ appPath = DEFAULT_APP_PATH } = {}) {
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
  if (!fs.existsSync(asarPath)) return null
  try {
    const app = JSON.parse(readAsarFile(asarPath, ['package.json']) ?? 'null')
    const host = JSON.parse(readAsarFile(asarPath, ['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json']) ?? 'null')
    return { appPath, appVersion: app?.version ?? null, hostVersion: host?.version ?? null }
  } catch (err) {
    return { appPath, appVersion: null, hostVersion: null, error: String(err.message || err).slice(0, 200) }
  }
}

// ── 崩溃报告 ────────────────────────────────────────────────────────────────

export function listCrashReports(crashDir = DEFAULT_CRASH_DIR, { limit = 5 } = {}) {
  let names = []
  try {
    names = fs.readdirSync(crashDir)
  } catch {
    return []
  }
  // 文件名按时间可排序（宿主自己的 prune 也按名字排），新的在前
  const files = names.filter((n) => CRASH_REPORT_NAME.test(n)).sort().reverse()
  return (limit ? files.slice(0, limit) : files).map((file) => ({ file, path: path.join(crashDir, file) }))
}

const SECTION_RE = /^--- (error|host diagnostic|renderer console)\b.*---$/

export function parseCrashReport(text, file = null) {
  const sections = { header: [], error: [], 'host diagnostic': [], 'renderer console': [] }
  let current = 'header'
  for (const line of text.split('\n')) {
    const m = line.match(SECTION_RE)
    if (m) {
      current = m[1]
      continue
    }
    sections[current].push(line)
  }
  const meta = {}
  for (const line of sections.header) {
    const m = line.match(/^([a-z][a-z ]*):\s*(.*)$/)
    if (m) meta[m[1].replace(/ /g, '')] = m[2]
  }
  const name = file?.match(CRASH_REPORT_NAME)
  const join = (key) => sections[key].join('\n').trim()
  const consoleText = join('renderer console')
  return {
    file,
    source: meta.source ?? name?.[2] ?? null,
    phase: meta.phase ?? null,
    time: meta.time ?? null,
    app: meta.app ?? null,
    errorText: join('error'),
    hostDiagnostic: sections['host diagnostic'].length ? join('host diagnostic') : null,
    rendererConsole: /^\(no error-level renderer console output/.test(consoleText) ? '' : consoleText,
  }
}
