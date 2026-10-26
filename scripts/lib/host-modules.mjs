#!/usr/bin/env node
// host-modules.mjs —— 解析本机已装 DSH 宿主的基类模块，并做「真基类装载验证」。
//
// 为什么需要它：scaffold 的 service / config / llm-adapter 三形态要 import 宿主的
// @deepseek-ai/* 基类（cordis 的 Service、schemastery 的 Schema、dsh-llm 的
// LlmAdapter）。quick-smoke 用纯内存 Mock 验契约形状，验不到「基类 API 用对没对」
// （super(ctx, name) 写错、Schema 导成了普通对象、adapter 没继承 LlmAdapter）。
// 本机装了宿主时，把真实基类软链进临时 node_modules 再 import 插件入口，补上这一半。
//
// 诚实边界：本机没装宿主时返回 available:false，不伪造通过；装了也只证「能装载、
// 契约成立」，不证业务能力——那要真宿主冷启动（run.mjs --real-smoke）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { findGlobalDsh } from '../env-doctor.mjs'

// 脚手架生成的插件会 import 这些包；缺哪个就少验哪一形态
const HOST_MODULES = [
  ['cordis', '@deepseek-ai/cordis'],
  ['schemastery', '@deepseek-ai/schemastery'],
  ['dshLlm', '@deepseek-ai/dsh-llm'],
]

export function resolveHostModules() {
  const host = findGlobalDsh()
  if (!host || !host.location) return null
  const modules = {}
  for (const [key, pkg] of HOST_MODULES) {
    const dir = path.join(host.location, 'node_modules', ...pkg.split('/'))
    if (fs.existsSync(path.join(dir, 'package.json'))) modules[key] = { pkg, dir }
  }
  if (!Object.keys(modules).length) return null
  return { version: host.version, location: host.location, modules }
}

function packageEntry(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const exp = pkg.exports?.['.']
  const rel = typeof exp === 'string' ? exp : exp?.default ?? exp?.import ?? pkg.module ?? pkg.main
  return rel ? path.join(dir, rel) : null
}

function copyTree(src, dest, skip = new Set(['node_modules'])) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(s, d, skip)
    else if (entry.isSymbolicLink()) continue
    else fs.copyFileSync(s, d)
  }
}

// 按形态核对导出的契约。返回 [名称, 是否通过, 细节]
const CHECKS = {
  tool: (mod) => [
    ['导出 name', typeof mod.name === 'string' && mod.name.length > 0],
    ['声明 inject: tools', Array.isArray(mod.inject) && mod.inject.includes('tools')],
    ['apply 是函数', typeof mod.apply === 'function'],
  ],
  hook: (mod) => [
    ['导出 name', typeof mod.name === 'string' && mod.name.length > 0],
    ['apply 是函数', typeof mod.apply === 'function'],
  ],
  service: (mod, { Service }) => {
    const out = [['默认导出是类', typeof mod.default === 'function']]
    if (typeof mod.default !== 'function') return out
    out.push(['继承宿主 Service', mod.default.prototype instanceof Service])
    try {
      const provided = []
      const inst = new mod.default({ reflect: { provide: (n) => provided.push(n) } })
      out.push(['可实例化并注册服务名', typeof inst.name === 'string' && provided.includes(inst.name)])
    } catch (err) {
      out.push([`实例化失败：${err.message}`, false])
    }
    return out
  },
  config: (mod) => {
    const out = [['导出 Config', typeof mod.Config === 'function']]
    try {
      const parsed = mod.Config({})
      out.push(['Config 能校验并填默认值', parsed !== null && typeof parsed === 'object'])
    } catch (err) {
      out.push([`Config 校验失败：${err.message}`, false])
    }
    out.push(['apply 是函数', typeof mod.apply === 'function'])
    return out
  },
  'llm-adapter': (mod, { LlmAdapter }) => {
    const out = [
      ['导出 name', typeof mod.name === 'string' && mod.name.length > 0],
      ['声明 inject: llm', Array.isArray(mod.inject) && mod.inject.includes('llm')],
      ['apply 是函数', typeof mod.apply === 'function'],
    ]
    const registered = []
    const ctx = {
      llm: {
        registerAdapter: (routes, adapter) => {
          registered.push({ routes, adapter })
          return { dispose() {}, replace() {} }
        },
      },
    }
    try {
      mod.apply(ctx, typeof mod.Config === 'function' ? mod.Config({}) : {})
      out.push(['apply 注册了 adapter', registered.length === 1])
      if (registered.length) {
        out.push(['adapter 继承宿主 LlmAdapter', registered[0].adapter instanceof LlmAdapter])
        out.push(['注册了 provider 路由', Array.isArray(registered[0].routes) && registered[0].routes.length > 0])
      }
    } catch (err) {
      out.push([`apply 执行失败：${err.message}`, false])
    }
    return out
  },
}

export async function verifyWithHostModules({ pluginDir, entryFile, form }) {
  const host = resolveHostModules()
  if (!host) return { available: false, reason: '本机未装 DSH 宿主（findGlobalDsh 为空）' }

  const check = CHECKS[form]
  if (!check) return { available: false, reason: `形态 ${form} 无真基类验证` }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfa-host-verify-'))
  try {
    // 软链宿主基类进临时 node_modules；Windows 用 junction（无需管理员权限）
    const nm = path.join(tmp, 'node_modules', '@deepseek-ai')
    fs.mkdirSync(nm, { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    for (const { dir } of Object.values(host.modules)) {
      fs.symlinkSync(dir, path.join(nm, path.basename(dir)), linkType)
    }

    copyTree(pluginDir, tmp)

    const entryAbs = path.join(tmp, entryFile)
    if (!fs.existsSync(entryAbs)) {
      return { available: true, hostVersion: host.version, success: false, checks: [], error: `入口不存在：${entryFile}` }
    }

    let mod
    try {
      mod = await import(`${pathToFileURL(entryAbs).href}?t=${Date.now()}`)
    } catch (err) {
      return { available: true, hostVersion: host.version, success: false, checks: [], error: `入口装载失败：${err.message}` }
    }

    const bases = {}
    if (host.modules.cordis) bases.Service = (await import(pathToFileURL(packageEntry(host.modules.cordis.dir)).href)).Service
    if (host.modules.dshLlm) bases.LlmAdapter = (await import(pathToFileURL(packageEntry(host.modules.dshLlm.dir)).href)).LlmAdapter

    const checks = check(mod, bases).map(([name, ok, detail]) => ({ name, ok, detail: detail ?? null }))
    return {
      available: true,
      hostVersion: host.version,
      checks,
      success: checks.every((c) => c.ok),
      error: checks.find((c) => !c.ok)?.detail ?? null,
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
