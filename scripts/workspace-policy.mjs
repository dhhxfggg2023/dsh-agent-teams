/**
 * pnpm rewrites `pnpm-workspace.yaml` in place: it keeps the repository's
 * single-quoted JSON object shape but appends YAML keys of its own (for
 * example `minimumReleaseAgeExclude`, which lists every pinned tarball). A
 * plain JSON.parse therefore throws after any ordinary `pnpm install`, which
 * used to take this gate down instead of the install it was meant to inspect.
 * The repository only needs `overrides`, so read that object directly and fall
 * back to a line scan for a block-style file.
 */
function extractBracedObject(text, key) {
  const start = new RegExp(`"?${key}"?\\s*:\\s*\\{`).exec(text)
  if (!start) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start.index + start[0].length - 1; index < text.length; index++) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth++
    else if (character === '}' && --depth === 0) return text.slice(start.index + start[0].length - 1, index + 1)
  }
  return undefined
}

function blockOverrides(text) {
  const overrides = {}
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    if (/^overrides:\s*$/.test(line)) { inside = true; continue }
    if (!inside) continue
    if (/^\S/.test(line)) break
    const entry = /^\s{2,}["']?([^"':]+)["']?\s*:\s*["']?([^"'\s]+)["']?\s*$/.exec(line)
    if (entry) overrides[entry[1].trim()] = entry[2]
  }
  return inside ? overrides : undefined
}

export function parseWorkspacePolicy(text) {
  try {
    return JSON.parse(text)
  } catch { /* pnpm appended YAML keys; read the object this gate needs. */ }
  const raw = extractBracedObject(text, 'overrides')
  if (raw !== undefined) {
    try {
      return { overrides: JSON.parse(raw) }
    } catch { /* fall through to the block form */ }
  }
  const overrides = blockOverrides(text)
  if (overrides) return { overrides }
  throw new Error('pnpm-workspace.yaml has no readable overrides object')
}
