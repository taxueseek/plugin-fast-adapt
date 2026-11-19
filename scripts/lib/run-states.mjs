// lib/run-states.mjs —— run.mjs 流水线状态词的单一真源。
//
// 为什么需要它：run.mjs 的每个阶段都写 `status: 'ok' | 'skipped' | 'fail' | 'error'`，
// 24 处字面量散在一个文件里，runlog.mjs 的 phasesOf 又要按另一套派生逻辑读它们
// （`record.typecheck.status ?? (record.typecheck.skipped ? 'skipped' : null)`）。
// 后果不是「不好看」，而是**改一个状态名要改 N 处**：给某个阶段加一个终态，
// 要同时改 run.mjs 的写入点、runlog.mjs 的派生、run-log.mjs 的展示——漏一处
// 就是一个静默失配的状态（消费方读到 null，报告看起来和正常的一样）。
//
// 设计原则（对齐 argo 的 engine_states.py）：
//   - 每个状态**只有一个名字**，写入点从这里取，不手写写字面量。
//   - 按**阶段**组织：一个阶段的全部状态与转换条件放在一起，读一遍就能理解它的生命周期。
//   - 只定义词表与纯判定函数（is_xxx），不碰 IO、不碰持久化。
//
// 覆盖的状态面：
//   1. 通用阶段态（env / version / guides / typesDiff / scan / audit）
//      ok / skipped / error
//   2. typecheck：ok / skipped / fail（工具链缺失是 skipped 不是 fail）
//   3. smoke：ok / skipped / fail / error（未构建拦截是 error，与冒烟执行失败同态）
//   4. realSmoke：ok / skipped / fail / inconclusive（不定论是独立终态，不是 fail）
//   5. 运行摘要 phases：scan / smoke / typecheck / realSmoke 的四态投影（含 null）
//   6. 构建态（fleet-sweep checkBuild）：N/A / OK / UNBUILT / CORRUPTED
//   7. 生命周期态（fleet-sweep state）：RUNNING / ENABLED / DISABLED / WORKSPACE
//   8. 健康态（fleet-sweep healthStatus）：healthy / warning / broken
//
// 第 6~8 张表与 1~5 是**不同状态面**，值域刻意不合并：构建态要大写是因为它进
// 看板表格与 buildStatus 字段，健康态要小写是因为它进 JSON。合并成一张表会
// 让「改一个状态名」重新变成改 N 处，这正是本文件要消灭的东西。

/** 通用阶段状态。 */
export const STAGE_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  ERROR: 'error',
})

/** typecheck 阶段状态。 */
export const TYPECHECK_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAIL: 'fail',
})

/** 冒烟阶段状态。 */
export const SMOKE_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAIL: 'fail',
  ERROR: 'error',
})

/** 真冷启动状态。inconclusive 是独立终态：不定论不等于失败。 */
export const REAL_SMOKE_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive',
})

/** 构建态。N/A 是「不适用」（纯脚本目录，无 tsconfig 无 src），不是失败。 */
export const BUILD_STATUS = Object.freeze({
  NOT_APPLICABLE: 'N/A',
  OK: 'OK',
  UNBUILT: 'UNBUILT',
  CORRUPTED: 'CORRUPTED',
})

/** 插件生命周期态。WORKSPACE 与前三者并列但不互斥：它标的是「还没装」。 */
export const LIFECYCLE_STATE = Object.freeze({
  RUNNING: 'RUNNING',
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
  WORKSPACE: 'WORKSPACE',
})

/** 健康态。broken 是「有 critical/high」，不是「跑不起来」。 */
export const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  WARNING: 'warning',
  BROKEN: 'broken',
})

/**
 * package.json 探测态。missing 是正常形态（纯脚本目录），corrupt 是必须报的故障——
 * 旧实现把两者都吞成 null，BOM 或语法错误只显示「解析失败」而不说为什么。
 */
export const PKG_PROBE_STATUS = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  CORRUPT: 'corrupt',
})

/**
 * 宿主包在不在。unknown 是「没查成」（候选位置一个都没有），不是「查了没有」——
 * 把没查成当成不存在会让「已移除」的结论凭空成立。
 */
export const HOST_PRESENCE = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
})

/**
 * 符号文本搜索证据态。text-* 与 HOST_PRESENCE 的 present/absent **刻意不合并**：
 * 前者是「源码里有没有这个词」（弱证据，命中不代表 API 可用），
 * 后者是「包目录在不在」（强证据）。混为一谈会让弱证据冒充强证据。
 */
export const SYMBOL_TEXT_PRESENCE = Object.freeze({
  TEXT_PRESENT: 'text-present',
  TEXT_ABSENT: 'text-absent',
  UNKNOWN: 'unknown',
})

/** 检查项结论态。skip 与 unknown 都算「没判成」，但语义不同：skip 是主动跳过。
 *  warn 是「判成了但有顾虑」，不计入 fail 也不计入 unknown——发布预检的退出语义
 *  依赖这个区分（warn 不拦发布，unknown 拦）。 */
export const CHECK_VERDICT = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  SKIP: 'skip',
  UNKNOWN: 'unknown',
  WARN: 'warn',
})

/** PR 基线态真源在 lib/pr-gate.mjs（PR_BASELINE_STATES），这里不复制——
 *  复制就会变成第二份真源，pr-gate 改状态名时这里静默漂移。 */

/** 所有合法的状态值并集。自检用它做「字面量 == 词表」的对账。 */
export const ALL_STATUSES = Object.freeze([
  ...new Set([
    ...Object.values(STAGE_STATUS),
    ...Object.values(TYPECHECK_STATUS),
    ...Object.values(SMOKE_STATUS),
    ...Object.values(REAL_SMOKE_STATUS),
    ...Object.values(BUILD_STATUS),
    ...Object.values(LIFECYCLE_STATE),
    ...Object.values(HEALTH_STATUS),
    ...Object.values(PKG_PROBE_STATUS),
    ...Object.values(HOST_PRESENCE),
    ...Object.values(CHECK_VERDICT),
    ...Object.values(SYMBOL_TEXT_PRESENCE),
  ]),
])

/**
 * 阶段状态是否算「失败」（影响退出码 2）。
 * @param {string} status
 * @returns {boolean}
 */
export function isFailureStatus(status) {
  return status === STAGE_STATUS.ERROR || status === TYPECHECK_STATUS.FAIL || status === SMOKE_STATUS.FAIL || status === SMOKE_STATUS.ERROR
}

/**
 * 阶段状态是否算「未知」（--strict 下按失败处理）。
 * skipped 是未知：没验成与验干净是两回事。
 * @param {string} status
 * @returns {boolean}
 */
export function isUnknownStatus(status) {
  return status === STAGE_STATUS.SKIPPED
}

/**
 * 运行摘要 phases 的四态投影。
 *
 * 消费方（run-log.mjs list / doctor）按这份摘要判断「扫描没跑」与「扫描满分」，
 * 所以派生逻辑只有一份。
 *
 * 两种输入形状都要认，缺一个就是静默失配：
 *   1. run.mjs 全量报告：状态散在 record.scan / smoke / typecheck / realSmoke
 *   2. 账本直通的 fast-pass 记录：run.mjs:380 直接写 `phases: lastRun.phases`，
 *      没有 scan/smoke 字段。只认形状 1 时，直通记录会被投影成全 null，
 *      list 显示「?」、doctor 判「代码侧未核查」——明明是绿的。
 *      实录：2026-11-19T12:24:25.549Z 的直通记录被 doctor 判成 scan-unknown。
 *
 * @param {object} record 运行记录
 * @returns {{ scan: string|null, smoke: string|null, typecheck: string|null, realSmoke: string|null }}
 */
export function phasesOf(record) {
  // 形状 2 优先：直通记录自带 phases，且它已经是这份投影的结果，直接用。
  const direct = record.phases
  if (direct && typeof direct === 'object') {
    return {
      scan: direct.scan ?? null,
      smoke: direct.smoke ?? null,
      typecheck: direct.typecheck ?? null,
      realSmoke: direct.realSmoke ?? null,
    }
  }
  return {
    scan: record.scan?.error ? STAGE_STATUS.ERROR : record.scan?.skipped ? STAGE_STATUS.SKIPPED : record.scan ? STAGE_STATUS.OK : null,
    smoke: record.smoke == null ? null : record.smoke.skipped ? STAGE_STATUS.SKIPPED : record.smoke.success ? SMOKE_STATUS.OK : SMOKE_STATUS.FAIL,
    // --no-typecheck 产生的 { skipped: true } 没有 status 字段，也要归入 skipped
    typecheck: record.typecheck == null ? null : record.typecheck.status ?? (record.typecheck.skipped ? TYPECHECK_STATUS.SKIPPED : null),
    realSmoke: record.realSmoke == null ? null : record.realSmoke.skipped ? REAL_SMOKE_STATUS.SKIPPED : (record.realSmoke.status ?? null),
  }
}

/**
 * 索引摘要里除 phases 外的数值/布尔结论。
 *
 * 单独成函数是因为它有**两种输入形状**，与 phasesOf 完全同构：
 *   1. 全量报告：findings/criticalOrHigh 在 record.scan 下，得分在 record.audit 下
 *   2. 直通记录：结论直接记在顶层（run.mjs 的 fastRecord）
 * 只认形状 1 时，直通记录在 list 里显示「命中 ? 体检 ?」——与 phases 是同一个
 * 形状失配，只是漏在了另一组字段上。两处消费者（runlog.mjs 与夹具）共用这一份。
 * @param {object} record 运行记录
 * @returns {{ findings: number|null, criticalOrHigh: number|null, auditScore: number|null, smoke: boolean|null, typecheck: string|null }}
 */
export function summaryOf(record) {
  return {
    findings: record.scan?.findingCount ?? record.findings ?? null,
    criticalOrHigh: record.scan?.criticalOrHigh ?? record.criticalOrHigh ?? null,
    auditScore: record.audit?.overallScore ?? record.auditScore ?? null,
    smoke: record.smoke?.success ?? (record.phases?.smoke === SMOKE_STATUS.OK ? true : null),
    typecheck: record.typecheck?.status ?? null,
  }
}

/**
 * 统一投影 report.smoke 的最终形状，消除 run.mjs 中的多层三目嵌套。
 * @param {object|null} smokeResult quick-smoke.mjs 的输出
 * @param {object|undefined} stageSmoke stages.smoke（如未构建拦截）
 */
export function projectSmokeReport(smokeResult, stageSmoke) {
  if (smokeResult) {
    if (smokeResult.success) {
      return {
        success: true,
        durationMs: smokeResult.durationMs,
        registeredToolsCount: smokeResult.registeredToolsCount,
        mockFallbacks: smokeResult.mockFallbacks,
      }
    }
    return {
      status: SMOKE_STATUS.ERROR,
      success: false,
      stage: smokeResult.stage || 'runtime_execution',
      error: smokeResult.error,
      undeclaredInjectAccess: smokeResult.undeclaredInjectAccess,
      skipped: false,
    }
  }
  if (stageSmoke?.status === SMOKE_STATUS.ERROR) {
    return {
      status: SMOKE_STATUS.ERROR,
      success: false,
      stage: stageSmoke.stage || 'runtime_execution',
      error: stageSmoke.error,
      skipped: false,
    }
  }
  return { skipped: true }
}
