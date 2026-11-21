// lib/guide-parser.mjs
// 解析 DeepSeek 官方 upgrade-guide，抽出「符号锚点」。
//
// 权威来源是官方仓库 docs/upgrade-guide/<version>/<topic>/guide.md，
// 格式固定为：
//   ---
//   kind: upgrade-guide
//   description: "..."
//   ---
//   # 标题
//   ## Change      —— 破坏性变更描述
//   ## Migration   —— 编号步骤，含「旧符号 → 新符号」
//
// 我们只抽三类锚点：包名、成员/方法、字符串常量（错误码等）。
// 抽不出来没关系，扫描器退化成「无命中」，不会伪造规则。

import fs from 'node:fs'
import path from 'node:path'
import { scanSource, compareVersions } from './scanner.mjs'

export function parseGuideMarkdown(text) {
  const frontmatter = {}
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (m) frontmatter[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }

  const sections = {}
  const normalized = text.replace(/\x1b\]8;[^\x07]*\x07/g, '').replace(/\r/g, '')
  for (const name of ['Change', 'Migration']) {
    const re = new RegExp(`##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n---\\s*$|$)`, 'i')
    const m = normalized.match(re)
    sections[name.toLowerCase()] = m ? m[1].trim() : ''
  }

  const titleMatch = normalized.match(/^#\s+(.+)$/m)

  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    description: frontmatter.description || '',
    change: sections.change,
    migration: sections.migration,
  }
}

// 太通用的名字不能当锚点：register / resolve / readFile 这类词在几乎任何插件里都会出现，
// 拿它们匹配只会制造噪音。宁可不报，也不要报错。
// 实测：session-digger 插件扫出 12 个命中，逐一核对后 12 个全是这类误报。
const GENERIC_MEMBERS = new Set([
  'register', 'unregister', 'tools', 'config', 'session', 'options', 'logger', 'apply',
  'exports', 'imports', 'default', 'params', 'result', 'results', 'context', 'service',
  'provider', 'manager', 'handler', 'schema', 'client', 'server', 'plugin', 'plugins',
  'this', 'super', 'value', 'values', 'target', 'source', 'request', 'response',
  'error', 'errors', 'message', 'messages', 'event', 'events', 'state', 'states',
  'resolve', 'reject', 'readFile', 'writeFile', 'existsSync', 'stringify', 'parse',
  'initialize', 'configure', 'validate', 'normalize', 'serialize', 'deserialize',
  'toString', 'valueOf', 'displayName', 'getInstance', 'setTimeout', 'setInterval',
])

// 带点锚点看末段，裸名看整体：裸名没有对象约束，更容易撞名，所以门槛更高。
const MIN_MEMBER_LEN = 6
const MIN_BARE_LEN = 8
// 宿主/Cordis 强命名空间前缀：有对象约束时允许更短末段（如 ctx.root）与通用末段（如 Service.config）。
const STRONG_OBJECT_PREFIXES = new Set(['ctx', 'Service', 'Config', 'Context', 'Cordis'])
const PKG_PATH_RE = /@deepseek-ai\/[a-z0-9][\w-]*(?:\/[a-z0-9][\w.-]*)*/g

// 尾点半角点剥离（2026-11-21 实测漏报复盘）：子路径段 [\w.-]* 会把紧跟的句号
// 一起吃进捕获（`@deepseek-ai/dsh/commands.` 句尾），拿带点形式去比插件源码的
// import 必然落空——官方指南句尾紧跟句号是常态。捕获后统一剥尾点再入锚点。
const stripTrailingDots = (pkg) => pkg.replace(/\.+$/, '')

// 延续句判据（2026-11-21 实测误报复盘）：Change 段常顺带写「X keeps its form /
// unchanged」划定不动的边界。全量抽取把这些没坏的符号也变成待报锚点，插件里的
// 本地同名函数（store 的 subscribe）与无关子系统的同名方法（composer shell 的
// getSnapshot）全被报成 high。判据只收「正向延续」表述——「no compatibility
// alias」是破坏面表述，绝不能进这张表。
const CONTINUITY_RE =
  /\b(?:keeps?\s+(?:its|their)\s+(?:form|shape|names?|behavior|semantics|codes?)|unchanged|remains?\s+(?:valid|intact|writable|the\s+same)|(?:is|are)\s+preserved|still\s+(?:works?|functions?|compiles?))\b/i

// 子句切分：逗号接转折连词（或分号）是语义翻转点——「keeps its form, but … fails」
// 前半延续、后半破坏，整句一刀切会把破坏面符号一起丢掉（丢召回）。
const BREAK_CLAUSE_SPLIT_RE = /,\s+(?:but|however|though|although|whereas)\b\s*|;\s+/i

// 把 Change 段切成「非延续子句」的拼接文本：延续子句整体剔除，
// 其余子句（含转折子句的破坏面）保留。成员链与裸调用只从这里抽。
function nonContinuityText(changeText) {
  const keep = []
  for (const sentence of changeText.split(/(?<=[.!?])\s+|\n+/)) {
    for (const clause of sentence.split(BREAK_CLAUSE_SPLIT_RE)) {
      const t = clause.trim()
      if (t && !CONTINUITY_RE.test(t)) keep.push(t)
    }
  }
  return keep.join('\n')
}

// 从 Change 段的 Markdown 表格提取被移除的包/子路径：
// 仅当表头第一列明确标明 Removed/Deprecated/Retired/Old 时，取数据行第一列的 @deepseek-ai/* 路径。
function extractTableRemovedPackages(changeText) {
  const removed = []
  const lines = changeText.split('\n')
  let inRemovedTable = false
  let sawSeparator = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.startsWith('|')) {
      inRemovedTable = false
      sawSeparator = false
      continue
    }
    const cols = line.split('|').slice(1, -1).map((c) => c.trim())
    if (!cols.length) continue
    if (!inRemovedTable) {
      if (/\b(removed|deprecated|retired|old)\b/i.test(cols[0])) {
        inRemovedTable = true
        sawSeparator = false
      }
      continue
    }
    if (!sawSeparator) {
      if (/^:?-{3,}:?$/.test(cols[0])) sawSeparator = true
      else inRemovedTable = false
      continue
    }
    for (const m of cols[0].matchAll(PKG_PATH_RE)) {
      removed.push(stripTrailingDots(m[0]))
    }
  }
  return removed
}

// 从 guide 正文抽锚点。包名用精确匹配，成员名用词边界。
//
// 三条降噪规则，都是实测误报复盘得来的：
//   1. 常量锚点只从 Change 段抽。Migration 里的连字符字符串往往是示例值
//      （mode: 'read-only'、max-tokens），拿它们匹配会大面积误报。
//   2. 识别「旧 → 新」替换对，新符号不再报命中。
//      插件用了新符号说明已经适配过，报了只是噪音。
//   3. 成员/裸调用锚点只从 Change 段的非延续子句抽（2026-11-21 实测回归）。
//      Migration 段写的是迁移目标与新写法——ctx.slots.inject、ctx.sessions.create
//      这类「应该用」的符号被抽成待报锚点，会把已适配的插件报成 high；
//      Change 段的延续句（keeps its form / unchanged）里的是没坏的符号，
//      报了同样只是噪音。破坏面若只在 Migration 出现，由替换对旧符号补锚兜底。
export function extractAnchors(changeText, migrationText) {
  const blob = `${changeText}\n${migrationText}`
  const anchors = { packages: new Set(), members: new Set(), codes: new Set() }

  // 语义门（2026-10-24 实测误报复盘）：包名只有与「移除/改名」动词同句才进 package 锚点。
  // Change 段大量提及包名只是语境引用——tool-presentation-mode 的
  // 「The mode fields of @deepseek-ai/dsh-tools accept only native or ptc」讲的是字段取值，
  // 包没被移除；无差别抽取会把所有 import 该包的插件误报成 critical。
  const REMOVAL_RE =
    /\b(removed|remove|retired|renamed|deleted|dropped|no longer|replaced by|moved to|exported by|update imports|migrated|migrate|deprecated|discontinue|split into)\b/i
  const sentenceHasRemoval = (text, pkg) => {
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      if (sentence.includes(pkg) && REMOVAL_RE.test(sentence)) return true
    }
    return false
  }
  for (const m of blob.matchAll(PKG_PATH_RE)) {
    const pkg = stripTrailingDots(m[0])
    if (sentenceHasRemoval(changeText, pkg) || sentenceHasRemoval(migrationText, pkg)) {
      anchors.packages.add(pkg)
    }
  }
  for (const pkg of extractTableRemovedPackages(changeText)) {
    anchors.packages.add(pkg)
  }

  // 完整点链优先：抽 ctx.tools.presentAs 而不是 ctx.tools + tools.presentAs。
  // 短链会被长链覆盖，避免「ctx.tools」这种过于通用的锚点。
  // 抽取源只认 Change 段的非延续子句（见上面规则 3）。
  const memberSource = nonContinuityText(changeText)
  const chains = new Set()
  for (const m of memberSource.matchAll(/\b([A-Za-z][\w$]*(?:\.[A-Za-z_][\w$]*)+)\b/g)) {
    chains.add(m[1])
  }
  // 裸调用：foo(
  for (const m of memberSource.matchAll(/\b([a-z][\w]+)\s*\(/g)) {
    chains.add(m[1])
  }

  // 替换对：新符号进 introduced，扫描时跳过；旧符号补进待报锚点——
  // 有的指南 Change 段对旧符号只写行为变化不点名，破坏面只出现在
  // Migration 的「Replace X with Y / X instead of Y」里，Change-only 抽取
  // 会漏掉 X，这里兜住召回。补锚发生在下面的统一过滤之前。
  const introduced = new Set()
  for (const [oldRaw, newRaw] of findReplacements(migrationText)) {
    const oldSym = normalizeSymbol(oldRaw)
    const newSyms = expandBracketSymbols(newRaw)
    for (const s of newSyms) {
      if (s) introduced.add(s)
    }
    if (oldSym && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(oldSym)) {
      chains.add(oldSym)
    }
    if (oldSym) introduced.delete(oldSym)
  }

  for (const chain of chains) {
    const parts = chain.split('.')
    const last = parts[parts.length - 1]
    const isBare = parts.length === 1
    const hasStrongPrefix = !isBare && STRONG_OBJECT_PREFIXES.has(parts[0])
    if (isBare && last.length < MIN_BARE_LEN) continue
    if (!isBare && last.length < (hasStrongPrefix ? 4 : MIN_MEMBER_LEN)) continue
    if (GENERIC_MEMBERS.has(chain)) continue
    if (!hasStrongPrefix && GENERIC_MEMBERS.has(last)) continue
    anchors.members.add(chain)
  }

  // 常量锚点：只从 Change 段抽（见上面规则 1），且与成员同源——只取非延续子句，
  // 「every ATTACHMENT_* code are unchanged」这类延续句里的码不再进待报锚点。
  // 1. kebab-case 格式 (like 'already-installed')
  for (const m of memberSource.matchAll(/['"`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)['"`]/g)) {
    anchors.codes.add(m[1])
  }
  // 2. SCREAMING_SNAKE 错误码/状态码 (like 'ABORTED', 'CODE_RUN_FAILED')
  for (const m of memberSource.matchAll(/['"`]([A-Z][A-Z0-9_]{3,39})['"`]/g)) {
    anchors.codes.add(m[1])
  }
  for (const m of memberSource.matchAll(/\b(?:as|than|code)\s+([A-Z][A-Z0-9_]{3,30})\b/g)) {
    anchors.codes.add(m[1])
  }

  // 两条过滤，返回的 members 就是「待报」清单：
  //   1. 父链被更长的链涵盖（ctx.tools 被 ctx.tools.presentAs 涵盖）
  //   2. 迁移目标不算问题（插件用了新符号说明已适配）
  const members = [...anchors.members].sort()
  const introducedSet = new Set(introduced)
  const filtered = members
    .filter((m) => !members.some((other) => other !== m && other.startsWith(`${m}.`)))
    .filter((m) => !isIntroducedSymbol(introducedSet, m))

  return {
    packages: [...anchors.packages].sort(),
    members: filtered,
    codes: [...anchors.codes].sort(),
    introduced: [...introduced].sort(),
  }
}

// 识别 Migration 里的「旧 → 新」写法。
// 两条路都走：完整替换对（拿旧符号），以及 with/using/by 之后的符号（拿新符号）。
// 后面这条更宽松，因为真实 guide 常写成
//   Replace A or B with C.
// 用严格配对会漏掉 C。
function findReplacements(migrationText) {
  const pairs = []
  const symPat = `\\[?(?:declare\\s+)?(?:[a-zA-Z_][\\w$]*\\.)*[a-zA-Z_][\\w$]*(?:\\[[a-zA-Z_][\\w$.]*\\]|(?:\\.[a-zA-Z_][\\w$]*)*)\\]?(?:\\([^)]*\\))?`
  // 第一条：Replace A (or B / or C)* with D——旧侧整段捕获后按 or 拆，
  // 每个 or 同伴都是被替换的旧符号（重复上限定 4，防嵌套量词回溯爆炸）。
  const strictPatterns = [
    new RegExp(`\\b(?:[Rr]eplace|[Rr]ename)\\s+(?:every\\s+|the\\s+)?((?:\`?(?:declare\\s+)?${symPat}\`?\\s+or\\s+){0,3}\`?(?:declare\\s+)?${symPat}\`?)\\s+(?:with|by|using|to)\\s+\`?(?:declare\\s+)?(\\[?[a-zA-Z_][\\w$]*(?:\\.[a-zA-Z_][\\w$]*)*(?:\\[[a-zA-Z_][\\w$.]*\\])?\\]?(?:\\([^)]*\\))?)\`?`, 'g'),
    /\`?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*(?:\([^)]*\))?)\`?\s*(?:→|->|becomes?|is\s+renamed\s+to|now\s+becomes)\s+\`?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*(?:\([^)]*\))?)/g,
    // 「X instead of Y」：X 是被弃用的旧符号、Y 是迁移目标（2026-11-21 补，
    // 真实指南 Migration 常写 Call create() instead of open()）。
    new RegExp(`\`?(${symPat})\`?\\s+instead\\s+of\\s+\`?(${symPat})\`?`, 'g'),
  ]
  for (const re of strictPatterns) {
    for (const m of migrationText.matchAll(re)) {
      if (!m[1] || !m[2] || m[1] === m[2]) continue
      if (re === strictPatterns[0]) {
        for (const oldRaw of m[1].split(/\s+or\s+/i)) pairs.push([oldRaw, m[2]])
      } else if (re === strictPatterns[2]) {
        // 「X instead of Y」：X 是新写法（in Y 的位置），Y 才是被弃用的旧符号，方向与字面相反。
        pairs.push([m[2], m[1]])
      } else {
        pairs.push([m[1], m[2]])
      }
    }
  }

  // 宽松：with/using/by/into 后面的符号一律视为新符号，随后的「and Y」同伴
  // 也是新符号。实测教训（白描插件，v0.2.0-rc.2 指南）："Move … into
  // meta.title and meta.description" 的 meta.description 是迁移目标，
  // 只抓 into 后第一个符号会漏掉 and 同伴，把新写法当待报锚点误报 high。
  // 不带反引号的纯小写单词（如 with the / by declaring）属于自然语言，不收。
  const LOOSE_NEW =
    /\b(?:with|using|by|into)\s+(`?\[?[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*(?:\[[a-zA-Z_][\\w$.]*\])?\]?(?:\([^)]*\))?`?)(?:\s+and\s+(`?\[?[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*(?:\[[a-zA-Z_][\\w$.]*\])?\]?(?:\([^)]*\))?`?))?/g
  const isCodeToken = (raw) => raw.startsWith('`') || /[A-Z_.\[\]]/.test(raw)
  for (const m of migrationText.matchAll(LOOSE_NEW)) {
    if (m[1] && isCodeToken(m[1])) pairs.push([null, m[1]])
    if (m[2] && isCodeToken(m[2])) pairs.push([null, m[2]])
  }

  // 带反引号的迁移目标：`to \`[Service.resolveIntercept]()\``（排除 `references to \`old\``）或 `use \`symbols.decorator\``
  for (const m of migrationText.matchAll(/(?<!\breferences\s)\b(?:to(?:\s+a|\s+an)?|use)\s+`(\[?[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*(?:\[[a-zA-Z_][\w$.]*\])?\]?(?:\([^)]*\))?)`/g)) {
    pairs.push([null, m[1]])
  }

  return pairs
}

function isIntroducedSymbol(introducedSet, anchor) {
  if (!introducedSet.size) return false
  if (introducedSet.has(anchor)) return true
  const parts = anchor.split('.')
  const last = parts[parts.length - 1]
  const obj = parts.slice(0, -1).join('.')
  for (const sym of introducedSet) {
    if (!sym.includes('.')) {
      if (sym === last && !STRONG_OBJECT_PREFIXES.has(parts[0])) return true
      continue
    }
    const sParts = sym.split('.')
    if (sParts[sParts.length - 1] !== last) continue
    const sObj = sParts.slice(0, -1).join('.')
    if (obj === sObj || obj.endsWith(`.${sObj}`) || sObj.endsWith(`.${obj}`)) return true
  }
  return false
}

// 去掉参数列表和包裹符号，只留符号名：installBundle(spec) → installBundle
function normalizeSymbol(raw) {
  if (!raw) return ''
  return String(raw)
    .replace(/[`'"]/g, '')
    .replace(/^declare\s+/, '')
    .replace(/\s*\(.*$/, '')
    .replace(/^\[|\]$/g, '')
    .trim()
}

// 展开方括号计算属性：ctx[Context.root] → ['ctx', 'Context.root']，[Service.metadata] → ['Service.metadata']
function expandBracketSymbols(raw) {
  if (!raw) return []
  const cleaned = String(raw).replace(/[`'"]/g, '').replace(/^declare\s+/, '').replace(/\s*\(.*$/, '').trim()
  const bracket = cleaned.match(/^([a-zA-Z_][\w$.]*)\[([a-zA-Z_][\w$.]*)\]$/)
  if (bracket) return [bracket[1], bracket[2]]
  return [cleaned.replace(/^\[|\]$/g, '').trim()]
}

// 从 GitHub Release 文本中抽取出虚拟指南条目
export function parseReleaseNotesToGuides(releaseText, version) {
  if (!releaseText) return []
  const guides = []

  // 优先匹配英文 Breaking Changes / Other Changes 区块（中英双语 Release Note 下避免中英各扫一遍双倍重复，
  // 且英文区块保留了完整的 API 符号与错误码原名）；若无英文区块则匹配中文 破坏性变更 / 其他变更。
  const reEn = /###\s+(?:Breaking Changes|Other Changes)\s*([\s\S]*?)(?=\n###\s|\n---\s*$|$)/i
  const reZh = /###\s+(?:破坏性变更|其他变更)\s*([\s\S]*?)(?=\n###\s|\n---\s*$|$)/i
  const m = releaseText.match(reEn) || releaseText.match(reZh)
  const body = m ? m[1] : releaseText

  // 按 bullet 切分
  const bullets = body
    .split(/\n(?=[•*-]\s+)/)
    .map((b) => b.replace(/^[•*-]\s+/, '').trim())
    .filter(Boolean)

  let idx = 1
  const seenAnchorKeys = new Set()
  for (const item of bullets) {
    const anchors = extractAnchors(item, item)
    if (!anchors.packages.length && !anchors.members.length && !anchors.codes.length) continue
    const key = `${anchors.packages.join(',')}|${anchors.members.join(',')}|${anchors.codes.join(',')}`
    if (seenAnchorKeys.has(key)) continue
    seenAnchorKeys.add(key)

    const firstSentence = item.split(/[。\n.!?]/)[0] || `Change ${idx}`
    const topic = `release-${version}-${idx}`
    guides.push({
      version,
      topic,
      guideFile: `releases/${version}.json#${idx}`,
      titleLine: idx,
      title: firstSentence.slice(0, 80),
      description: item,
      change: item,
      migration: item,
      anchors,
      virtual: true,
    })
    idx++
  }
  return guides
}

// 查找与当前 guideRoot 配套的 releases 虚拟指南目录
function resolveReleasesDir(guideRoot, explicitDir = null) {
  if (explicitDir) return explicitDir
  if (!guideRoot) return null
  // 1. 同级或上级 releases 目录
  const candidates = [
    path.join(guideRoot, 'releases'),
    path.resolve(guideRoot, '..', 'releases'),
    path.resolve(guideRoot, '..', '..', 'releases'),
    path.resolve(guideRoot, '..', '..', '..', 'releases'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

// 读一个版本目录下的全部 guide，返回带版本与主题的锚点表
export function loadGuides(guideRoot, version, { releasesDir = null } = {}) {
  const versionDir = path.join(guideRoot, version)
  if (fs.existsSync(versionDir)) {
    const guides = []
    for (const topic of fs.readdirSync(versionDir)) {
      const guidePath = path.join(versionDir, topic, 'guide.md')
      if (!fs.existsSync(guidePath)) continue

      const raw = fs.readFileSync(guidePath, 'utf8')
      const parsed = parseGuideMarkdown(raw)
      const anchors = extractAnchors(parsed.change, parsed.migration)
      if (!anchors.packages.length && !anchors.members.length && !anchors.codes.length) continue

      // 出处锚点：指南内相对路径 + 标题行号。findings 带上它们，
      // 每个结论都能回溯到官方原文位置，不用在指南目录里再搜标题。
      let titleLine = null
      for (const [i, line] of raw.split('\n').entries()) {
        if (/^#\s+/.test(line.replace(/\r$/, ''))) {
          titleLine = i + 1
          break
        }
      }

      guides.push({ version, topic, guideFile: `${version}/${topic}/guide.md`, titleLine, ...parsed, anchors })
    }
    return guides
  }

  // 降级：从 releases 缓存读取虚拟指南（只在匹配的缓存根下查找，不污染沙箱）
  const relRoot = resolveReleasesDir(guideRoot, releasesDir)
  if (relRoot && fs.existsSync(relRoot)) {
    const bareVer = version.replace(/^v/, '')
    const relFile = path.join(relRoot, `${bareVer}.json`)
    if (fs.existsSync(relFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(relFile, 'utf8'))
        const text = data.body || data.text || ''
        return parseReleaseNotesToGuides(text, version)
      } catch {}
    }
  }

  return []
}

// 官方指南目录下的全部版本，按 semver 升序。
// 目录名带 v 前缀（v0.2.1-alpha.2），比较时剥掉。
// 排序复用 scanner 的 compareVersions：这里曾自带一份字典序实现，
// rc.10 会排到 rc.9 前面，两处必须同源。
export function listGuideVersions(guideRoot, { releasesDir = null } = {}) {
  const versions = new Set()
  const bare = (name) => name.replace(/^v/, '')

  if (fs.existsSync(guideRoot)) {
    const entries = fs
      .readdirSync(guideRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => /^v?\d+\.\d+\.\d+/.test(name))
      // 空目录不算「覆盖到了这一版」。上游会先建版本目录再逐步补条目，
      // 2026-11-05 实测 v0.2.2-rc.1 目录存在但零条目：按目录名算覆盖度会让
      // 账本报 complete=true（「已覆盖到 0.2.2-rc.1」），而那一版根本没看过。
      // 判据取「目录下至少有一个含 guide.md 的主题目录」，与 loadGuides 的口径一致。
      .filter((name) => {
        const dir = path.join(guideRoot, name)
        try {
          return fs
            .readdirSync(dir, { withFileTypes: true })
            .some((t) => t.isDirectory() && fs.existsSync(path.join(dir, t.name, 'guide.md')))
        } catch {
          return false
        }
      })
    for (const e of entries) versions.add(e)
  }

  // 并入配套 releases 缓存里的虚拟版本
  const relRoot = resolveReleasesDir(guideRoot, releasesDir)
  if (relRoot && fs.existsSync(relRoot)) {
    try {
      const files = fs.readdirSync(relRoot)
      for (const f of files) {
        if (f.endsWith('.json')) {
          const v = f.slice(0, -5)
          if (/^\d+\.\d+\.\d+/.test(v)) versions.add(`v${v}`)
        }
      }
    } catch {}
  }

  return [...versions].sort((a, b) => compareVersions(bare(a), bare(b)))
}

// 供自检使用：确认解析器不会把注释里的同名词当成锚点
export function parserSelfCheck() {
  const sample = `---\nkind: upgrade-guide\ndescription: "test"\n---\n# T\n\n## Change\n\nUse \`@deepseek-ai/dsh-settings\` and call installBundle(spec).\n\n## Migration\n\n1. Replace installBundle(spec) with removeBundle(name) then installBundle(spec).\n2. Handle error.code 'already-installed'.\n`
  const parsed = parseGuideMarkdown(sample)
  const anchors = extractAnchors(parsed.change, parsed.migration)
  return { parsed, anchors, scan: scanSource(sample) }
}
