# @argszero/cordis-plugin-profile-duplicate-doctor

Names the second copy of a package your profile did not need — and the manifest
that declared it.

```sh
npm install @argszero/cordis-plugin-profile-duplicate-doctor
```

Until 0.2.0 reaches the registry, the same package installs straight from this
repository — `npm install github:argszero/cordis-plugin-profile-duplicate-doctor`
inside the profile directory, which builds `lib/` on install (verified
2026-10-20 with npm 12.2.0: the tree arrives at version 0.2.0 with `lib/`
present).

Mount it in a profile and it runs on every start; there is nothing to configure.

```yaml
- insert:
    - id: profile-duplicate-doctor
      name: '@argszero/cordis-plugin-profile-duplicate-doctor'
```

The bundle patch (`cordis.patch.yml`) does exactly this, so a profile that lists
the package as a bundle gets it by installing it.

## The defect

`dsh` supplies its own packages once, beside the application, and a plugin
installed into a profile is meant to *share* that copy — which is why the
authoring guide asks for `peerDependencies` on them. A plugin that instead lists
one in `dependencies` makes pnpm **install** it, and under the hoisted linker a
real second copy appears inside `<profile>/node_modules`. The plugin's `import`
reaches that copy, so the package's module-level identity is evaluated twice: two
`Symbol`s, two service registrations, two class objects.

`@deepseek-ai/dsh-tools` publishes `TOOL_RUNTIME_SCHEDULER` as a `unique symbol`,
and the agent loop reads it off the service instance the *other* copy produced.
The lookup is therefore `undefined` and the first tool call of every turn dies —
first-party `bash` and `read` included — with `tool/call` already on disk and
`turn/end` closing immediately as an error:

```
dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')
```

Every command fails, retrying cannot change anything, and the profile is only
broken inside the process that loaded the second copy — which is why discussion
[#8287](https://github.com/deepseek-ai/deepseek-harness/discussions/8287) had to
isolate it with a three-arm table:

| profile state | result |
| --- | --- |
| plugin installed, and its manifest declares `"@deepseek-ai/dsh-tools"` in `dependencies` | ❌ `reading 'prepare'` |
| plugin removed (pnpm prunes the copy) | ✅ |
| plugin reinstalled with no such entry | ✅ |

The unit of duplication in that report is a **copy**. Earlier reports of the same
crash were one realpath evaluated twice; both end in the same signature and have
different discriminants.

The authoring guide's exception clause is the trap. It asks for
`peerDependencies` on "packages that must share an instance with the host" and
then says "independently versioned third-party dependencies and stateless dsh
utilities" go in `dependencies` — and `@deepseek-ai/dsh-tools` reads like a
stateless utility. It is not one: it carries the `unique symbol` and the
`ToolRuntime` service identity.

## What it does

1. **A boot scan.** Every entry under `<profile>/node_modules` whose name the
   installation also owns is compared to the installation's copy by `realpath`.
   The same directory — a link into the installation, or the harness's own module
   proxy — is the shared shape and is not reported; a distinct directory is a
   second copy. The verdicts go to the host log either way, because a quiet start
   and a scan that never ran must not look alike, and the scan's own limits are
   part of the report.
2. **A rescan when the profile changes.** Installing a plugin into a live profile
   is the ordinary case — `dsh plugin add`, one keystroke before a restart — and a
   scan taken before it cannot see it. The plugin watches `<profile>`,
   `<profile>/node_modules` and every `@scope` directory under it, coalesces one
   install into one rescan, and reports only when the set of second copies
   actually changed. An agent that was already told about the old set is told
   about the new one, once; an agent that has heard nothing new is not disturbed.
3. **One durable advisory per agent.** The `agent/pre-step` waterfall decides
   which messages enter a step, so the first step of each agent additionally
   carries one user-role message naming the duplicated package, both directories
   and their versions, the manifest whose `dependencies` field declared it (with
   the range and the manifest path), and the edit the author owns. The loop
   commits it into the session like any other accepted message, so it is read in
   the step it was about and in every request after.

The report separates two cases, and says which one it is:

- **`identity`** — a harness package (`@deepseek-ai/*`). Its identity is designed
  to be process-singleton, so two copies cannot see each other's and this is the
  crash class above.
- **`duplicate`** — any other installation-owned name. Two copies are two
  modules, which is usually harmless; reported, and read as a warning if the
  package is one whose identity elsewhere has to be a single instance.

## Two copies are not always the same failure

The same second copy has two endings, and the versions decide which:

- **within what the installation accepts** (the common case: the plugin pinned
  the same version, or a compatible one) — the identity splits, everything loads,
  and the **first tool call of every turn** dies with `reading 'prepare'`. The
  advisory reaches the model before that call, which is why it rides
  `agent/pre-step`.
- **outside what the installation accepts** — the startup compatibility check
  refuses the row whose manifest now resolves to the profile's copy. The row never
  activates, the service other packages require is missing, and the process
  **stops during boot**. No plugin runs in that process, this one included, so the
  only place such a profile can be named is the run *before* the restart — which
  is what the watch above exists for.

The report says which one it is, rather than leaving it to be inferred from an
otherwise identical log line.

## What it does NOT do

**It does not remove the copy, and it cannot.** By the time anything is loaded
the symbol has already been evaluated twice, and rewriting another package's
`node_modules` is not a third-party plugin's business. The durable fix belongs
upstream — resolve the package through the installation, or key the identity with
`Symbol.for` — so that a second copy can no longer split it.

What the report is missing without this plugin is the **attribution**: that a
specific manifest's `dependencies` field caused it. A scan over the profile can
supply exactly that, and that is what this plugin contributes.

## The fix, when it is yours

1. Remove the package from the `dependencies` field of the manifest named in the
   report. A package the installation provides belongs in `peerDependencies`, and
   in `devDependencies` for the type-check and the local test run.
2. Run `pnpm install` in the profile directory so the copy is pruned, then
   restart `dsh`.

Reinstalling the plugin while the `dependencies` entry is still there re-creates
the same copy.

## Configuration

```yaml
- insert:
    - id: profile-duplicate-doctor
      name: '@argszero/cordis-plugin-profile-duplicate-doctor'
      config:
        # true (default): the finding also enters the session as one user-role
        # message per agent. false: log only — the scan still runs and reports
        # to the host log, and nothing is ever written to a session.
        advise: true
        # Scopes treated as harness packages, whose identity cannot span two
        # copies. A fork with its own scope adds it here.
        inboxScopes: ['@deepseek-ai/']
        # Optional URL quoted at the end of the advisory.
        href: ''
        # true (default): rescan when the profile changes on disk, so an install
        # made while dsh is running is named before the restart. false: the boot
        # scan only.
        watch: true
        # How long a burst of changes settles before the rescan runs (ms).
        watchSettleMs: 250
```

Nothing here writes: no copy is created, moved or removed, and neither the scan
nor the watch touches the profile tree.

## What the watch cannot cover

- **A change that arrives before this process started.** The boot scan is the
  first reading; nothing earlier exists.
- **A process that is never started again.** The verdict is a diagnosis, not a
  repair: a user who leaves the profile as it is still meets the failure at the
  next start.
- **A copy nested inside another package's own `node_modules`.** Only the top
  level of the profile's `node_modules` is inspected — the hoisted linker's
  flattened shape. The report says so on every run.
- **A process that dies during boot.** Nothing in that process runs, so the case
  is named only from the run before it, which is why the rescan reports a version
  split rather than waiting for the failure.

## Compatibility

Verified on `0.1.7-rc.2` and `0.2.0-rc.2`. The published peer ranges are:

- `@deepseek-ai/cordis`: `^4.0.2`
- `@deepseek-ai/dsh-agent`: `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.1 <0.3.0`
- `@deepseek-ai/dsh-llm`: `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.1 <0.3.0`

`dsh-agent` and `dsh-llm` are compiled against for their types (`PreStepDecision`,
`UserMessage`, `createUserMessage`), which is why they carry the same claim as a
runtime peer.

## Tests

```sh
npm test             # scan arms, plugin arms, rescan arms, packaging guard
npm run test:inject  # mutate the source, rebuild, and require every mutation to be caught
```

The behavior suites build real profile trees under the OS temp directory and drive
the real `agent/pre-step` waterfall on a real cordis context. The rescan arms go
one step further and let a real `fs.watch` deliver real filesystem changes: a
plugin installed mid-session, a scope directory created mid-session, a copy
removed, an edit that changes nothing, and an unmount that must stop all of it.
What they prove is that the listener is wired to the seam, that the advisory rides
the message batch the loop commits, and that the scan's verdicts come from the
filesystem. What they do not prove — and do not claim — is that the harness's
linker produced the tree, or that a real `dsh` crashes this way: the tree is built
to the shape the report describes, and the crash text is taken from it.

## License

MIT
