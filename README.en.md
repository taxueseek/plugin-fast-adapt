# plugin-fast-adapt

[简体中文](README.md) | English

[![CI](https://github.com/taxueseek/plugin-fast-adapt/actions/workflows/ci.yml/badge.svg)](https://github.com/taxueseek/plugin-fast-adapt/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.13-blue.svg)](package.json) [![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#dependencies) [![Self-test](https://img.shields.io/badge/self--test-198%20passing-brightgreen.svg)](#dependencies)

> **Every time DSH ships a new release, existing plugins can stop working.** This skill reads the vendor's official upgrade guide directly, scans your plugin code, and reports which breaking changes you hit together with the vendor's own fix instructions; it also scaffolds a runnable plugin from zero in one command and verifies it. **Now fully adapted for the latest DSH 0.2.2 series (including 0.2.2-alpha.2)**, featuring local environment anchoring, Release Note targeted extraction, and fleet multi-dimensional governance.

## At a glance

| | |
| --- | --- |
| Upstream ships a new release | Works immediately, zero changes (reads vendor sources and release notes, no hand-curated cards) |
| DSH Host Compatibility | **Fully adapted for latest DSH 0.2.2 series** (covers v0.1.7-rc.2 through 0.2.2-alpha.2) |
| Fleet Governance Board | One-click sweep across Web/APP installed plugins & workspace code with life-cycle matrix |
| Version Authority | Strictly anchors to the local installed host version by default (Plan B: 0 network requests) |
| Scan false positives | 12 → 0 (four noise-reduction layers + word boundary regex + virtual guide deduplication) |
| Verifying one change | 3,600 s real host cold start → millisecond-scale in-memory smoke test (with unbuilt check & host module fallback) |
| Ghost host | Warns when the disk has new code but the running process still executes the old one (compares process start time, not version strings) |
| Fake-green check | Warns when `tsconfig` `paths` point at a missing checkout, where TypeScript silently falls back to published types |
| Self-test | 198 assertions, runs offline |
| External dependencies | 0 (Node built-ins + the `git`/`npm` commands only) |
| Cross-platform | Native support for macOS, Linux standard paths, Termux Android, and containers (XDG-compliant) |
| Scaffolding | One command emits a runnable plugin in five forms, verified on creation, then a write gate issues the birth certificate |

## What problem it solves

DSH (DeepSeek Harness) is an AI runtime framework where everything is a plugin, and the trouble is that every new release can break existing plugins. The common workaround is hand-written upgrade cards: dozens of cards per version range, each recording what broke and how to fix it. That path has three problems it cannot get around:

1. **Cards go stale the moment they are written**. A single upstream jump can touch thousands of files, and there are "corridor gaps" the cards never cover.
2. **A large knowledge base crowds out reasoning**. In the paper's evaluation a weaker model (qwen3.8-27b) scored -3.07 pp worse with the full card library loaded (equal-weight difference over 56 tasks: 7 improved, 18 regressed, 31 flat).
3. **Verification is expensive**. Every change needs a real host cold start (a 3,600-second timeout is on record), and stale packages left in the profiles overlay after a host upgrade break plugin loading.

This project takes a different approach: **maintain the method of obtaining knowledge, not the knowledge itself.** The authoritative description of breaking changes lives in the vendor harness repository at `docs/upgrade-guide/<version>/<topic>/guide.md`, updated with each release in a fixed format (`## Change` for what changed, `## Migration` for how to fix it); version information lives in the npm registry's `dist-tags`. Both are vendor sources, so the skill catches up the moment upstream ships.

### Advantages

- **Full adaptation for latest DSH 0.2.2 series**: reads the official `docs/upgrade-guide/` and Release Notes directly, covering breaking change anchors and official migrations in 0.2.2-alpha.2; generates virtual guides and speeds up scans with a 3-tuple compatibility ledger
- **Local environment authority anchoring (zero network reliance)**: defaults to the locally installed DSH host version (Plan B, 0 external network requests), eliminating upstream network jitters and GitHub rate limits; uses `--check-upstream` for explicit check
- **Fleet multi-dimensional governance board**: introduces `fleet-sweep.mjs` to inspect workspace code, installed Web plugins, APP desktop plugins, and active processes in a multi-stage life-cycle matrix, with `--apply-compat` batch safe patching
- **Hard guards against false positives & unbuilt traps**:
  - Four noise-reduction layers + regex word boundaries (preventing `ABORTED` matching `FS_ABORTED`)
  - Virtual release note & official guide deduplication
  - Unbuilt TypeScript plugin hard gate (blocks and guides `pnpm run build` when missing `lib/index.js`)
  - Bundle Resolution Shadow detection for host-bundled packages
  - Exit code 143 (`SIGTERM`) acknowledged as graceful shutdown, eliminating false crash alarms
  - Auto Schemastery `Config({})` parsing and temporary host `node_modules` fallback symlinking during smoke tests
- **Cross-platform & container ready**: eliminates hardcoded directory assumptions, supporting Linux standard paths (`/usr/lib/node_modules`), Termux on Android (`$PREFIX/lib/node_modules`), `npm_config_prefix`, `DSH_HOST_PATH` / `DSH_LOCATION` env overrides, and XDG cache specs
- **Cheap verification**: in-memory Cordis smoke test returns in milliseconds to seconds without a real host cold start; `--real-smoke` provides real-host isolated profile boot verification
- **Zero external dependencies**: Node built-ins plus `git`/`npm` commands only
- **Reproducible**: 198 assertions, runs offline; CI runs on ubuntu, macOS, and Windows
- **More than adaptation**: `scaffold.mjs` emits a runnable plugin in five forms in one command, and `write-gate.mjs` issues a birth certificate
- **Silent failures have hard evidence**: `ghostHost` compares process start time against disk change time; `falseGreen` catches TypeScript silent fallbacks
- **Honest about its limits**: passing smoke test ≠ host compatibility, and the tool states this clearly in its output

## Three lanes

The main entry only routes. Each lane owns one job, and the agent reads the matching document instead of loading all three:

```
SKILL.md                      main skill: pick a lane + one-shot pipeline + cross-lane discipline
sub-skills/adapt/SKILL.md     upgrade adaptation: resolve version → fetch guide → scan hits → seams → smoke → audit
sub-skills/build/SKILL.md     plugin authoring: scaffold five forms + write-gate birth certificate
sub-skills/diagnose/SKILL.md  environment and boot failures: env-doctor + log-doctor + env-heal
scripts/                      shared toolbox for all lanes, not split per lane
references/                   noise rules, migration SOP, CI template
```

`build` and `diagnose` also ship optional top-level aliases so they can trigger on their own (they are not required — the main skill reads the lane document by intent):

```sh
ln -s <repo>/sub-skills/build    ~/.agents/skills/dsh-plugin-build
ln -s <repo>/sub-skills/diagnose ~/.agents/skills/dsh-plugin-diagnose
```

The aliases exist so "author a plugin" and "installed but not working" each get their own trigger surface instead of competing inside one `description`. Host loaders cap `description` at 1024 characters and drop the whole skill when it overflows (they do not truncate); the self-test now guards that limit.

## Install

With the [skills CLI](https://github.com/vercel-labs/skills) (recommended — one command installs to every supported agent):

```sh
npx skills add taxueseek/plugin-fast-adapt
```

Claude Code marketplace:

```sh
/plugin marketplace add taxueseek/plugin-fast-adapt
/plugin install plugin-fast-adapt
```

npm (ships a `plugin-fast-adapt` command that forwards to the one-command pipeline):

```sh
npx plugin-fast-adapt <plugin-dir>
```

Manual install:

```sh
git clone https://github.com/taxueseek/plugin-fast-adapt.git
# Point your agent at the repository root (where SKILL.md lives) as a skill directory
# Cursor users: cp -r plugin-fast-adapt/* .cursor/skills/plugin-fast-adapt/
```

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
node scripts/fleet-sweep.mjs --target 0.2.2-alpha.2 --apply-compat # batch adapt zero-hit plugins
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
#     guide anchors and the local host install ("removed" is only concluded when both agree)
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
npm test   # node scripts/self-test.mjs, 198 assertions
```

Contributors should enable the pre-commit gate (one time): `git config core.hooksPath .githooks` — every commit runs the self-test, so a forgotten downstream sync is caught at commit time.

Covers scanner false positives (names in comments and strings are not hits), false negatives, version heuristics, replacement-pair recognition, end-to-end findings (with guide file + line provenance anchors), dual-source seam-query verdicts (agree-removed / host-still-present disagreement / honest no-record), run-log × host-log cross-checks, the --real-smoke bridge tier (fail → exit 2 with a next-step pointer), the upstream-watch exit codes, the sync commit-command suggestion (adds only the synced path), SOP reference integrity, dist-tags cache states, smoke verification (including the undeclared-inject contract rejection), the four-dimension audit (including peer patches), activation diagnostics, ghost-host four states (stale/ok/unknown/no-running-host) with disk-time provenance, tsconfig paths fake green (extends chains, JSONC comments, wildcard prefixes, non-host aliases downgraded), the plugin scaffolder (all five forms, naming-projection grammar, smoke closure, patch-layer recognizability, invalid-input and non-empty-target rejection), the write gate (hard-gate interception, soft metrics never overrule, skip semantics, scaffold handoff), log diagnosis, downstream-sync drift checks plus a real-machine zero-drift gate, cache-root injection (the self-test never writes the real user cache), one-time run-log ledger migration (legacy `~/.cache` root moves to `~/.local/state`), a self-test size gate and a scanner performance gate. The self-test itself is zero-network and zero-dependency, and runs on any machine.

To gate your own plugin's repository at commit time (smoke/typecheck as hard gates, audit as a soft report), see [references/ci-snippet.md](references/ci-snippet.md).

## Scripts

| Script | Responsibility |
| --- | --- |
| `scripts/cli.mjs` | npm entry (`npx plugin-fast-adapt`), forwards to run.mjs |
| `scripts/run.mjs` | One-command orchestration of the full chain (env → version → guide → scan → audit → smoke → typecheck), unified report plus a local run log; `--real-smoke` bridges upstream verify-runtime for a real-cold-boot tier |
| `scripts/run-log.mjs` | Run-log viewing (list/show), cross-checking (doctor: run logs × host startup logs) and sanitised export (sanitize) |
| `scripts/seams.mjs` | Seam query: dual-source verdict for one package/API symbol across official guide anchors and the local host install |
| `scripts/scaffold.mjs` | Scaffold a plugin from zero: one command emits a runnable plugin in any of the five forms (package.json invariants + complete form entry + patch layer + naming projections), verified on creation |
| `scripts/write-gate.mjs` | Gate a finished plugin: orchestrates smoke + activation readiness + four-dimension audit + official-guide scan into a birth certificate; only three hard gates auto-judge, soft metrics pass through untouched |
| `scripts/env-doctor.mjs` | Probe the local DSH environment (version, overlay, plugins, processes, activation readiness, ghost host, tsconfig fake green) |
| `scripts/env-heal.mjs` | Heal stale overlay packages (dry-run by default) |
| `scripts/guide-sync.mjs` | Resolve the target version and fetch the official guide (managed default-branch snapshot, 1-hour TTL; release tags are an offline fallback marked `frozen`) |
| `scripts/release-check.mjs` | Release preflight: version sync, tag, npm publish state, `npm pack` contents, self-test and worktree; read-only, never tags or publishes |
| `scripts/code-scan.mjs` | Scan plugin code against official change anchors |
| `scripts/quick-smoke.mjs` | Post-fix smoke verification (in-memory Cordis mock, discloses fallbacks) |
| `scripts/plugin-audit.mjs` | Four-dimension performance & architecture audit, optional `--guide` cross-check; `--peer-patch` prints verified peer patches |
| `scripts/log-doctor.mjs` | One-command diagnosis of `~/.dsh/logs/` (startup header / failed plugins / waiting services / signal summary) |
| `scripts/sync-skill.mjs` | Sync the skill surface to a downstream skill directory; `--check` reports drift |
| `scripts/self-test.mjs` | Self-test |
| `scripts/lib/scanner.mjs` | Lexical scanner and version comparison (zero-dependency) |
| `scripts/lib/guide-parser.mjs` | Official guide parsing and anchor extraction |
| `scripts/lib/host-modules.mjs` | Resolves the host `@deepseek-ai/*` base classes and runs the real-base-class load check |
| `references/user-guide.md` | Comprehensive user guide (local anchoring, cross-platform adaptability, Web/APP fleet governance, guardrails) |
| `references/legacy-migration-sop.md` | Legacy migration SOP (for ranges the official guide does not cover) |
| `references/heuristics.md` | Scan noise-reduction rules and the measurements behind them |
| `references/ci-snippet.md` | CI gate template for plugin repositories (smoke/typecheck hard gates + audit soft report) |

## Safety posture

- `env-doctor`, `code-scan`, `plugin-audit`, `log-doctor`, `seams` and `run-log` are strictly read-only
- `env-heal` is dry-run by default and moves rather than deletes when applied (into `~/.dsh/.trash/<date>/`)
- `sync-skill` writes to a downstream skill directory explicitly, copying only the fixed skill surface (`SKILL.md`/`README*`/`references`/`scripts`/`sub-skills`); `--check`/`--dry-run` let you inspect first
- Never modifies DSH itself, nor config or profile declarations under `~/.dsh`
- Never edits plugin code automatically; it reports findings and vendor fixes only, and `--peer-patch` prints rather than applies
- Network is used only for "fetching vendor sources": version resolution reads npm `dist-tags`, guide fetching clones the official repo. Both have timeouts and report failures explicitly instead of silently skipping; `dist-tags` is cached for 1 hour and degrades to the stale cache with a `stale` marker; guides reuse an existing local clone first, and `--no-clone` skips the fetch

## Legacy plugins

The official upgrade guide only goes back to dsh-v0.1.7-rc.2. For older plugins, follow the [legacy migration SOP](references/legacy-migration-sop.md): use the upstream [plugin-upgrade skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-upgrade)'s hand-curated card corridor (from dsh-v0.1.0-rc.8 on) as the difference source and walk a seven-stage checklist (mode → read-only prep → ghost-host check → corridor assembly → seven touchpoint classes → plan & confirm → six-layer validation). The SOP references rather than copies the cards, so renamed cards are caught by the self-test's dead-link assertion.

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
| Fleet-wide sweep | `plugin-fleet-sweep` owns breadth | The six-step pipeline owns depth |

A fleet-wide sweep after a host upgrade goes to upstream's [plugin-fleet-sweep](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-fleet-sweep) (breadth), and each flagged plugin comes back to this project's six-step pipeline for a deep pass (depth). For historical corridors the official guide does not cover (before v0.1.7-rc.2), this project's SOP references upstream's cards and scripts — segments with a guide use this project's `code-scan`, segments without use upstream's `plan-migration.mjs` and cards, and runtime verification uses upstream's `verify-runtime.mjs` (directly bridgeable via this project's `run.mjs --real-smoke`).
