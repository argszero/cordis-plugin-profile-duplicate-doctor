/**
 * The words. Pure functions over facts, so the wording is testable without a
 * context, a filesystem, or an agent.
 *
 * Two audiences, two registers:
 *
 * - the **model** gets a durable advisory that says what is on disk, why the
 *   failure that follows cannot be retried away, and which edit the author owns —
 *   the same shape this family uses for the sandbox and profile failures;
 * - the **host log** gets one line per event, naming the same facts, so an
 *   operator reading stderr sees the diagnosis without a session.
 *
 * Every path in the text is quoted from the facts that were measured — the
 * profile copy, the installation copy, the declaring manifest, the declared
 * range — never from a template with a guess in it. Where the scan could not
 * attribute a copy to a manifest it says so instead of inventing one.
 *
 * @module @argszero/cordis-plugin-profile-duplicate-doctor
 */

import type { Declarer, DuplicateFinding, ScanReport } from './scan.js'

/** The upstream report of this defect. */
export const DISCUSSION = '8287'

/** The crash the identity class produces, quoted so the report is searchable. */
export const CRASH_SIGNATURE = "dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')"

/** How one declarer is written in a sentence. */
function declarerText(declarer: Declarer): string {
  return `${declarer.name} (${declarer.section}: ${declarer.range}) at ${declarer.manifestPath}`
}

/** The declaration line for one finding, or the honest alternative when there is none. */
function declarationLine(finding: DuplicateFinding): string {
  if (finding.declarers.length === 0) {
    return '  declared by:        (no manifest at the top level of this profile names it)'
  }
  return `  declared by:        ${finding.declarers.map(declarerText).join('; ')}`
}

/** The version of one copy, written for a report line. */
function versionText(version: string | undefined): string {
  return version === undefined ? 'version not declared' : `v${version}`
}

/**
 * The boot-time log block for one scan.
 *
 * A quiet start and a scan that never ran must not look alike, so this returns
 * a line for both outcomes — and the `notes` are part of the block, because the
 * limits of a scan are a finding too.
 * @param report - the scan.
 * @returns one line per fact.
 */
export function bootReportLines(report: ScanReport): readonly string[] {
  const lines: string[] = []
  if (report.findings.length === 0) {
    lines.push(`profile-duplicate-doctor: ${String(report.reviewed)} installation-owned package(s) under`
      + ` ${report.modulesDir} share the installation's copy; no duplicate to report`)
    for (const note of report.notes) lines.push(`  note: ${note}`)
    return lines
  }
  const identity = report.findings.filter(finding => finding.severity === 'identity').length
  lines.push(`profile-duplicate-doctor: ${String(report.findings.length)} of ${String(report.reviewed)}`
    + ` installation-owned package(s) under ${report.modulesDir} are a SECOND copy`
    + `${identity === 0 ? '' : ` (${String(identity)} of them a harness package, whose identity cannot span two copies)`}`
    + ` (discussion ${DISCUSSION})`)
  for (const finding of report.findings) {
    lines.push(`  - ${finding.name} [${finding.severity}]: ${versionText(finding.profileVersion)} at`
      + ` ${finding.profileDir} vs installation ${versionText(finding.installationVersion)} at`
      + ` ${finding.installationDir}`)
    lines.push(`    ${declarationLine(finding).trimStart()}`)
  }
  for (const note of report.notes) lines.push(`  note: ${note}`)
  return lines
}

/** The one-line host-side account of one duplicate, for the reactive half. */
export function hostLine(report: ScanReport): string {
  const names = report.findings.map(finding => finding.name).join(', ')
  return `profile-duplicate-doctor: this profile carries a second copy of ${names} — a package the installation`
    + ` already provides, installed into ${report.modulesDir} by the manifest(s) named below; a harness package`
    + ` duplicated this way splits its module-level identity and the first tool call of every turn fails with`
    + ` "${CRASH_SIGNATURE}" (discussion ${DISCUSSION})`
}

/** The one-line transcript summary for the advisory. */
export function summaryOf(report: ScanReport): string {
  const names = report.findings.map(finding => finding.name)
  return names.length === 1
    ? `this profile carries a second copy of "${names[0]}"`
    : `this profile carries second copies of ${names.map(name => `"${name}"`).join(', ')}`
}

/** What the advisory is allowed to say. */
export interface AdviceContext {
  /** An optional thread URL to quote. */
  readonly href: string | undefined
}

/**
 * The durable advisory attached to the step.
 * @param report - the scan taken at boot.
 * @param context - the mount's configuration.
 * @returns the advisory body.
 */
export function adviceText(report: ScanReport, context: AdviceContext): string {
  const lines: string[] = [
    'This profile is carrying a second copy of a package the dsh installation already provides. Nothing about',
    'this turn caused it and nothing about this turn can undo it: it is a fact about the profile\'s',
    '`node_modules` on disk, measured when this process started.',
    '',
  ]
  for (const finding of report.findings) {
    lines.push(`${finding.severity === 'identity' ? 'harness package' : 'duplicate'}: ${finding.name}`)
    lines.push(`  profile copy:       ${finding.profileDir} (${versionText(finding.profileVersion)})`)
    lines.push(`  installation copy:  ${finding.installationDir} (${versionText(finding.installationVersion)})`)
    lines.push(declarationLine(finding))
  }
  lines.push(
    '',
    'Why it matters: two directories holding the same package are two modules, and each evaluates its own',
    'module-level state. Where a package carries identity the harness relies on being process-singleton —',
    '`@deepseek-ai/dsh-tools` publishes `TOOL_RUNTIME_SCHEDULER` as a `unique symbol`, and the agent loop reads',
    'it off the service instance the other copy produced — the two copies cannot see each other, the lookup',
    'returns `undefined`, and every tool call in this profile fails, first-party tools included:',
    '',
    `  ${CRASH_SIGNATURE}`,
    '',
    'with `tool/call` already appended and `turn/end` closing immediately as an error. Retrying cannot help, and',
    'neither can rewriting the command: the failure is in the profile, not in the call.',
    '',
    'What fixes it (the author owns this edit):',
    '',
    '  1. Remove the package from the `dependencies` field of the manifest named above. A package the',
    '     installation provides belongs in `peerDependencies` (and `devDependencies` for the type-check and the',
    '     local test run) — that is what makes every plugin share the installation\'s single copy.',
    '  2. Run pnpm install in the profile directory so the copy is pruned, then restart dsh.',
    '',
    'What does not help: retrying this call, restarting the session, or reinstalling the plugin while the',
    '`dependencies` entry is still there — pnpm materializes the same copy again.',
    '',
  )
  const identity = report.findings.some(finding => finding.severity === 'identity')
  if (!identity) {
    lines.push(
      'The entries above are marked `duplicate`: two copies of a package whose identity is not shared with the',
      'harness is usually harmless. Remove them for tidiness, and read them as a warning if the package is one',
      'whose identity elsewhere has to be a single instance.',
      '',
    )
  }
  lines.push(
    'This plugin does not remove the copy and cannot: it reports what is on disk, because by the time anything',
    'is loaded the split has already happened. The durable fix belongs upstream — resolving the package through',
    'the installation, or keying the identity with `Symbol.for` — so that a second copy can no longer split it.',
    `This defect is reported as discussion ${DISCUSSION} in deepseek-ai/deepseek-harness, which is where the`,
    'upstream fix would land.',
    '',
    'Tell the user which manifest the edit belongs to before retrying anything.',
  )
  if (context.href !== undefined && context.href.length > 0) lines.push('', context.href)
  return lines.join('\n')
}
