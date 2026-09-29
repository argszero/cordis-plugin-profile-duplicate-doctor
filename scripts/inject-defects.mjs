/**
 * Defect injection: mutate the source, rebuild, run the affected suite, and
 * require that the mutation is caught. An arm whose mutation leaves the suite
 * green is SILENT — it proves nothing about the test that was supposed to hold
 * the line.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with tsc
 * first; a mutation that fails to type-check proves nothing either, and is
 * reported separately as UNBUILDABLE. The source is restored **and rebuilt**
 * whatever happened: an injector that can leave a mutation (or a stale `lib/`)
 * in the tree would be worse than no injector.
 *
 * Every mutation here is a defect this plugin could plausibly ship — a gate
 * dropped, a comparison replaced by a weaker one, a boundary sentence removed,
 * state hoisted out of its mount. None is engineered to be caught: each names
 * the shape of mistake the arm exists for.
 *
 * Run from the plugin root: `npm run test:inject`.
 *
 * The control arm is the unmutated suite, run first: every mutant is compared
 * against a suite that is known green, so a manifest-wide failure (a broken
 * dependency, a missing build) cannot be mistaken for a caught defect.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MUTATIONS = [
  {
    name: 'a copy is resolved by name instead of by directory, so every installation-owned entry counts as shared',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [[
      '  return realDirOf(left) === realDirOf(right)',
      '  return true',
    ]],
  },
  {
    name: 'a directory that merely shares the path of an installation-owned package is taken for that package',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [[
      '      declaresName: manifest !== undefined && (declared === undefined || declared === name),',
      '      declaresName: manifest !== undefined,',
    ]],
  },
  {
    name: 'the harness own module proxy is not exempted, so its redirection is reported as a second copy',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [[
      '    if (entry.proxy || sameCopy(entry.realDir, installation.dir)) {',
      '    if (sameCopy(entry.realDir, installation.dir)) {',
    ]],
  },
  {
    name: 'scoped entries are not enumerated, so a scoped package is invisible to the scan',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [[
      "    if (entry.name.startsWith('@')) {",
      '    if (false) {',
    ]],
  },
  {
    name: 'a peer declaration is not read, so the section the correct shape uses is dropped from the attribution',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [[
      "    for (const section of ['dependencies', 'peerDependencies'] as const) {\n      for (const [declaredName, range] of Object.entries(stringMap(manifest[section]))) {",
      "    for (const section of ['dependencies'] as const) {\n      for (const [declaredName, range] of Object.entries(stringMap(manifest[section]))) {",
    ]],
  },
  {
    name: 'every duplicate is called the identity class, so the "usually harmless" distinction is lost',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [[
      "      severity: inboxScopes.some(scope => entry.name.startsWith(scope)) ? 'identity' : 'duplicate',",
      "      severity: 'identity',",
    ]],
  },
  {
    name: 'the scan stops stating its own limits, so a clean report implies coverage it does not have',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [[
      "  notes.push('a duplicate is not removed by this scan: it reports what is on disk, and never writes')",
      "  notes.push('scan complete')",
    ]],
  },
  {
    name: 'the remedy names the field that causes the defect instead of the field that fixes it',
    file: 'src/advice.ts',
    arms: 'plugin.spec.mjs',
    edits: [[
      "    '     installation provides belongs in `peerDependencies` (and `devDependencies` for the type-check and the',",
      "    '     installation provides belongs in `dependencies` (and `devDependencies` for the type-check and the',",
    ]],
  },
  {
    name: 'the advisory is delivered on every step instead of once per agent',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [[
      '    if (!ledger.claim(agent)) return undefined',
      '    if (!ledger.claim(agent)) void 0',
    ]],
  },
  {
    name: 'the mount option that asks for a log-only run is ignored',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [[
      '  const advise = config.advise !== false',
      '  const advise = true',
    ]],
  },
  {
    name: 'a process with no launcher gets no line of its own, so a scan that never ran reads like a clean profile',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [[
      "    ctx.logger.warn('profile-duplicate-doctor: no profileContext in this process, so no boot scan was taken')",
      '    void facts',
    ]],
  },
  {
    name: 'the advisory is computed, logged, and then dropped instead of admitted into the step',
    file: 'src/index.ts',
    arms: 'plugin.spec.mjs',
    edits: [[
      '    return { ...decision, messages: [...decision.messages, message] }',
      '    return decision',
    ]],
  },
  {
    name: 'the finding quotes the entry path instead of the directory that was measured',
    file: 'src/scan.ts',
    arms: 'scan.spec.mjs',
    edits: [[
      '      profileDir: entry.realDir ?? entry.path,',
      '      profileDir: entry.path,',
    ]],
  },
  {
    name: 'the advice bookkeeping is module-level instead of per mount',
    file: 'src/state.ts',
    arms: 'plugin.spec.mjs',
    edits: [[
      '  const states = new WeakMap<object, AgentState>()',
      '  const states = SHARED_STATES',
    ]],
    // The mutation needs its own carrier for the shared map, which a single
    // find/replace pair cannot express, so it is declared as a second rewrite.
    extra: [[
      'export function createAdviceLedger(): AdviceLedger {',
      'const SHARED_STATES = new WeakMap<object, AgentState>()\nexport function createAdviceLedger(): AdviceLedger {',
    ]],
  },
]

/** Rebuild `lib/` from `src/`; true when tsc accepted the tree. */
function build() {
  try {
    execFileSync('npx', ['tsc'], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Run one suite file; true when it failed, plus its output. */
function runSuite(arms) {
  try {
    execFileSync('node', ['--test', `test/${arms}`], { cwd: ROOT, stdio: 'pipe' })
    return { failed: false, output: '' }
  } catch (error) {
    return { failed: true, output: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

// The control arm: the unmutated tree. A suite that is red on its own makes
// every CAUGHT below meaningless, so it is asserted rather than assumed.
if (!build()) {
  console.log('CONTROL UNBUILDABLE: src/ does not compile, no arm below proves anything')
  process.exit(1)
}
const control = runSuite(['*.spec.mjs'])
if (control.failed) {
  console.log('CONTROL RED: the unmutated suite fails, no arm below proves anything')
  console.log(control.output)
  process.exit(1)
}
console.log('CONTROL: the unmutated suite is green')

let silent = 0
let unbuildable = 0
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of [...mutation.extra ?? [], ...mutation.edits]) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) continue

  writeFileSync(path, mutated)
  let built = false
  let result = { failed: false, output: '' }
  try {
    built = build()
    if (built) result = runSuite(mutation.arms)
  } finally {
    // Restore the source and rebuild, whatever happened: leaving either a
    // mutation or a stale `lib/` behind is the failure mode this file exists to
    // avoid, and a stale `lib/` is how an arm goes SILENT.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  const caught = result.failed && /fail [1-9]/.test(result.output)
  if (!caught && mutation.equivalent === undefined) silent += 1
  const label = caught ? 'CAUGHT' : mutation.equivalent === undefined ? 'SILENT' : 'EQUIVALENT'
  console.log(`${label}: ${mutation.name} (${mutation.arms})${caught || mutation.equivalent === undefined ? '' : ` — ${mutation.equivalent}`}`)
}
console.log(`SILENT ARMS: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${String(unbuildable)}`)
if (silent > 0 || unbuildable > 0) process.exit(1)
