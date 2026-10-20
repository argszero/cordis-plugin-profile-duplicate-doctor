/**
 * `profile-duplicate-doctor`: name the second copy of a package this profile did
 * not need, and name the manifest that declared it.
 *
 * ## The defect
 *
 * `dsh` supplies its own packages once, beside the application, and every plugin
 * in a profile is meant to *share* that copy — the reason the authoring guide
 * asks for `peerDependencies`. A plugin that instead lists one in
 * `dependencies` makes pnpm **install** it, and under the hoisted linker a real
 * second copy appears inside `<profile>/node_modules`. The plugin's `import`
 * reaches that copy, so the package's module-level identity is evaluated twice:
 * two `Symbol`s, two service registrations. `@deepseek-ai/dsh-tools` publishes
 * `TOOL_RUNTIME_SCHEDULER` as a `unique symbol` and the agent loop reads it off
 * the service instance the *other* copy produced, so the lookup is `undefined`
 * and the first tool call of every turn dies:
 *
 *   dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')
 *
 * `tool/call` is on disk and `turn/end` closes immediately as an error, which is
 * what report #8287 shows — including the three-arm table that isolates the
 * cause (with the `dependencies` entry: fails; plugin removed: passes;
 * reinstalled with no such entry: passes). The unit of duplication in that
 * report is a **copy**, which is the half the earlier reports of this crash
 * (one realpath evaluated twice) never pinned down.
 *
 * ## What this plugin does
 *
 * 1. **A boot scan.** Every entry under `<profile>/node_modules` whose name the
 *    installation also owns is compared to the installation's copy by
 *    `realpath`. Same directory — a link into the installation, or the harness's
 *    own module proxy — is the correct shape and is not reported; a distinct
 *    directory is a second copy, reported with the manifest that declared it.
 *    The verdicts go to the host log either way, because a quiet start and a
 *    scan that never ran must not look alike.
 * 2. **A rescan when the profile changes.** The boot scan describes the profile
 *    this process started with, and a plugin installed into the profile afterwards
 *    — the ordinary `dsh plugin add` — is invisible to it. That install is exactly
 *    what makes the next start fail, so the plugin watches the profile, coalesces
 *    one install into one rescan, and speaks only when the set of second copies
 *    actually changed (see `watch.ts`).
 * 3. **One durable advisory per agent.** The `agent/pre-step` waterfall decides
 *    which messages enter a step, so the first step of each agent additionally
 *    carries one user-role message naming the copies, the declaring manifests,
 *    and the edit the author owns. It is committed to the session by the loop
 *    like any other admitted message, so it survives into the next request. A
 *    rescan that changes the set of copies opens a new generation, so an agent
 *    already advised is told about the new fact once (see `state.ts`).
 *
 * ## Why the fix is not here
 *
 * A plugin cannot remove the second copy, and pretending otherwise would be the
 * worse answer: by the time anything is loaded the symbol has already been
 * evaluated twice, and rewriting another package's `node_modules` is not a
 * third-party plugin's business. What is missing from the report is the
 * *attribution* — that a specific manifest's `dependencies` field caused it —
 * and that is exactly what a scan over the profile can supply. The durable fix
 * is upstream: resolve the package through the installation, or key the identity
 * with `Symbol.for`.
 *
 * ## Where it acts, and why there
 *
 * Two seams, both public and neither required:
 *
 * - `ctx.get('profileContext')` — the launcher's own facts (`dir`,
 *   `installAnchor`). Read optionally: a composition with no launcher still gets
 *   the whole reactive half, and the scan is skipped with a line saying so
 *   rather than silently.
 * - `agent/pre-step` (`@deepseek-ai/dsh-agent`) — a waterfall whose default
 *   already appends the projected runtime context to the admitted messages, so
 *   adding one more is the seam's ordinary use, not a trick.
 *
 * @module @argszero/cordis-plugin-profile-duplicate-doctor
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { adviceText, bootReportLines, hostLine, rescanReportLines, summaryOf } from './advice.js'
import type { InstallationCopy, InstallationResolver, ScanReport } from './scan.js'
import { findingSignature, scanProfileDuplicates } from './scan.js'
import { createAdviceLedger } from './state.js'
import { DEFAULT_SETTLE_MS, watchProfile } from './watch.js'


declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'profile-duplicate-doctor': { kind: 'profile-duplicate-doctor' } & ContextFormed
  }
}

export const name = 'profile-duplicate-doctor'

/**
 * The producer kind every message this plugin writes carries.
 *
 * Its own kind rather than a shared one: the session format admits a
 * producer-owned kind and refuses the literal `plugin`
 * (`session-format-v3-to-v4/src/message-sources.ts`), and the source union is
 * documented as merge-extensible, one kind per producer.
 */
export const SOURCE_KIND = 'profile-duplicate-doctor'

/** The service name the launcher provides; read optionally, never required. */
export const PROFILE_CONTEXT = 'profileContext'

/** The profile facts this plugin reads, structurally. */
export interface ProfileFacts {
  /** The running profile's directory. */
  readonly dir: string
  /** The installation's package.json, the anchor its own resolution starts from. */
  readonly installAnchor: string
}

/** Configures the scan and the advisory. */
export interface Config {
  /**
   * Whether the scan's finding enters the session as a user-role message.
   * Default true: the scan alone writes to a log the model never reads, and the
   * whole point is that a broken profile is diagnosed instead of retried. Set
   * false for a log-only mount.
   */
  advise?: boolean
  /** Package scopes treated as harness packages; defaults to `['@deepseek-ai/']`. */
  inboxScopes?: string[]
  /** URL quoted in the advisory as the upstream thread; optional. */
  href?: string
  /**
   * Rescan when the profile changes on disk. Default true.
   *
   * A boot scan describes the profile the process started with. A plugin
   * installed into the profile *afterwards* — the ordinary `dsh plugin add`, one
   * keystroke before a restart — is invisible to it, and that install is exactly
   * what makes the next start fail. The watch is what lets this process name the
   * offender before it is restarted, and it is the only moment it can: the
   * failure it warns about happens during boot, where no plugin runs.
   */
  watch?: boolean
  /**
   * How long a burst of profile changes may settle before the rescan runs, in
   * milliseconds. Default {@link DEFAULT_SETTLE_MS}: one `pnpm install` writes
   * many entries and must produce one rescan, not one per entry.
   */
  watchSettleMs?: number
}

/**
 * Read the launcher's profile facts, when this process was launched by `dsh`.
 *
 * `get` is optional lookup (it reads the isolate's service store rather than the
 * ancestry walk), and this plugin deliberately does not declare the service: a
 * composition that mounts no launcher still gets the whole reactive half. The cast
 * exists because the *declaration* of `profileContext` lives in
 * `@deepseek-ai/dsh-app-boot` — a package this plugin does not depend on — so the
 * key is absent from the installed `Context` interface. The value is never read
 * through a property access, which is the failure mode that shape is known to
 * cause.
 * @param ctx - the plugin's context.
 * @returns the facts, or undefined when they are absent or malformed.
 */
export function readProfileFacts(ctx: Context): ProfileFacts | undefined {
  const lookup = ctx as unknown as { get(service: string, strict?: boolean): unknown }
  const found = lookup.get(PROFILE_CONTEXT)
  if (found === null || typeof found !== 'object') return undefined
  const candidate = found as Partial<Record<keyof ProfileFacts, unknown>>
  const { dir, installAnchor } = candidate
  if (typeof dir !== 'string' || typeof installAnchor !== 'string') return undefined
  return { dir, installAnchor }
}

/**
 * Resolve a name to the copy the **installation** owns.
 *
 * The walk is Node's own for a bare specifier starting at the installation's
 * anchor: `node_modules/<name>` in that directory, then in each parent. No
 * `exports` map is consulted — the question is where the copy lives, not what its
 * entry point is — and the manifest must declare the name being looked for, so a
 * directory that merely shares the path cannot be mistaken for it.
 * @param anchor - an absolute path inside the installation (`ProfileFacts.installAnchor`).
 * @returns the resolver.
 */
export function createInstallationResolver(anchor: string): InstallationResolver {
  return (requested: string): InstallationCopy | undefined => {
    let directory = dirname(anchor)
    for (;;) {
      const candidate = join(directory, 'node_modules', requested)
      const manifest = readManifest(candidate)
      if (manifest?.name === requested) {
        const version = manifest.version
        return { dir: candidate, version: typeof version === 'string' ? version : undefined }
      }
      const parent = dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
  }
}

/** Read a package manifest, or undefined when it is absent or unparseable. */
function readManifest(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * The one user-role message that carries the diagnosis into the conversation.
 * @param report - the boot scan.
 * @param href - the optional thread URL.
 * @returns the message, identified and frozen by the harness factory.
 */
function notice(report: ScanReport, href: string | undefined): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: adviceText(report, { href }) }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(summaryOf(report)),
    },
  })
}

/**
 * Install the doctor.
 * @param ctx - the plugin's context.
 * @param config - resolved options.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const advise = config.advise !== false
  const href = config.href
  const ledger = createAdviceLedger()
  const facts = readFacts(ctx)
  // The report the reactive half reads, replaced by every rescan that finds a
  // different set of copies. `let` rather than a captured const because the
  // profile is a live directory: installing a plugin into it is the event this
  // plugin exists to name, and it happens after the boot scan.
  let report = facts === undefined ? undefined : takeScan(ctx, config, facts, 'boot')
  let signature = report === undefined ? '' : findingSignature(report)

  /**
   * The advisory for one agent, when there is a finding and this agent is owed it.
   * @param agent - the agent entering a step.
   * @returns the message to admit, or undefined.
   */
  function inspect(agent: Agent): UserMessage | undefined {
    if (!advise || report === undefined || report.findings.length === 0) return undefined
    if (!ledger.claim(agent)) return undefined
    ctx.logger.warn(hostLine(report))
    return notice(report, href)
  }

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let message: UserMessage | undefined
    try {
      message = inspect(agent)
    } catch (error: unknown) {
      // A broken doctor must not become a broken turn.
      ctx.logger.warn(`profile-duplicate-doctor: step left alone after internal error: ${String(error)}`)
    }
    if (message === undefined) return decision
    return { ...decision, messages: [...decision.messages, message] }
  })

  if (facts === undefined || config.watch === false) return
  ctx.effect(() => {
    const watch = watchProfile({
      profileDir: facts.dir,
      settleMs: config.watchSettleMs ?? DEFAULT_SETTLE_MS,
      onChange: () => {
        try {
          const next = takeScan(ctx, config, facts, 'quiet')
          if (next === undefined) return
          const previous = report
          const changed = findingSignature(next) !== signature
          report = next
          signature = findingSignature(next)
          if (!changed) return
          // A different set of copies is a new fact for every live agent: the one
          // already told about the old set is owed the new one, and no agent is
          // owed it twice.
          ledger.bump()
          for (const line of rescanReportLines(next, previous)) {
            if (next.findings.length === 0) ctx.logger.info(line)
            else ctx.logger.warn(line)
          }
        } catch (error: unknown) {
          ctx.logger.warn(`profile-duplicate-doctor: rescan failed, previous report kept: ${String(error)}`)
        }
      },
      onError: (directory: string, error: unknown) => {
        ctx.logger.warn(`profile-duplicate-doctor: cannot watch ${directory}, so changes there are not`
          + ` rescanned: ${String(error)}`)
      },
    })
    ctx.logger.info(`profile-duplicate-doctor: watching ${watch.directories().join(', ')} for installs and removals`)
    return () => watch.close()
  }, 'profile-duplicate-doctor: profile watch')
}

/**
 * Read the launcher's facts once, saying why when there are none.
 *
 * Not a claim that everything is fine: without the launcher's facts there is no
 * profile to scan, and saying so is the difference between "nothing to report"
 * and "no report was taken".
 * @param ctx - the plugin's context, for logging.
 * @returns the facts, or undefined when they cannot be read.
 */
function readFacts(ctx: Context): ProfileFacts | undefined {
  try {
    const facts = readProfileFacts(ctx)
    if (facts === undefined) {
      ctx.logger.warn('profile-duplicate-doctor: no profileContext in this process, so no boot scan was taken')
    }
    return facts
  } catch (error: unknown) {
    ctx.logger.warn(`profile-duplicate-doctor: profile lookup failed, no boot scan: ${String(error)}`)
    return undefined
  }
}

/**
 * Scan, and say what was found.
 *
 * Every failure here is caught and logged: a plugin that cannot read the profile
 * must not stop the process that is loading it.
 * @param ctx - the plugin's context, for logging.
 * @param config - resolved options.
 * @param facts - the launcher's profile facts.
 * @param phase - `boot` reports; `quiet` scans without reporting, leaving the
 *   decision to the caller, which is what a rescan needs (an unchanged profile
 *   must be silent).
 * @returns the scan, or undefined when none could be taken.
 */
function takeScan(
  ctx: Context,
  config: Config,
  facts: ProfileFacts,
  phase: 'boot' | 'quiet',
): ScanReport | undefined {
  try {
    const report = scanProfileDuplicates({
      profileDir: facts.dir,
      installation: createInstallationResolver(facts.installAnchor),
      ...config.inboxScopes === undefined ? {} : { inboxScopes: config.inboxScopes },
    })
    if (phase === 'boot') {
      for (const line of bootReportLines(report)) {
        if (report.findings.length === 0) ctx.logger.info(line)
        else ctx.logger.warn(line)
      }
    }
    return report
  } catch (error: unknown) {
    ctx.logger.warn(`profile-duplicate-doctor: scan failed, no report: ${String(error)}`)
    return undefined
  }
}
