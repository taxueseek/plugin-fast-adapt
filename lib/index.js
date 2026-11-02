// lib/index.js —— DSH 原生插件入口：提供 Fast-Adapt 审核、诊断与快速适配服务
//
// 本入口让 plugin-fast-adapt 能够以 DSH 原生 Bundle / 插件形式直接挂载进宿主环境
// （通过 cordis.patch.yml 自动加载），提供：
//   1. 原生 Cordis 架构服务（ctx.fastAdapt）
//   2. Agent 审查与体检工具（dsh_fast_adapt_audit / dsh_fast_adapt_scan 等）
//   3. 斜杠命令交互（/fast-adapt, /fast-audit）
// 保持 0 外部依赖与纯 ESM 架构。

import { auditPlugin } from '../scripts/plugin-audit.mjs'
import { probeEnvironment } from '../scripts/env-doctor.mjs'
import { discoverPlugins } from '../scripts/fleet-sweep.mjs'
import { runQuickSmoke } from '../scripts/quick-smoke.mjs'

export const name = 'plugin-fast-adapt'
export const inject = ['tools', 'command']

export const Config = {
  type: 'object',
  properties: {
    defaultTarget: { type: 'string', description: '默认目标宿主版本' },
    autoHealDryRun: { type: 'boolean', default: true },
  },
}

export function apply(ctx, config = {}) {
  // 1. 注册核心 fastAdapt 服务
  const service = {
    audit: (pluginDir, opts) => auditPlugin(pluginDir, opts),
    doctor: (pluginDir, opts) => probeEnvironment(pluginDir, opts),
    smoke: (pluginDir) => runQuickSmoke(pluginDir),
    fleet: (profile, opts) => discoverPlugins(profile, opts),
  }

  if (typeof ctx.provide === 'function') {
    ctx.provide('fastAdapt', service)
  }

  // 2. 注册 DSH Agent 工具
  if (ctx.tools?.register) {
    ctx.tools.register({
      name: 'dsh_fast_adapt_audit',
      description: '审查指定 DSH 插件的防御性架构、生命周期泄漏与宿主兼容性，输出 P0/P1 阻断项与紧凑报告',
      parameters: {
        type: 'object',
        properties: {
          pluginDir: { type: 'string', description: '插件绝对路径，缺省为当前工作区' },
          targetVersion: { type: 'string', description: '目标宿主版本' },
        },
      },
      execute: async ({ pluginDir, targetVersion }) => {
        const target = pluginDir || process.cwd()
        const report = auditPlugin(target, { targetVersion })
        return {
          plugin: report.plugin,
          overallScore: report.overallScore,
          scores: report.scores,
          priorityCounts: report.priorityCounts,
          blockers: report.findings.filter((f) => f.priority === 'P0' || f.priority === 'P1'),
        }
      },
    })
  }

  // 3. 注册命令交互入口
  if (typeof ctx.command === 'function') {
    ctx.command('fast-adapt [target]', '运行快速适配与环境诊断')
      .action(async ({ session }, target) => {
        const dir = target || process.cwd()
        const audit = auditPlugin(dir)
        return `[Fast-Adapt] 插件: ${audit.plugin} | 得分: ${audit.overallScore}/100 (P0阻断: ${audit.priorityCounts.P0}, P1风险: ${audit.priorityCounts.P1})`
      })

    ctx.command('fast-audit [target]', '审查插件防御性架构与生命周期')
      .action(async ({ session }, target) => {
        const dir = target || process.cwd()
        const audit = auditPlugin(dir)
        const blockers = audit.findings.filter((f) => f.priority === 'P0' || f.priority === 'P1')
        if (blockers.length === 0) {
          return `[Fast-Audit] ${audit.plugin} 架构审核通过 (得分: ${audit.overallScore})，无 P0/P1 阻断项`
        }
        return `[Fast-Audit] ${audit.plugin} 发现 ${blockers.length} 个阻断项:\n` +
          blockers.map((b) => `• [${b.priority}] ${b.title} (${b.file})`).join('\n')
      })
  }
}
