/**
 * The profile watch: turn "the profile changed on disk" into "scan again".
 *
 * ## Why a scan at boot is not enough
 *
 * The boot scan describes the profile **as the process found it**. Installing a
 * plugin into a live profile — which is what `dsh plugin add` does, and what a
 * user does right before restarting — writes a new directory under
 * `<profile>/node_modules` while this process keeps running. The next start
 * loads it, and if that plugin's `dependencies` names a package the installation
 * already provides, the next start is the one that pays for it: the second copy
 * is materialized, the identity splits, and the first tool call of every turn
 * dies. In the worse variant the compatibility preflight refuses the in-box row
 * the copy shadowed and the process exits — and a process that exits during boot
 * runs no plugin at all, so nothing in this family can report that case after the
 * fact. The only moment such a profile can be named is therefore **between the
 * install and the restart**, while the process that will be restarted is still
 * alive. That is this file.
 *
 * ## What is watched, and why exactly that
 *
 * A package appears in one of three places, so three kinds of directory are
 * watched, all non-recursively:
 *
 * - the **profile directory** — `<profile>/package.json` is written by a plugin
 *   install even when the linker then hoists the entry elsewhere, and the
 *   `node_modules` directory itself is created or removed here;
 * - `<profile>/node_modules` — an unscoped package, or a whole scope directory,
 *   appears as a new entry of this directory;
 * - every `@scope` directory under it — a scoped package appears *inside* the
 *   scope, which the parent's own entry set does not change. Missing this is the
 *   one that would silently skip `@deepseek-ai/*`, so the scope list is rebuilt
 *   after every burst.
 *
 * Recursive watching is deliberately not used: platform support varies, and the
 * shallow shape is the one the hoisted linker produces.
 *
 * ## What a burst is
 *
 * `pnpm install` writes many entries; a scan per event would be waste. Events are
 * coalesced by a settle timer, so one install produces one rescan, and the caller
 * compares the rescan against the previous one — an unchanged profile is silent.
 *
 * ## What this deliberately does not do
 *
 * It does not fight the loader. A rescan is a reading of the filesystem; it never
 * installs, removes, reloads or restarts anything, and the plugins the running
 * process already loaded are untouched. What the rescan buys is the *diagnosis*
 * before the restart, not a repair.
 *
 * @module @argszero/cordis-plugin-profile-duplicate-doctor
 */

import { readdirSync, watch as watchDirectory } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'

/**
 * How long a burst of changes may keep arriving before the rescan runs.
 *
 * Long enough to swallow one `pnpm install` (which touches the linker's whole
 * tree and can take hundreds of milliseconds), short enough that a user who
 * installs a plugin and then reads the log sees the verdict in the same breath.
 */
export const DEFAULT_SETTLE_MS = 250

/** Options for {@link watchProfile}. */
export interface ProfileWatchOptions {
  /** The profile directory (`profileContext.dir`). */
  readonly profileDir: string
  /** Called once per settled burst, after the watch set has been rebuilt. */
  readonly onChange: () => void
  /** The settle window in milliseconds; defaults to {@link DEFAULT_SETTLE_MS}. */
  readonly settleMs?: number
  /**
   * Called when one directory cannot be watched (removed mid-install, a
   * permission, a platform that refuses the path). One directory is not the
   * whole watch: the rest stay armed and the failure is named.
   */
  readonly onError?: (directory: string, error: unknown) => void
}

/** A watch set that can be closed. */
export interface ProfileWatch {
  /** The directories currently watched, sorted — for the log and for tests. */
  readonly directories: () => readonly string[]
  /** Close every watcher and cancel a pending rescan. Idempotent. */
  readonly close: () => void
}

/** The scope directories (`@name`) present under a `node_modules` directory. */
function scopesIn(modulesDir: string): readonly string[] {
  try {
    return readdirSync(modulesDir, { withFileTypes: true })
      .filter(entry => entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink()))
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * Every directory whose own entry set decides what the profile has installed.
 * @param profileDir - the profile directory.
 * @returns absolute directory paths, parents before children.
 */
export function watchedDirectories(profileDir: string): readonly string[] {
  const modulesDir = join(profileDir, 'node_modules')
  const directories = [profileDir, modulesDir]
  for (const scope of scopesIn(modulesDir)) directories.push(join(modulesDir, scope))
  return directories
}

/** Close one watcher without letting its error escape. */
function closeQuietly(watcher: FSWatcher): void {
  try {
    watcher.close()
  } catch {
    // A watcher that is already closed (or whose directory vanished) throws here
    // and there is nothing left to do about it.
  }
}

/**
 * Watch a profile for installs and removals.
 * @param options - the profile and the callback.
 * @returns the watch set; `close()` it when the mount ends.
 */
export function watchProfile(options: ProfileWatchOptions): ProfileWatch {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const watchers = new Map<string, FSWatcher>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  /** Give one directory a watcher, if it does not have one yet. */
  function arm(directory: string): void {
    if (watchers.has(directory) || closed) return
    try {
      // `persistent: false`: the watch is a diagnostic, and a diagnostic that
      // alone keeps a process from exiting is a leak — a test suite that mounts
      // this plugin, or a `dsh` shutting down, must not wait on it.
      const watcher = watchDirectory(directory, { persistent: false }, () => { schedule() })
      watcher.on('error', (error: unknown) => {
        closeQuietly(watcher)
        watchers.delete(directory)
        options.onError?.(directory, error)
      })
      watchers.set(directory, watcher)
    } catch (error: unknown) {
      // A directory that does not exist yet is the ordinary case, not a failure:
      // its parent is watched, so the creation is still seen.
      options.onError?.(directory, error)
    }
  }

  /** Bring the watch set in line with what is on disk now. */
  function rearm(): void {
    const wanted = new Set(watchedDirectories(options.profileDir))
    for (const [directory, watcher] of watchers) {
      if (wanted.has(directory)) continue
      closeQuietly(watcher)
      watchers.delete(directory)
    }
    for (const directory of wanted) arm(directory)
  }

  /** Coalesce one burst of events into one rescan. */
  function schedule(): void {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (closed) return
      // Rebuild first: a scope directory created by this very install has to be
      // under watch before the rescan's verdict is reported, or the next package
      // installed into it would be silent.
      rearm()
      options.onChange()
    }, settleMs)
    // The pending rescan must not be the reason the process stays up, either.
    timer.unref?.()
  }

  rearm()
  // One deferred rescan, so the watch is not born with a hole in it. A filesystem
  // event stream starts asynchronously: an install that lands between the scan the
  // caller already took and the moment the stream is actually delivering would be
  // seen by neither — too late for the scan, too early for the watch. The deferred
  // pass closes that window, and costs nothing when the profile did not change
  // (the caller compares before it speaks).
  schedule()

  return {
    directories: (): readonly string[] => [...watchers.keys()].sort(),
    close: (): void => {
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      for (const watcher of watchers.values()) closeQuietly(watcher)
      watchers.clear()
    },
  }
}
