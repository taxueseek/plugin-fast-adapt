// lib/release-rules.mjs —— 发布预检的纯判定：不碰网络、不碰磁盘，自检直接调。
// 采集（git/npm/pack）留在 scripts/release-check.mjs，规则单独一份才好测。

export const PKG_NAME = 'plugin-fast-adapt'

// 技能读者真正会用的文件；缺一项，装完就是残缺技能
export const REQUIRED_PACK = [
  'package.json',
  'SKILL.md',
  'README.md',
  'README.en.md',
  'LICENSE',
  'sub-skills/adapt/SKILL.md',
  'sub-skills/build/SKILL.md',
  'sub-skills/diagnose/SKILL.md',
  'scripts/run.mjs',
  'scripts/guide-sync.mjs',
  'scripts/release-check.mjs',
  'scripts/lib/release-rules.mjs',
  'scripts/lib/scanner.mjs',
]

// 本机状态、构建残留、发布产物都不该进包
export const FORBIDDEN_PACK = [/^node_modules\//, /^tmp\//, /^\.git\//, /(^|\/)\.env(\.|$)/, /\.tgz$/]

export function tail(text, max = 300) {
  const s = String(text || '').trim()
  return s.length > max ? `…${s.slice(-max)}` : s
}

export function checkVersionSync(packageVersion, manifestVersion) {
  if (!manifestVersion) {
    return { id: 'version', status: 'fail', detail: '缺 .claude-plugin/plugin.json 或其中没有 version' }
  }
  if (packageVersion !== manifestVersion) {
    return { id: 'version', status: 'fail', detail: `package.json ${packageVersion} ≠ plugin.json ${manifestVersion}` }
  }
  return { id: 'version', status: 'pass', detail: `${packageVersion}（package.json 与 plugin.json 一致）` }
}

export function checkPackFiles(files) {
  const present = new Set(files)
  const missing = REQUIRED_PACK.filter((f) => !present.has(f))
  const forbidden = files.filter((f) => FORBIDDEN_PACK.some((re) => re.test(f)))
  if (missing.length) {
    return { id: 'pack', status: 'fail', detail: `包内容缺 ${missing.join('、')}`, missing }
  }
  if (forbidden.length) {
    return { id: 'pack', status: 'fail', detail: `包内容夹带本机物 ${forbidden.slice(0, 5).join('、')}`, forbidden }
  }
  return { id: 'pack', status: 'pass', detail: `${files.length} 个文件，技能面必需项齐` }
}

export function checkTag({ version, localTags = [], remoteTags = null, offline = false }) {
  const tag = `v${version}`
  if (localTags.includes(tag)) return { id: 'tag', status: 'pass', detail: `本地 ${tag} 存在` }
  if (offline) return { id: 'tag', status: 'unknown', detail: `本地没有 ${tag}；--offline 未查远端` }
  if (remoteTags === null) return { id: 'tag', status: 'unknown', detail: `本地没有 ${tag}，远端查询失败` }
  if (remoteTags.includes(tag)) return { id: 'tag', status: 'pass', detail: `远端 ${tag} 存在（本地未打）` }
  return { id: 'tag', status: 'fail', detail: `本地与远端都没有 ${tag}` }
}

export function checkNpm({ version, published = null, latest = null, error = null, offline = false }) {
  if (offline) return { id: 'npm', status: 'skip', detail: '--offline 跳过 npm 查询' }
  if (error) return { id: 'npm', status: 'unknown', detail: `npm 查询失败：${tail(error, 160)}` }
  if (!published) {
    return {
      id: 'npm',
      status: 'fail',
      detail: `${PKG_NAME}@${version} 未发布${latest ? `；npm latest 仍是 ${latest}` : ''}`,
    }
  }
  return { id: 'npm', status: 'pass', detail: `已发布 ${published}${latest && latest !== version ? `；latest 仍是 ${latest}` : ''}` }
}

export function checkWorktree(porcelain) {
  const lines = String(porcelain || '')
    .split('\n')
    .filter(Boolean)
  if (lines.length === 0) return { id: 'worktree', status: 'pass', detail: '工作区干净' }
  return { id: 'worktree', status: 'warn', detail: `工作区有 ${lines.length} 处未提交改动（发布前先提交）` }
}

export function summarize(checks) {
  const count = { pass: 0, fail: 0, skip: 0, unknown: 0, warn: 0 }
  for (const c of checks) count[c.status] = (count[c.status] || 0) + 1
  const verdict = count.fail > 0 ? 'not-ready' : count.unknown > 0 ? 'undetermined' : 'ready'
  return { ...count, verdict }
}
