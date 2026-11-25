#!/usr/bin/env node
// npm 入口（npx plugin-fast-adapt）：提供 doctor / fleet / check / new 四个直觉子命令，
// 并保持向后兼容（直接传 <插件目录> 时转发到 run.mjs）。
// skill 本体（SKILL.md、sub-skills/、scripts/、references/）随包分发，装好后把包
// 目录作为 skill 目录接入你的 agent 即可。

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainEntry } from './lib/main-entry.mjs'
import { readPackageJson } from './lib/package-json.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export const SUBCOMMANDS = Object.freeze({
  doctor: 'env-doctor.mjs',
  fleet: 'fleet-sweep.mjs',
  check: 'run.mjs',
  new: 'scaffold.mjs',
})

export function resolveCliCommand(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { action: 'help' }
  }
  const [first, ...rest] = args
  if (first === '--help' || first === '-h' || first === 'help') {
    return { action: 'help' }
  }
  if (first === '--version' || first === '-v') {
    return { action: 'version' }
  }
  if (Object.hasOwn(SUBCOMMANDS, first)) {
    return { action: 'run', script: SUBCOMMANDS[first], args: rest }
  }
  // 向后兼容：npx plugin-fast-adapt <插件目录> [--real-smoke | --offline | ...]
  return { action: 'run', script: 'run.mjs', args }
}

export function formatHelp(version) {
  return `plugin-fast-adapt v${version}

用法：
  plugin-fast-adapt doctor [选项]              整机环境体检（版本/残留包/幽灵进程/假绿）
  plugin-fast-adapt fleet [选项]               一键扫描整机所有已装插件与工作区，输出健康看板
  plugin-fast-adapt check <插件目录> [选项]    单插件全链路（环境→定版→指南→扫描→体检→冒烟）
  plugin-fast-adapt new <ns>/<name> [选项]     一条命令生成五形态可运行插件并验证
  plugin-fast-adapt <插件目录> [选项]          check 的兼容简写（直接转发到 run.mjs）

示例：
  npx plugin-fast-adapt doctor --brief
  npx plugin-fast-adapt fleet --running
  npx plugin-fast-adapt check ./my-plugin --real-smoke
  npx plugin-fast-adapt new acme/hello --form tool

选项：
  -h, --help      显示帮助
  -v, --version   显示版本号

skill 本体（SKILL.md、sub-skills/、scripts/、references/）就在本包目录，
把包目录作为 skill 目录接入你的 agent 即可。`
}

if (isMainEntry(import.meta.url)) {
  const pkg = readPackageJson(path.join(here, '..'))
  const resolved = resolveCliCommand(process.argv.slice(2))

  if (resolved.action === 'help') {
    console.log(formatHelp(pkg.version))
    process.exit(0)
  }
  if (resolved.action === 'version') {
    console.log(`plugin-fast-adapt v${pkg.version}`)
    process.exit(0)
  }

  const result = spawnSync(process.execPath, [path.join(here, resolved.script), ...resolved.args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  process.exit(result.status ?? 1)
}
