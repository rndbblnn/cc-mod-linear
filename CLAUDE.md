# linear-panel — notes for Claude

A Claude Code **mod** (hooks module). Load the `plugin-authoring` skill before changing it. Sibling of
`cc-mod-subagents-panel`; same conventions.

## Layout
- `hooks/model.ts` — pure: MCP result parsing, tree walk (`fetchTree`, injected `McpCall`), ordering,
  rollups, diffs, labels, the prompt section and the `tree` tool text. Unit-tested.
- `hooks/register.tsx` — `/linear` command, `tree` + `focus` tools, `prompt.compose` section, a
  `tool.call` watch on the Linear MCP's `save_issue`/`save_comment`, 1 s clock (poll + status line),
  `ui.render` Pane `linear`.
- `types/index.d.ts` — `$.state` contract. Change a value's fields → bump its `shape` tag.

## Gotchas
- The validator requires every function that takes `$` to be declared at module top level (not a
  closure inside `register`). Options live in the module-level `cfg`, set as `register` runs.
- Linear is reached with `$.mcp.call(server, tool, args)` — the engine's own MCP connection; the
  results are a JSON text block (`parseResult`).
- The prompt section must stay stable while the root is (no statuses in it): it sits in the system
  prompt and any change invalidates the conversation's prompt cache.
- A `prompt.compose` test input needs `promptModel` and friends; `clock.every` must be mocked.
- A `Button`'s children may only be strings and `Text`, so a tree row is one line of padded text
  (`fit`), not a flex row. Build JSX lists as a `RenderChildren[]` outside the JSX: a `.map` nested in
  JSX children can blow up tsc's inference.
- `tsc -p .` can run out of memory when the engine regenerates `.claude-plugin/types/claude-code-mcp`
  for many connected MCP servers. Type-check against `claude-code` + `claude-code-tools` only.
- In auto mode the panel's own `$.mcp.call`s (from `/linear` and the timer) get no classifier verdict;
  the person must allow the Linear read tools in `permissions.allow`.

## Check
`claude plugin validate . && claude plugin test .` (12 tests).
