#!/usr/bin/env node
// scaffold.mjs —— 第 0 步（可选）：从零造出可运行的插件，一条命令生成并验证。
//
// 输入 coordinate（namespace/name）+ 形态（tool/hook/service/config/llm-adapter），
// 生成五件套：package.json、lib/index.js、cordis.patch.yml、dsh-plugin.naming.json、
// README。命名投影按上游 plugin-write 的 collision-resistant 规则全量推导，
// 不让 agent 手工抄 manifest。
//
// 模板依据（不得凭记忆改写契约）：
//   - 形态契约：上游 plugin-write skill 五份 form reference（tool/hook/service/
//     config/llm-adapter-plugin.md），五份模板都是能跑通的完整实现（不是 TODO
//     骨架），完整规则仍以原文为准
//   - 命名投影：上游 naming-conventions.md 的 community coordinate 表
//   - 挂载层形状：对拍本机真实插件（argo-dsh / plainspoken-writing-dsh 的
//     cordis.patch.yml，均为 `- insert:` + `- id:` + `name:` 条目）
//   - 免构建路线：外部插件不带构建链（对拍 argo-dsh：纯 JS、零依赖、main 直指
//     源文件）
//
// 验证分两层，缺一层就报一层：
//   - quick-smoke（tool/hook）：零依赖内存 Mock，验契约形状与工具注册
//   - 真基类装载（五形态全跑）：本机装了宿主时，用真实 @deepseek-ai/* 基类
//     import 入口，验基类 API 用对没对（Service 继承与 super(ctx, name)、
//     Schema 真校验、LlmAdapter 继承与路由注册）。见 lib/host-modules.mjs
//
// 诚实边界：
//   - 本机没装宿主时真基类装载跳过（available:false），不伪造通过；装包后可跑
//     quick-smoke 补验
//   - 生成物保证「能装载、契约成立、能力可跑」；业务能力仍是起点实现，换成你的
//     能力即可。naming 的完整语义校验（碰撞推荐、registry 查询）仍走上游
//     plugin-write 的 validate-names / query-registry 两个脚本

import fs from 'node:fs'
import path from 'node:path'
import { printJson } from './lib/scanner.mjs'
import { parsePatchEntries, candidateGlobalRoots } from './env-doctor.mjs'
import { runQuickSmoke } from './quick-smoke.mjs'
import { verifyWithHostModules } from './lib/host-modules.mjs'

const FORMS = ['tool', 'hook', 'service', 'config', 'llm-adapter']

// 零依赖可自动冒烟的形态；其余依赖宿主 @deepseek-ai/* 基类，缺包时 import 必炸
const SMOKEABLE_FORMS = new Set(['tool', 'hook'])

// kebab 语法（namespace 与插件名同一条官方惯例；settings/command 正则在
// naming-conventions 里更宽，但收在这里能保证全部投影天然合法）
const KEBAB_RE = /^[a-z]([a-z0-9]*(-[a-z0-9]+)*)?$/

// ── 命名投影（collision-resistant profile）─────────────────────────────────

export function projectNames(namespace, name) {
  const base = `${namespace}-${name}`
  const camel = base
    .split('-')
    .map((seg, i) => (i === 0 ? seg : seg[0].toUpperCase() + seg.slice(1)))
    .join('')
  const pascal = camel[0].toUpperCase() + camel.slice(1)
  return {
    coordinate: `${namespace}/${name}`,
    packageName: `@${namespace}/dsh-${name}`,
    pluginNames: [name],
    loaderIds: [base],
    services: [`${camel}Index`],
    tools: [`${base.replace(/-/g, '_')}_query`],
    commands: [base],
    skills: [base],
    skillProviders: [`${base}-filesystem`],
    events: [`${base}/ready`],
    settingsNamespaces: [base],
    routes: [{ kind: 'exact', path: `/api/plugins/${base}/query` }],
    // 内部引用用
    base, camel, pascal,
  }
}

function validateCoordinate(coordinate) {
  const slash = coordinate.indexOf('/')
  if (slash === -1 || slash !== coordinate.lastIndexOf('/')) {
    throw new UsageError(`coordinate 必须是 <namespace>/<name> 形式（如 taxueseek/my-tool），实得「${coordinate}」`)
  }
  const namespace = coordinate.slice(0, slash)
  const name = coordinate.slice(slash + 1)
  if (!KEBAB_RE.test(namespace)) {
    throw new UsageError(`namespace 须为小写 kebab（${KEBAB_RE.source}），实得「${namespace}」`)
  }
  if (!KEBAB_RE.test(name)) {
    throw new UsageError(`name 须为小写 kebab（${KEBAB_RE.source}），实得「${name}」`)
  }
  return { namespace, name }
}

export class UsageError extends Error {}

// ── 宿主版本探测（显式参数 > 全局安装 > null）───────────────────────────────

export function detectHarnessVersion({ env = process.env, platform = process.platform } = {}) {
  for (const root of candidateGlobalRoots({ env, platform })) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
      if (pkg?.version) return pkg.version
    } catch {}
  }
  return null
}

// ── 插件模板 ────────────────────────────────────────────────────────────────

function packageJsonTemplate(names, form, harnessVersion) {
  const formSentence = {
    tool: '模型可调用工具插件（raw JSON Schema 注册，registry 原生支持）',
    hook: '钩子插件（在 tools/pre-execute 等扩展点拦截，waterfall 语义）',
    service: '服务插件（向其他插件通过 ctx 提供能力）',
    config: '配置插件（cordis.yml 提供用户配置，Schemastery 校验）',
    'llm-adapter': 'LLM adapter 插件（接入新模型 provider，协议义务多，见 README）',
  }[form]
  const pkg = {
    name: names.packageName,
    version: '0.1.0',
    description: `DSH ${formSentence}。由 dsh-plugin-fast-adapt scaffold 生成（针对 dsh-v${harnessVersion || 'unknown'}）`,
    license: 'MIT',
    type: 'module',
    main: './lib/index.js',
    exports: {
      '.': './lib/index.js',
      './package.json': './package.json',
    },
    files: ['lib', 'cordis.patch.yml'],
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
    },
    engines: { node: '>=18' },
    keywords: ['deepseek-harness', 'dsh', 'cordis', form],
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

function namingManifestTemplate(names) {
  const manifest = {
    schemaVersion: 1,
    policy: 'dsh-plugin-naming/v1',
    plugin: {
      namespace: names.coordinate.split('/')[0],
      name: names.pluginNames[0],
      coordinate: names.coordinate,
      packageName: names.packageName,
    },
    names: {
      pluginNames: names.pluginNames,
      loaderIds: names.loaderIds,
      services: names.services,
      tools: names.tools,
      commands: names.commands,
      skills: names.skills,
      skillProviders: names.skillProviders,
      events: names.events,
      settingsNamespaces: names.settingsNamespaces,
      routes: names.routes,
    },
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

function patchYmlTemplate(names) {
  return `# ${names.coordinate} 挂载层（bundle patch）。
#
# 宿主组合时按这里把插件插进会话；没有本条目，装了也不会生效（env-doctor
# 的 activation 检查看的就是 patch 层有没有提及插件）。同 id + 同 name 的
# 条目在用户层 cordis.patch.yml 里是替换语义，可用于覆盖配置。装进 profile
# 后重启宿主生效。
#
# config 里的字段由插件入口的 Config Schema 校验；Loader 元数据（id/name/
# disabled/inject 等）必须保持字面量，不要用 !!js 表达式（disabled 用 !!js
# 会恒为真值，插件永远被禁用）。

- insert:
    - id: ${names.loaderIds[0]}
      name: '${names.packageName}'
`
}

function entryTemplate(form, names) {
  if (form === 'tool') {
    return `// 零依赖可运行工具插件：raw JSON Schema 注册（registry 原生支持这条路）。
// execute 里是能跑通的最小能力——换成你的能力即可，其余结构照留。
// 要类型增强（defineTool 自动校验参数并推导 execute 类型）时，装
// @deepseek-ai/dsh-tools 后按上游 plugin-write skill 的 tool-plugin.md 迁移。
// 完整契约（execute 的九条义务、输出投影、UI 卡片、Code Mode）见该文档。

export const name = '${names.pluginNames[0]}'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: '${names.tools[0]}',
    description: '把传入的文本原样回显。用来验证「插件装载 → 工具注册 → 模型调用」整条链路是否通。',
    parameters: {
      text: { type: 'string', required: true, description: '要回显的文本' },
    },
    async execute(args, exec) {
      // exec.signal 中止时尽快返回；抛错即 isError。
      return { text: args.text }
    },
  })
}
`
  }
  if (form === 'hook') {
    return `// 零依赖可运行钩子插件：在 tools/pre-execute 扩展点拦截工具调用。
// waterfall 语义（重点）：监听器收到 (...args, next)。不调 next() 就是
// 短路整条链——只做观察的监听器必须调 next() 把决定权交回去，静默接管
// 是这个形态最危险的坑。完整扩展点表与规则见上游 plugin-write 的 hook-plugin.md。

export const name = '${names.pluginNames[0]}'

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    // 观察式钩子：记一条日志就放行。换成你的策略——
    // 返回 { kind: 'deny', reason } 拒绝；{ kind: 'ask', ... } 走 ctx.approval 征求批准。
    ctx.logger.info('${names.pluginNames[0]}: 拦截到工具调用 %s', exec.name ?? '(未命名)')
    return next()
  })
}
`
  }
  if (form === 'service') {
    return `// 可运行服务插件：class 形态向其他插件通过 ctx 提供能力。
// 依赖宿主提供的 @deepseek-ai/cordis（Service 基类），本机装了 DSH 宿主或
// 在插件目录 npm install 后才能 import。加载期强依赖缺失时插件静默 pending
// 不报错（Cordis 的已知陷阱，env-doctor 的 activation 段查这个）。
// 消费者声明 inject: ['${names.camel}Index']，即可用 ctx.${names.camel}Index 访问。
// 完整契约（声明合并、typed events、HMR、capability seam 拆包判据）见
// 上游 plugin-write 的 service-plugin.md。

import { Service } from '@deepseek-ai/cordis'

export default class ${names.pascal}Service extends Service {
  static inject = []

  constructor(ctx) {
    super(ctx, '${names.camel}Index')
  }

  /**
   * 示例方法：去掉首尾空白。换成你的能力即可。
   * @param {string} text
   * @returns {string}
   */
  format(text) {
    return String(text ?? '').trim()
  }
}
`
  }
  if (form === 'config') {
    return `// 可运行配置插件：cordis.yml 的 config 行提供用户配置。
// 依赖宿主提供的 @deepseek-ai/schemastery。必须导出 Schemastery Schema，
// 不能导出普通对象（Cordis 走 Standard Schema 接口校验，普通对象会在
// 加载期失败）。无效配置必须在加载期显式报错，不许静默吞。
// 完整规则（!!js 边界、凭据不入配置、HMR）见上游 plugin-write 的 config-plugin.md。

import Schema from '@deepseek-ai/schemastery'

export const name = '${names.pluginNames[0]}'

export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
})

export function apply(ctx, config) {
  // config 已过 Schema 校验并填好默认值。
  // 可调参数一律走 Config，不许在代码里写死部署值。
  ctx.logger.info('${names.pluginNames[0]}: greeting = %s', config.greeting)
}
`
  }
  // llm-adapter —— 五形态里协议义务最重的（streaming 闭联集、usage 先于
  // finish、tool-call 参数原样透传、两条错误路径、attribution 头、空闲超时
  // 上限……）。本实现覆盖主路径与最常见的错误路径，能直接对着 OpenAI 兼容
  // 端点跑通；完整清单见上游 plugin-write 的 llm-adapter-plugin.md。
  return `// 可运行 LLM adapter：接入一个 OpenAI 兼容端点。
// 依赖宿主提供的 @deepseek-ai/dsh-llm（LlmAdapter / LlmError / attributionHeaders）
// 与 @deepseek-ai/schemastery（Config Schema）。
// 协议义务很多，完整清单见上游 plugin-write 的 llm-adapter-plugin.md。

import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'

export const name = '${names.pluginNames[0]}'
export const inject = ['llm']

export const Config = Schema.object({
  apiKey: Schema.string().role('secret'),
  baseUrl: Schema.string().default('https://api.openai.com/v1'),
  model: Schema.string().default('gpt-4o-mini'),
})

export class ${names.pascal}Adapter extends LlmAdapter {
  constructor(options) {
    super()
    this.options = options
  }

  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  async *stream(options) {
    const baseUrl = String(this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\\/+$/, '')
    let res
    try {
      res = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + String(this.options.apiKey ?? ''),
          ...attributionHeaders(),
        },
        body: JSON.stringify({
          model: options.model ?? this.options.model,
          messages: options.messages,
          stream: true,
        }),
        signal: options.signal,
      })
    } catch (err) {
      if (options.signal?.aborted) throw new LlmError('请求已中止', 'ABORTED')
      throw new LlmError('传输失败：' + err.message, 'TRANSPORT')
    }
    if (!res.ok) throw new LlmError('provider 返回 HTTP ' + res.status, 'PROVIDER_HTTP', res.status)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let index = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        const delta = chunk.choices?.[0]?.delta
        if (typeof delta?.content === 'string' && delta.content) {
          text += delta.content
          yield { type: 'text-delta', index, text: delta.content }
        }
      }
    }

    // usage 必须先于 finish，且 finish 之后不再产出任何 chunk。
    if (text) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'block-end', index, block: { type: 'text', text } }
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx, config) {
  ctx.llm.registerAdapter(['${names.base}'], new ${names.pascal}Adapter(config))
}
`
}

function readmeTemplate(names, form, harnessVersion) {
  const REF_ROOT = 'https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-write'
  return `# ${names.packageName}

DSH ${form} 形态插件，由 [dsh-plugin-fast-adapt](https://github.com/taxueseek/plugin-fast-adapt) 的 scaffold 生成，针对 dsh-v${harnessVersion || 'unknown（未探测到本机宿主）'}。

## 文件

- \`lib/index.js\` — 插件入口（免构建纯 ESM，main 直指源文件）
- \`cordis.patch.yml\` — 挂载层；没有它装了不生效
- \`dsh-plugin.naming.json\` — 命名声明（collision-resistant 投影已全量生成）

## 下一步

1. **写完能力后过体检门**：\`node <fast-adapt>/scripts/write-gate.mjs .\` —— 冒烟＋启用就绪＋四维体检＋官方指南核查一条命令出报告（刚生成完可加 \`--skip-smoke\` 免重复冒烟）
2. **环境核查**：\`node <fast-adapt>/scripts/env-doctor.mjs .\` 看启用就绪度与覆盖层
3. **体检**：\`node <fast-adapt>/scripts/plugin-audit.mjs .\` 四维打分
4. **命名完整校验**（碰撞推荐 + registry 查询，可选联网）：
   \`node <plugin-write>/scripts/validate-names.mjs --manifest ./dsh-plugin.naming.json\`
5. **对照形态文档补能力**：${REF_ROOT}/references/ 下五份 form reference，入口里的能力是起点实现（能跑通），换成你的能力即可

## 测试挂载

把 \`cordis.patch.yml\` 合进 profile（或 \`dsh plugin --profile <name> add <本目录>\`），重启宿主。${names.loaderIds[0]} 条目已按最小挂载生成。
`
}

// ── 生成主流程 ──────────────────────────────────────────────────────────────

export async function scaffoldPlugin({ coordinate, form, outDir, harnessVersion = undefined, autoSmoke = true } = {}) {
  if (!FORMS.includes(form)) {
    throw new UsageError(`--form 必须是 ${FORMS.join(' | ')} 之一，实得「${form}」`)
  }
  const { namespace, name } = validateCoordinate(coordinate)
  const names = projectNames(namespace, name)

  const resolvedOut = path.resolve(outDir || path.join(process.cwd(), `dsh-${name}`))
  if (fs.existsSync(resolvedOut) && fs.readdirSync(resolvedOut).length > 0) {
    throw new UsageError(`目标目录已存在且非空，拒绝覆盖: ${resolvedOut}`)
  }

  const detected = harnessVersion === undefined ? detectHarnessVersion() : harnessVersion

  const files = [
    ['package.json', packageJsonTemplate(names, form, detected)],
    ['lib/index.js', entryTemplate(form, names)],
    ['cordis.patch.yml', patchYmlTemplate(names)],
    ['dsh-plugin.naming.json', namingManifestTemplate(names)],
    ['README.md', readmeTemplate(names, form, detected)],
    ['.gitignore', 'node_modules/\n'],
  ]
  for (const [rel, content] of files) {
    const abs = path.join(resolvedOut, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }

  let smoke = null
  if (autoSmoke && SMOKEABLE_FORMS.has(form)) {
    const result = await runQuickSmoke(resolvedOut)
    smoke = {
      run: true,
      success: result.success,
      durationMs: result.durationMs ?? null,
      registeredTools: result.registeredTools ?? [],
      injectedServices: result.injectedServices ?? [],
      mockFallbacks: result.mockFallbacks ?? [],
      error: result.error ?? null,
    }
  }

  // 真基类装载验证：本机装了宿主时，用真实 @deepseek-ai/* 基类 import 入口，
  // 验「基类 API 用对没对」——quick-smoke 的内存 Mock 覆盖不到这一半。
  // 没装宿主时返回 available:false，不伪造通过。
  const hostVerify = await verifyWithHostModules({
    pluginDir: resolvedOut,
    entryFile: 'lib/index.js',
    form,
  })

  return {
    coordinate: names.coordinate,
    form,
    outDir: resolvedOut,
    harnessVersion: detected,
    files: files.map(([rel]) => rel),
    naming: {
      packageName: names.packageName,
      loaderIds: names.loaderIds,
      tools: names.tools,
      services: names.services,
    },
    smoke,
    hostVerify,
    nextSteps: [
      '写完能力后跑: node scripts/write-gate.mjs <outDir>  # 出生证：冒烟＋启用就绪＋四维体检＋指南核查（刚生成完可加 --skip-smoke 免重复冒烟）',
      'node scripts/env-doctor.mjs <outDir>  # 单看启用就绪度',
      '上游 validate-names / query-registry 做完整命名校验（可选联网）',
    ],
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--form' || arg === '--out' || arg === '--harness') {
      const value = argv[++i]
      if (value === undefined) throw new UsageError(`${arg} 缺少值`)
      flags[arg.slice(2)] = value
    } else if (arg === '--no-smoke') {
      flags.noSmoke = true
    } else if (arg.startsWith('--')) {
      throw new UsageError(`未知参数「${arg}」，支持 --form/--out/--harness/--no-smoke`)
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const { positional, flags } = parseArgv(process.argv.slice(2))
    if (positional.length !== 1) {
      throw new UsageError('用法: node scripts/scaffold.mjs <namespace>/<name> --form tool|hook|service|config|llm-adapter [--out <dir>] [--harness <version>] [--no-smoke]')
    }
    const result = await scaffoldPlugin({
      coordinate: positional[0],
      form: flags.form,
      outDir: flags.out,
      harnessVersion: flags.harness,
      autoSmoke: !flags.noSmoke,
    })
    printJson(result)
    process.stderr.write(`\n[插件已生成] ${result.coordinate}（${result.form}）→ ${result.outDir}\n`)
    process.stderr.write(`目标宿主: dsh-v${result.harnessVersion || '未探测到，README 里已如实标注'}\n`)
    if (result.smoke) {
      if (result.smoke.success) {
        process.stderr.write(`冒烟: 通过（${result.smoke.durationMs}ms，注册工具 ${result.smoke.registeredTools.length} 个${result.smoke.mockFallbacks.length ? `，Mock 兜底 ${result.smoke.mockFallbacks.length} 处` : ''}）\n`)
      } else {
        process.stderr.write(`冒烟: 失败——${result.smoke.error}\n`)
        process.exit(1)
      }
    } else {
      process.stderr.write('冒烟: 跳过（本形态零依赖冒烟不适用，改由真基类装载验证）\n')
    }
    const hv = result.hostVerify
    if (hv?.available) {
      if (hv.success) {
        process.stderr.write(`真基类装载: 通过（宿主 dsh-v${hv.hostVersion}，${hv.checks.length} 项契约全绿）\n`)
      } else {
        const failed = hv.checks.filter((c) => !c.ok).map((c) => c.name).join('、')
        process.stderr.write(`真基类装载: 失败——${failed}${hv.error ? `（${hv.error}）` : ''}\n`)
        process.exit(1)
      }
    } else {
      process.stderr.write(`真基类装载: 跳过（${hv?.reason ?? '本机未装宿主'}；装包后可跑 quick-smoke）\n`)
    }
    process.stderr.write(`下一步:\n  - ${result.nextSteps.join('\n  - ')}\n`)
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`用法错误: ${err.message}\n`)
      process.exit(2)
    }
    process.stderr.write(`失败: ${err.stack || err.message}\n`)
    process.exit(1)
  }
}
