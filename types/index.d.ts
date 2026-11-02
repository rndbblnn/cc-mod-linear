/** One Linear issue as the panel tracks it. */
export type Issue = {
  /** Identifier, e.g. "ENG-123". */
  id: string
  title: string
  /** Workflow state name, e.g. "In Review". */
  status: string
  /** Workflow state type: triage | backlog | unstarted | started | completed | canceled | duplicate. */
  statusType: string
  assignee?: string | null
  parentId?: string | null
  /** 0 none, 1 urgent .. 4 low. */
  priority?: number
  team?: string
  url?: string
  updatedAt?: string
}

/** A status change the panel noticed, and who made it. */
export type Change = {
  id: string
  title: string
  from: string
  to: string
  at: number
  by: 'panel' | 'claude' | 'linear'
}

/** The issue Claude said it is working on. */
export type Focus = { id: string; note?: string; at: number }

export type TeamStatus = { id: string; name: string; type: string }

declare module 'claude-code' {
  interface PluginState {
    'linear-panel': {
      /** The tracked parent issue; null when nothing is tracked. */
      root: Shaped<string | null>
      /** The root and every descendant, as last read from Linear. */
      issues: Shaped<Issue[]>
      loading: Shaped<boolean>
      error: Shaped<string | null>
      /** Epoch ms of the last full read. */
      refreshedAt: Shaped<number>
      /** True when the tree hit the node cap and was cut. */
      truncated: Shaped<boolean>
      /** The issue whose detail view is open; null shows the tree. */
      selected: Shaped<string | null>
      /** 'comment' while the comment box is open, 'status' while the status picker is. */
      mode: Shaped<'none' | 'comment' | 'status'>
      focus: Shaped<Focus | null>
      changes: Shaped<Change[]>
      /** Workflow states per team name. */
      statuses: Shaped<Record<string, TeamStatus[]>>
      /** Clock for "refreshed 30s ago". */
      now: Shaped<number>
    }
  }
}
