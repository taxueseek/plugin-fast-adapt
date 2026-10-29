# DSH 插件适配与集群治理实战指南 (User Guide)

本指南为 `plugin-fast-adapt` 技能的完整实战手册，随技能面同步分发，适用于插件开发者、大仓维护者以及在各类环境（macOS、Linux、Windows、Termux 移动端、Docker 容器）中运行 DSH 的用户。

---

## 一、核心原则与设计哲学

DSH（DeepSeek Harness）官方预发布节奏极快（约 1.7 至 2.8 天一个版本），频繁带来 API 重构与破坏性变更。本技能抛弃传统「人工维护滞后卡片库」的模式，基于第一性原理建立自动化适配通道：

1. **本地环境版本真实锚定（零外部网络压力）**
   - 适配的本质是适配使用者**本机实际运行的宿主版本**，而非强行追踪官方未落地的最新 tag。
   - 默认以本地已安装环境（`findGlobalDsh` / `dsh -v`）为权威真源，适配全流程 0 外部网络请求，消除官方源网络抖动与 GitHub 访问频控限制。
   - 当需要获知官方演进动向时，显式使用 `--check-upstream` 进行只读核对，新版本交由用户或作者在本地自主升级。

2. **跨平台跨工作区零硬编码自适应**
   - 剔除对固定路径的假设。全局 npm 路径自适应覆盖 Linux `/usr/lib/node_modules`、Termux 移动端 `$PREFIX/lib/node_modules` 与 `npm_config_prefix`。
   - 允许通过环境变量 `DSH_HOST_PATH` 或 `DSH_LOCATION` 显式注入宿主安装位；工作区向上回溯探测周边祖先目录依赖。

3. **集群广度看板与单兵深度审计结合**
   - 既能对单插件一键跑完「环境→定版→指南→扫描→体检→冒烟→编译」全链路；
   - 也能通过全域集群巡检，对整机所有 Web、APP 桌面端、核心服务插件及工作区源码进行全生命周期多维摸排。

---

## 二、快速起步与环境探针

在执行任何适配之前，先通过环境探针明确当前运行环境与依赖状态：

```sh
# 查看当前宿主版本、安装位置、运行中进程、挂载插件与代际状态
node scripts/env-doctor.mjs

# 瘦身模式：输出结构化简报（省略冗长 patch 原文，减少约 94% 输出体积）
node scripts/env-doctor.mjs --brief
```

探针将自动核验并提示：
- **APP 捆绑宿主与全局宿主版本差异**：若两者不一致，系统自动区分桌面端（APP）与 Web 端结论。
- **幽灵宿主（Ghost Host）**：若宿主进程启动时间早于磁盘插件文件的变更时间，提示代码已更新但内存未热加载的风险。
- **假绿路径（False Green Paths）**：检查 `tsconfig.json` 的 `paths` 是否指向不存在的本地源码检出。

---

## 三、单兵插件深度适配车道（`run.mjs`）

针对指定插件目录进行端到端全量扫描与契约验证：

```sh
node scripts/run.mjs <插件目录路径> [选项]
```

### 1. 流水线执行阶段

```
[环境探测] ──> [版本锚定] ──> [指南提取] ──> [源码扫描] ──> [产物构建核验] ──> [内存冒烟] ──> [四维体检] ──> [落盘日志]
```

1. **环境探测**：自动识别插件形态（Tool、Hook、Service、Client Extension、Workspace）。
2. **版本锚定**：以本地宿主版本为基准，计算适配窗口；支持三元版本账本快速探测未修改源码。
3. **指南提取**：优先复用本地缓存指南；如未命中且允许时提取官方分支快照或 Release Note 破坏性变更虚拟指南。
4. **源码扫描**：精准降噪匹配破坏性变更锚点，报出具体命中代码位置、指南出处与官方修法。
5. **构建态硬拦截**：针对 TypeScript 插件，物理核查编译产物（如 `lib/index.js`），未编译立即拦截并指引 `pnpm run build`，杜绝未构建代码参与冒烟。
6. **内存级冒烟（Quick Smoke）**：百毫秒级 Cordis 运行时装载，验证服务依赖注册与契约完整性。
7. **四维架构审计**：给出性能、弹性、上下文预算、生命周期的量化评分（0-100）。
8. **本地日志**：生成运行日志留痕，支持后续交叉诊断与脱敏导出。

### 2. 常用参数速查

| 参数 | 说明 |
| :--- | :--- |
| *(默认)* | 严格锚定本机已安装宿主版本，零外部网络请求 |
| `--check-upstream` | 显式核对上游官方 npm registry 与最新 tag，提示落差 |
| `--target <版本>` | 显式指定要适配的目标宿主版本（如 `0.2.2-alpha.2`） |
| `--from <版本>` | 显式指定适配窗口起点版本（默认取 package.json peerDependencies 下限） |
| `--real-smoke` | 启用官方真实宿主冷启动验证（在隔离 profile 中真实挂载执行，耗时约 3~5 秒） |
| `--strict` | 严格模式：扫描未执行或指南覆盖不全时一律以退出码 2 退出 |
| `--no-smoke` | 跳过冒烟测试，仅跑扫描与四维体检 |
| `--offline` | 完全离线模式，禁止任何形式的网络同步尝试 |

### 3. 日志排查与脱敏

```sh
# 列出最近的适配运行记录
node scripts/run-log.mjs list

# 交叉核对：将最近一次插件运行记录与宿主崩溃日志对拍
node scripts/run-log.mjs doctor

# 脱敏导出：对外提交 issue 或分享时脱敏绝对路径与用户名
node scripts/run-log.mjs sanitize <run-id>
```

---

## 四、集群批量治理车道（`fleet-sweep.mjs`）

当宿主升级、维护 Monorepo 多包工程，或需要摸排整机所有插件健康状况时，使用全域集群巡检看板：

```sh
node scripts/fleet-sweep.mjs [目录...] [选项]
```

### 1. 全域双源发现能力

- **工作区插件**：递归探测指定目录或当前工作目录周围的插件项目，支持 `packages/*`、`plugins/*` 单仓多包架构。
- **安装环境插件**：穿透全局 `~/.dsh/profiles/*` 下各配置文件（`web.yml`、`desktop.yml`、`headless.yml`）及 `~/.dsh/cordis.patch.yml` 全局挂载层。

### 2. 多维分类矩阵

看板将扫描到的所有项目归类至独立扇区：

```
┌─ 一、正在运行中的插件 (RUNNING) ─────────────（当前活跃宿主主进程已装载且未禁用的插件）
├─ 二、本地工作区源码插件 (WORKSPACE) ──────────（本地正在开发或迭代的插件代码）
├─ 三、已安装 Web 插件 (INSTALLED / WEB) ───────（安装在 web profile 中的生态扩展）
├─ 四、已安装 Desktop 插件 (INSTALLED / APP) ───（桌面客户端 asar/desktop profile 插件）
└─ 五、已禁用或未启用插件 (DISABLED / INACTIVE) ─（被标记 disabled: true 或未挂载的插件）
```

### 3. 过滤与定向巡检命令

```sh
# 1. 默认全域梳理（当前工作区 + 本机安装环境全量看板）
node scripts/fleet-sweep.mjs

# 2. 仅看当前电脑上正在运行的插件状态
node scripts/fleet-sweep.mjs --running

# 3. 仅检查 Web 平台插件
node scripts/fleet-sweep.mjs --web

# 4. 仅检查 Desktop (APP) 桌面端插件
node scripts/fleet-sweep.mjs --app

# 5. 仅扫描本地工作区源码（排除全局安装插件）
node scripts/fleet-sweep.mjs --workspace

# 6. 查看所有被禁用或未激活的插件清单与原因
node scripts/fleet-sweep.mjs --disabled

# 7. 指定目标版本并输出结构化 JSON 报告（供自动化脚本消费）
node scripts/fleet-sweep.mjs --target 0.2.2-alpha.2 --json

# 8. 批量准入账本与 Peer 范围自适应修补（仅对 0 代码级破坏性命中的插件自动更新 package.json）
node scripts/fleet-sweep.mjs --workspace --target 0.2.2-alpha.2 --apply-compat
```

---

## 五、低级错误硬守卫与常见排错清单

本技能内置了多道防御性门禁，自动识别并拦截常见低级错误：

### 1. TS 源码修改后未构建（Entry Resolution Missing）
- **现象**：修改了 `src/index.ts`，直接跑测试或冒烟，执行的是上一次遗留的旧产物，或者抛出 `Cannot find module lib/index.js`。
- **守卫机制**：`fleet-sweep` 与 `run.mjs` 检测到 `tsconfig.json` 存在时，物理校验入口产物；若缺失，强制给出 `UNBUILT` 阻断，并提示：`请先执行构建 (如 pnpm run build 或 npm run build)`。

### 2. 宿主同名包遮蔽（Bundle Resolution Shadow）
- **现象**：插件自身发布为 `@deepseek-ai/dsh-xxx` 或依赖某个 Bundle，宿主根目录下恰好有同名依赖，Node 优先加载宿主自带版本，导致插件代码未生效或版本错乱。
- **守卫机制**：`plugin-audit.mjs` 自动比对插件名、依赖项与本地宿主根目录下的模块名，命中时标为 `HIGH` 级弹性风险，并给出隔离与重命名指引。

### 3. 宿主停机退出码 143（SIGTERM）假死误报
- **现象**：自动化冒烟脚本杀掉真实宿主进程时，Node 子进程返回退出码 143，被测试工具误判为「宿主异常崩溃」。
- **守卫机制**：`runRealSmoke` 显式判定退出码 143 为正常收到优雅终止信号停机，仅在宿主未完成初始化即退出时记为真实失败。

### 4. 幽灵宿主进程代际错位（Ghost Host Stale）
- **现象**：磁盘上的插件代码或 patch 文件已经更新，但终端里的 `dsh` 服务未重启，新代码完全未进内存。
- **守卫机制**：`env-doctor` 比对活跃宿主主进程的启动时间与磁盘变更时间，发现进程时间早于文件时间时明确报告 `stale`，并点出对应 PID。

### 5. `tsconfig.json` paths 穿透假绿
- **现象**：`tsconfig.json` 的 `paths` 指向了上一台机器或历史检出的本地路径，本地缺失该路径时 TypeScript 静默回退到 npm 发布包类型，编译假绿。
- **守卫机制**：静态分析 `tsconfig.json` 及其 `extends` 链条，路径缺失时明确报告 `falseGreen` 警告。

---

## 六、典型场景操作 SOP

### 场景 A：电脑上装了很多插件，想一键查看整体健康度
1. 运行集群看板：
   ```sh
   node scripts/fleet-sweep.mjs
   ```
2. 查看输出末尾的【健康结论】。若存在故障高危项，根据提示直接运行针对该插件的单兵修复命令：
   ```sh
   node scripts/run.mjs /Users/.../plugins/broken-plugin
   ```

### 场景 B：官方发布了新版本，我想测试我的单包插件是否兼容
1. 检查本地宿主是否支持该版本（若未更新可加 `--target`）：
   ```sh
   node scripts/run.mjs . --target 0.2.2-alpha.2
   ```
2. 查看扫描命中项（若提示破坏性变更，按给出的官方修复指引修改代码）。
3. 编译源码：`pnpm run build`。
4. 跑真实宿主冷启动验证：
   ```sh
   node scripts/run.mjs . --real-smoke
   ```

### 场景 C：从零开发一个全新形态的插件并验证
1. 一键生成标准插件脚手架（可选 tool、hook、service、client-ext 等形态）：
   ```sh
   node scripts/scaffold.mjs my-awesome-tool --type tool --dir ./my-plugin
   ```
2. 进入目录完成业务逻辑编写与构建：
   ```sh
   cd my-plugin && pnpm install && pnpm run build
   ```
3. 执行出厂体检门禁核验：
   ```sh
   node scripts/write-gate.mjs .
   ```
4. 验证通过后系统将发放出厂出生证明，确保无缝接入 DSH 生态。
