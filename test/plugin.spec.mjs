/**
 * The plugin's arms, driven through the real `agent/pre-step` waterfall on a
 * real cordis context.
 *
 * These are the arms that decide whether the plugin is *useful*: that the
 * advisory reaches the step's admitted message batch (the batch the loop commits
 * as durable user messages), that it is said once per agent rather than per
 * step, that it carries this plugin's own producer kind, that a clean profile
 * says nothing to the model while still saying something to the log, and that a
 * broken advisor cannot break a turn.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { CRASH_SIGNATURE, DISCUSSION } from '../lib/advice.js'
import { addedText, admitted, install, logText, scenario, step, who, world } from './harness.mjs'

/** The log records of one type, joined. */
function logOfType(logged, type) {
  return logged.filter(message => message.type === type)
    .map(message => message.args.map(value => String(value)).join(' '))
    .join('\n')
}

test('a profile with a second copy gets one durable advisory naming the copies and the declaring manifest', async () => {
  const built = scenario()
  const { ctx } = await world({}, { profile: built.facts })
  const decision = await step(ctx)
  const text = addedText(decision)
  assert.match(text, /@deepseek-ai\/dsh-tools/)
  assert.ok(text.includes(join(built.profileModules, '@deepseek-ai/dsh-tools')), 'names the profile copy')
  assert.ok(text.includes(join(built.installModules, '@deepseek-ai/dsh-tools')), 'names the installation copy')
  assert.match(text, /my-plugin \(dependencies: 0\.2\.0-rc\.2\)/)
  assert.match(text, /peerDependencies/)
  assert.match(text, /pnpm install in the profile directory/)
  assert.ok(text.includes(CRASH_SIGNATURE), 'quotes the crash the split produces')
  assert.ok(text.includes(DISCUSSION), 'names the upstream discussion')
  assert.match(text, /does not remove the copy and cannot/)
})

test('the advisory is one user-role message, carrying this plugin own producer kind', async () => {
  const built = scenario()
  const { ctx } = await world({}, { profile: built.facts })
  const decision = await step(ctx)
  const added = admitted(decision).slice(0)
  assert.equal(added.length, 1)
  assert.equal(added[0].role, 'user')
  assert.equal(added[0].source.kind, 'profile-duplicate-doctor')
  assert.equal(added[0].content.length, 1)
  assert.equal(added[0].content[0].type, 'text')
})

test('the messages the loop already admitted are preserved, and the advisory is appended', async () => {
  const built = scenario()
  const { ctx } = await world({}, { profile: built.facts })
  const existing = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }]
  const decision = await step(ctx, who('s1'), existing)
  const messages = admitted(decision)
  assert.equal(messages.length, 2)
  assert.equal(messages[0], existing[0])
  assert.equal(messages[1].source.kind, 'profile-duplicate-doctor')
})

test('the advisory is delivered once per agent, not once per step', async () => {
  const built = scenario()
  const { ctx, logged } = await world({}, { profile: built.facts })
  const agent = who('s1')
  assert.equal(admitted(await step(ctx, agent)).length, 1)
  assert.equal(admitted(await step(ctx, agent)).length, 0)
  assert.equal(admitted(await step(ctx, agent)).length, 0)
  // The quiet steps are not silent host-side: the delivery is logged once, and
  // the boot report is a separate, single line about the scan.
  const deliveries = logOfType(logged, 'warn').split('\n')
    .filter(line => line.includes('the first tool call of every turn fails'))
  assert.equal(deliveries.length, 1)
})

test('a second agent in the same process is its own first time', async () => {
  const built = scenario()
  const { ctx } = await world({}, { profile: built.facts })
  assert.equal(admitted(await step(ctx, who('s1'))).length, 1)
  assert.equal(admitted(await step(ctx, who('s2'))).length, 1)
})

test('two mounts do not share their ledger', async () => {
  // A process may mount this plugin more than once (a test suite does), and
  // module-level state would make one mount's first step silence the other's.
  const built = scenario()
  const first = await world({}, { profile: built.facts })
  const second = await world({}, { profile: built.facts })
  const agent = who('s1')
  assert.equal(admitted(await step(first.ctx, agent)).length, 1)
  assert.equal(admitted(await step(second.ctx, agent)).length, 1)
})

test('the host log carries the boot report, with each finding and its declarer', async () => {
  const built = scenario()
  const { logged } = await world({}, { profile: built.facts })
  const warn = logOfType(logged, 'warn')
  assert.match(warn, /1 of 1 installation-owned package\(s\)/)
  assert.match(warn, /- @deepseek-ai\/dsh-tools \[identity\]/)
  assert.match(warn, /my-plugin \(dependencies: 0\.2\.0-rc\.2\)/)
  assert.match(warn, /note: only the top level/)
})

test('a clean profile says nothing to the model and says so to the log, at INFO', async () => {
  const built = scenario({ duplicate: false, pluginManifest: { dependencies: {} } })
  const { ctx, logged } = await world({}, { profile: built.facts })
  assert.deepEqual(admitted(await step(ctx)), [])
  const info = logOfType(logged, 'info')
  assert.match(info, /share the installation's copy; no duplicate to report/)
  assert.equal(logOfType(logged, 'warn'), '')
})

test('advise: false scans and logs but never admits a message', async () => {
  const built = scenario()
  const { ctx, logged } = await world({ advise: false }, { profile: built.facts })
  assert.deepEqual(admitted(await step(ctx)), [])
  assert.match(logOfType(logged, 'warn'), /1 of 1 installation-owned package\(s\)/)
})

test('a duplicate that is not a harness package still advises, and says it is usually harmless', async () => {
  const built = scenario({ duplicate: false, pluginManifest: { dependencies: { semver: '7.6.0' } } })
  install(built.installModules, 'semver', { name: 'semver', version: '7.6.0' })
  install(built.profileModules, 'semver', { name: 'semver', version: '7.6.0' })
  const { ctx } = await world({}, { profile: built.facts })
  const text = addedText(await step(ctx))
  assert.match(text, /^duplicate: semver/m)
  assert.match(text, /usually harmless/)
  assert.doesNotMatch(text, /harness package: semver/)
})

test('no profileContext is reported as no scan taken, and steps pass through untouched', async () => {
  const { ctx, logged } = await world({})
  assert.deepEqual(admitted(await step(ctx)), [])
  assert.match(logText(logged), /no profileContext in this process, so no boot scan was taken/)
})

test('a launcher whose facts cannot be read is a logged failure, and steps still pass through', async () => {
  const hostile = {}
  Object.defineProperty(hostile, 'dir', { get() { throw new Error('boom') } })
  Object.defineProperty(hostile, 'installAnchor', { value: '/nowhere/package.json' })
  const { ctx, logged } = await world({}, { profile: hostile })
  assert.deepEqual(admitted(await step(ctx)), [])
  assert.match(logText(logged), /profile lookup failed, no boot scan/)
})

test('a downstream rejection is passed through untouched', async () => {
  const built = scenario()
  const { ctx } = await world({}, { profile: built.facts })
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent: who('s1'), messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'reject' }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
})

test('href is quoted in the advisory when configured', async () => {
  const built = scenario()
  const href = 'https://github.com/deepseek-ai/deepseek-harness/discussions/8287'
  const { ctx } = await world({ href }, { profile: built.facts })
  assert.ok(addedText(await step(ctx)).includes(href), 'the advisory quotes the configured URL')
})

test('the inbox scopes decide which duplicates are named the identity class', async () => {
  const built = scenario({ duplicate: false, pluginManifest: { dependencies: { semver: '7.6.0' } } })
  install(built.installModules, 'semver', { name: 'semver', version: '7.6.0' })
  install(built.profileModules, 'semver', { name: 'semver', version: '7.6.0' })
  const { ctx } = await world({ inboxScopes: ['semver'] }, { profile: built.facts })
  assert.match(addedText(await step(ctx)), /^harness package: semver/m)
})
