import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseWorkspacePolicy } from './workspace-policy.mjs'

export const policy = JSON.parse(readFileSync(new URL('../compatibility.json', import.meta.url), 'utf8'))
// Read through the tolerant reader: pnpm appends its own YAML keys to this file
// on every install, so a bare JSON.parse breaks the gate, not the install.
export const workspacePolicy = parseWorkspacePolicy(readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'))

// Contract consumed by the published server entry and client module table.
// Keeping this independent from package.json catches accidentally deleted peers.
export const requiredHostPeers = [
  '@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'react',
  ...[
    'agent', 'api-session-controller', 'client-connection', 'client-locale',
    'client-store', 'client-ui-chat', 'client-ui-conversation', 'client-ui-layout',
    'client-ui-model-selection', 'client-ui-primitives', 'client-ui-renderer',
    'client-ui-session', 'client-ui-slots', 'commands', 'llm', 'session',
    'session-projection', 'subagent', 'system-prompt', 'tools', 'util-values',
  ].map(name => `@deepseek-ai/dsh-${name}`),
]

// These are value imports of the server entry, so optional-peer metadata does
// not make an unresolved installation executable. Client services can instead
// be supplied by the host's browser module table.
export const serverRuntimePeers = [
  '@deepseek-ai/schemastery', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-tools',
]

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/
const COMPARATOR_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Parse the `X.Y.Z[-pre]` form this policy uses. Returns null for anything
 * else, so callers can reject a floating or malformed target instead of
 * silently accepting it.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = COMPARATOR_VERSION.exec(value.trim())
  if (!match || value.trim() !== value) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  }
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  // A numeric identifier always has lower precedence than an alphanumeric one.
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Ascending order; a release sorts after every prerelease of itself. */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (!left.prerelease && !right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const order = compareIdentifiers(leftPart, rightPart)
    if (order !== 0) return order
  }
  return 0
}

function parseComparator(token) {
  const match = /^(>=|<=|>|<)?(.*)$/.exec(token)
  const version = parseVersion(match[2])
  if (!version) throw new Error(`Corridor comparator is not an exact version: ${token}`)
  return { operator: match[1] ?? '=', version }
}

function matchesComparator(candidate, { operator, version }) {
  const order = compareVersions(candidate, version)
  if (operator === '>=') return order >= 0
  if (operator === '<=') return order <= 0
  if (operator === '>') return order > 0
  if (operator === '<') return order < 0
  return order === 0
}

/**
 * A corridor is a disjunction of comparator sets, the same shape a package
 * manager writes into a peer range: `>=0.2.1-rc.1 <0.3.0 || >=0.1.5-rc.1 <0.1.6-0`.
 *
 * Prerelease targets follow npm's rule: a prerelease only matches a set that
 * names a prerelease of the very same `X.Y.Z`, which is why every line in the
 * corridor is anchored at the oldest prerelease that line still accepts. A
 * plain `>=0.1.2-alpha.2 <0.3.0` would silently exclude every 0.2.x prerelease.
 */
export function satisfiesCorridor(version, corridor) {
  const candidate = parseVersion(version)
  if (!candidate || typeof corridor !== 'string' || corridor.trim() === '') return false
  let anySetParsed = false
  for (const rawSet of corridor.split('||')) {
    const tokens = rawSet.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const comparators = tokens.map(parseComparator)
    anySetParsed = true
    if (!comparators.every(comparator => matchesComparator(candidate, comparator))) continue
    if (candidate.prerelease && !comparators.some(({ version: bound }) => bound.prerelease !== null
        && bound.major === candidate.major && bound.minor === candidate.minor && bound.patch === candidate.patch)) continue
    return true
  }
  if (!anySetParsed) throw new Error(`Corridor has no comparator set: ${corridor}`)
  return false
}

export function validatePolicy(input) {
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) throw new Error('Unsupported compatibility policy')
  if (input.previewTag !== 'next') throw new Error('Unsupported compatibility policy')
  const hosts = input.supportedHosts
  if (!Array.isArray(hosts) || hosts.length === 0) throw new Error('supportedHosts must list exact tested host targets')
  const versions = new Set()
  for (const host of hosts) {
    if (typeof host.version !== 'string' || !EXACT_VERSION.test(host.version)
        || host.version.trim() !== host.version || versions.has(host.version)
        || !['recommended', 'preview', 'legacy'].includes(host.track)) {
      throw new Error('Host targets must be unique exact versions with an explicit track')
    }
    versions.add(host.version)
  }
  const recommended = hosts.filter(host => host.track === 'recommended')
  if (recommended.length !== 1 || recommended[0].version !== input.recommendedHost) throw new Error('Exactly one recommended host is required')
  if (/-(alpha|beta)\./.test(input.recommendedHost)) throw new Error('Alpha/beta hosts cannot be the ordinary-user recommendation')
  const candidates = input.sourceCandidates ?? []
  if (!Array.isArray(candidates)) throw new Error('sourceCandidates must be an array')
  for (const candidate of candidates) {
    if (typeof candidate.version !== 'string' || candidate.version.trim() !== candidate.version
        || !EXACT_VERSION.test(candidate.version)
        || versions.has(candidate.version)
        || candidate.repository !== 'https://github.com/deepseek-ai/deepseek-harness'
        || typeof candidate.commit !== 'string' || candidate.commit.length !== 40 || !/^[a-f0-9]{40}$/.test(candidate.commit)
        || typeof candidate.evidence !== 'string' || !candidate.evidence.startsWith('docs/')) {
      throw new Error('Source candidates require a unique exact version, official repository, commit and evidence')
    }
    versions.add(candidate.version)
  }
  // A corridor is optional only for the historical schema: it is what keeps a
  // host the plugin has not been tested against from failing at install time,
  // so a policy that declares one must actually admit every declared target.
  if (input.schemaVersion === 2) {
    if (typeof input.hostCorridor !== 'string' || input.hostCorridor.trim() === '') throw new Error('schemaVersion 2 requires a hostCorridor')
    for (const version of versions) {
      if (!satisfiesCorridor(version, input.hostCorridor)) throw new Error(`hostCorridor excludes declared target ${version}`)
    }
  }
  // Only published targets enter the npm download/CI matrix.
  return hosts.map(host => host.version)
}

export function declaredHostVersions(input = policy) {
  return [...validatePolicy(input), ...(input.sourceCandidates ?? []).map(candidate => candidate.version)]
}

export function validatePackageCompatibility(pkg, input = policy, workspace = workspacePolicy) {
  const versions = validatePolicy(input)
  const declaredVersions = declaredHostVersions(input)
  for (const name of requiredHostPeers) {
    if (typeof pkg.peerDependencies?.[name] !== 'string' || pkg.peerDependencies[name].trim() === '') {
      throw new Error(`Missing required host peer declaration: ${name}`)
    }
  }
  const baseline = pkg.devDependencies?.['@deepseek-ai/dsh']
  if (!versions.includes(baseline)) throw new Error('Development host must be an exact supported target')
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      if (version !== baseline) throw new Error(`${name} must match the exact development host ${baseline}`)
    }
  }
  if (pkg.pnpm?.overrides) throw new Error('Move pnpm.overrides to pnpm-workspace.yaml for pnpm 11')
  const overrides = workspace.overrides ?? {}
  const dshNames = Object.keys(pkg.devDependencies ?? {}).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  for (const name of dshNames) {
    if (overrides[name] !== baseline) throw new Error(`${name} requires an exact pnpm override to ${baseline}`)
  }
  for (const [name, version] of Object.entries(overrides)) {
    if (name.includes('@deepseek-ai/dsh')) {
      if (!/^@deepseek-ai\/dsh(?:-[a-z0-9-]+)?$/.test(name)) {
        throw new Error(`${name} override must use a bare DSH package name, without ranges or parent selectors`)
      }
      if (version !== baseline) throw new Error(`${name} override must match the development host ${baseline}`)
    }
  }
  const corridor = input.hostCorridor
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      if (corridor !== undefined) {
        // A `||` enumeration of exact versions rejects every host that shipped
        // after the last plugin release, which is the whole install-time cost of
        // a bare `0.2.1-rc.N` bump. Declaring the cohort as `*` keeps install
        // working for any host, and the versions this repository actually tests
        // live in compatibility.json, where doctor and CI read them.
        if (range !== '*') throw new Error(`${name} peer range must be "*" so a newer host is installable`)
        continue
      }
      for (const version of declaredVersions) {
        if (!satisfiesCorridor(version, range)) throw new Error(`${name} peer range excludes declared target ${version}`)
      }
    }
  }
  return versions
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const hosts = validatePackageCompatibility(pkg)
  if (process.argv[2] === '--github-output') console.log(`hosts=${JSON.stringify(hosts)}`)
  else if (process.argv.length === 2) console.log(`Compatibility targets: ${hosts.join(', ')}`)
  else throw new Error('Usage: node scripts/compatibility.mjs [--github-output]')
}
