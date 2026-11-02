import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Change, Issue, TeamStatus } from '../types'
import {
  PRIORITY,
  ago,
  bar,
  color,
  diff,
  fetchTree,
  fit,
  getIssue,
  glyph,
  initials,
  isClosed,
  legend,
  parseIssueRef,
  parseResult,
  pickable,
  promptSection,
  readyToClose,
  rollup,
  rows,
  treeText,
  type Row,
  upsert,
  type McpCall,
} from './model'

// Bump a shape tag when that value's fields change: it declines what an older
// version stored, which outlives a reload.
const root = atom({ plugin: 'linear-panel', key: 'root' } as const, null, { shape: 'root-1' })
const issues = atom({ plugin: 'linear-panel', key: 'issues' } as const, [], { shape: 'issues-1' })
const loading = atom({ plugin: 'linear-panel', key: 'loading' } as const, false, { shape: 'loading-1' })
const error = atom({ plugin: 'linear-panel', key: 'error' } as const, null, { shape: 'error-1' })
const refreshedAt = atom({ plugin: 'linear-panel', key: 'refreshedAt' } as const, 0, { shape: 'refreshedAt-1' })
const truncated = atom({ plugin: 'linear-panel', key: 'truncated' } as const, false, { shape: 'truncated-1' })
const selected = atom({ plugin: 'linear-panel', key: 'selected' } as const, null, { shape: 'selected-1' })
const mode = atom({ plugin: 'linear-panel', key: 'mode' } as const, 'none', { shape: 'mode-1' })
const focus = atom({ plugin: 'linear-panel', key: 'focus' } as const, null, { shape: 'focus-1' })
const changes = atom({ plugin: 'linear-panel', key: 'changes' } as const, [], { shape: 'changes-1' })
const statuses = atom({ plugin: 'linear-panel', key: 'statuses' } as const, {}, { shape: 'statuses-1' })
const now = atom({ plugin: 'linear-panel', key: 'now' } as const, 0, { shape: 'now-1' })

const PLUGIN = 'linear-panel'
const PANE = 'linear'
const TITLE = 'Linear'
const KEEP_CHANGES = 30
/** A status change seen within this long of a write we made is credited to that writer. */
const CREDIT_MS = 5 * 60_000

// Module state: starts over on a reload, which is fine for all of it.
let refreshing: Promise<void> | undefined
let queued = false
/** Who last wrote each issue, and when: credits the next diff. */
const wroteBy = new Map<string, { by: Change['by']; at: number }>()
/** The session's folder: the last tracked root is remembered per folder. */
let sessionCwd = ''

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Options, set as `register` runs. */
const cfg = { server: 'linear', refreshMs: 90_000, instruct: true }

function mcp($: EngineInterface): McpCall {
  return (tool, args) => $.mcp.call(cfg.server, tool, args)
}

function who(id: string): Change['by'] {
  const w = wroteBy.get(id)
  return w && Date.now() - w.at < CREDIT_MS ? w.by : 'linear'
}

async function record($: EngineInterface, found: Change[]) {
  if (!found.length) return
  for (const c of found) wroteBy.delete(c.id)
  await update($, changes, list => [...found, ...list].slice(0, KEEP_CHANGES))
  const others = found.filter(c => c.by === 'linear')
  if (others.length === 1) await $.ui.toast(`Linear: ${others[0]!.id} ${others[0]!.from} → ${others[0]!.to}`)
  else if (others.length > 1) await $.ui.toast(`Linear: ${others.length} status changes in ${await read($, root)}`)
}

async function loadStatuses($: EngineInterface, list: readonly Issue[]) {
  const known = await read($, statuses)
  const teams = [...new Set(list.map(i => i.team).filter((t): t is string => !!t && !known[t]))]
  for (const team of teams) {
    try {
      const raw = parseResult(await $.mcp.call(cfg.server, 'list_issue_statuses', { team })) as TeamStatus[]
      if (Array.isArray(raw)) await update($, statuses, s => ({ ...s, [team]: raw }))
    } catch {
      // The picker just stays empty for that team.
    }
  }
}

/** Re-reads the whole tree; overlapping calls fold into one more run. */
async function refresh($: EngineInterface): Promise<void> {
  if (refreshing) {
    queued = true
    return refreshing
  }
  refreshing = (async () => {
    do {
      queued = false
      const id = await read($, root)
      if (!id) break
      await update($, loading, () => true)
      try {
        const prev = await read($, issues)
        const got = await fetchTree(mcp($), id)
        if ((await read($, root)) !== id) continue // retargeted mid-walk
        const at = Date.now()
        await record($, prev.length ? diff(prev, got.issues, at, who) : [])
        await update($, issues, () => got.issues)
        await update($, truncated, () => got.truncated)
        await update($, refreshedAt, () => at)
        await update($, now, () => at)
        await update($, error, () => null)
        await loadStatuses($, got.issues)
      } catch (err) {
        await update($, error, () => errText(err))
      } finally {
        await update($, loading, () => false)
      }
    } while (queued)
  })().finally(() => {
    refreshing = undefined
  })
  return refreshing
}

/** Re-reads one issue after a write; a new or moved issue re-reads the tree. */
async function refreshOne($: EngineInterface, id: string): Promise<void> {
  try {
    const issue = await getIssue(mcp($), id)
    const prev = await read($, issues)
    const old = prev.find(i => i.id === id)
    if (!old || old.parentId !== issue.parentId) return void refresh($)
    await record($, diff([old], [issue], Date.now(), who))
    await update($, issues, list => upsert(list, issue))
  } catch {
    void refresh($)
  }
}

async function track($: EngineInterface, id: string): Promise<void> {
  await update($, root, () => id)
  await update($, issues, () => [])
  await update($, changes, () => [])
  await update($, selected, () => null)
  await update($, mode, () => 'none')
  await update($, focus, () => null)
  await update($, error, () => null)
  if (sessionCwd) await $.store.set(`root:${sessionCwd}`, id)
  await refresh($)
}

async function openPane($: EngineInterface, focusIt = false): Promise<boolean> {
  await update($, now, () => Date.now())
  const r = await $.ui.open({ id: PANE, title: TITLE, columns: 60, backgroundColor: 'transparent', ...(focusIt ? { focus: true as const } : {}) })
  return r.isPlaced
}

async function setStatus($: EngineInterface, issue: Issue, st: TeamStatus): Promise<void> {
  wroteBy.set(issue.id, { by: 'panel', at: Date.now() })
  try {
    parseResult(await $.mcp.call(cfg.server, 'save_issue', { id: issue.id, state: st.id }))
    await update($, issues, list => list.map(i => (i.id === issue.id ? { ...i, status: st.name, statusType: st.type } : i)))
    await record($, [{ id: issue.id, title: issue.title, from: issue.status, to: st.name, at: Date.now(), by: 'panel' }])
    await $.ui.toast(`${issue.id} → ${st.name}`)
  } catch (err) {
    wroteBy.delete(issue.id)
    await $.ui.toast(`Could not move ${issue.id}: ${errText(err)}`)
  }
}

async function comment($: EngineInterface, issue: Issue, body: string): Promise<void> {
  try {
    parseResult(await $.mcp.call(cfg.server, 'save_comment', { issueId: issue.id, body }))
    await $.ui.toast(`Comment added to ${issue.id}`)
  } catch (err) {
    await $.ui.toast(`Could not comment on ${issue.id}: ${errText(err)}`)
  }
}

async function openUrl($: EngineInterface, url: string) {
  try {
    const r = await $.process.run(['xdg-open', url], { timeoutMs: 5000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`)
  } catch {
    try {
      await $.process.run(['open', url], { timeoutMs: 5000 })
    } catch (err) {
      await $.ui.toast(`Could not open the browser: ${errText(err)}`)
    }
  }
}

async function statusLine($: EngineInterface) {
  const id = await read($, root)
  if (!id) return $.ui.status(undefined)
  const list = await read($, issues)
  const r = rollup(list, id)
  const f = await read($, focus)
  $.ui.status(`◐ ${id} ${r.closed}/${r.total}${f ? ` · on ${f.id}` : ''} · /linear`)
}

type Els = { Text: any; Button: any }

/**
 * The tree as one line per issue: dim connectors, status glyph, an aligned id
 * column, the title, and the sub-issue count + assignee pushed to the right edge.
 * A top-level issue with children gets a spacer line above it, to group.
 */
function treeRows(els: Els, list: readonly Issue[], body: readonly Row[], width: number, focusId: string | undefined, onPick: (id: string) => void) {
  const { Text, Button } = els
  const idW = Math.max(0, ...body.map(r => r.issue.id.length))
  const meta = body.map(r => {
    const sub = r.kids ? rollup(list, r.issue.id) : undefined
    return { sub, count: sub ? `${sub.closed}/${sub.total}` : '', who: initials(r.issue.assignee) }
  })
  const countW = Math.max(0, ...meta.map(m => m.count.length))
  const whoW = Math.max(0, ...meta.map(m => m.who.length))
  const metaW = countW + whoW + (countW && whoW ? 1 : 0)
  const out: RenderChildren[] = []
  body.forEach((r, n) => {
    const i = r.issue
    const m = meta[n]!
    const closed = isClosed(i.statusType)
    const room = width - [...r.guide].length - 2 - idW - 1
    const showMeta = metaW > 0 && room - metaW - 1 >= 12
    const titleW = showMeta ? room - metaW - 1 : room
    const mark = focusId === i.id ? '▸ ' : ''
    if (r.depth === 1 && r.kids && n > 0) out.push(<Text key={`gap-${i.id}`} dimColor>│</Text>)
    out.push(
      <Button key={`row-${i.id}`} plain onPress={() => onPick(i.id)}>
        <Text dimColor>{r.guide}</Text>
        <Text color={color(i)}>{glyph(i.statusType)}</Text>{' '}
        <Text dimColor>{fit(i.id, idW)}</Text>{' '}
        {mark ? <Text color="cyan">{mark}</Text> : ''}
        <Text bold={r.kids > 0 && !closed} dimColor={closed} strikethrough={i.statusType === 'canceled' || i.statusType === 'duplicate'}>
          {fit(i.title, titleW - mark.length)}
        </Text>
        {showMeta ? (
          <Text>
            {' '}
            <Text color={m.sub && m.sub.closed === m.sub.total ? 'green' : undefined} dimColor={!(m.sub && m.sub.closed === m.sub.total)}>
              {m.count.padStart(countW)}
            </Text>
            {countW && whoW ? ' ' : ''}
            <Text dimColor>{m.who.padStart(whoW)}</Text>
          </Text>
        ) : (
          ''
        )}
      </Button>,
    )
  })
  return out
}

export const register: Register = (on, options) => {
  const n = typeof options.refreshSeconds === 'number' ? options.refreshSeconds : Number(options.refreshSeconds)
  cfg.server = typeof options.mcpServer === 'string' && options.mcpServer.trim() ? options.mcpServer.trim() : 'linear'
  cfg.refreshMs = (Number.isFinite(n) && n >= 0 ? n : 90) * 1000
  cfg.instruct = options.instructClaude !== false && options.instructClaude !== 'false'
  const { server, refreshMs, instruct } = cfg
  const linearTool = (name: string) => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${name}`

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionCwd = e.cwd
    await $.command.register({
      name: 'linear',
      description:
        'Linear hierarchy panel: `/linear ENG-123` tracks a parent issue, `/linear` shows/hides, `/linear refresh`, `/linear stop`',
    })
    await $.tool.register({
      name: 'tree',
      description:
        'The tracked Linear hierarchy (parent issue + every sub-issue) with current statuses, assignees, closed/total rollups and the issue you are focused on. Read it before updating Linear.',
      inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'Re-read from Linear first (slower).' } } },
    })
    await $.tool.register({
      name: 'focus',
      description:
        'Tell the Linear panel which issue of the tracked hierarchy you are working on now (shown to the person). Call it when you start on an issue; pass an empty issue to clear.',
      inputSchema: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: 'Issue identifier, e.g. ENG-123; empty to clear.' },
          note: { type: 'string', description: 'A few words on what you are doing.' },
        },
        required: ['issue'],
      },
    })

    // Resume what this folder tracked last session, without opening the pane unasked.
    if (!(await read($, root))) {
      const last = await $.store.get(`root:${e.cwd}`)
      if (typeof last === 'string') {
        await update($, root, () => last)
        void refresh($)
      }
    }

    let tick = 0
    $.clock.every(1000, () => {
      void (async () => {
        tick++
        if (tick % 10 === 0) await update($, now, () => Date.now())
        if (tick % 5 === 0) await statusLine($)
        const id = await read($, root)
        if (!id || !refreshMs || refreshing) return
        if (Date.now() - (await read($, refreshedAt)) >= refreshMs) await refresh($)
      })()
    })
    return started
  })

  on('command.run', { command: 'linear' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'refresh') {
      if (!(await read($, root))) return { text: 'Nothing tracked. `/linear ENG-123` to track a parent issue.' }
      await refresh($)
      const err = await read($, error)
      return { text: err ? `Refresh failed: ${err}` : `Refreshed ${(await read($, issues)).length} issues.` }
    }
    if (arg === 'stop' || arg === 'clear') {
      await update($, root, () => null)
      await update($, issues, () => [])
      await update($, selected, () => null)
      await update($, focus, () => null)
      if (sessionCwd) await $.store.delete(`root:${sessionCwd}`)
      $.ui.status(undefined)
      await $.ui.close({ id: PANE })
      return { text: 'Stopped tracking Linear.' }
    }
    const ref = parseIssueRef(arg)
    if (ref) {
      await openPane($, true)
      await track($, ref)
      const err = await read($, error)
      if (err) return { text: `Tracking ${ref}, but Linear answered: ${err}` }
      return { text: `Tracking ${ref}: ${(await read($, issues)).length} issues.` }
    }
    if (arg) return { text: `Not an issue id: ${arg}. Usage: /linear ENG-123 | refresh | stop` }
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Linear panel closed.' }
    }
    await openPane($, true)
    return { text: (await read($, root)) ? 'Linear panel opened.' : 'Linear panel opened. `/linear ENG-123` to track a parent issue.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const id = instruct ? await read($, root) : null
    if (!id) return composed
    const r = (await read($, issues)).find(i => i.id === id)
    return {
      ...composed,
      sections: [...composed.sections, { id: `${PLUGIN}:tracked`, text: promptSection(r, id, server, PLUGIN), scope: 'session' as const }],
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: `mcp__${PLUGIN}__tree` }, async ($, e) => {
    const id = await read($, root)
    if (!id) return { result: 'No Linear hierarchy is tracked. The person can track one with /linear <ISSUE-ID>.' }
    if ((e as { refresh?: boolean }).refresh || !(await read($, issues)).length) await refresh($)
    const err = await read($, error)
    const text = treeText(await read($, issues), id, await read($, focus), await read($, refreshedAt), Date.now())
    return { result: err ? `${text}\n(last refresh failed: ${err})` : text }
  }).catch(() => ({ result: 'The Linear panel could not read its tree; use the Linear MCP tools directly.' }))

  on('tool.call', { tool: `mcp__${PLUGIN}__focus` }, async ($, e) => {
    const raw = String((e as { issue?: unknown }).issue ?? '').trim()
    const note = (e as { note?: unknown }).note
    const id = raw ? parseIssueRef(raw) : undefined
    if (!id) {
      await update($, focus, () => null)
      await statusLine($)
      return { result: 'focus cleared' }
    }
    await update($, focus, () => ({ id, note: typeof note === 'string' ? note : undefined, at: Date.now() }))
    await statusLine($)
    const tracked = (await read($, issues)).some(i => i.id === id)
    return { result: tracked ? `focused on ${id}` : `focused on ${id} (not in the tracked hierarchy)` }
  }).catch(() => ({ result: 'ok' }))

  // Claude's own writes to Linear: credit them, then re-read what they touched.
  on('tool.call', async ($, e, next) => {
    if (e.tool !== linearTool('save_issue') && e.tool !== linearTool('save_comment')) return next(e)
    const input = e as unknown as Record<string, unknown>
    const target = typeof input.id === 'string' && e.tool === linearTool('save_issue') ? parseIssueRef(input.id) : undefined
    if (target) wroteBy.set(target, { by: 'claude', at: Date.now() })
    const res = await next(e)
    try {
      if ((res as { isError?: boolean }).isError) return res
      if (!(await read($, root))) return res
      const list = await read($, issues)
      const parent = typeof input.parentId === 'string' ? parseIssueRef(input.parentId) : undefined
      if (target && list.some(i => i.id === target)) void refreshOne($, target)
      else if (parent && list.some(i => i.id === parent)) void refresh($) // a new sub-issue
    } catch {
      // The write happened; the panel catches up on its next poll.
    }
    return res
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const width = Math.max(16, e.props.bodyColumns ?? 60)
    const id = await read($, root)
    const list = await read($, issues)
    const at = Math.max(await read($, now), Date.now() - 10_000)
    const isLoading = await read($, loading)
    const err = await read($, error)
    const f = await read($, focus)

    if (!id) {
      return (
        <Box flexDirection="column">
          <Text bold>No Linear hierarchy tracked</Text>
          <Text dimColor>Type /linear ENG-123 (an issue id or URL) to track a parent issue and every sub-issue under it.</Text>
        </Box>
      )
    }

    const sel = await read($, selected)
    const pick = sel ? list.find(i => i.id === sel) : undefined
    const back = () => {
      void update($, selected, () => null)
      void update($, mode, () => 'none')
    }

    if (pick) {
      const m = await read($, mode)
      const r = rollup(list, pick.id)
      const b = bar(r.closed, r.started, r.total, width)
      const teamStatuses = pickable((await read($, statuses))[pick.team ?? ''] ?? [])
      const kids = rows(list, pick.id).slice(1, 40)
      return (
        <Box flexDirection="column">
          <Box gap={2}>
            <Button key="back" label="← back" hotkey="b" plain onPress={back} />
            <Button key="refresh" label="refresh" hotkey="r" plain onPress={() => void refreshOne($, pick.id)} />
          </Box>
          <Text bold>
            {pick.id} <Text color={color(pick)}>{glyph(pick.statusType)} {pick.status}</Text>
            {f?.id === pick.id ? <Text color="cyan"> · Claude is on it</Text> : null}
          </Text>
          <Text>{pick.title}</Text>
          <Text dimColor wrap="truncate">
            {[pick.team, pick.assignee ?? 'unassigned', pick.priority ? PRIORITY[pick.priority] : ''].filter(Boolean).join(' · ')}
          </Text>
          {f?.id === pick.id && f.note ? <Text color="cyan" wrap="truncate-end">▸ {f.note}</Text> : null}
          {r.total ? (
            <Box flexDirection="column">
              <Text dimColor>
                {r.closed}/{r.total} sub-issues closed{r.started ? ` · ${r.started} in progress` : ''}
              </Text>
              <Text wrap="truncate">
                <Text color="green">{'━'.repeat(b.done)}</Text>
                <Text color="yellow">{'━'.repeat(b.doing)}</Text>
                <Text dimColor>{'─'.repeat(b.rest)}</Text>
              </Text>
            </Box>
          ) : null}
          <Text> </Text>
          {m === 'status' ? (
            <Box flexDirection="column">
              <Text bold>Move {pick.id} to</Text>
              {teamStatuses.length === 0 && <Text dimColor>No statuses known for {pick.team ?? 'this team'}.</Text>}
              {teamStatuses.slice(0, 9).map((st, i) => (
                <Button
                  key={`st-${st.id}`}
                  hotkey={String(i + 1)}
                  plain
                  onPress={() => {
                    void update($, mode, () => 'none')
                    if (st.name !== pick.status) void setStatus($, pick, st)
                  }}
                >
                  <Text>
                    {i + 1}. <Text color={color({ status: st.name, statusType: st.type })}>{glyph(st.type)} {st.name}</Text>
                    {st.name === pick.status ? <Text dimColor> (current)</Text> : ''}
                  </Text>
                </Button>
              ))}
              <Button key="cancel" label="cancel" hotkey="x" plain onPress={() => void update($, mode, () => 'none')} />
            </Box>
          ) : m === 'comment' && Input ? (
            <Input
              key="comment"
              label={`Comment on ${pick.id}`}
              placeholder="markdown; Enter sends"
              submitLabel="post"
              autoFocus
              onSubmit={(value: string) => {
                const text = value.trim()
                void update($, mode, () => 'none')
                if (text) void comment($, pick, text)
              }}
            />
          ) : (
            <Box gap={2} flexWrap="wrap">
              <Button key="status" label="status" hotkey="s" plain onPress={() => void update($, mode, () => 'status')} />
              {Input ? <Button key="comment-btn" label="comment" hotkey="c" plain onPress={() => void update($, mode, () => 'comment')} /> : null}
              {pick.url ? <Button key="open" label="open" hotkey="o" plain onPress={() => void openUrl($, pick.url!)} /> : null}
              {pick.url ? (
                <Button key="copy" label="copy link" hotkey="y" plain onPress={() => void $.ui.copy({ text: pick.url!, surface: e.surface })} />
              ) : null}
              {pick.id !== id ? <Button key="track" label="track this" hotkey="t" plain onPress={() => void track($, pick.id)} /> : null}
            </Box>
          )}
          {kids.length ? <Text> </Text> : null}
          {treeRows({ Text, Button }, list, kids, width, f?.id, k => void update($, selected, () => k))}
        </Box>
      )
    }

    const all = rows(list, id)
    const head = all[0]?.issue
    const r = rollup(list, id)
    const b = bar(r.closed, r.started, r.total, width)
    const ready = readyToClose(list)
    const recent = (await read($, changes)).slice(0, 4)
    const refreshed = await read($, refreshedAt)
    const cut = await read($, truncated)
    const keys: RenderChildren[] = []
    legend(all.map(r => r.issue)).forEach((l, n) => {
      if (n) keys.push('  ')
      keys.push(<Text color={l.color}>{l.glyph}</Text>, <Text dimColor> {l.label}</Text>)
    })
    // Docked, the body is at least the pane's height so the footer (refresh +
    // legend) sits on its last rows; a longer tree pushes it down, scrolled to.
    const dock = e.props.placement === 'dock'
    const minRows = dock ? e.props.scroll.bodyRows : undefined
    return (
      <Box flexDirection="column" minHeight={minRows}>
        <Box flexDirection="column" flexGrow={1}>
          <Text bold wrap="truncate-end">
            {id} {head ? <Text color={color(head)}>{glyph(head.statusType)} {head.status}</Text> : null}
          </Text>
          {head ? <Text wrap="truncate-end">{head.title}</Text> : null}
          <Text dimColor wrap="truncate">
            {r.closed}/{r.total} closed{r.total ? ` (${Math.round((r.closed / r.total) * 100)}%)` : ''}
            {r.started ? ` · ${r.started} in progress` : ''} ·{' '}
            {isLoading ? '⟳ reading Linear…' : refreshed ? ago(at - refreshed) : 'not read yet'}
            {cut ? ' · tree cut at cap' : ''}
          </Text>
          <Text wrap="truncate">
            <Text color="green">{'━'.repeat(b.done)}</Text>
            <Text color="yellow">{'━'.repeat(b.doing)}</Text>
            <Text dimColor>{'─'.repeat(b.rest)}</Text>
          </Text>
          {err ? <Text color="red" wrap="truncate-end">✗ {err}</Text> : null}
          {f ? (
            <Button key="focus" plain onPress={() => void update($, selected, () => f.id)}>
              <Text color="cyan" wrap="truncate-end">
                ▸ Claude on {f.id}
                {f.note ? <Text dimColor> · {f.note}</Text> : ''}
              </Text>
            </Button>
          ) : null}
          <Text> </Text>
          {all.length === 0 && <Text dimColor>{isLoading ? 'Loading…' : 'No issues.'}</Text>}
          {treeRows({ Text, Button }, list, all.slice(1), width, f?.id, k => void update($, selected, () => k))}
          {ready.length || recent.length ? <Text dimColor>{'─'.repeat(width)}</Text> : null}
          {ready.slice(0, 3).map(i => (
            <Button key={`ready-${i.id}`} plain onPress={() => void update($, selected, () => i.id)}>
              <Text wrap="truncate-end">
                <Text color="green">✓ </Text>
                {i.id} <Text dimColor>all sub-issues closed · still {i.status}</Text>
              </Text>
            </Button>
          ))}
          {recent.map(c => (
            <Text dimColor wrap="truncate-end">
              {ago(at - c.at)} {c.id} {c.from} → <Text color="text">{c.to}</Text>
              {c.by === 'linear' ? '' : ` (${c.by === 'claude' ? 'Claude' : 'you'})`}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Box gap={2}>
            <Button key="refresh-all" label="refresh" hotkey="r" plain onPress={() => void refresh($)} />
          </Box>
          {keys.length ? <Text>{keys}</Text> : null}
        </Box>
      </Box>
    )
  })
}
