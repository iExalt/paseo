# Agent messages in collapsed chat

Scope: the requested chat fix; medium autonomy. The user authorized implementation
with keep-me-in-the-loop and an isolated worktree on 2026-11-06.

## Outcome and gates

One increment shares the stream presentation boundary:

- [x] Agree grouping and CLI normalization with the persistent reviewer.
- [x] Implement sent/received counts, same-turn grouping, and CLI send cards.
- [x] Verify parser, projection, turn boundaries, translations, and typecheck.
- [x] Close production browser verification and reviewer acceptance.
- [x] Ready for publication; required checks and merge are tracked by the enclosing PR.

All received delivery types group and count in collapsed views, including agent
completion, error, permission, and closure notifications. Expanding retains each
event's label and body. Full view retains its existing attributed message disclosure
and lifecycle event presentation. Canonical turn IDs and legacy trigger boundaries
continue to separate turns.

Literal standalone Paseo CLI sends use the existing message presentation catalog.
Ambiguous shell commands keep their shell presentation. Send details retain the
prompt or prompt-file reference, target, original command, and result. No release,
application installation, or daemon update is included.

## Evidence and limits

Base: `930b4de8038dc37715d1d6a998e205f158100455`, with only the task diff applied.
Checks ran in an isolated dev-station checkout with the same source and lockfile;
external dependency resolutions were unchanged by workspace version metadata.

- Repository-wide typecheck and changed-file lint passed, with no lint warnings or errors.
- Final focused unit checks passed: 5 files, 106 tests, 16.46 seconds. They cover all
  five delivery types, display changes, turn boundaries, parser fallbacks, and the
  platform export scan.
- The full app unit run passed 6,834 tests and hit one 5-second timeout in the
  unchanged platform export scan (251.64 seconds total). That scan passed in the
  final focused run in 2.68 seconds; its timeout was not changed.
- Real production components were exercised with synthetic data on desktop,
  tablet, and phone. Main-agent screenshot inspection confirmed mixed summaries
  and readable sent-message details. Full-mode disclosure verification passed.
  Screenshots are retained locally under `design/dogfood/2026-11-07-agent-messages`.
  Physical Android/iOS application builds were not run.

Review ledger (material / total): initial 1/1; parser repair 0/0; changed-base
integration 0/0; locale/format integration 0/0; parser extraction/Korean labels
0/0; all-delivery integration 0/0, accepted with final browser evidence. The material
finding was conservative shell tokenization; independent probes and regression
cases cover its repairs.

Original estimate: 25–45 minutes and one review round. Verification setup required
moving from slow local cold installs to the existing dev station. Publication and required checks are tracked by the enclosing PR.
