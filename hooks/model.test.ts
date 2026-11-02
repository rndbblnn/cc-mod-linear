import { expect, test } from 'claude-code/testing'

import type { Issue } from '../types'
import { diff, fetchTree, fit, legend, parseIssueRef, readyToClose, rollup, rows, toIssue, treeText, type McpCall } from './model'

const I = (id: string, statusType: string, parentId: string | null, status = statusType): Issue => ({
  id,
  title: `t ${id}`,
  status,
  statusType,
  parentId,
})

const ok = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }], isError: false })

test('toIssue reads the MCP issue shape', async () => {
  const i = toIssue({ id: 'ENG-2', title: 'x', status: 'In Review', statusType: 'started', assignee: 'Ada Lovelace', parentId: 'ENG-1', priority: { value: 2, name: 'High' }, team: 'Eng Team' })
  expect(i).toEqual({ id: 'ENG-2', title: 'x', status: 'In Review', statusType: 'started', assignee: 'Ada Lovelace', parentId: 'ENG-1', priority: 2, team: 'Eng Team', url: undefined, updatedAt: undefined })
  expect(toIssue({ title: 'no id' })).toBe(undefined)
})

test('fetchTree walks every level and follows pages', async () => {
  const kids: Record<string, unknown[]> = {
    'A-1': [{ id: 'A-2', statusType: 'started', status: 'In Progress' }, { id: 'A-3', statusType: 'completed', status: 'Done' }],
    'A-2': [{ id: 'A-4', statusType: 'unstarted', status: 'Todo' }],
  }
  const call: McpCall = async (tool, args) => {
    if (tool === 'get_issue') return ok({ id: 'A-1', title: 'root', status: 'In Progress', statusType: 'started' })
    const list = kids[args.parentId as string] ?? []
    // A-1's children come in two pages.
    if (args.parentId === 'A-1' && !args.cursor) return ok({ issues: list.slice(0, 1), hasNextPage: true, cursor: 'c1' })
    if (args.parentId === 'A-1') return ok({ issues: list.slice(1), hasNextPage: false })
    return ok({ issues: list, hasNextPage: false })
  }
  const { issues, truncated } = await fetchTree(call, 'A-1')
  expect(truncated).toBe(false)
  expect(issues.map(i => i.id).sort()).toEqual(['A-1', 'A-2', 'A-3', 'A-4'])
  expect(issues.find(i => i.id === 'A-4')!.parentId).toBe('A-2')
})

test('fetchTree surfaces a Linear error', async () => {
  const call: McpCall = async () => ({ content: [{ type: 'text', text: 'Entity not found' }], isError: true })
  let msg = ''
  await fetchTree(call, 'X-1').catch(e => (msg = String(e.message)))
  expect(msg).toContain('Entity not found')
})

const tree = [I('A-1', 'started', null), I('A-3', 'completed', 'A-1'), I('A-2', 'started', 'A-1'), I('A-4', 'completed', 'A-2'), I('A-5', 'canceled', 'A-2')]

test('rows: depth first, active siblings first', async () => {
  expect(rows(tree, 'A-1').map(r => `${r.depth}:${r.issue.id}`)).toEqual(['0:A-1', '1:A-2', '2:A-4', '2:A-5', '1:A-3'])
})

test('rows draw tree connectors; fit cuts and pads', async () => {
  expect(rows(tree, 'A-1').map(r => r.guide)).toEqual(['', '├─ ', '│  ├─ ', '│  └─ ', '└─ '])
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('ab', 4)).toBe('ab  ')
})

test('legend lists only the statuses in use, in lifecycle order', async () => {
  const l = legend([
    I('A-1', 'completed', null),
    I('A-2', 'started', 'A-1', 'In Review'),
    I('A-3', 'started', 'A-1'),
    I('A-4', 'duplicate', 'A-1'),
    I('A-5', 'unstarted', 'A-1'),
    I('A-6', 'triage', 'A-1'),
  ])
  expect(l.map(x => x.label)).toEqual(['triage', 'todo', 'in progress', 'in review', 'done', 'canceled'])
  expect(l[3]!.color).toBe('cyan')
})

test('rollup counts closed descendants; readyToClose finds open parents with all kids closed', async () => {
  expect(rollup(tree, 'A-1')).toEqual({ closed: 3, total: 4, started: 1 })
  expect(readyToClose(tree).map(i => i.id)).toEqual(['A-2'])
})

test('diff reports status changes only, credited', async () => {
  const next = tree.map(i => (i.id === 'A-2' ? { ...i, status: 'In Review' } : i)).concat(I('A-9', 'unstarted', 'A-1'))
  expect(diff(tree, next, 5, () => 'claude')).toEqual([{ id: 'A-2', title: 't A-2', from: 'started', to: 'In Review', at: 5, by: 'claude' }])
})

test('parseIssueRef takes ids and Linear URLs', async () => {
  expect(parseIssueRef('eng-1995')).toBe('ENG-1995')
  expect(parseIssueRef('https://linear.app/acme/issue/ENG-2002/some-title')).toBe('ENG-2002')
  expect(parseIssueRef('refresh')).toBe(undefined)
})

test('treeText marks focus and close candidates', async () => {
  const t = treeText(tree, 'A-1', { id: 'A-2', at: 0 }, 0, 0)
  expect(t).toContain('  - A-2 [started] t A-2 [2/2 closed] ← working on it')
  expect(t).toContain('parent still open: A-2')
})
