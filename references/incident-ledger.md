# 事故账本（incident-ledger）

每行一条真实发生过的事故，与 `fixtures/` 下的夹具一一对应。**判据可执行、结论可追溯**：
每条事故都有最小复现切片，自检启动时全量回归；判据写松了或写紧了都会红。

## 回写纪律

修一次误报或漏报，三件一起做，缺一不可：

1. **写回判据**：`references/heuristics.md`（扫描降噪）或对应 `lib/*.mjs` 的注释（机器判据），说清「为什么这条判据是对的」。
2. **沉淀夹具**：`fixtures/<id>/input/` 放最小复现，`fixtures/<id>/expected.json` 写正确判定与 fingerprint。
3. **登记本表**：一行一条，带来源与夹具 id。

只做第 1 步不做第 2 步，下次换台机器重跑就没了；只做第 2 步不做第 3 步，夹具与判据会各自漂移。

## 登记

| id | 事故一句话 | 来源 | 夹具 |
| --- | --- | --- | --- |
| `shared-state-constant-table` | 泛化判据把模块级常量查表报成「共享状态无所有者」，实测 35 处命中全是常量表与编译产物 | 本机实测 2026-11-05 | `fixtures/shared-state-constant-table/` |
| `waterfall-far-next` | `next()` 写在监听器函数体第 3300 字符处，被 800 字符窗口报成断链 | 本机实测 2026-11-06 | `fixtures/waterfall-far-next/` |
| `waterfall-object-literal-body` | 箭头表达式体里收对象字面量的调用被当成块体，函数体外的 `next()` 被漏读 | 本机实测 2026-11-06（dsh-ops 假阳性） | `fixtures/waterfall-object-literal-body/` |
| `waterfall-real-break` | 真断链的对照面：收了 `next` 从不调用，必须报 | `docs/defensive-patterns/general.zh.md#waterfall-责任链流水线` | `fixtures/waterfall-real-break/` |
| `git-config-broken-group` | 宿主凭证擦除留下残缺 git 配置组，本工具所有 git 调用静默失败 | 本机实测 2026-11-05；上游 `packages/boot/plugin-manager/tests/git-environment.ts` | `fixtures/git-config-broken-group/` |
| `symlink-delete-no-follow` | 递归删缓存目录穿透软链删掉目标内容 | `docs/defensive-patterns/general.zh.md#用-unlink-删除链接形态的路径` | `fixtures/symlink-delete-no-follow/` |
| `scan-code-boundary` | 常量锚点 `ABORTED` 子串误伤 `FS_ABORTED` | 本机实测（v0.2.2 降噪复盘） | `fixtures/scan-code-boundary/` |
| `bom-silent-null` | `package.json` 带 UTF-8 BOM 读不出元信息，被吞成 null 继续跑 | 上游 issue #12322；本机实测 2026-11-05 | `fixtures/bom-silent-null/` |
| `regex-literal-masking` | 本工具自扫报出两处 lifecycle 误报，位置在自己的检测器源码里 | 本机实测 2026-11-09（fleet 场测） | `fixtures/regex-literal-masking/` |
| `typecheck-installed-copy` | 对已安装副本跑 typecheck，`tsc -p tsconfig.json` 报 TS18003/TS5058 被判成构建失败并给退出码 2；安装副本的 `files` 白名单不含 tsconfig，本机 47 个有目录条目里 44 个是这种形态 | 本机实测 2026-11-06（dsh-workbuddy-connect 8 次运行指向已安装副本，2 次 `typecheck=fail`） | `fixtures/typecheck-installed-copy/` |
| `fastpass-shape-projection` | 账本直通记录被 `run-log list` 显示成「命中=? 体检=? scan=?」、被 doctor 判成「代码侧未核查」，而记录里 `phases.scan` 明明是 `ok`；基线缺结论时 `null` 还会在直通链上自我复制 | 本机实测 2026-11-19 | `fixtures/fastpass-shape-projection/` |
| `subpath-not-exported` | 插件导入宿主包未在 `package.json#exports` 公开的子路径（如 `@deepseek-ai/dsh-subagent/internal`），包存在检查放过但启动必抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` | 本机实测 2026-11-21（`@linxin666/dsh-agents` 20 次报错） | `fixtures/subpath-not-exported/` |

## F4 场测结论（2026-11-09）

三条新规则（lifecycle-unpaired-resource / vendor-rescope-unscoped / waterfall-missing-next）在**本机 45 个真实插件、1278 个文件**上跑过一遍：

- **第三方插件零命中**——没有一条误报，判据收窄的三轮（见 `references/heuristics.md`）经受住了场测。
- 唯一命中在本工具自己的仓库里：`fixtures/waterfall-real-break/`（夹具，预期命中）与 `scripts/self-test.mjs`（真实 `process.on`，本就该报）。
- 场测顺带发现 `regex-literal-masking`（maskSource 不认正则字面量），已入库并修。

结论：三条规则的判据**不需要再收窄**，F4 结案。场测工具是临时脚本，未入库（判据本身已由夹具与自检覆盖）。

## 2026-11-21 误报收口与假绿显形（四笔，已修，回归用例在 scripts/self-test/）

- **member 锚点 Migration 源误报**：dsh-suggestion-chips 9 high / dsh-files 5 high 逐条对照指南原文全为误报——Migration 迁移目标代码（ctx.slots.inject/register、ctx.sessions.create、ctx.emit、ctx.tools.register）被抽成待报锚点。判据=成员锚点只从 Change 段非延续子句抽+替换对旧符号补锚；回归=guide-anchors.test.mjs 六用例 + self-test.mjs 抽取用例（removeBundle 断言随语义翻转）。
- **延续句锚点误报**：「keeps its form / unchanged」句里的 getSnapshot、subscribe、ATTACHMENT_* 被抽成待报锚点，插件本地同名函数（normalize.js:728 subscribe）撞车。判据=CONTINUITY_RE 延续句剔除+转折子句切分保破坏面；回归=guide-anchors.test.mjs 延续句/转折子句/常量延续三用例。
- **包路径尾点半角点漏报**：PKG_PATH_RE 子路径段把句尾句号吃进捕获（@deepseek-ai/dsh/commands.），带点形式比 import 必落空。判据=捕获后剥尾点；回归=guide-anchors.test.mjs 尾点剥离用例。
- **fleet 假绿与假绿显形**：profile 已声明但目录解析不到时 build 判 NOT_APPLICABLE ok:true、audit 硬造 overallScore:100（38 条假绿实测）。判据=目录未解析降 WARNING（score null 不伪造）+包名反查表（id↔包名不同名：turn-guard↔dsh-turn-guard、save-token↔dsh-plugin-save-token）+~/.dsh/plugins 候选根+宿主树守卫（解析进宿主包内的条目按内置模块跳过）；回归=fleet.test.mjs 卸载残留/反查/plugins 根/宿主树四用例。同日实测顺带发现 main 守卫软链 no-op（17 个脚本 argv[1] 与 import.meta.url 裸比较），已收口 lib/main-entry.mjs+源码门+软链端到端用例。

- **发现面盲区与失败块解析缺陷（2026-11-21 第二批）**：@linxin666/dsh-agents 装在 profiles/{web,desktop}/node_modules、宿主每次启动尝试激活并失败，却因从未挂进任何 patch 层而进不了 fleet 发现面；且 parseFailedPlugins 把 `failed to import:` 错误行当成插件名（单份日志 202 条里一半是垃圾块，真实插件 package 字段挂丢）。判据=解析器错误行先于插件名判定（Error:/failed to import: 两形态）+ fleet 宿主日志点名兜底发现（discoverHostLogOnlyPlugins，按解析目录 realpath 同一性去重）+ 失败关联目录双键（宿主按包名点名 dsh-suggest-actions ↔ patch 挂载名 dsh-suggestion-chips）。回归=fleet.test.mjs 解析与发现两用例。

## 待入库（有事故记录、还没切片）

- 扫描根重复报：`src` 与同级 `client`/`web`/`ui` 一并扫，`lib`/`dist` 是构建产物只在没有源码根时退回，否则同一处命中按两份文件重复报（2026-10-25 实录）。
- 同名符号撞车：插件里的 `path.resolve()` 与指南里的 `runtime.resolve()`（`references/heuristics.md` 规则 3）。
- **夹具 mock 宿主树被 .gitignore 吞出库（2026-11-21 第三批，已修）**：全局 `node_modules/` 规则把 subpath-not-exported 夹具的模拟宿主树吞出版本库——磁盘有树本机全绿、CI 检出无树夹具必红，随 0.5.0/0.5.1 发布出去（resolvePackageSubpathOnHost 返回 unknown 被夹具门判红）。判据=`!fixtures/**/node_modules/` 负模式入库+自检「夹具资产全部入库」断言（fixtures/ 下每个磁盘文件必须被 git 追踪）；回归=fixtures.test.mjs 入库断言。
- **doctor 交叉核对夹具毫秒竞态（2026-11-21 第三批，已修）**：startup 日志夹具写在 cleanRun.time 之前，log-hit-scan-clean 判定实际依赖「写入与取时落在同一整数毫秒」（run.time ISO 截断 floor、mtime 亚毫秒精度，跨毫秒边界则 mtime 早于 runTime 被判 host-log-stale）——同一提交 Windows CI main 绿 tag 红实录 flaky。判据=夹具 utimes 显式封闭到 run.time+1min（语义即「失败是当下的不是历史遗留」）；回归=self-test.mjs doctor 用例。
