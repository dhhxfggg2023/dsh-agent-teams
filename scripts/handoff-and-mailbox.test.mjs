import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Regressions for two durability defects that only show up in the states a
// healthy run never reaches:
//   A) an interrupted reassignment leaves a fence no tool can release;
//   B) a mailbox record whose batch cannot resolve is discarded with its body,
//      and settled records are never compacted out of an append-only file.
// Node imports the type-stripping-compatible plugin sources directly.
const { releaseHandoffFences, appendMailbox, acknowledgeMailbox, readMailbox } = await import('../src/state.ts')
const { installMailboxAdmission, mailboxPrompt } = await import('../src/mailbox.ts')

const STATE_DIR = '.agent-teams-state'
const CAPTAIN_ID = 'captain-session-0001'
const MEMBER_ID = 'member-session-0001'
const MEMBER_NAME = 'alice'
const TEAM_ID = 'team-a'
const NOW = 1_700_000_000_000

const teamState = (overrides = {}) => ({
  id: TEAM_ID,
  name: 'Fence Team',
  captainSessionId: CAPTAIN_ID,
  createdAt: NOW,
  members: [{ id: MEMBER_ID, name: MEMBER_NAME, role: 'engineer', joinedAt: NOW, status: 'idle' }],
  tasks: [],
  taskSeq: 0,
  ...overrides,
})

const fencedTask = (overrides = {}) => ({
  id: 't1',
  subject: 'Work',
  status: 'pending',
  attempts: 0,
  attempt: 0,
  createdAt: NOW,
  updatedAt: NOW,
  dependencies: [],
  reassigning: true,
  handoffFromMemberId: MEMBER_ID,
  ...overrides,
})

test('A halt releases a reassignment fence that was interrupted between its two locks', () => {
  const team = teamState({
    members: [{ id: MEMBER_ID, name: MEMBER_NAME, role: 'engineer', joinedAt: NOW, status: 'idle', stopping: true }],
    tasks: [fencedTask()],
  })
  assert.equal(releaseHandoffFences(team, true), 2)
  assert.equal(team.members[0].stopping, undefined, 'a halted member must be available again')
  assert.equal(team.tasks[0].reassigning, false, 'a halted task must be claimable again')
  assert.equal(team.tasks[0].handoffFromMemberId, undefined)
})

test('a resume keeps a live fence and releases only a fence whose member is gone', () => {
  const live = teamState({
    members: [{ id: MEMBER_ID, name: MEMBER_NAME, role: 'engineer', joinedAt: NOW, status: 'idle', stopping: true }],
    tasks: [fencedTask()],
  })
  assert.equal(releaseHandoffFences(live, false), 0, 'a member that is still draining stays fenced')
  assert.equal(live.members[0].stopping, true)
  assert.equal(live.tasks[0].reassigning, true)

  const orphaned = teamState({
    members: [{ id: MEMBER_ID, name: MEMBER_NAME, role: 'engineer', joinedAt: NOW, status: 'removed', stopping: true }],
    tasks: [fencedTask()],
  })
  assert.equal(releaseHandoffFences(orphaned, false), 2, 'a removed owner cannot still be draining')
  assert.equal(orphaned.members[0].stopping, undefined)
  assert.equal(orphaned.tasks[0].reassigning, false)
})

test('B an archived team passes the receipt input through instead of deleting its body', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-mailbox-unresolved-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, STATE_DIR)
  await mkdir(join(stateRoot, TEAM_ID, 'inbox'), { recursive: true })
  await writeFile(join(stateRoot, TEAM_ID, 'team.json'), JSON.stringify(teamState(), null, 2))
  const message = { id: 'm1', from: MEMBER_NAME, to: CAPTAIN_ID, content: 'report body', ts: NOW, taskId: 't1', attemptId: undefined }
  await appendMailbox(stateRoot, TEAM_ID, MEMBER_NAME, message)
  // The receipt was built while the team existed; the team is archived before
  // the host runs the step that carries it.
  const prompt = mailboxPrompt(TEAM_ID, MEMBER_NAME, [message])
  await rm(join(stateRoot, TEAM_ID), { recursive: true, force: true })

  const listeners = new Map()
  const warnings = []
  const ctx = { on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name) }, logger: { warn: m => warnings.push(m) } }
  installMailboxAdmission(ctx, STATE_DIR)
  const input = { content: [{ type: 'text', text: prompt }] }
  const result = await listeners.get('agent/pre-step')(
    { agent: { id: MEMBER_ID, session: { header: { cwd: root }, ownEvents: () => [] } }, turn: 1 },
    async () => ({ kind: 'enter', messages: [input] }),
  )
  assert.equal(result.kind, 'enter', 'an unresolved receipt must not reject the step')
  assert.equal(result.messages.length, 1, 'the input carrying the message body must survive')
  assert.equal(result.messages[0].content[0].text, prompt, 'the body must reach the model untouched')
})

test('B settled mailbox records are compacted while unread ones are kept', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-mailbox-compact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, STATE_DIR)
  await mkdir(join(stateRoot, TEAM_ID, 'inbox'), { recursive: true })
  const settledIds = []
  for (let index = 0; index < 100; index++) {
    const id = `settled-${index}`
    settledIds.push(id)
    await appendMailbox(stateRoot, TEAM_ID, MEMBER_NAME, {
      id, from: CAPTAIN_ID, to: MEMBER_NAME, content: `note ${index}`, ts: NOW + index,
    })
  }
  const unread = { id: 'unread-1', from: CAPTAIN_ID, to: MEMBER_NAME, content: 'still pending', ts: NOW + 500 }
  await appendMailbox(stateRoot, TEAM_ID, MEMBER_NAME, unread)
  await acknowledgeMailbox(stateRoot, TEAM_ID, MEMBER_NAME, settledIds)

  const rows = (await readFile(join(stateRoot, TEAM_ID, 'inbox', `${MEMBER_NAME}.jsonl`), 'utf8'))
    .split('\n').filter(line => line.trim() !== '')
  assert.ok(rows.length <= 65, `settled rows must be bounded, saw ${rows.length}`)
  assert.ok(rows.length >= 2, 'compaction must not empty the mailbox')
  const mailbox = await readMailbox(stateRoot, TEAM_ID, MEMBER_NAME)
  assert.ok(mailbox.some(entry => entry.id === unread.id), 'an unread record is never dropped')
  assert.ok(mailbox.some(entry => entry.readAt !== undefined), 'the most recent settled records stay as history')
})
