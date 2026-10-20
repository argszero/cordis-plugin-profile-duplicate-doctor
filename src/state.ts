/**
 * Per-agent bookkeeping.
 *
 * The unit of delivery is the **agent**, not the process: the profile is broken
 * for every step of every turn, so the model needs the diagnosis once, and
 * repeating it on every step would spend the session's context on the same
 * paragraph. Keyed on the agent object the `agent/pre-step` waterfall hands the
 * listener, so a second agent in the same process (a subagent, another session)
 * is its own first time.
 *
 * The ledger is created **per mount** rather than at module scope: a process can
 * mount this plugin more than once (tests do), and module-level state would make
 * one mount's first step silence another mount's advisory.
 *
 * ## Generations
 *
 * "Once per agent" is right for a fact that cannot change during the process, and
 * wrong for one that can. The profile is a live directory — a plugin installed
 * into it after this process started is exactly the event this plugin exists to
 * name (see `watch.ts`) — so the ledger counts **generations**: the boot scan is
 * generation 0, and every rescan that finds a different set of copies opens the
 * next one. An agent is owed the advisory once per generation, which is what
 * makes a live install reach an agent already in the middle of a conversation
 * without making every step repeat it.
 *
 * Nothing here is durable. There is no session event to fold and none is wanted:
 * the advisory rides the step's admitted message batch, which the loop commits
 * into history itself, and a process restart re-derives the whole decision from
 * the filesystem.
 *
 * @module @argszero/cordis-plugin-profile-duplicate-doctor
 */

/** What is remembered about one agent. */
export interface AgentState {
  /** The generation this agent was last advised in, or undefined when never. */
  generation?: number
  /** How many steps were left untouched because of the advisory. */
  suppressed: number
}

/** The per-mount ledger. */
export interface AdviceLedger {
  /**
   * Claim the advisory for one agent, in the current generation.
   * @param agent - the agent identity.
   * @returns true when this agent has not been advised since the last change.
   */
  readonly claim: (agent: object) => boolean
  /**
   * Open a new generation: every agent is owed the advisory again.
   * @returns the new generation number.
   */
  readonly bump: () => number
  /** The current generation (0 until the first change). */
  readonly generation: () => number
  /** How many steps one agent's advisory has suppressed, in total. */
  readonly suppressed: (agent: object) => number
  /** Whether one agent has been advised in the current generation. */
  readonly advised: (agent: object) => boolean
}

/**
 * Create one mount's ledger.
 * @returns the ledger, backed by a WeakMap so a finished agent stays collectable.
 */
export function createAdviceLedger(): AdviceLedger {
  const states = new WeakMap<object, AgentState>()
  let current = 0
  return {
    claim: (agent: object): boolean => {
      const existing = states.get(agent)
      if (existing === undefined) {
        states.set(agent, { generation: current, suppressed: 0 })
        return true
      }
      if (existing.generation === current) {
        existing.suppressed += 1
        return false
      }
      existing.generation = current
      return true
    },
    bump: (): number => {
      current += 1
      return current
    },
    generation: (): number => current,
    suppressed: (agent: object): number => states.get(agent)?.suppressed ?? 0,
    advised: (agent: object): boolean => states.get(agent)?.generation === current,
  }
}
