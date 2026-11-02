---
name: dsh-plugin-review
description: DSH 插件代码审查与防御性架构审核车道。基于 Git 范围或工作区源码，检查 Cordis 生命周期泄漏、未逆向注销、单例状态漂移、已废弃模板变量（如 {{cwd}}）、Vendored Peer 依赖污染、准入账本覆盖，按 P0/P1/P2/P3 输出精炼结构化报告；提供子 Agent 隔离委派协议（Sub-agent Dispatch Pattern），在后台沙箱运行紧凑分析并回传精炼结果，防止主会话上下文污染。触发词：代码审查、代码审核、code review、插件体检、防御性审查、生命周期检查、单例泄漏、Peer污染、子Agent审查、紧凑报告。
---

# 代码审查与防御性架构车道

在插件适配或交付前，对代码进行深度架构审计。重点排查 Cordis 生命周期泄漏、单例漂移、Vendored Peer 依赖污染以及废弃 API，按统一严重度（P0/P1/P2/P3）给出明确判定。

同时定义**子 Agent 隔离委派协议（Sub-Agent Dispatch Pattern）**：当面对复杂插件或批量巡检时，主 Agent 派发独立子 Agent 执行重型静态分析与冒烟，仅回传结构化紧凑报告（`<20` 行），避免海量日志填满主会话上下文。

以下命令都相对工具根目录执行，工具根即本文件真实路径往上两级、含 `scripts/` 的那一层。脚本用自身文件的绝对路径定位，不必先 cd。`<插件目录>` 指被查插件的仓库根。

## 第一步：会话内极速体检

```sh
node scripts/plugin-audit.mjs <插件目录> --compact
```

使用 `--compact` 参数时，脚本仅输出高密度结构化 JSON 摘要与关键结论，屏蔽全量文件遍历噪音：

```json
{
  "plugin": "my-plugin@1.0.0",
  "overallScore": 95,
  "scores": { "performance": 100, "resilience": 90, "contextBudget": 100, "lifecycle": 90 },
  "priorityCounts": { "P0": 0, "P1": 1, "P2": 0, "P3": 0 },
  "blockers": [
    {
      "priority": "P1",
      "dimension": "lifecycle",
      "file": "lib/index.js",
      "title": "事件监听或定时器未绑定清理逻辑",
      "detail": "Cordis 插件重载时未清理的监听器与定时器会泄漏，建议注册进 ctx.effect 或提供 dispose。"
    }
  ]
}
```

## 第二步：子 Agent 隔离委派协议（Sub-Agent Dispatch Pattern）

当审查整个插件仓库或运行全流程适配验证时，主 Agent 应按以下协议委派后台子 Agent：

1. **派发子 Agent**：通过 `invoke_subagent` 或独立终端沙箱唤醒子 Agent，指定只读工作区；
2. **执行紧凑流水线**：
   ```sh
   node scripts/run.mjs <插件目录> --compact
   ```
3. **回传协议**：子 Agent **严禁**直接复制全量调试日志或终端文本到父会话，必须提炼为以下三段式紧凑摘要返回：
   - **通过性总账**：宿主版本、窗口、体检分（各维度分）、冒烟与 typecheck 状态；
   - **阻断项账本**：仅列出 `P0`（致命阻断）与 `P1`（严重缺陷）条目（文件 + 标题 + 根因）；
   - **下一步行动**：具体的修改建议（如 peer 替换、dispose 补充、模板变量清理）。
4. **主 Agent 决策**：主会话上下文保持清爽，主 Agent 仅依据紧凑报告决定修改代码或交付用户。

## 第三步：四级严重度标准（Priority Standards）

| 级别 | 定义与影响 | 典型案例 | 处理原则 |
| --- | --- | --- | --- |
| **P0** | **阻断发版/启动失败**：宿主启动必崩溃或类型严重分裂 | 强 import 已废弃包、提示词含已移除 `{{cwd}}` 抛错、核心 Peer 依赖写在 `dependencies` 产生 Vendored 污染 | 立即阻断，必须清零后才能交付 |
| **P1** | **资源泄漏/状态异常**：运行时静默失效或跨会话污染 | `ctx.on` / `setInterval` 缺失清理逻辑、准入账本范围未覆盖目标宿主、高频热路径同步 I/O 阻塞 | 适配阶段应优先修复 |
| **P2** | **架构异味/上下文开销**：不影响当前运行但存在隐患 | 模块顶层定义可变全局集合（Map/Set/数组）重载残留、无字节上限文件读取、工具 Schema 文件偏大 | 建议重构，顺带优化 |
| **P3** | **规范建议/提示**：声明性约定或类型维护 | `import type` 引用即将变动包、工具描述中引用已消亡宿主路径、peer 声明严格 semver 提示 | 人工知悉，按需调整 |

## 常见缺陷与标准修复模式

### 1. 核心 Peer 依赖污染（P0）
- **错误**：`package.json` 的 `dependencies` 里声明了 `"cordis": "^4.0.0"` 或 `"@deepseek-ai/dsh": "^0.2.1"`;
- **修复**：将其移至 `peerDependencies`，并在 `devDependencies` 保留开发类型支持。

### 2. 严格模板变量移除（P0）
- **错误**：系统提示词模板中包含 `{{cwd}}`；
- **修复**：删除模板中的 `{{cwd}}` 子句，直接依赖 DSH 运行时每轮注入的上下文。

### 3. Cordis 生命周期清理（P1）
- **错误**：`ctx.on('chat', handler)` 未保存 dispose 句柄；
- **修复**：改用 `ctx.effect(() => { ctx.on('chat', handler) })` 或在 `ctx.on('dispose', () => { ... })` 中解绑。
