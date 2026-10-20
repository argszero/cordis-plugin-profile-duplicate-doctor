/**
 * The duplicate scan: which packages the profile carries a **second physical
 * copy** of, and which manifest declared it.
 *
 * ## Why the scan exists
 *
 * `dsh` supplies its own packages to every profile — they are installed once,
 * beside the application, and a profile is meant to *share* that one copy. A
 * plugin added to a profile therefore declares them as peers
 * (`docs/user/develop/basic/publish.md`), which is what makes one `cordis`, one
 * `ToolRuntime`, one of everything.
 *
 * A `dependencies` entry instead makes pnpm **install** the package, and the
 * hoisted linker materializes a real second copy inside the profile's own
 * `node_modules`. The plugin's `import` then reaches the second copy, not the
 * installation's, and every module-level identity in that package is evaluated
 * twice: two `Symbol`s, two service registrations, two class objects. Where the
 * harness relies on such an identity — `TOOL_RUNTIME_SCHEDULER` in
 * `@deepseek-ai/dsh-tools` is a `unique symbol`, read by the agent loop through
 * the service instance the *other* copy produced — the lookup returns
 * `undefined` and the first tool call of every turn dies:
 *
 *   dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')
 *
 * with `tool/call` already on disk and `turn/end` closing immediately as an
 * error. The unit of duplication here is a **copy**, which is what separates
 * this shape from the same crash produced by one realpath evaluated twice
 * (discussion #8287).
 *
 * ## What the scan decides
 *
 * For each entry under `<profile>/node_modules` whose name the **installation**
 * also owns, the entry is either
 *
 * - **shared** — it resolves to the same directory the installation owns (a
 *   symlink into the installation, or the harness's own module proxy). This is
 *   the correct shape and is not reported;
 * - a **duplicate** — a distinct directory carrying its own copy of the same
 *   package. Reported, with the declaring manifest named.
 *
 * The comparison is `realpath`, not a path string or a version: two copies of
 * one version are still two modules, and one copy reached by two paths is still
 * one module.
 *
 * ## What is deliberately NOT claimed
 *
 * Only the top level of the profile's `node_modules` is inspected — the hoisted
 * linker's flattened shape, and the layer a plugin's own import resolves
 * through. A copy nested inside another package's own `node_modules` is outside
 * this scan, and the report says so (`ScanReport.notes`) rather than implying
 * coverage it does not have.
 *
 * Nothing here is specific to `@deepseek-ai/dsh-tools`: any installation-owned
 * package is compared the same way, and the report separates the harness's own
 * packages — the ones whose identity is designed to be process-singleton —
 * from third-party names the installation happens to carry, which are usually
 * harmless in duplicate.
 *
 * @module @argszero/cordis-plugin-profile-duplicate-doctor
 */

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Package scopes whose copies are designed to be process-singleton. */
export const INBOX_SCOPES: readonly string[] = ['@deepseek-ai/']

/**
 * Manifest field that marks a directory as a `dsh`-managed module proxy.
 *
 * A proxy is the harness's own redirection to the single installed copy, so it is
 * shared by construction and must never be reported as a duplicate.
 */
export const PROXY_MARKER = 'moduleFallback'

/** One loadable package the installation owns. */
export interface InstallationCopy {
  /** Absolute package directory. */
  readonly dir: string
  /** Declared version, when the manifest states one. */
  readonly version: string | undefined
}

/** Resolves a package name to the copy the *installation* owns, when it has one. */
export type InstallationResolver = (name: string) => InstallationCopy | undefined

/** What an entry under the profile's `node_modules` turned out to be. */
export type CopyShape =
  /** A real directory: the linker materialized it here. */
  | 'directory'
  /** A symlink; what matters is where it points. */
  | 'link'
  /** Nothing readable is there. */
  | 'unreadable'

/** One entry under `<profile>/node_modules`. */
export interface ProfileEntry {
  /** Bare package name, including its scope. */
  readonly name: string
  /** The entry path (`<modulesDir>/<name>`). */
  readonly path: string
  /** What is at that path. */
  readonly shape: CopyShape
  /** The resolved directory, when the entry resolves. */
  readonly realDir: string | undefined
  /** Declared version, when the manifest states one. */
  readonly version: string | undefined
  /** The parsed manifest, when there is one. */
  readonly manifest: Readonly<Record<string, unknown>> | undefined
  /** Whether the manifest marks this directory as a `dsh`-managed module proxy. */
  readonly proxy: boolean
  /** Whether the manifest declares the name being looked for (otherwise it is not that package). */
  readonly declaresName: boolean
}

/** A manifest field a package can be required through. */
export type DeclarationSection = 'dependencies' | 'peerDependencies'

/** One manifest that names a duplicated package. */
export interface Declarer {
  /** The declaring package's name, or a description of the manifest when it has none. */
  readonly name: string
  /** The field the name appears in. */
  readonly section: DeclarationSection
  /** The declared range. */
  readonly range: string
  /** Absolute path of the declaring manifest. */
  readonly manifestPath: string
}

/** How much a duplicate is expected to hurt. */
export type Severity =
  /**
   * A harness package: its identity is a `unique symbol` or a service
   * registration, so two copies cannot see each other's. This is the crash class.
   */
  | 'identity'
  /**
   * Any other installation-owned name. Two copies are two modules, which is
   * usually harmless and occasionally is not — reported, with the distinction
   * stated rather than asserted away.
   */
  | 'duplicate'

/** One package the profile carries a second copy of. */
export interface DuplicateFinding {
  /** Bare package name. */
  readonly name: string
  /** How much this duplicate is expected to hurt. */
  readonly severity: Severity
  /** Where the profile's copy lives. */
  readonly profileDir: string
  /** The profile copy's declared version. */
  readonly profileVersion: string | undefined
  /** Where the installation's copy lives. */
  readonly installationDir: string
  /** The installation copy's declared version. */
  readonly installationVersion: string | undefined
  /** The manifests that name this package, sorted by name. */
  readonly declarers: readonly Declarer[]
  /** One line of measured evidence, for the report. */
  readonly evidence: string
}

/** Everything one scan learned. */
export interface ScanReport {
  /** The profile the scan describes. */
  readonly profileDir: string
  /** `<profile>/node_modules`. */
  readonly modulesDir: string
  /** `<home>/profiles/node_modules`, the layer the installation manages for every profile. */
  readonly sharedModulesDir: string
  /** How many entries were installation-owned and therefore compared. */
  readonly reviewed: number
  /** Installation-owned names whose profile entry resolves to the installation's own copy. */
  readonly shared: readonly string[]
  /** The second copies, sorted by name. */
  readonly findings: readonly DuplicateFinding[]
  /** Honest limits of this scan, for the report and the log. */
  readonly notes: readonly string[]
}

/** Options for {@link scanProfileDuplicates}. */
export interface ScanOptions {
  /** The profile directory (`profileContext.dir`). */
  readonly profileDir: string
  /** Resolves the installation's own copy of a name; omit to report without it. */
  readonly installation?: InstallationResolver
  /** Scopes treated as harness packages; defaults to {@link INBOX_SCOPES}. */
  readonly inboxScopes?: readonly string[]
}

/**
 * Read a package manifest, or undefined when it is absent or unparseable.
 * @param dir - the package directory.
 * @returns the parsed manifest.
 */
export function readManifest(dir: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** A string-valued record from a manifest field, ignoring everything else. */
function stringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

/** Only a plain string, never a number or an object. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The re-export marker of a `dsh`-managed module proxy, when this manifest is one. */
function isProxy(manifest: Readonly<Record<string, unknown>>): boolean {
  const dsh = manifest['dsh']
  if (dsh === null || typeof dsh !== 'object') return false
  return (dsh as Record<string, unknown>)[PROXY_MARKER] !== undefined
}

/** What is at one path, without following a link. */
function shapeOf(path: string): CopyShape {
  try {
    return lstatSync(path).isSymbolicLink() ? 'link' : 'directory'
  } catch {
    return 'unreadable'
  }
}

/** Resolve one entry path, or undefined when it cannot be resolved. */
function realDirOf(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** The entries of one `node_modules` directory, ignoring an absent one. */
function readModules(dir: string): readonly { name: string }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => ({ name: entry.name }))
  } catch {
    return []
  }
}

/**
 * Enumerate the packages installed at the top level of a `node_modules`
 * directory, scoped names included.
 *
 * An entry is reported even when it has no readable manifest: "something is
 * here that is not a package" is a different fact from "nothing is here", and
 * the caller decides which of them it needs.
 * @param modulesDir - the `node_modules` directory.
 * @returns the entries, sorted by name.
 */
export function profileEntries(modulesDir: string): readonly ProfileEntry[] {
  const found: ProfileEntry[] = []
  for (const entry of readModules(modulesDir)) {
    if (entry.name.startsWith('@')) {
      for (const scoped of readModules(join(modulesDir, entry.name))) {
        push(join(modulesDir, entry.name, scoped.name), `${entry.name}/${scoped.name}`)
      }
      continue
    }
    push(join(modulesDir, entry.name), entry.name)
  }
  return found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  function push(path: string, name: string): void {
    const shape = shapeOf(path)
    const realDir = shape === 'unreadable' ? undefined : realDirOf(path)
    const manifest = realDir === undefined ? undefined : readManifest(realDir)
    const declared = stringOf(manifest?.['name'])
    found.push({
      name,
      path,
      shape,
      realDir,
      version: stringOf(manifest?.['version']),
      manifest,
      proxy: manifest !== undefined && isProxy(manifest),
      // A directory that merely shares the path is not the package: the manifest
      // has to declare the name being looked for.
      declaresName: manifest !== undefined && (declared === undefined || declared === name),
    })
  }
}

/** Whether two paths are the same directory once links are resolved. */
function sameCopy(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return realDirOf(left) === realDirOf(right)
}

/** Every manifest that names the packages under a profile, keyed by the name it declares. */
function collectDeclarers(
  entries: readonly ProfileEntry[],
  profileDir: string,
): ReadonlyMap<string, readonly Declarer[]> {
  const byName = new Map<string, Declarer[]>()

  const add = (declaredName: string, declarer: Declarer): void => {
    const list = byName.get(declaredName)
    if (list === undefined) byName.set(declaredName, [declarer])
    else list.push(declarer)
  }

  for (const entry of entries) {
    const manifest = entry.manifest
    if (manifest === undefined) continue
    const owner = stringOf(manifest['name']) ?? entry.name
    for (const section of ['dependencies', 'peerDependencies'] as const) {
      for (const [declaredName, range] of Object.entries(stringMap(manifest[section]))) {
        add(declaredName, {
          name: owner,
          section,
          range,
          manifestPath: join(entry.realDir ?? entry.path, 'package.json'),
        })
      }
    }
  }

  // The profile's own manifest is a declarer too: `dependencies` there installs
  // into the profile exactly as a plugin's does.
  const profileManifest = readManifest(profileDir)
  if (profileManifest !== undefined) {
    const owner = stringOf(profileManifest['name']) ?? '(the profile manifest)'
    for (const section of ['dependencies', 'peerDependencies'] as const) {
      for (const [declaredName, range] of Object.entries(stringMap(profileManifest[section]))) {
        add(declaredName, { name: owner, section, range, manifestPath: join(profileDir, 'package.json') })
      }
    }
  }

  for (const list of byName.values()) {
    list.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }
  return byName
}

/**
 * A stable one-string fingerprint of what a scan found.
 *
 * Two scans of the same profile must compare equal, and any change in *which*
 * packages are duplicated — a new one, a vanished one, a copy that moved — must
 * compare unequal. It is built from the finding's identity (name, directory,
 * version), not from its attribution: a manifest edited to declare the same copy
 * differently does not change what is on disk, and re-announcing it would be a
 * false alarm. The order is the findings' own, which the scan already sorts.
 * @param report - one scan.
 * @returns the fingerprint; an empty report is the empty string.
 */
export function findingSignature(report: ScanReport): string {
  return report.findings
    .map(finding => `${finding.name}\u0000${finding.profileDir}\u0000${finding.profileVersion ?? ''}`)
    .join('\n')
}

/**
 * Scan one profile for packages it carries a second copy of.
 * @param options - the profile and the optional installation resolver.
 * @returns the report; `findings` is empty when every installation-owned entry is shared.
 */
export function scanProfileDuplicates(options: ScanOptions): ScanReport {
  const profileDir = options.profileDir
  const modulesDir = join(profileDir, 'node_modules')
  // `profileContext.dir` is `<home>/profiles/<name>` by construction
  // (`resolveProfileDir`), so its parent is the profiles directory.
  const sharedModulesDir = join(dirname(profileDir), 'node_modules')
  const notes: string[] = []
  const inboxScopes = options.inboxScopes ?? INBOX_SCOPES
  const entries = profileEntries(modulesDir)
  const declarers = collectDeclarers(entries, profileDir)
  const findings: DuplicateFinding[] = []
  const shared: string[] = []
  let reviewed = 0

  for (const entry of entries) {
    if (entry.manifest === undefined || !entry.declaresName) continue
    const installation = options.installation?.(entry.name)
    // A name the installation does not own is an ordinary out-of-tree package:
    // having its own directory here is the whole point of installing it.
    if (installation === undefined) continue
    reviewed += 1
    if (entry.proxy || sameCopy(entry.realDir, installation.dir)) {
      shared.push(entry.name)
      continue
    }
    const named = declarers.get(entry.name) ?? []
    findings.push({
      name: entry.name,
      severity: inboxScopes.some(scope => entry.name.startsWith(scope)) ? 'identity' : 'duplicate',
      profileDir: entry.realDir ?? entry.path,
      profileVersion: entry.version,
      installationDir: installation.dir,
      installationVersion: installation.version,
      declarers: named,
      evidence: `profile copy ${entry.realDir ?? entry.path}`
        + `${entry.version === undefined ? '' : ` (v${entry.version})`} is a distinct directory from the`
        + ` installation copy ${installation.dir}`
        + `${installation.version === undefined ? '' : ` (v${installation.version})`}, which pnpm materialized`
        + ` inside this profile${named.length === 0 ? '' : ` for ${named.map(entry => entry.name).join(', ')}`}`,
    })
  }

  if (entries.length === 0) notes.push(`no package is installed under ${modulesDir}`)
  notes.push(`only the top level of ${modulesDir} is inspected (the hoisted linker shape)`)
  if (options.installation === undefined) {
    notes.push('no installation resolver was available, so installation-owned copies could not be identified')
  } else if (findings.length > 0) {
    for (const finding of findings) {
      if (finding.declarers.length === 0) {
        notes.push(`no manifest in this profile names "${finding.name}"; the declaring manifest was not found at `
          + 'the top level of the profile, so the copy is reported without attribution')
      }
    }
  }
  notes.push('a duplicate is not removed by this scan: it reports what is on disk, and never writes')

  return {
    profileDir,
    modulesDir,
    sharedModulesDir,
    reviewed,
    shared,
    findings,
    notes,
  }
}
