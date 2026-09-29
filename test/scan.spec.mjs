/**
 * The scan's arms: what counts as a second copy, what does not, and what the
 * report says when it cannot tell.
 *
 * Each arm builds a real tree under the OS temp directory, because the whole
 * question — "is this entry the installation's own directory, or a second one?"
 * — is a question about the filesystem and cannot be asked of a mock.
 */

import assert from 'node:assert/strict'
import { realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createInstallationResolver } from '../lib/index.js'
import { profileEntries, scanProfileDuplicates } from '../lib/scan.js'
import { install, linkInto, scenario, writeJson } from './harness.mjs'

/** Scan one built scenario with the installation resolver it implies. */
function scan(built, options = {}) {
  return scanProfileDuplicates({
    profileDir: built.profileDir,
    installation: createInstallationResolver(built.facts.installAnchor),
    ...options,
  })
}

test('a real second copy of an installation-owned package is a finding, with its declarer named', () => {
  const built = scenario()
  const report = scan(built)
  assert.equal(report.findings.length, 1)
  const [finding] = report.findings
  assert.equal(finding.name, '@deepseek-ai/dsh-tools')
  assert.equal(finding.severity, 'identity')
  // The scan reports the directory it measured, with links resolved — the same
  // resolution the shared/duplicate verdict is made with. The OS temp root is
  // itself behind a link on macOS, so the expected path is resolved the same way
  // rather than quoted lexically.
  assert.equal(finding.profileDir, realpathSync(join(built.profileModules, '@deepseek-ai/dsh-tools')))
  assert.equal(finding.installationDir, join(built.installModules, '@deepseek-ai/dsh-tools'))
  assert.equal(finding.profileVersion, '0.2.0-rc.2')
  assert.equal(finding.installationVersion, '0.2.0-rc.2')
  assert.equal(finding.declarers.length, 1)
  assert.deepEqual(
    { name: finding.declarers[0].name, section: finding.declarers[0].section, range: finding.declarers[0].range },
    { name: 'my-plugin', section: 'dependencies', range: '0.2.0-rc.2' },
  )
  assert.ok(finding.declarers[0].manifestPath.endsWith(join('my-plugin', 'package.json')))
  assert.match(finding.evidence, /distinct directory/)
})

test('the same version in two directories is still two copies: the comparison is realpath, not version', () => {
  // Both copies declare `0.2.0-rc.2`, so a version check would call this clean.
  // It is not: two directories are two modules, and this arm is the reason the
  // scan never compares versions.
  const built = scenario({ duplicateVersion: '0.2.0-rc.2', installedVersion: '0.2.0-rc.2' })
  assert.equal(scan(built).findings.length, 1)
})

test('a symlink to the installation own copy is the shared shape and is not reported', () => {
  const built = scenario({ duplicate: false })
  linkInto(built.profileModules, '@deepseek-ai/dsh-tools', join(built.installModules, '@deepseek-ai/dsh-tools'))
  const report = scan(built)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.shared, ['@deepseek-ai/dsh-tools'])
  assert.equal(report.reviewed, 1)
})

test('a package the installation does not own is not reported: installing it is the point', () => {
  const built = scenario({ duplicate: false })
  install(built.profileModules, 'semver', { name: 'semver', version: '7.6.0' })
  const report = scan(built)
  assert.deepEqual(report.findings, [])
  assert.equal(report.reviewed, 0)
})

test('a profile manifest that names an installation-owned package is a declarer too', () => {
  const built = scenario({
    duplicate: false,
    pluginManifest: { dependencies: {} },
    profileManifest: { name: 'dev', private: true, dependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.2' } },
  })
  install(built.profileModules, '@deepseek-ai/dsh-tools', { name: '@deepseek-ai/dsh-tools', version: '0.2.0-rc.2' })
  const [finding] = scan(built).findings
  assert.equal(finding.declarers.length, 1)
  assert.equal(finding.declarers[0].section, 'dependencies')
  assert.equal(finding.declarers[0].range, '^0.2.0-rc.2')
  assert.equal(finding.declarers[0].manifestPath, join(built.profileDir, 'package.json'))
})

test('a peer declaration is reported with its own section and range', () => {
  const built = scenario({
    pluginManifest: { dependencies: {}, peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.2' } },
  })
  const [finding] = scan(built).findings
  assert.equal(finding.declarers.length, 1)
  assert.equal(finding.declarers[0].section, 'peerDependencies')
  assert.equal(finding.declarers[0].range, '^0.2.0-rc.2')
})

test('a copy nothing in the profile declares is reported without attribution, and says so', () => {
  const built = scenario({ pluginManifest: { dependencies: { 'left-pad': '^1.0.0' } } })
  const report = scan(built)
  assert.equal(report.findings.length, 1)
  assert.deepEqual(report.findings[0].declarers, [])
  assert.ok(report.notes.some(note => note.includes('the declaring manifest was not found')))
})

test('a harness-scope duplicate is the identity class; another installation-owned name is not', () => {
  // The installation also carries a third-party package, and the profile has its
  // own copy of that one: two copies, but not a package whose identity the
  // harness relies on, so the severity separates them.
  const built = scenario({ duplicate: false })
  install(built.installModules, 'semver', { name: 'semver', version: '7.6.0' })
  install(built.profileModules, 'semver', { name: 'semver', version: '7.6.0' })
  install(built.profileModules, '@deepseek-ai/dsh-tools', { name: '@deepseek-ai/dsh-tools', version: '0.2.0-rc.2' })
  const report = scan(built)
  assert.deepEqual(
    report.findings.map(finding => [finding.name, finding.severity]),
    [['@deepseek-ai/dsh-tools', 'identity'], ['semver', 'duplicate']],
  )
})

test('the inbox scopes are configurable, so a fork can name its own harness scope', () => {
  const built = scenario({ duplicate: false })
  install(built.installModules, 'semver', { name: 'semver', version: '7.6.0' })
  install(built.profileModules, 'semver', { name: 'semver', version: '7.6.0' })
  const report = scan(built, { inboxScopes: ['semver'] })
  assert.deepEqual(report.findings.map(finding => finding.severity), ['identity'])
})

test('a dsh-managed module proxy is the harness own redirection and is not a second copy', () => {
  const built = scenario({ duplicate: false })
  install(built.profileModules, '@deepseek-ai/dsh-tools', {
    name: '@deepseek-ai/dsh-tools',
    version: '0.2.0-rc.2',
    dsh: { moduleFallback: { targets: { '.': join(built.installModules, '@deepseek-ai/dsh-tools') } } },
  })
  const report = scan(built)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.shared, ['@deepseek-ai/dsh-tools'])
})

test('an entry with no readable manifest is neither compared nor reported', () => {
  const built = scenario({ duplicate: false })
  // A directory that merely shares the path is not the package: it has no
  // manifest declaring the name being looked for.
  install(built.profileModules, '@deepseek-ai/dsh-tools', { name: 'something-else', version: '1.0.0' })
  const report = scan(built)
  assert.deepEqual(report.findings, [])
  assert.equal(report.reviewed, 0)
})

test('scoped and unscoped entries are both enumerated, and a broken entry is still listed', () => {
  // The base shape, because this arm is about the enumeration itself: it needs a
  // scoped entry (the duplicate) beside an unscoped one (the plugin).
  const built = scenario()
  const entries = profileEntries(built.profileModules)
  assert.deepEqual(entries.map(entry => entry.name), ['@deepseek-ai/dsh-tools', 'my-plugin'])
  install(built.profileModules, 'no-manifest', { name: 'x' })
  rmSync(join(built.profileModules, 'no-manifest', 'package.json'))
  const withBroken = profileEntries(built.profileModules)
  const broken = withBroken.find(entry => entry.name === 'no-manifest')
  assert.equal(broken.manifest, undefined)
  assert.equal(broken.declaresName, false)
})

test('a dangling entry is unreadable rather than a finding', () => {
  const built = scenario({ duplicate: false })
  linkInto(built.profileModules, '@deepseek-ai/dsh-tools', join(built.root, 'gone', '@deepseek-ai', 'dsh-tools'))
  const [entry] = profileEntries(built.profileModules).filter(candidate => candidate.name.startsWith('@deepseek-ai/'))
  assert.equal(entry.realDir, undefined)
  assert.deepEqual(scan(built).findings, [])
})

test('a clean profile reports nothing and still states the scan limits', () => {
  const built = scenario({ duplicate: false, pluginManifest: { dependencies: {} } })
  const report = scan(built)
  assert.deepEqual(report.findings, [])
  assert.ok(report.notes.some(note => note.includes('only the top level')))
  assert.ok(report.notes.some(note => note.includes('never writes')))
})

test('without an installation resolver the scan says so instead of guessing', () => {
  const built = scenario()
  const report = scanProfileDuplicates({ profileDir: built.profileDir })
  assert.deepEqual(report.findings, [])
  assert.equal(report.reviewed, 0)
  assert.ok(report.notes.some(note => note.includes('no installation resolver was available')))
})

test('an absent profile node_modules is a note, not a crash', () => {
  const built = scenario()
  rmSync(built.profileModules, { recursive: true, force: true })
  const report = scan(built)
  assert.deepEqual(report.findings, [])
  assert.ok(report.notes.some(note => note.includes('no package is installed under')))
})

test('the resolver walks up from the installation anchor and only accepts a manifest that declares the name', () => {
  const built = scenario()
  const resolve = createInstallationResolver(built.facts.installAnchor)
  assert.equal(resolve('@deepseek-ai/dsh-tools').dir, join(built.installModules, '@deepseek-ai/dsh-tools'))
  assert.equal(resolve('never-installed'), undefined)
  // A directory that shares the path but declares another name is not that package.
  writeJson(join(built.installModules, 'impostor', 'package.json'), { name: 'other', version: '1.0.0' })
  assert.equal(resolve('impostor'), undefined)
})

test('the report answers the same disk twice with the same verdict', () => {
  const built = scenario()
  assert.deepEqual(scan(built).findings, scan(built).findings)
})
