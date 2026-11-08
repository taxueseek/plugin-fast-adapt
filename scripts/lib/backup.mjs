// lib/backup.mjs —— 写用户文件前的备份，三个自动修补入口共用一份约定。
//
// 为什么单独成层：codemod、fix-peer-deps、fleet-sweep --apply-compat 都会写
// 用户的 package.json（codemod 还写源码），此前各自实现备份，返回形状三种：
//   codemod        → { backupDir: 绝对目录, backedUpFiles: [...] }
//   fix-peer-deps  → { backup: 相对目录 }
//   fleet-sweep    → { backup: 相对文件 }
// 同一约定三个形状，下一个消费方必然要写三套判断；而且 fleet-sweep 的早退分支
// 连 backup 字段都没有，读 appliedPatches.backup 会拿到 undefined 而不是空串。
//
// 统一形状：{ backupDir, backupFiles, backupRel }
//   backupDir  绝对目录（'' 表示没备份）
//   backupFiles 相对插件根的备份文件列表（与 codemod 的 backedUpFiles 同义）
//   backupRel  相对插件根的备份目录（'' 表示没备份），给人看与写进报告用
//
// 备份目录固定为 <插件根>/.pfa-backup/<时间戳>/，且该目录名同时进了
// release-rules 的 FORBIDDEN_PACK 与 scaffold 生成的 .gitignore——备份是本地
// 现场，不该进版本库，也不该被打进 npm 包。

import fs from 'node:fs'
import path from 'node:path'

/** 备份根目录名。改这里要同步 release-rules 的 FORBIDDEN_PACK 与 scaffold 的 .gitignore。 */
export const BACKUP_DIR_NAME = '.pfa-backup'

/** 空备份结果。所有入口的「没改动」分支都返回它，消费方不必判 undefined。 */
export const NO_BACKUP = Object.freeze({ backupDir: '', backupFiles: [], backupRel: '' })

/**
 * 时间戳目录名。冒号与点在 Windows 上是非法文件名字符，全部换成连字符。
 * @param {Date} [now]
 * @returns {string}
 */
export function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * 为一次落盘创建备份目录。
 * @param {string} pluginDir 插件根
 * @param {{ now?: Date }} [opts]
 * @returns {{ backupDir: string, backupRel: string }}
 */
export function createBackupDir(pluginDir, { now = new Date() } = {}) {
  const root = path.resolve(pluginDir)
  // backupRel 进报告给人看：统一 posix 分隔符，Windows 上不出现反斜杠；
  // backupDir 用 path.join 拼，实际落盘仍是原生分隔符。
  const rel = `${BACKUP_DIR_NAME}/${backupStamp(now)}`
  const backupDir = path.join(root, BACKUP_DIR_NAME, backupStamp(now))
  fs.mkdirSync(backupDir, { recursive: true })
  return { backupDir, backupRel: rel }
}

/**
 * 把插件根下的若干相对路径文件备份进 backupDir，保留目录结构。
 * 不存在的源文件跳过（调用方可能只改其中一部分）。
 * @param {string} pluginDir 插件根
 * @param {string} backupDir createBackupDir 的产物
 * @param {string[]} relPaths 相对插件根的路径
 * @returns {string[]} 实际备份的相对路径
 */
export function backupFiles(pluginDir, backupDir, relPaths) {
  const root = path.resolve(pluginDir)
  const done = []
  for (const rel of relPaths) {
    const src = path.join(root, rel)
    if (!fs.existsSync(src)) continue
    const dest = path.join(backupDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    done.push(rel)
  }
  return done
}

/**
 * 一步到位：建目录 + 备份指定文件，返回统一形状。
 * @param {string} pluginDir 插件根
 * @param {string[]} relPaths 要备份的相对路径
 * @param {{ now?: Date }} [opts]
 * @returns {{ backupDir: string, backupFiles: string[], backupRel: string }}
 */
export function backupBeforeWrite(pluginDir, relPaths, { now = new Date() } = {}) {
  const { backupDir, backupRel } = createBackupDir(pluginDir, { now })
  const files = backupFiles(pluginDir, backupDir, relPaths)
  return { backupDir, backupFiles: files, backupRel }
}
