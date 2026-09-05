# Detail pane comparison mocks

This is a fixed-data comparison mock for reviewing Layer 2 Output 2: a clearer
detail-pane handoff surface for Agent Workbench.

- **A — current structure with small organization:** retains the current
  Always/Resume/tab approach and only clarifies headings, grouping, whitespace,
  short action-result text, and the unselected-project message.
- **B — State / Context / Actions:** separates live repository state, explicitly
  saved work context, and actions while stating each action's read/write scope.
- **C — action-centred:** keeps direct access to every action but groups the
  view around checking state, preparing context, saving, and copying a handoff.

The current production UI, backend, API, runtime data, tests, and documentation
are intentionally unchanged. This mock has no backend imports or API calls and
is not production code. No option is selected: after visual review, the user may
adopt one option, combine ideas, retain the current UI, or discard all three.
