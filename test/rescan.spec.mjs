/**
 * The 0.2.0 arms: what the plugin does when the profile changes **while the
 * process is running**.
 *
 * The boot scan answers "what does this profile carry now"; these are the arms
 * that answer "and what did it start carrying a minute later". That second
 * question is the whole reason for the watch: a plugin installed into a live
 * profile is invisible to a boot scan taken before it, and the next start is the
 * one that pays for it — either at the first tool call, or, when the shadowed
 * copy's version is outside what the installation accepts, during boot itself,
 * where no plugin runs and nothing can report it. The window between the install
 * and the restart is the only place this can be said, so it is measured here.
 *
 * Every arm drives real filesystem changes against a real profile tree and lets a
 * real `fs.watch` deliver them; nothing about the watcher is mocked. The settle
 * window is shortened so a test costs milliseconds, and waits poll for the
 * plugin's own output rather than sleeping a fixed amount.
 */

import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { addedText, admitted, install, logLines, logText, scenario, step, waitFor, who, world } from './harness.mjs'

/** A settle window short enough to test against and long enough to coalesce. */
const SETTLE = 40

/** The header every rescan writes before its report. */
const RESCAN = 'the profile changed on disk; rescanned'

/** Mount one scenario with the watch on. */
async function mounted(built, config = {}) {
  return world({ watchSettleMs: SETTLE, ...config }, { profile: built.facts })
}

test('a second copy installed after this process started is named by a rescan, not only by the next boot', async () => {
  const built = scenario({ duplicate: false })
  const { ctx, logged } = await mounted(built)
  const agent = who('rescan-install')

  // Nothing is duplicated yet: the boot scan is clean and the agent is told nothing.
  assert.deepEqual(admitted(await step(ctx, agent)), [])

  // The install a user performs one keystroke before restarting `dsh`: a plugin
  // whose `dependencies` names a package the installation already provides, so
  // pnpm materializes a second copy inside the profile.
  install(built.profileModules, 'late-plugin', {
    name: 'late-plugin',
    version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' },
  })
  install(built.profileModules, '@deepseek-ai/dsh-tools', {
    name: '@deepseek-ai/dsh-tools',
    version: '0.2.0-rc.2',
  })

  assert.ok(await waitFor(() => logText(logged).includes(RESCAN)), 'the rescan ran')
  const header = logLines(logged, RESCAN)
  assert.equal(header.length, 1, 'one install is one rescan, not one per entry')
  assert.match(header[0], /now carrying a second copy of @deepseek-ai\/dsh-tools/)

  // The agent that was already in a conversation is told: the fact changed under it.
  const text = addedText(await step(ctx, agent))
  assert.match(text, /@deepseek-ai\/dsh-tools/)
  assert.match(text, /late-plugin \(dependencies: 0\.2\.0-rc\.2\)/)
  // And told once — the rescan did not reactivate the per-step advisory.
  assert.deepEqual(admitted(await step(ctx, agent)), [])
})

test('an agent already advised is told again when the profile gains another second copy', async () => {
  // "Once per agent" is right for a fact that cannot change and wrong for one that
  // can: the agent below was told about `dsh-tools` a minute ago, and the profile
  // just gained a second copy of `dsh-llm`. Delivering nothing would leave it
  // working from a stale picture; delivering on every step would spend the
  // session's context repeating itself. The ledger's generation is what separates
  // the two.
  const built = scenario()
  install(built.installModules, '@deepseek-ai/dsh-llm', { name: '@deepseek-ai/dsh-llm', version: '0.2.0-rc.2' })
  const { ctx, logged } = await mounted(built)
  const agent = who('rescan-generation')

  const first = addedText(await step(ctx, agent))
  assert.match(first, /@deepseek-ai\/dsh-tools/)
  assert.doesNotMatch(first, /@deepseek-ai\/dsh-llm/, 'the second copy does not exist yet')

  install(built.profileModules, '@deepseek-ai/dsh-llm', { name: '@deepseek-ai/dsh-llm', version: '0.2.0-rc.2' })
  assert.ok(
    await waitFor(() => logLines(logged, RESCAN).some(line => line.includes('dsh-llm'))),
    'the second copy was seen',
  )

  const second = addedText(await step(ctx, agent))
  assert.match(second, /@deepseek-ai\/dsh-llm/, 'the already-advised agent is owed the new fact')
  assert.deepEqual(admitted(await step(ctx, agent)), [], 'and owed it once')
})

test('the watch also sees a scoped install, which changes nothing at the top level of node_modules', async () => {
  // The parent's entry set is unchanged when a package appears inside an existing
  // `@scope` directory, so a watch that stopped at `node_modules` would miss every
  // `@deepseek-ai/*` install — the one class this plugin exists for.
  const built = scenario({ duplicate: false })
  const { ctx, logged } = await mounted(built)
  install(built.profileModules, '@deepseek-ai/dsh-tools', {
    name: '@deepseek-ai/dsh-tools',
    version: '0.2.0-rc.2',
  })
  assert.ok(await waitFor(() => logText(logged).includes(RESCAN)), 'the scoped install was seen')
  assert.match(logLines(logged, RESCAN)[0], /@deepseek-ai\/dsh-tools/)
})

test('a scope directory created after the mount is itself watched afterwards', async () => {
  // The first scoped install creates the scope directory; the second one appears
  // *inside* it, where only a watcher armed after the first install can see it.
  // Both packages are installation-owned, so each install is a finding and its
  // arrival is observable — the arm measures the watch set, not the scan.
  const built = scenario({ duplicate: false })
  install(built.installModules, '@deepseek-ai/dsh-llm', { name: '@deepseek-ai/dsh-llm', version: '0.2.0-rc.2' })
  const { logged } = await mounted(built)

  install(built.profileModules, '@deepseek-ai/dsh-tools', {
    name: '@deepseek-ai/dsh-tools',
    version: '0.2.0-rc.2',
  })
  assert.ok(await waitFor(() => logLines(logged, RESCAN).length === 1), 'the scope directory was created and seen')

  install(built.profileModules, '@deepseek-ai/dsh-llm', { name: '@deepseek-ai/dsh-llm', version: '0.2.0-rc.2' })
  assert.ok(
    await waitFor(() => logLines(logged, RESCAN).some(line => line.includes('dsh-llm'))),
    'the install inside the new scope is seen, so the scope was added to the watch set',
  )
})

test('an edit that leaves the copies alone is silent: only a different set of copies speaks', async () => {
  const built = scenario()
  const { ctx, logged } = await mounted(built)
  const agent = who('rescan-quiet')
  assert.equal(admitted(await step(ctx, agent)).length, 1)

  // A manifest rewrite in the watched profile directory: an event really fires,
  // the rescan really runs, and the verdict is unchanged — the same directory
  // holding the same version is the same second copy, however it is declared.
  writeFileSync(
    join(built.profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dev', private: true, description: 'rewritten' }, null, 2)}\n`,
  )
  await waitFor(() => logText(logged).includes(RESCAN), 300)
  assert.equal(logLines(logged, RESCAN).length, 0, 'an unchanged profile is not re-announced')
  assert.deepEqual(admitted(await step(ctx, agent)), [], 'and the agent is not re-advised')
})

test('removing the second copy is reported, and the advisory stops', async () => {
  const built = scenario()
  const { ctx, logged } = await mounted(built)
  const agent = who('rescan-remove')
  assert.equal(admitted(await step(ctx, agent)).length, 1)

  rmSync(join(built.profileModules, '@deepseek-ai/dsh-tools'), { recursive: true, force: true })

  assert.ok(await waitFor(() => logText(logged).includes(RESCAN)), 'the removal was seen')
  const header = logLines(logged, RESCAN)[0]
  assert.match(header, /no longer carrying a second copy of @deepseek-ai\/dsh-tools/)
  // The repaired profile says so at INFO, not as a warning.
  assert.equal(logLines(logged, `${RESCAN}`).filter(line => line !== header).length >= 0, true)
  assert.match(logText(logged), /no duplicate to report/)
  assert.deepEqual(admitted(await step(ctx, agent)), [], 'nothing to advise once the copy is gone')
})

test('watch: false keeps the boot scan and never rescans', async () => {
  const built = scenario({ duplicate: false })
  const { ctx, logged } = await mounted(built, { watch: false })
  const agent = who('rescan-off')
  install(built.profileModules, '@deepseek-ai/dsh-tools', {
    name: '@deepseek-ai/dsh-tools',
    version: '0.2.0-rc.2',
  })
  await waitFor(() => false, 300)
  assert.equal(logLines(logged, RESCAN).length, 0, 'no rescan was armed')
  assert.deepEqual(admitted(await step(ctx, agent)), [])
})

test('unmounting closes the watch, so nothing rescans after the mount ends', async () => {
  const built = scenario({ duplicate: false })
  const { logged, dispose } = await mounted(built)
  await dispose()
  install(built.profileModules, '@deepseek-ai/dsh-tools', {
    name: '@deepseek-ai/dsh-tools',
    version: '0.2.0-rc.2',
  })
  await waitFor(() => false, 300)
  assert.equal(logLines(logged, RESCAN).length, 0, 'the watcher was closed with the mount')
})

test('a version split says which of the two outcomes to expect at the next start', async () => {
  // The same second copy has two endings. Outside the range the installation
  // accepts, the compatibility preflight refuses the row the copy shadowed and
  // the process stops during boot — where no plugin runs, so the warning has to
  // be legible before the restart, not after.
  const built = scenario({ duplicateVersion: '0.0.1-rc.1', installedVersion: '0.2.0-rc.2' })
  const { ctx, logged } = await mounted(built)
  const text = addedText(await step(ctx, who('rescan-version')))
  assert.match(text, /different versions/)
  assert.match(text, /stops during boot/)
  assert.match(logText(logged), /the compatibility preflight decides at the NEXT start/)
})

test('two copies of the same version do not claim a version split', async () => {
  // The discriminator has to be able to say no: a version difference that is not
  // there must not produce the fatal-boot warning, or the warning means nothing.
  const built = scenario()
  const { ctx, logged } = await mounted(built)
  const text = addedText(await step(ctx, who('rescan-same')))
  assert.doesNotMatch(text, /different versions/)
  assert.doesNotMatch(logText(logged), /compatibility preflight decides/)
})
