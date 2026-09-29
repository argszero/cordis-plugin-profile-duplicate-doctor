/**
 * The integration harness both behavior suites mount the plugin on: a REAL
 * cordis context, a REAL `profileContext` service provided from a fiber (the way
 * the launcher provides it), the real `agent/pre-step` waterfall — plus helpers
 * that build a real profile tree on disk, because this plugin's subject is what
 * is physically installed under `<profile>/node_modules`.
 *
 * What this shape proves: the listener is registered on the seam the loop
 * dispatches and returns a decision the loop can commit, the advisory really
 * rides `decision.messages` (the batch the loop appends as durable user
 * messages), the boot scan runs against a real filesystem, and the plugin
 * reaches the launcher's facts through the optional `get` lookup it actually
 * uses in production.
 *
 * What it does not prove, and does not claim: that the harness's own linker
 * produces this tree, or that a real `dsh` crashes this way. The tree is built
 * to the shape report #8287 describes (a plugin installed into the profile that
 * declares an installation-owned package in `dependencies`), and the crash text
 * is taken from that report — that text is the plugin's entire input.
 *
 * The waterfall is driven through `ctx.waterfall` rather than a running agent
 * loop: the subject under test is the listener's registration and its returned
 * decision, and standing up a whole agent would measure the agent.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

/** A fresh OS-temp root for one test's profile tree. */
export function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'pdd-'))
}

/** Write a JSON file, creating its directory. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Install one package, and return its directory.
 * @param modulesDir - the `node_modules` directory to install into.
 * @param name - the bare package name (scoped names allowed).
 * @param manifest - the manifest to write (`name`/`version` included by the caller).
 * @returns the package directory.
 */
export function install(modulesDir, name, manifest) {
  const dir = join(modulesDir, name)
  writeJson(join(dir, 'package.json'), manifest)
  return dir
}

/** Create one entry that is a symlink rather than a directory. */
export function linkInto(modulesDir, name, target) {
  const path = join(modulesDir, name)
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
  return path
}

/** One agent identity, memoized per id: the plugin keys its state on the object. */
const agents = new Map()
export function who(id) {
  if (!agents.has(id)) agents.set(id, { id, session: { id } })
  return agents.get(id)
}

/**
 * Build one whole scenario: the harness home, the profile, and the installation.
 *
 * The base shape mirrors the reported case — the installation owns
 * `@deepseek-ai/dsh-tools`, the profile has an out-of-tree plugin, and a second
 * real copy of `@deepseek-ai/dsh-tools` sits beside it because that plugin's
 * `dependencies` named it. Each arm turns one knob and leaves the rest alone.
 * @param options - the knobs each test turns.
 * @returns the paths, ready to scan or mount.
 */
export function scenario(options = {}) {
  const root = tempRoot()
  const home = join(root, 'dsh')
  const profileDir = join(home, 'profiles', options.profile ?? 'dev')
  const appDir = join(root, 'app')
  const installModules = join(appDir, 'node_modules')
  const profileModules = join(profileDir, 'node_modules')
  const sharedModules = join(home, 'profiles', 'node_modules')

  writeJson(join(appDir, 'package.json'), { name: '@deepseek-ai/dsh-cli', version: '0.2.0-rc.2' })
  writeJson(join(profileDir, 'package.json'), options.profileManifest ?? { name: 'dev', private: true })
  mkdirSync(sharedModules, { recursive: true })
  install(installModules, '@deepseek-ai/dsh-tools', {
    name: '@deepseek-ai/dsh-tools',
    version: options.installedVersion ?? '0.2.0-rc.2',
    ...options.installationExtra,
  })
  install(profileModules, options.plugin ?? 'my-plugin', {
    name: options.plugin ?? 'my-plugin',
    version: '1.0.0',
    ...(options.pluginManifest ?? { dependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' } }),
  })
  if (options.duplicate !== false) {
    install(profileModules, '@deepseek-ai/dsh-tools', {
      name: '@deepseek-ai/dsh-tools',
      version: options.duplicateVersion ?? '0.2.0-rc.2',
    })
  }
  return {
    root,
    home,
    profileDir,
    appDir,
    installModules,
    profileModules,
    sharedModules,
    /** The facts the launcher would provide. */
    facts: { dir: profileDir, installAnchor: join(appDir, 'package.json') },
  }
}

/**
 * Mount this plugin on a real context, with the optional profile facts.
 * @param config - plugin config to forward; omitted → defaults.
 * @param options - `profile` mounts a `profileContext` service; omit to leave it
 * unmounted, which is its own arm (a composition with no launcher).
 * @returns the context and the captured log messages.
 */
export async function world(config, options = {}) {
  const ctx = new Context()
  const logged = []
  // `levels.default` is the highest level an exporter admits (2 = WARN), so
  // INFO lines reach the capture too — the clean-profile report is that case.
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })
  if (options.profile !== undefined) {
    // Provided from a fiber, so the service's lifetime is the test's and the
    // lookup under test is genuinely the optional `get` path.
    await ctx.plugin({ name: 'profile-facts-stand-in', apply: c => { c.provide('profileContext', options.profile) } })
  }
  await ctx.plugin({ name: plugin.name, apply: c => { plugin.apply(c, config ?? {}) } })
  return { ctx, logged }
}

/**
 * Drive one step through the real waterfall.
 * @param ctx - the mounted context.
 * @param agent - the agent entering the step.
 * @param messages - the messages the loop would already have admitted.
 * @returns the decision the chain produced.
 */
export function step(ctx, agent = who('s1'), messages = []) {
  const payload = { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }
  return ctx.waterfall('agent/pre-step', payload, () => Promise.resolve({ kind: 'enter', messages }))
}

/** The messages one decision admits. */
export function admitted(decision) {
  return decision.kind === 'enter' ? decision.messages : []
}

/** The body text of the single message a decision added. */
export function addedText(decision, before = 0) {
  const messages = admitted(decision)
  return messages.slice(before).map(message => message.content.map(block => block.text).join('\n')).join('\n')
}

/**
 * The captured log as one string.
 *
 * A message carries the format string plus its arguments, unformatted — the
 * exporter renders them — so the arguments are joined in too.
 */
export function logText(logged) {
  return logged.map(message => message.args.map(value => String(value)).join(' ')).join('\n')
}

/**
 * The captured log lines that mention one phrase.
 * @param logged - the array `world()` returned.
 * @param needle - the substring a line must contain.
 * @returns the matching lines, in order.
 */
export function logLines(logged, needle) {
  return logText(logged).split('\n').filter(line => line.includes(needle))
}
