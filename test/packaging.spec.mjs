/**
 * Packaging guard: the published artifact must declare every bare specifier it
 * imports, must not declare packages it never imports, must actually ship the
 * files the manifest promises — and must describe its own compatibility range
 * the same way in the manifest and in the README.
 *
 * The tarball's own file list is asked of npm and every relative import inside it
 * is then resolved against that list, because five availability probes can all be
 * green while the artifact is missing one of the modules its entry imports.
 *
 * The content assertions are the lesson this family already paid for once: the
 * only surface in a published artifact with no assertion is where stale text
 * lives. `cordis.patch.yml` and the README are prose, so what they claim is
 * checked against the values the code itself exports — the crash signature and
 * the discussion number come from `src/advice.ts`, never from a string typed
 * into this test.
 *
 * Every arm here is a defect this family has already shipped once:
 *
 * - A value import declared only in `devDependencies` resolves on the publishing
 *   machine and fails for a consumer with `ERR_MODULE_NOT_FOUND`.
 * - A `files` list that names the entry but not its modules publishes a package
 *   whose own relative imports are missing.
 * - A peer range is a claim about versions nobody ran: it has twice been written
 *   too long (admitting lines where an imported symbol does not exist) and twice
 *   been quoted only partially in a README, which turns the documentation into
 *   the trap. Both halves are asserted against one list of supported lines.
 * - A bundle patch that still describes the previous release is published
 *   happily, because nothing asserts prose.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import semver from 'semver'
import { CRASH_SIGNATURE, DISCUSSION } from '../lib/advice.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The prerelease lines this plugin was run against.
 *
 * The list is the contract, not the manifest: adding a line here without running
 * the suite on it is how a wrong range gets published.
 */
const SUPPORTED_LINES = ['0.1.7-rc.2', '0.2.0-rc.2']

/** Every file under `dir` whose name ends with one of `extensions`. */
function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some(extension => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/** Specifiers reached by static import/export, dynamic `import()`, and `require()`. */
function allSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])import\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

/** Bare (installable) specifiers only: relative targets and `node:` builtins are not packages. */
function bareSpecifiers(source) {
  return allSpecifiers(source)
    .filter(specifier => !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'))
}

/** The package a specifier resolves to: `@scope/name` or `name`, subpath dropped. */
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])

/** The harness packages whose API this plugin is compiled against. */
const dshPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))

const sourceFiles = [...walk(join(ROOT, 'src'), ['.ts']), ...walk(join(ROOT, 'lib'), ['.js'])]
const imported = new Set()
for (const file of sourceFiles) {
  for (const specifier of bareSpecifiers(readFileSync(file, 'utf8'))) imported.add(packageOf(specifier))
}

/** What npm itself would put in the tarball. */
function packedPaths() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const parsed = JSON.parse(output)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return new Set(entry.files.map(file => file.path))
}

test('the guard has something to guard', () => {
  // A walk that silently finds nothing would make every assertion below vacuous.
  const relative = sourceFiles.flatMap(file => allSpecifiers(readFileSync(file, 'utf8'))
    .filter(specifier => specifier.startsWith('.')))
  assert.ok(sourceFiles.some(file => file.endsWith(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(sourceFiles.some(file => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  assert.ok(imported.size >= 1, `expected at least one bare import, saw ${imported.size}`)
  assert.ok(relative.length >= 3, `expected the entry to import its own modules, saw ${relative.length} relative specifiers`)
})

test('every bare import in the published artifact is a runtime dependency', () => {
  const undeclared = [...imported].filter(name => !runtimeDeclared.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `imported by shipped code but declared only in devDependencies (or nowhere): ${undeclared.join(', ')}`
      + ' — a consumer installing this package by name gets ERR_MODULE_NOT_FOUND',
  )
})

test('no runtime dependency is declared without being imported', () => {
  const unused = [...runtimeDeclared].filter(name => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
})

test('every harness peer range admits exactly the lines this plugin claims, and no next minor', () => {
  // Every `@deepseek-ai/dsh-*` peer is a claim about versions this plugin was run
  // against — `dsh-agent` and `dsh-llm` are imported for their types, and those
  // types are what the shipped `.d.ts` compiles against, so they carry the same
  // claim as a runtime peer.
  assert.ok(dshPeers.length >= 2, `expected the harness peers to be declared, saw ${dshPeers.join(', ')}`)
  for (const name of dshPeers) {
    const range = manifest.peerDependencies[name]
    assert.ok(typeof range === 'string' && range.length > 0, `${name} must carry a range`)
    for (const line of SUPPORTED_LINES) {
      assert.ok(semver.satisfies(line, range), `the peer range for ${name} rejects ${line}, which the README claims`)
    }
    assert.ok(!semver.satisfies('0.3.0', range), `the peer range for ${name} must not admit the next minor line`)
  }
})

test('the README quotes the range it is describing, in full', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  // A README that quotes only the first `||` segment is a trap: it admits one
  // line where the published range admits two.
  for (const name of dshPeers) {
    assert.ok(readme.includes(manifest.peerDependencies[name]), `the README must quote the ${name} range verbatim`)
  }
  for (const line of SUPPORTED_LINES) {
    assert.ok(readme.includes(line), `the README must name the ${line} line it was verified against`)
  }
})

test('the tarball carries the entry, its modules, the bundle patch, and the type declarations', () => {
  const paths = packedPaths()
  for (const required of [
    'package.json',
    'lib/index.js',
    'lib/scan.js',
    'lib/advice.js',
    'lib/state.js',
    'lib/types/index.d.ts',
    'lib/types/scan.d.ts',
    'lib/types/advice.d.ts',
    'lib/types/state.d.ts',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
  ]) {
    assert.ok(paths.has(required), `npm pack omits ${required} (declared in "files"): ${[...paths].join(', ')}`)
  }
  assert.ok(![...paths].some(path => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('scripts/')),
    'source, tests and scripts stay unpublished')
})

test('every manifest entry point is in the tarball, and the patch names this plugin', () => {
  const paths = packedPaths()
  assert.ok(paths.has(manifest.main), `"main" (${manifest.main}) is not in the tarball`)
  assert.ok(paths.has(manifest.types), `"types" (${manifest.types}) is not in the tarball`)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'the bundle patch declaration points at the shipped file')
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(manifest.name), 'the bundle patch must mount this package by name')
  assert.ok(patch.includes('profile-duplicate-doctor'), "the bundle patch must use this plugin's id")
})

test('the bundle patch describes the defect this build reports, not a previous one', () => {
  // Prose is the one published surface with no compiler and no test unless one
  // is written for it, so the two facts it must carry are taken from the module
  // that produces them rather than typed here.
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(CRASH_SIGNATURE), 'the patch must quote the crash the duplicate produces')
  assert.ok(patch.includes(DISCUSSION), 'the patch must cite the discussion it comes from')
  assert.match(patch, /peerDependencies/, 'the patch must name the field the fix belongs in')
  assert.match(patch, /dependencies/, 'the patch must name the field that causes the defect')
})

test('the README describes the defect, names the field at fault, and states the boundary', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes(CRASH_SIGNATURE), 'the README must quote the crash')
  assert.ok(readme.includes(DISCUSSION), 'the README must cite the discussion')
  assert.match(readme, /does not remove/i, 'the README must state that the plugin does not remove the copy')
  assert.match(readme, /Symbol\.for/, 'the README must name the durable fix it cannot perform')
  assert.match(readme, /advise/, 'the README must document the config it ships')
})

test('every relative import inside the tarball resolves to a file the tarball contains', () => {
  const paths = packedPaths()
  let checked = 0
  for (const file of [...paths].filter(path => path.startsWith('lib/') && path.endsWith('.js'))) {
    for (const specifier of allSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      checked += 1
      const target = resolve(ROOT, dirname(file), specifier)
      const candidates = [target, `${target}.js`, join(target, 'index.js')]
      assert.ok(
        candidates.some(candidate => paths.has(resolve(candidate).slice(ROOT.length + 1))),
        `${file} imports ${specifier}, which the tarball does not contain`,
      )
    }
  }
  assert.ok(checked >= 3, `expected to check the entry's own modules, checked ${checked}`)
})
