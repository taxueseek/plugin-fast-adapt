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

## 待入库（有事故记录、还没切片）

- 扫描根重复报：`src` 与同级 `client`/`web`/`ui` 一并扫，`lib`/`dist` 是构建产物只在没有源码根时退回，否则同一处命中按两份文件重复报（2026-10-25 实录）。
- 同名符号撞车：插件里的 `path.resolve()` 与指南里的 `runtime.resolve()`（`references/heuristics.md` 规则 3）。
