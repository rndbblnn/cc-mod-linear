// Pure logic for the Linear panel: parsing MCP results, walking the hierarchy,
// ordering, rollups, diffs and labels. No `$` here, so it is unit-tested directly.
import type { Change, Focus, Issue, TeamStatus } from '../types'

/** The fields every issue read asks Linear for. */
export const FIELDS = ['id', 'title', 'status', 'statusType', 'assignee', 'parentId', 'priority', 'team', 'url', 'updatedAt']

/** Hard caps on one walk: Linear is called once per issue that may have children. */
export const MAX_NODES = 300
export const MAX_DEPTH = 8
export const CONCURRENCY = 4

export type McpResult = { content: { type: string; text?: string }[]; isError: boolean }
export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<McpResult>

/** The JSON a Linear MCP tool answered; throws with the server's text when it failed. */
export function parseResult(r: McpResult): unknown {
  const text = r.content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
  if (r.isError) throw new Error(text.slice(0, 300) || 'Linear call failed')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Unexpected Linear answer: ${text.slice(0, 120)}`)
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** One issue from a Linear MCP issue object; undefined when it has no identifier. */
export function toIssue(raw: unknown): Issue | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  if (!id) return undefined
  const pr = o.priority
  const priority = typeof pr === 'number' ? pr : pr && typeof pr === 'object' ? Number((pr as { value?: unknown }).value) : undefined
  const named = (v: unknown) => str(v) ?? (v && typeof v === 'object' ? str((v as { name?: unknown }).name) : undefined)
  return {
    id,
    title: str(o.title) ?? '',
    status: named(o.status) ?? '?',
    statusType: str(o.statusType) ?? 'unstarted',
    assignee: named(o.assignee) ?? null,
    parentId: str(o.parentId) ?? null,
    priority: Number.isFinite(priority) ? priority : undefined,
    team: named(o.team),
    url: str(o.url),
    updatedAt: str(o.updatedAt),
  }
}

export async function getIssue(call: McpCall, id: string): Promise<Issue> {
  const issue = toIssue(parseResult(await call('get_issue', { id, fields: FIELDS })))
  if (!issue) throw new Error(`Linear has no issue ${id}`)
  return issue
}

/** Every direct child of `parentId`, all pages. */
export async function listChildren(call: McpCall, parentId: string): Promise<Issue[]> {
  const out: Issue[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const args: Record<string, unknown> = { parentId, limit: 250, fields: FIELDS, includeArchived: false }
    if (cursor) args.cursor = cursor
    const res = parseResult(await call('list_issues', args)) as { issues?: unknown[]; hasNextPage?: boolean; cursor?: string }
    for (const raw of res.issues ?? []) {
      const i = toIssue(raw)
      // The server is asked for this parent's children; trust it, but pin the parent.
      if (i) out.push({ ...i, parentId: i.parentId ?? parentId })
    }
    if (!res.hasNextPage || !res.cursor) break
    cursor = res.cursor
  }
  return out
}

/**
 * The root and all its descendants, breadth first, `CONCURRENCY` calls at a time.
 * Cut at `MAX_NODES` issues or `MAX_DEPTH` levels (then `truncated`).
 */
export async function fetchTree(call: McpCall, rootId: string): Promise<{ issues: Issue[]; truncated: boolean }> {
  const root = await getIssue(call, rootId)
  const issues: Issue[] = [root]
  const seen = new Set([root.id])
  let level: Issue[] = [root]
  let truncated = false
  for (let depth = 0; level.length && depth < MAX_DEPTH; depth++) {
    const next: Issue[] = []
    for (let i = 0; i < level.length; i += CONCURRENCY) {
      const batch = level.slice(i, i + CONCURRENCY)
      const kids = await Promise.all(batch.map(p => listChildren(call, p.id)))
      for (const k of kids.flat()) {
        if (seen.has(k.id)) continue
        if (issues.length >= MAX_NODES) {
          truncated = true
          break
        }
        seen.add(k.id)
        issues.push(k)
        next.push(k)
      }
      if (truncated) break
    }
    if (truncated) break
    level = next
    if (depth === MAX_DEPTH - 1 && level.length) truncated = true
  }
  return { issues, truncated }
}

// ── Ordering and rollups ──────────────────────────────────────────────

const TYPE_RANK: Record<string, number> = { started: 0, unstarted: 1, triage: 2, backlog: 3, completed: 4, canceled: 5, duplicate: 6 }
const num = (id: string) => Number(id.split('-').pop()) || 0

export const isClosed = (t: string) => t === 'completed' || t === 'canceled' || t === 'duplicate'

export function childrenOf(issues: readonly Issue[]): Map<string, Issue[]> {
  const ids = new Set(issues.map(i => i.id))
  const m = new Map<string, Issue[]>()
  for (const i of issues) {
    if (!i.parentId || !ids.has(i.parentId)) continue
    const list = m.get(i.parentId) ?? []
    list.push(i)
    m.set(i.parentId, list)
  }
  for (const list of m.values())
    list.sort((a, b) => (TYPE_RANK[a.statusType] ?? 9) - (TYPE_RANK[b.statusType] ?? 9) || num(a.id) - num(b.id))
  return m
}

export type Row = { issue: Issue; depth: number; kids: number; guide: string }

/**
 * The tree in drawing order, depth first, active work first among siblings.
 * `guide` is the connector drawn before a row (`│  ├─ `), relative to the root's
 * children; the root's own is empty.
 */
export function rows(issues: readonly Issue[], rootId: string | null): Row[] {
  const root = issues.find(i => i.id === rootId) ?? issues[0]
  if (!root) return []
  const kids = childrenOf(issues)
  const out: Row[] = []
  const seen = new Set<string>()
  const walk = (i: Issue, depth: number, stem: string, last: boolean) => {
    if (seen.has(i.id)) return
    seen.add(i.id)
    const mine = (kids.get(i.id) ?? []).filter(k => !seen.has(k.id))
    out.push({ issue: i, depth, kids: mine.length, guide: depth ? stem + (last ? '└─ ' : '├─ ') : '' })
    const next = depth ? stem + (last ? '   ' : '│  ') : ''
    mine.forEach((k, n) => walk(k, depth + 1, next, n === mine.length - 1))
  }
  walk(root, 0, '', true)
  return out
}

/** `s` cut or padded to exactly `n` columns; a cut ends in `…`. */
export function fit(s: string, n: number): string {
  if (n <= 0) return ''
  const chars = [...s]
  if (chars.length <= n) return s + ' '.repeat(n - chars.length)
  return chars.slice(0, Math.max(0, n - 1)).join('') + '…'
}

/** Closed / total over every descendant of `id` (not `id` itself). */
export function rollup(issues: readonly Issue[], id: string): { closed: number; total: number; started: number } {
  const kids = childrenOf(issues)
  let closed = 0
  let total = 0
  let started = 0
  const stack = [...(kids.get(id) ?? [])]
  const seen = new Set<string>()
  while (stack.length) {
    const i = stack.pop()!
    if (seen.has(i.id)) continue
    seen.add(i.id)
    total++
    if (isClosed(i.statusType)) closed++
    else if (i.statusType === 'started') started++
    stack.push(...(kids.get(i.id) ?? []))
  }
  return { closed, total, started }
}

/** Open parents whose every child is closed: candidates to close. */
export function readyToClose(issues: readonly Issue[]): Issue[] {
  const kids = childrenOf(issues)
  return issues.filter(i => {
    const mine = kids.get(i.id)
    return !isClosed(i.statusType) && !!mine?.length && mine.every(k => isClosed(k.statusType))
  })
}

/** Status changes between two reads of the tree; new and removed issues are not changes. */
export function diff(prev: readonly Issue[], next: readonly Issue[], at: number, who: (id: string) => Change['by']): Change[] {
  const before = new Map(prev.map(i => [i.id, i]))
  const out: Change[] = []
  for (const i of next) {
    const p = before.get(i.id)
    if (p && p.status !== i.status) out.push({ id: i.id, title: i.title, from: p.status, to: i.status, at, by: who(i.id) })
  }
  return out
}

/** Replaces one issue in the list (or adds it under a known parent). */
export function upsert(issues: readonly Issue[], issue: Issue): Issue[] {
  if (issues.some(i => i.id === issue.id)) return issues.map(i => (i.id === issue.id ? { ...i, ...issue } : i))
  if (issue.parentId && issues.some(i => i.id === issue.parentId)) return [...issues, issue]
  return [...issues]
}

// ── Labels ────────────────────────────────────────────────────────────

export function glyph(t: string): string {
  switch (t) {
    case 'started':
      return '◐'
    case 'completed':
      return '●'
    case 'canceled':
    case 'duplicate':
      return '⊘'
    case 'triage':
      return '◇'
    case 'backlog':
      return '◌'
    default:
      return '○'
  }
}

export function color(i: Pick<Issue, 'status' | 'statusType'>): string | undefined {
  if (i.statusType === 'started') return /review|qa/i.test(i.status) ? 'cyan' : 'yellow'
  if (i.statusType === 'completed') return 'green'
  if (i.statusType === 'triage') return 'magenta'
  if (i.statusType === 'canceled' || i.statusType === 'duplicate' || i.statusType === 'backlog') return 'gray'
  return undefined
}

const LEGEND: { key: string; label: string; sample: Pick<Issue, 'status' | 'statusType'> }[] = [
  { key: 'triage', label: 'triage', sample: { status: '', statusType: 'triage' } },
  { key: 'backlog', label: 'backlog', sample: { status: '', statusType: 'backlog' } },
  { key: 'unstarted', label: 'todo', sample: { status: '', statusType: 'unstarted' } },
  { key: 'started', label: 'in progress', sample: { status: '', statusType: 'started' } },
  { key: 'review', label: 'in review', sample: { status: 'review', statusType: 'started' } },
  { key: 'completed', label: 'done', sample: { status: '', statusType: 'completed' } },
  { key: 'canceled', label: 'canceled', sample: { status: '', statusType: 'canceled' } },
]

/** The status glyphs the tree uses, in workflow order, for a legend line. */
export function legend(issues: readonly Pick<Issue, 'status' | 'statusType'>[]): { glyph: string; color?: string; label: string }[] {
  const seen = new Set(
    issues.map(i =>
      i.statusType === 'started' && /review|qa/i.test(i.status) ? 'review' : i.statusType === 'duplicate' ? 'canceled' : i.statusType,
    ),
  )
  return LEGEND.filter(l => seen.has(l.key)).map(l => ({ glyph: glyph(l.sample.statusType), color: color(l.sample), label: l.label }))
}

export const PRIORITY = ['', 'Urgent', 'High', 'Medium', 'Low']

export function initials(name?: string | null): string {
  if (!name) return ''
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase())
    .slice(0, 2)
    .join('')
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

export function bar(closed: number, started: number, total: number, width: number): { done: number; doing: number; rest: number } {
  const w = Math.max(4, width)
  if (!total) return { done: 0, doing: 0, rest: w }
  const done = Math.round((closed / total) * w)
  const doing = Math.min(w - done, Math.round((started / total) * w))
  return { done, doing, rest: w - done - doing }
}

/** Statuses a picker offers, in workflow order. */
export function pickable(list: readonly TeamStatus[]): TeamStatus[] {
  return [...list].sort((a, b) => (PICK_RANK[a.type] ?? 9) - (PICK_RANK[b.type] ?? 9))
}
const PICK_RANK: Record<string, number> = { triage: 0, backlog: 1, unstarted: 2, started: 3, completed: 4, canceled: 5, duplicate: 6 }

/** Parses the issue identifier out of `/linear` args or a Linear URL. */
export function parseIssueRef(s: string): string | undefined {
  const m = s.match(/\b([A-Za-z][A-Za-z0-9]{0,9}-\d+)\b/)
  return m ? m[1]!.toUpperCase() : undefined
}

// ── What Claude reads ─────────────────────────────────────────────────

/**
 * The system prompt section. Stable while the root is: it names the root and the
 * rules, never the statuses, so a refresh never busts the prompt cache.
 */
export function promptSection(root: Issue | undefined, rootId: string, server: string, plugin: string): string {
  const t = (name: string) => `mcp__${server}__${name}`
  return [
    `# Tracked Linear hierarchy`,
    `The person is tracking Linear issue ${rootId}${root ? ` "${root.title}"` : ''} and all its sub-issues in a panel beside the chat.`,
    `Call mcp__${plugin}__tree for the current hierarchy and statuses before deciding what to update. Keep Linear in step with the work:`,
    `- Before you start implementing one of these issues, call mcp__${plugin}__focus with its id; if it is in Triage/Backlog/Todo, move it to In Progress with ${t('save_issue')} (state).`,
    `- When an MR/PR for it is opened, move it to In Review (if the team has that state) and attach the link (${t('save_issue')} links).`,
    `- Add a short ${t('save_comment')} for notable findings, blockers or scope changes, not for routine progress.`,
    `- Never move an issue to Done, Canceled or Duplicate, and never create or re-parent issues, unless the person asks. When every sub-issue of a parent is closed, say so and offer to close the parent.`,
  ].join('\n')
}

/** The tree as text for the `tree` tool: one line per issue, indented. */
export function treeText(issues: readonly Issue[], rootId: string, focus: Focus | null, refreshedAt: number, at: number): string {
  const lines = rows(issues, rootId).map(({ issue: i, depth }) => {
    const r = rollup(issues, i.id)
    const sub = r.total ? ` [${r.closed}/${r.total} closed]` : ''
    const who = i.assignee ? ` @${i.assignee}` : ''
    const f = focus?.id === i.id ? ' ← working on it' : ''
    return `${'  '.repeat(depth)}- ${i.id} [${i.status}] ${i.title}${who}${sub}${f}`
  })
  const ready = readyToClose(issues).map(i => i.id)
  return [
    `Linear hierarchy under ${rootId} (read ${ago(at - refreshedAt)}):`,
    ...lines,
    ...(ready.length ? [`All sub-issues closed, parent still open: ${ready.join(', ')}`] : []),
  ].join('\n')
}
