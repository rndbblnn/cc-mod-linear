import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'linear-panel',
  component: 'Pane',
  requestId: 'linear',
  surface: 'terminal',
  props: { title: 'Linear', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const ok = (v: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(v) }], isError: false } })

test('/linear <id> tracks the tree; the panel moves a status through Linear', async ($, on) => {
  const writes: Record<string, unknown>[] = []
  on('command.register', () => ({ value: { command: 'linear' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__linear-panel__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'get_issue') return ok({ id: 'ENG-1', title: 'Parent', status: 'In Progress', statusType: 'started', team: 'ENG' })
    if (e.tool === 'list_issues')
      return ok({
        issues: e.args.parentId === 'ENG-1' ? [{ id: 'ENG-2', title: 'Child', status: 'Todo', statusType: 'unstarted', parentId: 'ENG-1', team: 'ENG' }] : [],
        hasNextPage: false,
      })
    if (e.tool === 'list_issue_statuses')
      return ok([
        { id: 's-todo', name: 'Todo', type: 'unstarted' },
        { id: 's-prog', name: 'In Progress', type: 'started' },
        { id: 's-done', name: 'Done', type: 'completed' },
      ])
    writes.push({ tool: e.tool, ...e.args })
    return ok({ id: 'ENG-2' })
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const res = await $.command.run({ command: 'linear', args: 'ENG-1' } as never)
  expect((res as { text: string }).text).toBe('Tracking ENG-1: 2 issues.')

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /0\/1 closed/ })).toBeTruthy()
  await ui.press({ key: 'row-ENG-2' })
  await ui.press({ key: 'status' })
  await ui.press({ key: 'st-s-prog' })
  expect(writes).toEqual([{ tool: 'save_issue', id: 'ENG-2', state: 's-prog' }])
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /Todo → / })).toBeTruthy()
  await ui.unmount()
})

test('the tree tool answers with the hierarchy, and the prompt names the root', async ($, on) => {
  on('command.register', () => ({ value: { command: 'linear' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__linear-panel__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', (_, e) =>
    e.tool === 'get_issue'
      ? ok({ id: 'ENG-1', title: 'Parent', status: 'Todo', statusType: 'unstarted' })
      : e.tool === 'list_issues'
        ? ok({ issues: [], hasNextPage: false })
        : ok([]),
  )
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'linear', args: 'ENG-1' } as never)
  const r = await $.tool.call({ tool: 'mcp__linear-panel__tree' } as never)
  expect(JSON.stringify(r)).toContain('- ENG-1 [Todo] Parent')
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  const mine = composed.sections.find(s => s.id === 'linear-panel:tracked')
  expect(mine?.text).toContain('ENG-1 "Parent"')
})
