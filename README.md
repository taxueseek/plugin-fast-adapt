<div align="center">

# plugin-fast-adapt

**Keep your DeepSeek Harness plugins working across every host upgrade.**

When DSH updates, plugins often break silently due to SDK shifts, leftover cache files, or outdated configs. `plugin-fast-adapt` checks your environment, scans your plugin code directly against official upgrade guides, verifies fixes with millisecond in-memory tests, and scaffolds new plugins from scratch — with **zero external dependencies** and **313 built-in checks**.

[![CI](https://github.com/taxueseek/plugin-fast-adapt/actions/workflows/ci.yml/badge.svg)](https://github.com/taxueseek/plugin-fast-adapt/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/plugin-fast-adapt.svg)](https://www.npmjs.com/package/plugin-fast-adapt) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#dependencies) [![Self-test](https://img.shields.io/badge/self--test-313%20passing-brightgreen.svg)](#dependencies)

English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) · Latest field-verified: **DSH `0.2.2-rc.5`** (18 official guide versions) · [Safety posture](#safety-posture)

</div>

---

## Quick start (30 seconds)

### Run directly via CLI (for DSH users & plugin authors)

```sh
npx plugin-fast-adapt doctor --brief               # check host version, leftover files, stale processes & broken configs
npx plugin-fast-adapt fleet                        # scan all installed (Web/Desktop) & workspace plugins in one overview
npx plugin-fast-adapt check <plugin-dir>           # full check: env → official guide → breaking scan → audit → 4ms smoke → typecheck
npx plugin-fast-adapt new <ns>/<name> --form tool  # create a ready-to-run plugin template (5 types) & verify immediately
```

### Install as an AI Agent Skill (Claude Code / Codex / Cursor / DSH)

```sh
npx skills add taxueseek/plugin-fast-adapt
```

<details>
<summary>Other install options (Claude Code Marketplace / manual / DSH native bundle)</summary>

Claude Code marketplace:

```sh
/plugin marketplace add taxueseek/plugin-fast-adapt
/plugin install plugin-fast-adapt
```

Manual install:

```sh
git clone https://github.com/taxueseek/plugin-fast-adapt.git
# Point your agent at the repository root (where SKILL.md lives) as a skill directory
# Cursor users: cp -r plugin-fast-adapt/* .cursor/skills/plugin-fast-adapt/
```

</details>

## What it looks like

```text
Plugin my-plugin@1.2.0 × Host 0.2.2-rc.5 (window 0.2.1-rc.1 → 0.2.2-rc.4)
  scan       0 breaking hits (18 official guides + Release Notes virtual guides)
  audit      100/100 (perf 100 / resilience 100 / budget 100 / lifecycle 100)
  smoke      PASS in 4ms (in-memory Cordis mock, 0 undeclared-inject violations)
  typecheck  PASS
  note       0.2.2-rc.5 has no vendor guide yet — coverage stops at 0.2.2-rc.4
```

## Why plugin-fast-adapt

**Maintain the method of obtaining knowledge, not hand-curated upgrade cards.** Official breaking changes live in DeepSeek's `docs/upgrade-guide/<version>/<topic>/guide.md` and Release Notes; version state lives in npm `dist-tags`. Reading vendor sources directly means the tool catches up the moment upstream ships.

| Pain point | Traditional approach | `plugin-fast-adapt` |
| --- | --- | --- |
| Upstream ships a new release | Wait for hand-written upgrade cards (corridor gaps; -3.07 pp on weaker models with full card context) | Reads official `docs/upgrade-guide/` & Release Notes directly — zero lag |
| Verifying one fix | Real host cold start (up to 3,600 s timeout) | Millisecond in-memory Cordis smoke test (4ms); add `--real-smoke` for clean-profile real boot |
| Breaking-change scan noise | Naive regex: 12 findings, all 12 false positives | Four noise-reduction layers + word-boundary & semantic gates: **12 → 0 false positives**, with `guideFile:line` provenance |
| Silent post-upgrade failures | Manual log & overlay hunting | `doctor` proves `ghostHost` (running old process), `falseGreen` (broken `tsconfig` paths), and stale overlays (`env-heal` moves to `.trash/`) |
| Multi-plugin / Web + APP governance | Inspect plugins one by one | `fleet` sweeps Web, Desktop (`app.asar`), active processes & workspace in one lifecycle matrix, with `--apply-compat` & `--pr-ready` |
| Authoring a new plugin | Copy boilerplate & guess naming rules | `new` scaffolds 5 runnable forms (`tool` / `hook` / `service` / `config` / `llm-adapter`) with real base-class load checks & `write-gate` |
| Portability & trust | Heavy toolchain, hidden writes | **0 external dependencies** (Node 22.13+ built-ins + `git`/`npm`), macOS / Linux / Windows / Termux / containers, **313 offline assertions** |

## Four lanes

The main entry only routes. Each lane owns one job, and the agent reads the matching document instead of loading all four:

```
SKILL.md                      main skill: pick a lane + one-shot pipeline + cross-lane discipline
sub-skills/adapt/SKILL.md     upgrade adaptation: resolve version → fetch guide → scan hits → seams → smoke → audit
sub-skills/build/SKILL.md     plugin authoring: scaffold five forms + write-gate birth certificate
sub-skills/diagnose/SKILL.md  environment and boot failures: env-doctor + log-doctor + env-heal
sub-skills/review/SKILL.md    code review and architecture audit: P0/P1/P2/P3 grading + sub-agent dispatch
scripts/                      shared toolbox for all lanes, not split per lane
references/                   noise rules, migration SOP, CI template
```

<details>
<summary>Optional top-level skill aliases (build / diagnose / review)</summary>

`build`, `diagnose` and `review` also ship optional top-level aliases so they can trigger on their own (not required — the main skill reads the lane document by intent):

```sh
ln -s <repo>/sub-skills/build    ~/.agents/skills/dsh-plugin-build
ln -s <repo>/sub-skills/diagnose ~/.agents/skills/dsh-plugin-diagnose
ln -s <repo>/sub-skills/review   ~/.agents/skills/dsh-plugin-review
```

Host loaders cap `description` at 1024 characters and drop the whole skill when it overflows; the self-test guards that limit.

</details>

## Pipeline

### 1. Single Plugin Pipeline (run.mjs)

Run the whole chain with one command (recommended); every run writes a local log and updates the compatibility ledger:

```sh
node scripts/run.mjs <plugin-dir>        # env → version → guide → scan → build-check → audit → smoke → typecheck
node scripts/run.mjs <plugin-dir> --check-upstream # explicitly check upstream npm registry and release tags
node scripts/run.mjs <plugin-dir> --real-smoke   # plus one more tier: install & boot in a clean profile (bridges upstream verify-runtime)
node scripts/run.mjs <plugin-dir> --offline      # skip fetching vendor sources (no npm read, no clone); local all-step pipeline
node scripts/run.mjs <plugin-dir> --no-clone     # resolve the version but do not fetch the guide (use an existing local clone)
node scripts/run.mjs <plugin-dir> --strict       # exit 2 when the scan did not run or the guide does not cover the target version (CI)
node scripts/run-log.mjs list           # review past runs (tool version@commit included)
node scripts/run-log.mjs doctor         # cross-check run logs × host startup logs (first stop for "plugin erroring")
node scripts/run-log.mjs sanitize --latest --out share.json   # sanitise before sharing
node scripts/run-log.mjs sanitize --latest --pr-draft         # PR baseline guard: blocks on stale local copy or dirty worktree
npm run release-check                   # release preflight: version sync, tag, npm publish state, pack contents, self-test
```

### 2. Fleet Governance Board (fleet-sweep.mjs)

When upgrading DSH hosts or managing monorepos, sweep and categorize all plugins:

```sh
node scripts/fleet-sweep.mjs                   # full matrix board: running, workspace, web, app, disabled
node scripts/fleet-sweep.mjs --running         # active plugins currently loaded in running host
node scripts/fleet-sweep.mjs --workspace       # workspace source plugins only
node scripts/fleet-sweep.mjs --web             # Web profile plugins only
node scripts/fleet-sweep.mjs --app             # Desktop (APP) profile plugins only
node scripts/fleet-sweep.mjs --disabled        # disabled/inactive plugins and reasons
node scripts/fleet-sweep.mjs --target 0.2.2-rc.5 --apply-compat # batch adapt zero-hit plugins
node scripts/fleet-sweep.mjs --pr-ready [--offline]  # shortlist plugins safe to PR upstream (stale/dirty ones are blocked)
```

Detailed SOP and multi-platform practices are in [references/user-guide.md](references/user-guide.md).

You can also run each step on its own (the six-step spine remains; run.mjs just chains the steps below, and the optional ones are added as needed):

```sh
# 1. Inspect the local environment: installed version, stale overlay packages,
#    installed plugins, activation readiness. Also two silent-failure judges:
#    ghostHost (process still running old code) and falseGreen (tsconfig paths fake green)
node scripts/env-doctor.mjs <plugin-dir> --brief   # omit raw patch lines, 80.5KB -> 4.5KB

# 2. Resolve the target version: what is upstream's latest, should this machine follow it
node scripts/guide-sync.mjs <local-version>

# 2b. Upstream watch (cron/agent friendly): exit 1 = new version out (guides prefetched),
#     0 = nothing to do, 2 = could not determine
node scripts/guide-sync.mjs --check

# 3. Fetch the guide for the scan window target (managed branch snapshot first;
#    never leave --target empty and follow upstream's newest)
node scripts/guide-sync.mjs <local-version> --target <scan-target> --clone

# 4. Find which changes the plugin hits
node scripts/code-scan.mjs <plugin-dir> <upgrade-guide-dir> <local-version> <target-version>

# 4b. Seam query: dual-source verdict for a package/API symbol across the official
#     guide anchors and the local host install ("removed" is only concluded when both agree).
#     Without an explicit guide root it prefers the managed default-branch snapshot,
#     then falls back to the per-host cache.
#     Sub-packages live under the host package's own node_modules; see lib/host-scope.mjs
node scripts/seams.mjs dsh-settings
```

Heal stale overlay packages first when any are reported (dry-run by default):

```sh
node scripts/env-heal.mjs           # report only
node scripts/env-heal.mjs --apply   # move to ~/.dsh/.trash/<date>/, never delete
```

Two optional steps complete the "verify as you build, audit as you upgrade" loop:

```sh
# 5. Post-fix smoke verification: in-memory Cordis mock checks module loading,
#    the apply contract and tool registration. Undeclared-inject host-service
#    access is rejected with the same contract error the real host throws.
node scripts/quick-smoke.mjs <plugin-dir>

# 6. Four-dimension audit while you are at it: performance, resilience,
#    context budget, lifecycle
node scripts/plugin-audit.mjs <plugin-dir>
node scripts/plugin-audit.mjs <plugin-dir> --guide <guide-root> <local-version> <target-version>
node scripts/plugin-audit.mjs <plugin-dir> --guide <guide-root> <local-version> <target-version> --peer-patch  # print verified peer patches

# 7. One-command host-log diagnosis: StartupError / port-in-use /
#    undeclared inject / dead client entry
node scripts/log-doctor.mjs --pattern '^startup-' --limit 5

# 8. Sync the skill surface to a downstream skill directory (--check = drift only)
node scripts/sync-skill.mjs --dest <downstream-skill-dir> --check
```

## Scan accuracy: from 12 false positives to 0

A naive first version reported 12 findings on a real plugin; on inspection **all 12 were false positives**. The current version applies four layers of noise reduction, and the same plugin reports 0:

- The scanner uses a state machine to skip comments and strings, so a name mentioned in a comment is not a hit
- Full member chains win; overly generic parent chains like `ctx.tools` are dropped
- Generic words (`register`, `resolve`, `readFile`) and short names never become anchors; "old → new" replacement pairs are recognized, so a plugin already using the new symbol is not reported
- Constant anchors come only from the `Change` section; matching requires the object parts to be mutual suffixes, so `engines.dsh` never collides with `result.dsh`
- Package semantic gate: a package name becomes an anchor only when mentioned in a sentence with a removal/renaming verb — contextual mentions ("The mode fields of X accept only …", about field values) do not count. All 3 criticals reported on dsh-files were of this kind; the gate zeroed them

Each finding carries a `severity` (package=critical, member=high, code=medium — fix the front of the list first), an `evidence` line (the source line itself, so checking for false positives needs no file opening) and provenance anchors (`guideFile`/`guideLine`, pointing straight at the official guide's original location). The rules and the measurements behind them are in [references/heuristics.md](references/heuristics.md). Scan roots are the union of source roots (`src` plus sibling `client`/`web`/`ui`); build outputs (`lib`/`dist`) are not scanned twice. The smoke test discloses its mock fallbacks: the `mockFallbacks` list in the output names every property the plugin touched but the mock does not provide — the longer that list, the less the result can be trusted. **A passing smoke test is not host compatibility**, and the tool says so in its output, not just in the docs. The smoke test also rejects undeclared-`inject` host-service access at the `inject_contract` stage, matching the real Cordis contract, instead of letting load-time crashes pass silently. When you need real-host evidence, `run.mjs --real-smoke` bridges upstream plugin-upgrade's `verify-runtime.mjs`: install → boot → four-class attribution in a clean profile (honestly skipped with install guidance when the script is absent).

## Scaffold a plugin from zero

```sh
node scripts/scaffold.mjs <namespace>/<name> --form tool|hook|service|config|llm-adapter [--out <dir>] [--harness <version>]
```

One command emits a runnable plugin in five forms: package.json (build-free pure-ESM invariants), a complete entry implementation per form, a `cordis.patch.yml` mounting row, and a `dsh-plugin.naming.json` with collision-resistant naming projections derived in full (the output passes upstream validate-names in `--strict` mode). Non-empty target directories and invalid coordinates are rejected before anything is written.

The entry ships a working starting capability (echo tool, observing hook, example service method, config with defaults, OpenAI-compatible adapter) — swap in your own; the full contract still follows the five form references of [plugin-write](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-write).

Verification runs in two layers, and each layer reports when it is skipped: tool and hook use the dependency-free in-memory smoke test; all five forms run a real-base-class load check — when the host is installed, the entry is imported against the real `@deepseek-ai/*` base classes to prove the API is used correctly (Service inheritance and `super(ctx, name)`, real Schema validation, LlmAdapter inheritance and route registration). When no host is installed it is honestly skipped, never faked. When the capability is written, gate it in one command:

```sh
node scripts/write-gate.mjs <plugin-dir>   # birth certificate: hard gates auto-judged, soft metrics passed through
```

There are only three hard gates (entry artifact exists, smoke passes, zero critical findings against the official guide); a failing one exits 1. Audit scores, high/medium findings, mockFallbacks and the not-yet-mounted fact all land in the discretion section labelled for human judgment — the tool never says "qualified" on your behalf. Guide discovery reuses the guide-sync cache (zero network); a new plugin is scanned against the full historical corridor; pass `--skip-smoke` right after scaffolding to skip the duplicate smoke run.

## Dependencies

Zero external dependencies. Only Node built-ins (`node:fs`, `node:path`, `node:os`, `node:child_process`) plus the `git` and `npm` commands.

No TypeScript, no AST library, no HTTP client. Runs on Node 22.13+ (`import.meta.dirname` needs 20.11+, the optional type stripping needs 22.13+; type stripping is off by default).

Self-test:

```sh
npm test   # node scripts/self-test.mjs, 313 assertions
```

Contributors should enable the pre-commit gate (one time): `git config core.hooksPath .githooks` — every commit runs the self-test, so a forgotten downstream sync is caught at commit time.

Covers scanner false positives (names in comments and strings are not hits), false negatives, version heuristics, replacement-pair recognition, end-to-end findings (with guide file + line provenance anchors), dual-source seam-query verdicts (agree-removed / host-still-present disagreement / honest no-record), run-log × host-log cross-checks, the --real-smoke bridge tier (fail → exit 2 with a next-step pointer), the upstream-watch exit codes, the sync commit-command suggestion (adds only the synced path), SOP reference integrity, dist-tags cache states, smoke verification (including the undeclared-inject contract rejection), the four-dimension audit (including peer patches), activation diagnostics, ghost-host four states (stale/ok/unknown/no-running-host) with disk-time provenance, tsconfig paths fake green (extends chains, JSONC comments, wildcard prefixes, non-host aliases downgraded), the plugin scaffolder (all five forms, naming-projection grammar, smoke closure, patch-layer recognizability, invalid-input and non-empty-target rejection), the write gate (hard-gate interception, soft metrics never overrule, skip semantics, scaffold handoff), log diagnosis, downstream-sync drift checks plus a real-machine zero-drift gate, cache-root injection (the self-test never writes the real user cache), one-time run-log ledger migration (legacy `~/.cache` root moves to `~/.local/state`), a self-test size gate, a scanner performance gate, full incident-fixture regression (`fixtures/` cross-checked against `references/incident-ledger.md`, with both sides of every tightened criterion pinned), a single-source state-vocabulary check (`lib/run-states.mjs`), and a doc-layering check (process reports are archived under `docs-local/archive/` and never enter the skill surface). The self-test itself is zero-network and zero-dependency, and runs on any machine.

To gate your own plugin's repository at commit time (smoke/typecheck as hard gates, audit as a soft report), see [references/ci-snippet.md](references/ci-snippet.md).

## Scripts

| Script | Responsibility |
| --- | --- |
| `scripts/cli.mjs` | npm CLI entry (`npx plugin-fast-adapt doctor\|fleet\|check\|new`), keeps `<plugin-dir>` forwarding to run.mjs |
| `scripts/run.mjs` | One-command orchestration of the full chain (env → version → guide → scan → audit → smoke → typecheck), unified report plus a local run log; derives scan windows from `dshReleases`, supports `--profile <web\|desktop>` host anchoring, pure-JS `check`/`typecheck`, `--run-tests`, `--strict`, and `--real-smoke` cold boot |
| `scripts/run-log.mjs` | Run-log viewing (list/show), cross-checking (doctor: run logs × host startup logs) and sanitised export (sanitize) |
| `scripts/seams.mjs` | Seam query: dual-source verdict for one package/API symbol across official guide anchors and the local host install; prefers the managed default-branch snapshot when no explicit guide root is given |
| `scripts/scaffold.mjs` | Scaffold a plugin from zero: one command emits a runnable plugin in any of the five forms (package.json invariants + complete form entry + patch layer + naming projections), verified on creation |
| `scripts/write-gate.mjs` | Gate a finished plugin: orchestrates smoke + activation readiness + four-dimension audit + official-guide scan into a birth certificate; only three hard gates auto-judge, soft metrics pass through untouched |
| `scripts/env-doctor.mjs` | Probe the local DSH environment (version, overlay, plugins, processes, activation readiness, ghost host, tsconfig fake green) |
| `scripts/env-heal.mjs` | Heal stale overlay packages (dry-run by default) |
| `scripts/guide-sync.mjs` | Resolve the target version and fetch the official guide (managed default-branch snapshot, 1-hour TTL; release tags are an offline fallback marked `frozen`) |
| `scripts/release-check.mjs` | Release preflight: version sync, tag, npm publish state, `npm pack` contents, self-test and worktree; read-only, never tags or publishes |
| `scripts/code-scan.mjs` | Scan plugin code against official change anchors |
| `scripts/quick-smoke.mjs` | Post-fix smoke verification (in-memory Cordis mock, discloses fallbacks) |
| `scripts/plugin-audit.mjs` | Four-dimension performance & architecture audit, optional `--guide` cross-check; `--peer-patch` prints verified peer patches |
| `scripts/standards-scan.mjs` | Upstream standing-rule detection (7 mechanically-decidable rules with defensive-patterns provenance); `--rules` prints the table |
| `scripts/codemod.mjs` | Deterministic code/package-surface autofix (Loader entry exports, peer deps, top-level await); dry-run by default, `--apply` writes with a backup |
| `scripts/types-diff.mjs` | Host .d.ts and export-surface diff; synthesises virtual guides keyed by baseline version |
| `scripts/fix-peer-deps.mjs` | Batch-move host core packages from dependencies into peerDependencies (`--installed` filters out core libs and non-plugin transitive deps); dry-run by default, `--apply` writes with a backup |
| `scripts/fleet-sweep.mjs` | Fleet-wide governance and inspection with a matrix board and JSON report; skips `tmp/` and `fixtures/`, supports `--profile` filtering and `--dedupe` by realpath; `--apply-compat` backs up before batch-writing ledgers, `--pr-ready` shortlists plugins safe to PR upstream (APP judged via `app.asar` bundled packages) |
| `scripts/log-doctor.mjs` | One-command diagnosis of `~/.dsh/logs/` (startup header / failed plugins / waiting services / signal summary) |
| `scripts/sync-skill.mjs` | Sync the skill surface to a downstream skill directory; `--check` reports drift |
| `scripts/self-test.mjs` | Self-test |
| `scripts/lib/scanner.mjs` | Lexical scanner and version comparison (zero-dependency) |
| `scripts/lib/guide-parser.mjs` | Official guide parsing and anchor extraction |
| `scripts/lib/runlog.mjs` | Run-log writing, indexing and sanitisation |
| `scripts/lib/host-modules.mjs` | Resolves the host `@deepseek-ai/*` base classes and runs the real-base-class load check |
| `scripts/lib/package-json.mjs` | Single source for reading `package.json`: strips UTF-8 BOM, lenient/strict modes, missing/corrupt/ok tri-state |
| `scripts/lib/cache-root.mjs` | Single source for the cache root (`DSH_PFA_CACHE_DIR` > `DSH_CACHE_DIR` > `XDG_CACHE_HOME` > `~/.cache`); self-test can isolate it |
| `scripts/lib/backup.mjs` | Shared backup contract for the three autofix entry points: `{ backupDir, backupFiles, backupRel }`, `NO_BACKUP` when nothing changed |
| `references/user-guide.md` | Comprehensive user guide (local anchoring, cross-platform adaptability, Web/APP fleet governance, guardrails) |
| `references/legacy-migration-sop.md` | Legacy migration SOP (for ranges the official guide does not cover) |
| `references/heuristics.md` | Scan noise-reduction rules and the measurements behind them |
| `references/incident-ledger.md` | Incident ledger: one line per real false positive/negative, each pointing at a minimal reproduction under `fixtures/` |
| `references/ci-snippet.md` | CI gate template for plugin repositories (smoke/typecheck hard gates + audit soft report) |

## Safety posture

- **Execution & privilege boundary**: `quick-smoke` and `write-gate` import the plugin's entry module and run it **in the current Node process** (no `node:vm`, no worker thread, no subprocess). The plugin inherits the privileges of whoever ran the command (files, network, environment variables). Run them only on code you wrote or reviewed, never on an untrusted directory; use `--real-smoke` for an isolated install and boot inside a clean profile
- `env-doctor`, `code-scan`, `plugin-audit`, `log-doctor`, `seams` are strictly read-only; `run-log` is read-only except for `sanitize --out <file>`, which writes the sanitised result to the given path
- `env-heal` is dry-run by default and moves rather than deletes when applied (into `~/.dsh/.trash/<date>/`)
- `sync-skill` writes to a downstream skill directory explicitly, copying only the fixed skill surface (`SKILL.md`/`README*`/`references`/`scripts`/`sub-skills`); `--check`/`--dry-run` let you inspect first
- Never modifies DSH itself, nor config or profile declarations under `~/.dsh`
- Automatic plugin-code edits are limited to three mechanically-decidable classes, always with a backup first: `codemod` (Loader entry exports, top-level await), `fix-peer-deps` (host core package peer relocation) and `fleet-sweep --apply-compat` (batch `package.json` compatibility ledger and peer ranges). All report by default and write only with `--apply`/`--apply-compat`, backing up the original to `<plugin>/.pfa-backup/<timestamp>/`. Everything else reports findings and vendor fixes only; `plugin-audit --peer-patch` also prints rather than applies
- `.pfa-backup/` is the local snapshot taken before an autofix; it is listed in the release gate's `FORBIDDEN_PACK` and in the `.gitignore` that scaffold generates, because `npm pack` does include it (measured) and the backup holds the pre-edit `package.json`
- The cache root is injectable (`DSH_PFA_CACHE_DIR` > `DSH_CACHE_DIR` > `XDG_CACHE_HOME` > `~/.cache`); the self-test points it at a temp directory on startup and never writes the real user cache
- Network is used only for "fetching vendor sources": version resolution reads npm `dist-tags`, guide fetching clones the official repo. Both have timeouts and report failures explicitly instead of silently skipping; `dist-tags` is cached for 1 hour and degrades to the stale cache with a `stale` marker; guides reuse an existing local clone first, and `--no-clone` skips the fetch

## Legacy plugins

The official upgrade guide only goes back to dsh-v0.1.7-rc.2. For older plugins, follow the [legacy migration SOP](references/legacy-migration-sop.md): use the upstream [plugin-upgrade skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-upgrade)'s hand-curated card corridor (from dsh-v0.1.0-rc.8 on) as the difference source and walk an eight-stage checklist (mode → read-only prep → ghost-host check → corridor assembly → seven touchpoint classes → plan & confirm → implementation → six-layer validation). The SOP references rather than copies the cards, so renamed cards are caught by the self-test's dead-link assertion.

## Known limitations

- The official upgrade guide does not cover every breaking change (package retirement is one class that is not documented there); the `env-doctor` overlay inspection covers that case
- Same-named symbols can still collide (a plugin's `path.resolve()` versus the guide's `runtime.resolve()`) and require human judgment of the surrounding code
- Static matching only, no runtime-behaviour verification; the smoke mock covers the common host surface only
- The ghost-host check covers CLI host processes only: Windows has no `ps etime`, and desktop Electron renderers are excluded; both cases report `unknown` with the reason instead of guessing

## Provenance and division of work

This project was split out of [oh-my-dsh/dsh-plugin-upgrade-skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill) (a skill collection that teaches AI agents to upgrade DSH plugins, with an [arXiv paper](https://arxiv.org/abs/2609.30120)) via git subtree and has evolved independently since. As of 2026-10-26, the upstream project carries 198 upgrade cards, 12 skills and a 65-case auto-graded benchmark.

The two projects complement each other:

| Aspect | Upstream | This project |
| --- | --- | --- |
| Difference source | Hand-maintained upgrade cards | Official `docs/upgrade-guide/` + npm `dist-tags`, updates with upstream automatically |
| New release ships | Wait for cards, corridor gaps in between | Works immediately, zero changes needed |
| Verifying one change | Real host cold start, measured up to 3,600 s | In-memory Cordis smoke test, milliseconds to seconds |
| Stale overlay packages | Manual troubleshooting | `env-doctor` inspection + `env-heal` healing (dry-run by default) |
| Weaker models | Full card library in context, -3.07 pp | Six independent scripts, one small output each |
| Code-level scanning | None | Anchor matching + four noise-reduction layers |
| Fleet-wide sweep | `plugin-fleet-sweep` | Built-in `fleet-sweep.mjs` (Web / Desktop `app.asar` / workspace matrix + `--apply-compat` / `--pr-ready`) |

For historical corridors the official guide does not cover (before v0.1.7-rc.2), this project's SOP references upstream's cards and scripts — segments with a guide use this project's `code-scan`, segments without use upstream's `plan-migration.mjs` and cards, and runtime verification uses upstream's `verify-runtime.mjs` (directly bridgeable via this project's `run.mjs --real-smoke`).
