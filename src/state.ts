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
 * Nothing here is durable. There is no session event to fold and none is wanted:
 * the advisory rides the step's admitted message batch, which the loop commits
 * into history itself, and a process restart re-derives the whole decision from
 * the filesystem.
 *
 * @module @argszero/cordis-plugin-profile-duplicate-doctor
 */

/** What is remembered about one agent. */
export interface AgentState {
  /** Whether this agent has already been given the advisory. */
  advised: boolean
  /** How many steps were left untouched because of it. */
  suppressed: number
}

/** The per-mount ledger. */
export interface AdviceLedger {
  /**
   * Claim the advisory for one agent.
   * @param agent - the agent identity.
   * @returns true for the first claim, false afterwards.
   */
  readonly claim: (agent: object) => boolean
  /** How many steps one agent's advisory has suppressed. */
  readonly suppressed: (agent: object) => number
  /** Whether one agent has already been advised. */
  readonly advised: (agent: object) => boolean
}

/**
 * Create one mount's ledger.
 * @returns the ledger, backed by a WeakMap so a finished agent stays collectable.
 */
export function createAdviceLedger(): AdviceLedger {
  const states = new WeakMap<object, AgentState>()
  return {
    claim: (agent: object): boolean => {
      const existing = states.get(agent)
      if (existing === undefined) {
        states.set(agent, { advised: true, suppressed: 0 })
        return true
      }
      if (existing.advised) {
        existing.suppressed += 1
        return false
      }
      existing.advised = true
      return true
    },
    suppressed: (agent: object): number => states.get(agent)?.suppressed ?? 0,
    advised: (agent: object): boolean => states.get(agent)?.advised === true,
  }
}
