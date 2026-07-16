# Web guide (planted fixture for RED-15 doc binding)

Guides render from markdown at build time. <!-- @spec DOCS-001 -->

The legacy nightly re-render pipeline is still described below for operators
of the old fleet. <!-- @spec DOCS-002 -->

The mystery export knob is documented here but its requirement never
existed. <!-- @spec DOCS-999 -->

The sidebar export lists every published guide exactly once.
<!-- @spec DOCS-004 -->

See DOCS-003 for the streaming re-render contract.

Tracked in JIRA-123, which is an issue-tracker ref, not a requirement.

Tag your code like this (a prose example that must NOT bind):

```ts
export function renderGuides() {} // @spec EXAMPLE-001
```
