/** Record and verify source/build-output digests for script-free Git installation. */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const STAMP = 'lib/git-artifact-stamp.json'
const REQUIRED = ['lib/index.js', 'lib/client.js', 'lib/types/index.d.ts', 'lib/types/client/index.d.ts']
const CONFIG = ['tsconfig.json', 'tsconfig.client.json', 'tsdown.config.ts', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'scripts/clean-build.mjs', 'scripts/git-artifacts.mjs']
function files(root, directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return files(root, path)
    if (!entry.isFile()) throw new Error(`Unsupported build input/output: ${path}`)
    return [path]
  }).sort()
}
function digest(root, paths, prefix = '') {
  const hash = createHash('sha256').update(prefix)
  for (const path of [...paths].sort()) hash.update(path).update('\0').update(asRepositoryBytes(readFileSync(join(root, path)))).update('\0')
  return hash.digest('hex')
}
/**
 * Hash the bytes Git stores, not the bytes this checkout materialised. A Windows
 * clone with `core.autocrlf=true` writes CRLF into the working tree, so hashing
 * the file as read makes the stamp a record of the author's line endings: it can
 * never be reproduced by a checkout on another platform, which is how a shipped
 * commit ends up failing its own gate. Normalising CRLF to LF makes the digest
 * identical on every platform and on the committed blob itself.
 */
function asRepositoryBytes(bytes) {
  if (!bytes.includes(0x0d)) return bytes
  const normalized = Buffer.allocUnsafe(bytes.length)
  let length = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue
    normalized[length++] = bytes[index]
  }
  return normalized.subarray(0, length)
}
function current(root) {
  for (const path of REQUIRED) if (!existsSync(join(root, path))) throw new Error(`Missing Git artifact: ${path}; run pnpm build`)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const settings = JSON.stringify({ name: pkg.name, version: pkg.version, type: pkg.type, exports: pkg.exports, devDependencies: pkg.devDependencies, dependencies: pkg.dependencies, build: pkg.scripts?.build })
  return { schema: 2, source: digest(root, [...files(root, 'src'), ...CONFIG], settings), output: digest(root, files(root, 'lib').filter(path => path !== STAMP)) }
}
export function writeGitArtifactStamp(root) {
  writeFileSync(join(root, STAMP), JSON.stringify(current(root), null, 2) + '\n')
}
export function verifyGitArtifacts(root) {
  if (!existsSync(join(root, STAMP))) throw new Error('Missing Git artifact stamp; run pnpm build')
  const saved = JSON.parse(readFileSync(join(root, STAMP), 'utf8'))
  const actual = current(root)
  if (saved.schema !== actual.schema || saved.source !== actual.source || saved.output !== actual.output) {
    throw new Error('Git artifacts are stale or modified; run pnpm build and include lib/ with the source changes')
  }
  return actual
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  if (process.argv[2] === '--write') writeGitArtifactStamp(root)
  else { verifyGitArtifacts(root); console.log('Git artifacts match source and build settings.') }
}
