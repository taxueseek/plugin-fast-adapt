# plugin-fast-adapt

[简体中文](README.md) | English

DSH plugin adaptation and breaking-change detection. Checks the vendor's latest release, pulls that version's official upgrade guide, scans local plugin code, and reports which breaking changes the plugin hits together with the vendor's own fix instructions — plus local DSH environment inspection and a post-upgrade performance & architecture audit.

> **Provenance**: this project is derived from [oh-my-dsh/dsh-plugin-upgrade-skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill) (a skill collection that teaches AI agents to upgrade DSH plugins, with an [arXiv paper](https://arxiv.org/abs/2609.30120)), split into an independent repository via git subtree and evolved independently. The upstream project carries 195 hand-maintained upgrade cards, 11 skills and a 63-case auto-graded benchmark; this project keeps and hardens only the "adapt a plugin to a new DSH" path, replacing its heaviest component — the hand-curated card mode.

## Why a rewrite

The upstream project's core asset is a migration card library: dozens of hand-written cards per version range, each describing what broke and how to fix it. The paper's own measurements exposed three problems with that approach:

1. **Card lag is inevitable**. A single upstream DSH jump can touch thousands of files, so cards are stale the moment they are written, with coverage gaps ("corridor gaps") in between.
2. **Long-context negative transfer on weaker models**. In the paper's evaluation, a weaker model (qwen3.8-27b) scored **-3.07 pp** worse with the full card library loaded (equal-weight difference over 56 tasks: 7 improved, 18 regressed, 31 flat) — a large knowledge base helps strong models and crowds out reasoning in weak ones.
3. **Verification is expensive, and the environment lies**. Every change needs a real host cold start to verify (issue #171 recorded a 3,600-second timeout); and after a host upgrade, stale packages left in the profiles overlay take precedence during resolution and break plugin loading (the issue #263 class of incidents) — the failure recurs if you swap files without restarting.

This project takes a different approach: **maintain the method of obtaining knowledge, not the knowledge itself.**

The authoritative description of breaking changes lives in the vendor harness repository at `docs/upgrade-guide/<version>/<topic>/guide.md`, updated with each release in a fixed format (`## Change` for what changed, `## Migration` for how to fix it). Version information lives in the npm registry's `dist-tags`. Both are vendor sources, so **the skill catches up the moment upstream ships** — there is no card lag.

### How the two approaches compare

| Aspect | Upstream (hand-curated card corridor) | This project |
| --- | --- | --- |
| Difference source | 195 hand-maintained upgrade cards | Official `docs/upgrade-guide/` + npm `dist-tags`, updates with upstream automatically |
| New release ships | Wait for cards, corridor gaps in between | Works immediately, zero changes needed |
| Verifying one change | Real host cold start, measured up to 3,600 s | In-memory Cordis smoke test, milliseconds to seconds |
| Stale overlay packages | Manual troubleshooting (issue #263 class) | `env-doctor` inspection + `env-heal` healing (dry-run by default) |
| Weaker models | Full card library in context, -3.07 pp | Six independent scripts, one small output each |
| Code-level scanning | None | Anchor matching + four noise-reduction layers (measured below) |
| Dependencies | — | Zero external: Node built-ins + `git`/`npm` commands |
| Self-test | — | 64 assertions, zero network, runs on any machine |

## Six steps

```sh
# 1. Inspect the local environment: installed version, stale overlay packages,
#    installed plugins, activation readiness
node scripts/env-doctor.mjs <plugin-dir>

# 2. Resolve the target version: what is upstream's latest, should this machine follow it
node scripts/guide-sync.mjs <local-version>

# 3. Fetch that version's official upgrade guide (reuses a local clone when present)
node scripts/guide-sync.mjs <local-version> --clone

# 4. Find which changes the plugin hits
node scripts/code-scan.mjs <plugin-dir> <upgrade-guide-dir> <local-version> <target-version>
```

Heal stale overlay packages first when any are reported (dry-run by default):

```sh
node scripts/env-heal.mjs           # report only
node scripts/env-heal.mjs --apply   # move to ~/.dsh/.trash/<date>/, never delete
```

Two optional steps complete the "verify as you build, audit as you upgrade" loop:

```sh
# 5. Post-fix smoke verification: in-memory Cordis mock checks module loading,
#    the apply contract and tool registration
node scripts/quick-smoke.mjs <plugin-dir>

# 6. Four-dimension audit while you are at it: performance, resilience,
#    context budget, lifecycle
node scripts/plugin-audit.mjs <plugin-dir>
node scripts/plugin-audit.mjs <plugin-dir> --guide <guide-root> <local-version> <target-version>
```

## Scan accuracy: from 12 false positives to 0

A naive first version reported 12 findings on a real plugin; on inspection **all 12 were false positives**. The current version applies four layers of noise reduction, and the same plugin reports 0:

- The scanner uses a state machine to skip comments and strings, so a name mentioned in a comment is not a hit
- Full member chains win; overly generic parent chains like `ctx.tools` are dropped
- Generic words (`register`, `resolve`, `readFile`) and short names never become anchors; "old → new" replacement pairs are recognized, so a plugin already using the new symbol is not reported
- Constant anchors come only from the `Change` section; matching requires the object parts to be mutual suffixes, so `engines.dsh` never collides with `result.dsh`
- Package semantic gate: a package name becomes an anchor only when mentioned in a sentence with a removal/renaming verb — contextual mentions ("The mode fields of X accept only …", about field values) do not count. All 3 criticals reported on dsh-files were of this kind; the gate zeroed them

Each finding carries a `severity` (package=critical, member=high, code=medium — fix the front of the list first) and an `evidence` line (the source line itself, so checking for false positives needs no file opening). The rules and the measurements behind them are in [references/heuristics.md](references/heuristics.md). The smoke test discloses its mock fallbacks: the `mockFallbacks` list in the output names every property the plugin touched but the mock does not provide — the longer that list, the less the result can be trusted. **A passing smoke test is not host compatibility**, and the tool says so in its output, not just in the docs.

## Install

With the [skills CLI](https://github.com/vercel-labs/skills) (recommended — one command installs to every supported agent):

```sh
npx skills add taxueseek/plugin-fast-adapt
```

Manual install:

```sh
git clone https://github.com/taxueseek/plugin-fast-adapt.git
# Point your agent at the repository root (where SKILL.md lives) as a skill directory
# Cursor users: cp -r plugin-fast-adapt/* .cursor/skills/plugin-fast-adapt/
```

## Dependencies

Zero external dependencies. Only Node built-ins (`node:fs`, `node:path`, `node:os`, `node:child_process`) plus the `git` and `npm` commands.

No TypeScript, no AST library, no HTTP client. Runs on Node 22.13+ (`import.meta.dirname` needs 20.11+, the optional type stripping needs 22.13+; type stripping is off by default).

Self-test:

```sh
npm test   # node scripts/self-test.mjs, 64 assertions
```

Covers scanner false positives (names in comments and strings are not hits), false negatives, version heuristics, replacement-pair recognition, end-to-end findings, SOP reference integrity, dist-tags cache states, smoke verification, the four-dimension audit, activation diagnostics and a scanner performance gate. Zero network, zero external dependencies, runs on any machine.

## Scripts

| Script | Responsibility |
| --- | --- |
| `scripts/env-doctor.mjs` | Probe the local DSH environment (version, overlay, plugins, processes, activation readiness) |
| `scripts/env-heal.mjs` | Heal stale overlay packages (dry-run by default) |
| `scripts/guide-sync.mjs` | Resolve the target version and fetch the official guide (dist-tags cached 1 h, degrades to stale cache) |
| `scripts/code-scan.mjs` | Scan plugin code against official change anchors |
| `scripts/quick-smoke.mjs` | Post-fix smoke verification (in-memory Cordis mock, discloses fallbacks) |
| `scripts/plugin-audit.mjs` | Four-dimension performance & architecture audit, optional `--guide` cross-check |
| `scripts/self-test.mjs` | Self-test |
| `scripts/lib/scanner.mjs` | Lexical scanner and version comparison (zero-dependency) |
| `scripts/lib/guide-parser.mjs` | Official guide parsing and anchor extraction |
| `references/legacy-migration-sop.md` | Legacy migration SOP (for ranges the official guide does not cover) |
| `references/heuristics.md` | Scan noise-reduction rules and the measurements behind them |

## Safety posture

- `env-doctor`, `code-scan` and `plugin-audit` are strictly read-only
- `env-heal` is dry-run by default and moves rather than deletes when applied (into `~/.dsh/.trash/<date>/`)
- Never modifies DSH itself, nor config or profile declarations under `~/.dsh`
- Never edits plugin code automatically; it reports findings and vendor fixes only
- Network is used only with `--clone`, always with a timeout, and failures are reported explicitly instead of silently skipped

## Legacy plugins

The official upgrade guide only goes back to dsh-v0.1.7-rc.2. For older plugins, follow the [legacy migration SOP](references/legacy-migration-sop.md): use the upstream [plugin-upgrade skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-upgrade)'s hand-curated card corridor (from dsh-v0.1.0-rc.8 on) as the difference source and walk a seven-stage checklist (mode → read-only prep → ghost-host check → corridor assembly → seven touchpoint classes → plan & confirm → six-layer validation). The SOP references rather than copies the cards, so renamed cards are caught by the self-test's dead-link assertion.

## Known limitations

- The official upgrade guide does not cover every breaking change (package retirement is one class that is not documented there); the `env-doctor` overlay inspection covers that case
- Same-named symbols can still collide (a plugin's `path.resolve()` versus the guide's `runtime.resolve()`) and require human judgment of the surrounding code
- Static matching only, no runtime-behaviour verification; the smoke mock covers the common host surface only

## Division of work with upstream

The two projects complement each other: upstream keeps the card library, the unified workflow and the benchmark; this project owns the "adapt to a new version" main path. A fleet-wide sweep after a host upgrade goes to upstream's [plugin-fleet-sweep](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-fleet-sweep) (breadth), and each flagged plugin comes back to this project's six-step pipeline for a deep pass (depth). For historical corridors the official guide does not cover (before v0.1.7-rc.2), this project's SOP references upstream's cards and scripts — segments with a guide use this project's `code-scan`, segments without use upstream's `plan-migration.mjs` and cards, and runtime verification uses upstream's `verify-runtime.mjs`.
