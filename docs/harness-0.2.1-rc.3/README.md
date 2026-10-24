# Harness 0.2.1-rc.3 compatibility

`0.1.27` moves the development cohort to `0.2.1-rc.3` and stops enumerating exact host versions in peer declarations. `0.2.1-rc.2` stays a supported legacy target.

## Why the peer declarations changed

`0.1.25` fixed installation on `0.2.1-rc.2` by adding that exact version to every `@deepseek-ai/dsh-*` peer range. That keeps the current host installable and makes every *future* host uninstallable until a plugin release adds it, which is a release-per-host-release tax for users and for the maintainer. From `0.1.27`:

- `peerDependencies` for the whole `@deepseek-ai/dsh*` cohort are `*`, so `dsh plugin add` (and npm/pnpm resolution) never rejects a host because of its version.
- The tested matrix and the claimed range live in [compatibility.json](../../compatibility.json) — `supportedHosts` (exact, tested, with tracks) and `hostCorridor` (npm-range syntax, one comparator set per supported line). `scripts/compatibility.mjs` enforces that every declared target sits inside the corridor, that the development baseline and every `pnpm` override still name one exact cohort, and that no peer reintroduces an exact enumeration.
- `doctor` accepts a host inside the corridor as `corridor-untested` and says so in its `limits`; it still fails on a mixed cohort, a missing runtime peer, a duplicate identity or a host outside the corridor.
- This is honest only because the runtime is capability-based: `src/harness-compat.ts` selects `startActivation` / `startContinuable` / the host delivery symbols and throws a named `unsupported Harness subagent contract (…)` diagnostic when none is available. Installation succeeding is not a claim that an untested host behaves.

## 0.2.1-rc.2 → 0.2.1-rc.3

- npm dist-tags on 2026-10-24: `latest` = `0.2.1-rc.2`, `next` = `0.2.1-rc.3`; the desktop runtime on the maintainer machine embeds `0.2.1-rc.3`.
- The rc.3 closure resolves 300 packages; every one of the 305 pinned overrides in `pnpm-workspace.yaml` still exists at rc.3, so the cohort moves with a version substitution and a lockfile update.
- No agent, session, subagent, tools, system-prompt, commands or plugin-manager contract used by AgentTeams changed between the two versions: `pnpm build`, `pnpm typecheck` and `pnpm verify:harness-contract` pass with no source change.
- The client half compiles against the rc.3 client packages (`dsh-client-ui-*`, `dsh-client-store`, `dsh-client-ui-slots`) unchanged.

## Verification performed

On Windows, Node 22.23.0, pnpm 11.28.5, with a complete rc.3 cohort installed from the registry:

```sh
pnpm install            # rc.3 closure, 300 packages
pnpm typecheck          # both tsconfigs
pnpm build              # tsc + tsdown + git-artifact stamp (schema 2)
node scripts/verify.mjs # 8/8 offline suites
pnpm verify:harness-contract
pnpm verify:compatibility
node --test scripts/compatibility.test.mjs
pnpm verify:package
```

## Limits

- Two tests cannot run on this machine: `scripts/compatibility.test.mjs` ("doctor runs through an installed bin symlink") and `scripts/quality-gates-work-order.test.mjs` (#174 symlink traversal) both need `symlink()` permission, which Windows only grants with Developer Mode or an elevated token; they fail with `EPERM` before exercising any product code. This is an environment limit, not a regression, and it was already failing on `0.1.26`.
- The `plugin-manager-install` scenario in `scripts/harness-runtime-verify.mjs` needs a downloaded host cohort; it was not run here. It is now keyed to `policy.recommendedHost` so it follows the matrix instead of a hard-coded version.
- No real provider credentials, no desktop interaction and no migration of existing user data were exercised. A green gate is not a desktop acceptance test.

## Recovery

Existing published artifacts and tags are immutable. To stay on the previous pair, install `@nanmicoder/dsh-agent-teams@0.1.26` on Harness `0.2.1-rc.2`. Do not bypass host compatibility checks by deleting user data.
