// lib/package-json.mjs —— package.json 读取的唯一真源。
//
// 为什么单独成层：全仓有十处 `JSON.parse(fs.readFileSync(...package.json...))`，
// 每处各自决定「读不出来怎么办」，于是同一个残缺输入在不同入口得到三种结局：
// 崩（plugin-audit / quick-smoke / run）、静默降级成 null 继续跑（standards-scan /
// fleet-sweep）、报错退出（codemod）。第三种是对的，前两种都不对——尤其第二种，
// 它把「读不出插件元信息」伪装成「查干净了」。
//
// 上游 #12322 的教训正是这个形状：package.json 带 UTF-8 BOM 时 JSON.parse 失败，
// 异常被吞成 null，级联成「找不到宿主」这种完全不指向根因的症状。剥 BOM 只堵了
// 宿主那一侧，插件那一侧原样留着。收进这里之后，BOM 与解析失败各只有一种处理。

import fs from 'node:fs'
import path from 'node:path'

/** UTF-8 BOM。JSON.parse 不认它，而 Windows 编辑器与部分脚本会写进去。 */
const BOM = '\uFEFF'

/**
 * 读文本并剥掉 UTF-8 BOM。
 * @param {string} file 绝对路径
 * @returns {string}
 */
export function readTextStrippingBom(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

/**
 * 文件是否带 UTF-8 BOM。BOM 本身是事实，值得单独报出来——
 * 它会让宿主启动崩溃循环（上游 #12322），而症状从不指向它。
 * @param {string} file 绝对路径
 * @returns {boolean}
 */
export function hasBom(file) {
  try {
    const buf = fs.readFileSync(file)
    return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  } catch {
    return false
  }
}

/**
 * 宽松读取：任何失败都返回 null。
 * 只用于「读不到就换下一条探测路径」的场景（宿主发现、批量巡检里的可选元信息）。
 * 需要区分「文件不存在」与「文件坏了」的地方不要用它，用 readPackageJsonStrict。
 * @param {string} dir 目录，或直接给 package.json 的路径
 * @returns {object|null}
 */
export function readPackageJson(dir) {
  try {
    return JSON.parse(readTextStrippingBom(resolvePkgPath(dir)))
  } catch {
    return null
  }
}

/**
 * 严格读取：文件不存在或解析失败都抛，错误信息指向具体文件与真实原因。
 * 用于「读不出来就必须停下」的入口——把静默降级换成响亮失败。
 * @param {string} dir 目录，或直接给 package.json 的路径
 * @returns {object}
 */
export function readPackageJsonStrict(dir) {
  const file = resolvePkgPath(dir)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`读不到 ${file}：${err.message}`)
  }
  const stripped = text.replace(/^\uFEFF/, '')
  try {
    return JSON.parse(stripped)
  } catch (err) {
    const bomHint = text.startsWith(BOM) ? '（文件带 UTF-8 BOM，已剥离后仍解析失败）' : ''
    throw new Error(`${file} 不是合法 JSON${bomHint}：${err.message}`)
  }
}

/**
 * 探测结果三态：ok / missing / corrupt。批量巡检要区分「没有 package.json」
 * 与「有但坏了」——前者是正常形态（纯脚本目录），后者是必须报出来的故障。
 * @param {string} dir 目录，或直接给 package.json 的路径
 * @returns {{ status: 'ok'|'missing'|'corrupt', pkg: object|null, file: string, error: string|null, bom: boolean }}
 */
export function probePackageJson(dir) {
  const file = resolvePkgPath(dir)
  if (!fs.existsSync(file)) return { status: 'missing', pkg: null, file, error: null, bom: false }
  const bom = hasBom(file)
  try {
    return { status: 'ok', pkg: JSON.parse(readTextStrippingBom(file)), file, error: null, bom }
  } catch (err) {
    return { status: 'corrupt', pkg: null, file, error: err.message, bom }
  }
}

/** 允许传目录或直接传 package.json 路径，两种调用方都不必自己拼。 */
function resolvePkgPath(dir) {
  return path.basename(dir) === 'package.json' ? dir : path.join(dir, 'package.json')
}
