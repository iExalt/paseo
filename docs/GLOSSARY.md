# Fork glossary

Terms for modules the fork owns. Product and domain terms (project, workspace,
host, agent session and the rest) live in the upstream
[glossary](upstream/glossary.md), which stays authoritative for those and is
not edited here. Add a term when its module lands, in the same change.

## CI and release

**Routine lane**:
One parallel job of fork Routine CI (`quality`, `workspaces`, `app-1..2`,
`server-1..3`, `integration`). Every planned step declares its lane group when
it is created; the group's shard count and single prerequisite live in one
table, `laneGroups` in `.github/scripts/ci-routine.mjs`.
_Avoid_: shard (one numbered member of a sharded lane group), job
