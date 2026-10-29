---
name: plugin-fast-adapt
description: DSH 插件升级适配的主入口。查 DeepSeek 官方最新版本，取该版本的官方升级指南，扫描本机插件代码，报出踩了哪些破坏性变更并给官方修法；seams 查某个包或 API 在指南与本机宿主里的双源结论；run.mjs 一键跑完环境→定版→指南→扫描→体检→冒烟→typecheck 并写本地运行日志。官方指南覆盖不到的老版本转迁移 SOP。造插件走 dsh-plugin-build，装了没生效或宿主起不来走 dsh-plugin-diagnose。触发词：适配 DSH 插件、升级插件、插件不兼容、dsh 升级后报错、插件用了废弃 API、接缝查询、这个 API 还在不在、老版本 DSH 适配、历史走廊迁移、一键编排、运行日志、插件性能架构体检、批量巡检。
---

# plugin-fast-adapt

DSH 插件升级适配的主入口。三条车道各管一件事，先判意图再动手：

| 车道 | 什么时候走这条 | 读哪一份 |
| --- | --- | --- |
| 适配升级 | 宿主发了新版、插件报错、要核某个包或 API 还在不在、要给插件做性能体检 | `sub-skills/adapt/SKILL.md` |
| 造插件 | 没有插件要从零写一个，或给刚写完的插件过体检门 | `sub-skills/build/SKILL.md` |
| 环境与启动故障 | 插件装了没生效、客户端卡 loading、宿主起不来 | `sub-skills/diagnose/SKILL.md` |

**不要一次把三份都读进来。** 按上表判断走哪条，只读那一份；跨车道时（比如升级完顺手补个出生证）再补第二份。以下命令都在技能根目录执行；脚本用自身文件的绝对路径定位，从任何目录直接 `node <技能根>/scripts/<脚本>.mjs` 也可以，不必先 cd。

**权威来源只有两处**：npm registry 的版本信息，和 deepseek-harness 仓库的 `docs/upgrade-guide/`。不依赖人工维护的升级卡片，也不镜像官方全量文档。指南取仓库默认分支的受管快照（发版后官方还会补全同版本条目），发版 tag 只是冻结切片，仅在拿不到分支快照时兜底并标 `frozen`。那类知识快照必滞后（上游预发布节奏 1.7 到 2.8 天一个），而「某个包还在不在」用宿主 node_modules 实测更硬。

## 一键编排（推荐入口）

```sh
node scripts/run.mjs <插件目录> [--check-upstream] [--target <版本>] [--from <版本>] [--no-clone] [--no-smoke] [--no-typecheck] [--no-log] [--real-smoke] [--strict]
```

环境→定版→指南→扫描→体检→冒烟→typecheck 一条命令跑完，出一份统一 JSON 报告并写本地运行日志。退出码：0 干净，2 有 critical/high 命中、typecheck 红或真冷启动失败；加 `--strict` 时「扫描没跑」和「指南没覆盖到目标版本」也按 2 退出。报告里的 `scan.coverage` 写明本轮指南覆盖到哪一版：没扫或覆盖不全时屏幕会明说「不能当查干净」，不再用「命中 0 处」冒充干净。扫描窗口、`--real-smoke`、运行日志（`run-log.mjs list/show/sanitize/doctor`）的细节见 `sub-skills/adapt/SKILL.md`。「插件报错 / 装了没生效」的第一站是 `node scripts/run-log.mjs doctor`，它把运行日志和宿主启动日志并排核对。

## 技能面同步（可选）

本仓默认不盯任何下游。要把技能面镜像到另一个技能目录时显式给它：

```sh
node scripts/sync-skill.mjs --dest <下游技能目录> --check   # 只查漂移（退出码 1 = 有漂移）
node scripts/sync-skill.mjs --dest <下游技能目录>            # 同步
```

同步面固定为技能读者真正会用的文件：`SKILL.md`、`README.md`、`README.en.md`、`references/**`、`scripts/**`、`sub-skills/**`，`package.json` 不入技能面。`--dry-run` 只打印不落盘；同步完成后打印建议的下游提交命令（只 add 同步路径防夹带），不自动提交。

## 跨车道纪律

- **命中为零不代表没问题**，只代表「在官方指南覆盖的范围内没踩到」。指南只记官方认为需要通知的破坏性变更，不覆盖所有可能性。先看 `scan.coverage.complete`：没扫或没覆盖到目标版本时，零命中是未知，不是干净。
- **命中先看是不是误报**。锚点匹配做了几层降噪（规则与实测依据见 `references/heuristics.md`），但同名符号仍会撞车，比如插件里的 `path.resolve()` 和指南里的 `runtime.resolve()`。判断方法：看命中位置的代码上下文，确认符号是不是真来自宿主 API。
- **`member` 命中里，若符号是指南的「迁移目标」就不会出现**。插件已用新 API 说明适配过，报了是噪音。
- **集群治理与单兵深度结合**。宿主刚升级、要把整批插件过一遍时，先用 `node scripts/fleet-sweep.mjs` 做集群广度筛查与矩阵看板诊断，筛出有问题的插件再逐个回到适配车道深查。
- **工具不自带定时器**。上游盯哨 `guide-sync --check` 的退出码是语义化的（1 有新版、0 无需动作、2 判定失败），接 cron、launchd 还是 agent 轮询由用户定。

## 安全边界

- **只读为主**：`env-doctor`、`code-scan`、`plugin-audit`、`seams`、`log-doctor`、`run-log` 完全不写文件。
- **`quick-smoke` 与 `write-gate` 会执行插件代码**（动态 import 入口模块）。只对自己或审过的代码跑，不要对来路不明的目录跑。执行面限于 Node 进程内，但插件代码理论上能做任何 Node 能做的事。
- **自愈默认 dry-run**：`env-heal` 不加 `--apply` 只报告，加了也是移动不删除（进 `~/.dsh/.trash/<日期>/`）。
- **不改 DSH 本体**，不动 `~/.dsh` 下的配置和 profile 声明。
- **不自动改插件代码**：只报命中和官方修法；`plugin-audit --peer-patch` 也只打印建议，不写 `package.json`。
- **网络只用在「取官方源」这一步**：定版本读 npm 的 dist-tags，取指南 clone 官方仓库。两处都有超时，失败明确报错而非静默跳过；dist-tags 有 1 小时缓存，网络失败降级用旧缓存并标 stale；上游 tag 未打导致的 clone 失败记 1 小时否定缓存（dist-tags 一变即作废），期间不重复拉取；指南优先复用本机已有 clone，`--no-clone` 可跳过。
- **日志只落本机**，含本地路径与用户名，外发前必须 `sanitize`。

## 按需读取（车道之外）

| 场景 | 读什么 |
| --- | --- |
| 完整使用指南与集群多维治理实战 | `references/user-guide.md` |
| 官方指南覆盖不到的老插件 | `references/legacy-migration-sop.md` |
| 扫描降噪规则与实测依据 | `references/heuristics.md` |
| 给插件自己的仓库加提交时门禁 | `references/ci-snippet.md` |

## 自检

```sh
npm test
```

198 项断言，覆盖扫描器不误报（注释和字符串里的同名词不算命中）、不漏报、版本窗口与 real semver 判定、目标形态判定、指南出处锚点、指南分支快照与覆盖度未知态、三元版本账本直通与变更嗅探、本地宿主接缝契约核对与未构建硬拦截、跨平台与工作区自适应（Termux/Linux/环境变量/祖先依赖）、上游经验吸纳（退出码 143 停机判定/Bundle 遮蔽阴影/准入账本 compatPatch/提示词 {{cwd}} 拦截/全局前缀分裂检测/集群治理 Web-APP 与运行态生命周期多维看板）、Release Note 破坏性变更虚拟指南提取与双语去重、接缝查询双源结论、运行日志与宿主日志交叉核对、一键编排各档位（含 --strict）、冒烟验证（含 Config 默认值解析、宿主 node_modules 兜底、未声明 inject 契约拦截与 exports-only 入口）、四维审计（含 peer 与 compat 准入账本修补）、启用诊断（宿主半与客户端半）、幽灵宿主四态与磁盘时间来源、tsconfig paths 假绿（含 extends 与 JSONC）、环境层三处盲区、创作脚手架与体检门、日志诊断、下游同步、发布预检规则（版本一致/tag/包内容/npm 状态）、跨平台模拟、诊断输出瘦身、CLI 帮助与未知参数、文档断言数与技能面 description 长度门禁、扫描性能回归。自检零网络、零外部依赖，任何机器上都能跑。

提交前门禁：`git config core.hooksPath .githooks`（一次性）启用 pre-commit 钩子，commit 时自动跑本自检，改完真源忘了同步在这一刻被拦。

## 脚本清单

脚本是三条车道共用的工具箱，全部在技能根的 `scripts/` 下，不随车道分家。

| 脚本 | 职责 |
| --- | --- |
| `run.mjs` | 一键编排全流程 + 写本地运行日志 |
| `fleet-sweep.mjs` | 集群批量治理与巡检：扫描工作区或已安装整批插件，输出矩阵看板与 JSON 报告 |
| `run-log.mjs` | 运行日志查看（list/show）与脱敏导出（sanitize）、日志交叉核对（doctor） |
| `env-doctor.mjs` | 探测本机 DSH 环境：版本、覆盖层、共享农场悬空软链、两层 patch、插件、进程、幽灵宿主（进程代际）、tsconfig paths 假绿、宿主半与客户端半启用就绪度；`--brief` 省略 patch 行原文（约降 94% 体积） |
| `env-heal.mjs` | 覆盖层旧包自愈（默认 dry-run） |
| `guide-sync.mjs` | 定目标版本 + 取官方升级指南：默认分支受管快照按 1 小时 TTL 刷新，tag 快照仅在离线兜底并标 frozen |
| `code-scan.mjs` | 扫描插件代码，匹配官方变更锚点（带指南文件与行号出处） |
| `seams.mjs` | 接缝查询：包名或 API 符号在指南锚点表与本机宿主里的双源结论 |
| `quick-smoke.mjs` | 内存级 Cordis 冒烟，含 Mock 兜底披露 |
| `plugin-audit.mjs` | 四维性能架构体检，可叠加官方指南交叉 |
| `log-doctor.mjs` | 解析 `~/.dsh/logs/` 的宿主故障 |
| `scaffold.mjs` | 五形态插件脚手架 |
| `write-gate.mjs` | 创作体检门：硬门禁自动判，软指标透传待裁量 |
| `sync-skill.mjs` | 技能面同步与漂移检查 |
| `release-check.mjs` | 发布前预检：版本一致、`v<版本>` tag、npm 是否已发布、`npm pack` 必需文件与夹带、自检、工作区；只读，不自动打 tag 或发布 |
| `cli.mjs` | npm bin 入口（`npx plugin-fast-adapt`），转发到 run.mjs |
| `self-test.mjs` | 自检 |
| `lib/` | 扫描器、指南解析、运行日志、客户端半判定、宿主模块探测、发布规则 |
