// lib/codemod.mjs —— 代码级与包面确定性自动修补引擎（Codemod）。
//
// 为什么需要 Codemod：
// 扫描器只负责「报红」，但对已确定有唯一安全解的问题（如入口四件套旁混用的 export default、
// 宿主核心包 peer 依赖错位、多余的值导出），让开发者手动翻文件改代码既费时又容易引入二次笔误。
//
// 设计原则（第一性原理与奥卡姆剃刀）：
// 1. 纯函数计划：只根据代码和规则计算变换计划，不触碰磁盘。
// 2. 格式与注释保留：只针对目标语句做局部切片替换，绝不全量格式化，未变动行的字符与换行 100% 原样保留。
// 3. 失败方向可控：只做数学上具备单射确定性的变换；凡需意图裁量的改动坚决不自动做。
// 4. 先备份后落盘：落盘前必先将原文件备份至 <插件目录>/.pfa-backup/<时间戳>/。

import fs from 'node:fs'
import path from 'node:path'
import { prepareLexicalView } from './scanner.mjs'
import { FUNC_PLUGIN_EXPORTS, collectEntryExports } from './standards.mjs'
import { planPeerFix } from './peer-fix.mjs'
import { NO_BACKUP, backupBeforeWrite } from './backup.mjs'

export const CODEMOD_RULES = [
  {
    id: 'loader-entry-shape',
    title: '修复 Loader 入口导出面（移除非法 export default 或收回多余导出）',
    severity: 'HIGH',
    safety: 'SAFE',
    description: '入口具名四件套旁若混用 export default 会导致 Loader 丢失命名空间；多余值导出应收为模块私有。',
  },
  {
    id: 'top-level-await',
    title: '封装模块顶层 await',
    severity: 'MEDIUM',
    safety: 'SAFE',
    description: '将顶层缩进为 0 的 await 语句封装入异步立即执行函数或生命周期，避免阻塞模块同步求值。',
  },
  {
    id: 'peer-deps',
    title: '包面宿主核心包迁移至 peerDependencies',
    severity: 'HIGH',
    safety: 'SAFE',
    description: '把 dependencies 里的 cordis / schemastery / @deepseek-ai/dsh 挪进 peerDependencies，防止多实例污染。',
  },
]

/**
 * 为单个入口文件修补 Loader 导出面。
 * @param {string} source 源码
 * @returns {{ source: string, transforms: Array<object> }}
 */
export function fixLoaderEntryShape(source) {
  const { code, mask, lineOf } = prepareLexicalView(source)
  const collected = collectEntryExports(code, mask, lineOf)
  const exportNames = collected.values.map((v) => v.name)
  const hasFunc = FUNC_PLUGIN_EXPORTS.every((n) => exportNames.includes(n))
  if (!hasFunc) return { source, transforms: [] }

  const transforms = []
  let next = source

  // 1. 若同时有 export default，安全移除或降级为内部声明
  if (collected.hasDefault) {
    // 匹配 export default class/function/const/let/var 或 export default <expr>
    const lines = next.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      // 具名 class / function: export default class Foo -> class Foo
      if (/^[ \t]*export\s+default\s+(class|function\*?)\s+([A-Za-z_$][\w$]*)/.test(line)) {
        const newLine = line.replace(/^[ \t]*export\s+default\s+/, '')
        transforms.push({
          rule: 'loader-entry-shape',
          line: i + 1,
          description: '将 export default class/function 转换为内部声明，保留类/函数定义并消除 Loader 命名空间覆盖',
          before: line,
          after: newLine,
        })
        lines[i] = newLine
      } else if (/^[ \t]*export\s+default\b/.test(line)) {
        // 表达式或对象导出: export default apply -> // [codemod] export default apply
        const newLine = `// [codemod:loader-entry-shape] 移除与四件套冲突的默认导出: ${line.trim()}`
        transforms.push({
          rule: 'loader-entry-shape',
          line: i + 1,
          description: '移除四件套旁的 export default 导出，防止 Loader 丢弃具名命名空间',
          before: line,
          after: newLine,
        })
        lines[i] = newLine
      }
    }
    next = lines.join('\n')
  }

  // 2. 检查多余的值导出（非四件套的 export const/let/var/function/class）
  const extraValues = collected.values.filter((v) => !FUNC_PLUGIN_EXPORTS.includes(v.name))
  if (extraValues.length > 0) {
    const lines = next.split('\n')
    for (const v of extraValues) {
      const lineIdx = v.line - 1
      if (lineIdx >= 0 && lineIdx < lines.length) {
        const line = lines[lineIdx]
        if (new RegExp(`^[ \\t]*export\\s+(?:async\\s+)?(?:const|let|var|function\\*?|class)\\s+${v.name}\\b`).test(line)) {
          const newLine = line.replace(/^([ \t]*)export\s+/, '$1')
          transforms.push({
            rule: 'loader-entry-shape',
            line: v.line,
            description: `将多余的值导出「${v.name}」收回为模块内部私有声明`,
            before: line,
            after: newLine,
          })
          lines[lineIdx] = newLine
        }
      }
    }
    next = lines.join('\n')
  }

  return { source: next, transforms }
}

/**
 * 为源码修补顶层 await。
 * @param {string} source 源码
 * @returns {{ source: string, transforms: Array<object> }}
 */
export function fixTopLevelAwait(source) {
  const lines = source.split('\n')
  const transforms = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^(await\s|for\s+await\s|await\s+using\s)/.test(line)) {
      const newLine = `// [codemod:top-level-await] 顶层 await 封装:\nvoid (async () => {\n  ${line}\n})()`
      transforms.push({
        rule: 'top-level-await',
        line: i + 1,
        description: '将缩进为 0 的顶层 await 封装进立即执行异步函数，避免模块求值时同步阻塞',
        before: line,
        after: newLine,
      })
      lines[i] = newLine
    }
  }
  return { source: lines.join('\n'), transforms }
}

/**
 * 生成全套 Codemod 修补计划（纯函数，零磁盘写）。
 * @param {string} pluginDir 插件目录
 * @param {object} [options]
 * @returns {{ transforms: Array<object>, moves: Array<object>, files: Record<string, string>, hasChanges: boolean }}
 */
export function planCodemods(pluginDir, { files = null, pkg = null, rules = null } = {}) {
  const activeRules = rules ? new Set(rules) : new Set(CODEMOD_RULES.map((r) => r.id))
  const allTransforms = []
  const filesToWrite = {}

  // 1. 包面修补（peer-deps）
  let peerMoves = []
  if (activeRules.has('peer-deps') && pkg) {
    const peerPlan = planPeerFix(pkg)
    if (peerPlan.moves && peerPlan.moves.length > 0) {
      peerMoves = peerPlan.moves
      filesToWrite['package.json'] = peerPlan.files['package.json']
    }
  }

  // 2. 代码级修补
  if (files && files.length > 0) {
    // 寻找入口文件
    let entryRel = null
    for (const cand of ['lib/index.js', 'lib/index.mjs', 'src/index.ts', 'src/index.tsx', 'index.js']) {
      if (files.some((f) => f.file === cand)) { entryRel = cand; break }
    }

    for (const { file, source } of files) {
      let currentSource = source
      const fileTransforms = []

      // loader-entry-shape (只对入口)
      if (activeRules.has('loader-entry-shape') && entryRel && file === entryRel) {
        const res = fixLoaderEntryShape(currentSource)
        if (res.transforms.length > 0) {
          fileTransforms.push(...res.transforms.map((t) => ({ ...t, file })))
          currentSource = res.source
        }
      }

      // top-level-await
      if (activeRules.has('top-level-await')) {
        const res = fixTopLevelAwait(currentSource)
        if (res.transforms.length > 0) {
          fileTransforms.push(...res.transforms.map((t) => ({ ...t, file })))
          currentSource = res.source
        }
      }

      if (fileTransforms.length > 0) {
        allTransforms.push(...fileTransforms)
        filesToWrite[file] = currentSource
      }
    }
  }

  const hasChanges = allTransforms.length > 0 || peerMoves.length > 0
  return {
    transforms: allTransforms,
    moves: peerMoves,
    files: filesToWrite,
    hasChanges,
  }
}

/**
 * 将修补计划落盘，并生成备份。
 * 备份形状与 fix-peer-deps、fleet-sweep --apply-compat 统一走 lib/backup.mjs：
 * { backupDir, backupFiles, backupRel }，没改动时返回 NO_BACKUP（不是 undefined）。
 * @param {string} pluginDir 插件根
 * @param {object} plan planCodemods 的产物
 * @returns {{ backupDir: string, backupFiles: string[], backupRel: string, writtenFiles: string[] }}
 */
export function applyCodemodPlan(pluginDir, plan) {
  if (!plan.hasChanges || Object.keys(plan.files).length === 0) {
    return { ...NO_BACKUP, writtenFiles: [] }
  }

  const relPaths = Object.keys(plan.files)
  const backup = backupBeforeWrite(pluginDir, relPaths)
  const writtenFiles = []

  for (const [relPath, newContent] of Object.entries(plan.files)) {
    const absPath = path.join(pluginDir, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, newContent, 'utf8')
    writtenFiles.push(relPath)
  }

  return { ...backup, writtenFiles }
}
