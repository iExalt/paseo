# Mobile terminal plan

On the user's Android phone with Samsung Keyboard, Paseo's terminal often
prints one key twice, and typing feels slow. This plan fixes input first and
then removes latency where measurements show it, before the move to acyclic.

## Known facts

### The acyclic app spike (2026-10-17)

The record is in the private acyclic planning repository. The spike was a web
PWA, not Paseo's native app. It compared xterm.js 6 and ghostty-web on the same
shell, with an optional local-echo overlay.

- Both terminals were judged "glitchy and below usable" on the phone.
  ghostty-web came out slightly ahead, and with xterm.js keys sometimes
  registered more than once.
- Plain words and spaces arrived correctly. The adb check found the
  duplicates came from backspacing into a word already sent, then typing:
  Gboard reopened that word in the terminal's hidden text field and the
  page sent the edited word again. The
  candidate fixes were to clear the field after each commit, turn off
  suggestions, or add a line-edit box.
- The phone never connected directly. Every session went through a Tailscale
  DERP relay at 326 to 695 ms round trip, which dominated send-to-paint. The
  2 to 10 s waits while a command ran were the shell not echoing, not the
  transport.
- Local echo made no noticeable difference with Gboard, because Gboard draws
  the word being composed itself.

### Paseo's Android terminal is a different stack

Android does not run xterm.js. `terminal-emulator.native.tsx` mounts the
native grid. It parses output with `@xterm/headless` in JS
(`headless-terminal-output-drain.ts`) and renders React Native rows
(`terminal-grid-view.native.tsx`). Input comes from a hidden 1×1 `TextInput`
(`terminal-input.native.tsx`) that sends data from both `onKeyPress` and
`onChangeText`. A `previousText` model is meant to remove the duplicates, but
it assumes the key event arrives first.

### Cause of the double keys (confirmed in source and a unit probe)

React Native's Android keypress emulation
(`ReactEditTextInputConnectionWrapper.kt`) delivers the text change _before_
the key in two cases:

- for `setComposingText`, in every case;
- for `commitText`, inside an IME batch edit, because the key is held until
  `endBatchEdit`.

Fabric keeps the dispatch order (`EventQueue.cpp`). Backspace arrives key
first through `deleteSurroundingText`, a `sendKeyEvent` DEL and
`commitText("")`, but change first when `setComposingText` shrinks a word
being composed. Inside a batch edit the wrapper keeps only the last key
(`dispatchKeyEventOrEnqueue`), so keys can also be lost.

When the change arrives first, the input state behaves like this, measured on
the wire at `b0fc858a9`:

| Events                                                | Sent                           |
| ----------------------------------------------------- | ------------------------------ |
| key then change, `l` `s` (today's tests)              | `ls`                           |
| change then key, `l` `s` space `-`                    | `lls -`                        |
| change then key, `l` `s`, then Backspace twice        | `lls`: both Backspaces dropped |
| composed `git`, then `commitText("git ")` with no key | `ggit`: space dropped          |
| one merged change `ab`, then keys `a` `b`             | `abab`                         |

The first character is sent twice. That latches `replacementDesynced`, and
from then on Backspace and change-only edits are dropped until Enter, a
newline in the text, or a `reset()` on focus, blur or show-keyboard. A
reopened word, as in the spike, also latches the desync rather than being
resent: printable keys still flow but Backspace stops working.

### Latency suspects (from source; not yet measured)

The server pipeline, its invariants and the existing benchmarks are in
[terminal-performance.md](upstream/terminal-performance.md). Those benchmarks
cover the daemon and the browser, not the native grid or a phone network.

| Stage                                                                                                                                                     | Where                                                                                   | Expectation                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Network path: direct, Tailscale direct, DERP, or Paseo's Cloudflare relay                                                                                 | `packages/relay`                                                                        | Likely dominant; the spike saw 326 to 695 ms over DERP |
| Server output coalescing                                                                                                                                  | `terminal-output-coalescer.ts:19`, applied in the worker and per stream                 | At most about 10 ms; leave alone without data          |
| Snapshot fallback on relay sockets: no buffered amount, so a full snapshot every 256 KB. Deliberate, so a slow relay client can't fall unboundedly behind | `terminal-session-controller.ts:962-978`, `terminal-restore.ts:10`                      | Heavy TUI output only, not echo                        |
| E2EE in JS on Hermes (tweetnacl, noble chacha20poly1305)                                                                                                  | `relay/src/crypto.ts`, `relay/src/noise/cipher-state.ts`                                | Unknown; measure                                       |
| Client parse, then rAF paint, then React reconcile                                                                                                        | `headless-terminal-output-drain.ts`, `terminal-emulator-native-grid.native.tsx:355-377` | One or two frames plus reconcile                       |
| Input send                                                                                                                                                | `client/src/daemon-client.ts`                                                           | Not batched; negligible                                |

## Increments

Each increment is reviewed before the next one that depends on it. P1 and P2
are independent once P0 lands.

### P0. Instrument and reproduce on the phone

- A dev-only input trace. For each event, log time, `key` or `change`, the
  payload, `previousText`, the desync flag and the bytes sent. Also record
  the IME and the input type with `adb shell dumpsys input_method`.
- A latency trace keyed by a sequence id. Record the keystroke send, server
  receive, PTY output emit, client frame receive, parse done and paint commit.
  Compare client-side times only with client-side times, and server-side times
  only with server-side times.
- Record the connection path the phone actually uses. For Tailscale, check
  `tailscale ping` and `tailscale status`; otherwise note the Paseo relay.

Two devices share the work:

- The virtual Android tablet (Cuttlefish in the k0s dev pod; see
  `/home/dev/cuttlefish/HARNESS.md` there) runs the AOSP keyboard and a real
  virtio hardware keyboard. Use it for the ordering bug under the AOSP
  keyboard, hardware-key paths and every P1 check. Run
  `settings put secure show_ime_with_hard_keyboard 1` in the guest so the
  soft keyboard shows. It has no network, so its latency means nothing.
- The user's phone runs Samsung Keyboard, not Gboard. It is needed for that
  keyboard's ordering, for real network latency and for the final sign-off.

On either device, type by tapping the keyboard's keys with
`adb shell input tap`, as the spike did.
`adb shell input text` injects key events that bypass Gboard's
`InputConnection`, which is the path with the bug. The existing agent-device
scenario (`packages/app/e2e/mobile/agent-device/native-terminal-basic.android.ad`)
probably types the same way, which would explain why it passes today;
the P0 trace confirms it. Record the keyboard and its version.

Acceptance:

- The device script types `ls -la`, two Backspaces and Enter, then the
  spike's case: `hello world`, Backspace into `world`, `ld`, Enter. It
  compares each shell line, and it fails before P1 lands (base:
  `origin/dev` at `c9820c294` or later). The trace shows
  whether the keyboard delivers change before key, and whether it wraps
  Backspace in a batch edit.
- If the phone's keyboard does not show change-first order, re-scope P1
  before writing any code.
- A per-stage latency table, p50 and p90 over 30 or more echoed keystrokes,
  on the phone's usual network with the path recorded.

#### P0a result: virtual tablet, AOSP keyboard (2026-10-25, accepted)

The trace (`EXPO_PUBLIC_PASEO_TERMINAL_INPUT_TRACE`, see
[development.md](upstream/development.md)) ran in an APK built from dev
`7e2fee497` plus the trace at `002fab680` (sha256 `69d45330…`). Base failures
were also reproduced on the tablet's untraced dev `9b38c3f65` APK. The field's input type was `0x2a0001`: text,
multi-line and `NO_SUGGESTIONS`. Bytes were read back with a raw-mode byte
logger, not a shell line.

- Every letter arrives as a text change 16 to 21 ms before its key. Enter
  arrives change first too. Backspace arrives key first, 0.5 ms before its
  change. That doesn't show whether LatinIME batches Backspace, because
  `deleteSurroundingText` sends its key at once either way.
- Base fails both cases. Typing `hello world`, three Backspaces and `ld`
  sent `hhello world`, no `\x7f`, then `lld`. Each time the model realigns,
  the next letter is sent twice.
- Results vary between runs because the field clear after Enter
  (`replaceText("")`) may not land; in one run it never landed for the rest
  of the session. The field then keeps a leading
  `\n`, every later change takes the newline branch and is ignored, and only
  keys are sent. That accidental key-only mode typed the second line
  correctly. Why the clear fails is unknown; a stale native `eventCount` is
  the first suspect.
- Echo over `adb reverse` took 56 ms p50 and 66 ms p90 from send to paint,
  over 21 keystrokes. Parsing one character took 10.6 ms at p50, which looks
  like the headless `write` callback's scheduling rather than parse work.
  Paint waits one frame (18 ms). The emulated CPU and the lack of a network
  make these numbers unrepresentative of a phone.

#### P0b result: the user's phone and the tablet (2026-10-25, accepted)

The phone runs Samsung Keyboard 5.9.30.97; Gboard is not installed. The trace
APK (Paseo Debug, `74351fa0c`, sha256 `9e7fb177…`) added each field clear's
reason and whether the next change still held the cleared text. The analyzer
treats a key-first Enter's own newline change as part of that Enter.

| Wire order              | Samsung (phone)          | LatinIME (tablet)                     |
| ----------------------- | ------------------------ | ------------------------------------- |
| Printable               | change first, 0.5 ms p50 | change first, 18 ms                   |
| Backspace               | change first, 0.5 ms     | key first, 0.2 ms                     |
| Enter                   | key first, then `…\n`    | change first, key 0.3 to 4.6 ms later |
| Clears after Enter      | 3 of 3 landed            | 2 of 2 (P0a: some failed)             |
| Clears on show-keyboard | 10 of 10 landed          | 10 of 10 landed                       |

- Base fails on Samsung as on the tablet. The first letter after every clear
  is sent twice (`hhello`, `aabcd`, and the `d` typed after reopening the
  keyboard). Backspace sends nothing, and the next letter then sends two stale
  characters: `hello world`, three Backspaces and `ld` gave
  `hhello worldolld`.
- No clear other than after Enter failed on either keyboard. The app's
  hide-keyboard button doesn't blur the input, so blur was always followed by
  a show-keyboard clear before typing. P1 therefore keeps the stuck-clear
  rule for Enter only (option A below).
- Latency on the phone, 106 keystrokes over a direct Tailscale path with a
  235 ms `tailscale ping`:

  | Stage          | p50 ms | p90 ms |
  | -------------- | ------ | ------ |
  | send → recv    | 328    | 342    |
  | recv → parsed  | 11     | 20     |
  | parsed → paint | 23     | 34     |
  | send → paint   | 367    | 385    |

  The network dominates. About 90 ms of send → recv is not the round trip
  and is unexplained; the app's endpoint (direct or relay) was not recorded.
  `recv → parsed` is about 11 ms on both devices, which suggests a timer
  floor rather than parse work. Paint takes about three 120 Hz frames.

- Gboard is unverified. Its order is unknown, so P1's device gates are
  Samsung Keyboard on the phone and LatinIME on the tablet.

### P1. One source of truth for typed text (agree the design first)

- On Android, printable text comes only from the text diff, and printable
  keypresses are ignored. Keypress is used for Enter, arrows and control keys.
- The diff owns every deletion while the field has text. Three one-shot flags
  pair a Backspace key with its diff, whichever arrives first:
  - A pure suffix deletion (the new text is a prefix of the old) sends one
    `\x7f` per removed code point. If `keyAwaitingShrink` is set, clear it.
    Otherwise set `shrinkAwaitingKey`.
  - A change to empty text with `keyAwaitingShrink` set follows the suffix
    rule. Without it, the change sends nothing and records
    `emptiedAwaitingKey` = the number of removed code points.
  - A Backspace key on a field with text sets `keyAwaitingShrink` and sends
    nothing. On an empty field, it does one of three things. If
    `emptiedAwaitingKey` is above 0, it sends that many `\x7f` (a composing
    word or a batched select-all deleted at once). If `shrinkAwaitingKey` is
    set, it clears it and sends nothing. Otherwise it sends one `\x7f`.
  - Every hardware terminal key calls a hook such as
    `inputState.noteHardwareClear()` before it is forwarded. The hook sets
    `previousText` to empty and clears all three flags, but leaves
    `replacementDesynced` alone. Android's hardware keyboard module
    (`PaseoHardwareKeyboardModule.kt`, #206) clears the field after a key it
    captures, and the terminal already has that text, so the clear must send
    nothing in either event order.
  - Any other key or change clears all three flags. Each flag also expires
    about 100 ms after it is set. Both halves of a real pair come from one
    native call or IME batch, so a stale flag, such as a Backspace that
    deleted nothing, can't pair with a later hardware clear.
- This is the candidate design. The case table under Acceptance is the
  contract. If the P0 trace shows that the rule needs more timing heuristics
  than the expiry, switch to the native `InputConnection` below instead of
  adding them.
- A field can keep its text across Enter when the clear after Enter doesn't
  land (P0a). A change whose appended text contains `\n` or `\r` sends
  nothing; Enter comes from its key, and the multi-line paste guard stays.
  Set `previousText` to the change's full text, newline included, then
  record `pendingClearFrom = previousText` and set `previousText` to empty.
  Only these clears record it, so the marker always contains `\n` or `\r`
  and a single-line paste can never match it. A clear request whose text has no
  newline, such as the Enter key's own clear or a later show-keyboard reset,
  keeps an existing marker. On the next change, diff against
  `pendingClearFrom` if the text starts with it (the clear didn't land), and
  otherwise against `previousText`. Then forget `pendingClearFrom`.
- A Backspace key on an empty field, followed within the pairing window by
  a change that shrinks the stuck line (a proper prefix of the marker),
  realigns silently, so the old line is not typed again. Without the key
  first, such a change is the first letter of a new line that starts the
  same way (`ls` twice) and is sent.
- Known gap: with change-first Backspace (Samsung), a Backspace into a line
  whose clear never landed resends that line. Telling it apart from new
  typing would mean holding the change until its key, the timing reconciler
  this plan rejects; the native `InputConnection` fallback would close it.
  No Samsung clear has failed in any run.
- Known gap: an Enter that arrives only as text, with no Enter key, sends
  nothing. A batch that drops the key or voice typing could do that; no
  device run has shown it, and the code before P1 behaved the same.
- Resets on focus, blur and show-keyboard record no marker (option A). P0b
  saw every one of them land on both keyboards. Marking them too (option B)
  would misread a second paste that extends the first, such as `git status`
  then `git status --short`, as a failed clear and drop its prefix.
- A non-append replacement that isn't CJK, such as autocorrect or a reopened
  word, is still not sent. It no longer disables Backspace: only the CJK
  rubout stays off until the next reset. A change to empty text does not
  reset it.
- The rule is a policy of the input state,
  `createTerminalTextInputState({ printableSource: "diff" | "keyThenDiff" })`.
  The component picks `"diff"` on Android with `Platform.OS`; every other
  platform keeps today's `"keyThenDiff"`, so iOS is untouched. Both policies
  run in vitest.
- The keypress-only test ("does not report text changes", from `04fe30a3e`)
  stays in the `"keyThenDiff"` table until an iOS run shows whether iOS
  needs it. Whether the Backspace decoupling below should also apply to iOS
  is a follow-up, not part of P1.
- Don't build a pending-key reconciler in JS. A merged change event (`ab`
  followed by the keys `a` and `b`) defeats it.
- Clear the field after each commit only if the P0 trace shows it is needed.
  The stale-suggestion test guards against clearing in the middle of a
  composition.
- Fallback if this approach fails on the device: a custom native
  `InputConnection`, as Termux does. It sees every IME call directly, but
  needs native code.

Acceptance:

- The existing `terminal-input.native.test.ts` becomes the `"keyThenDiff"`
  table and keeps its assertions. A new `"diff"` table holds the
  change-driven versions of the rows at L50, L61, L98, L112, L323 and L332
  (L112 replaces `submittedText` with the marker), and the Backspace flips of
  L355 and L364. The rows at L20, L32, L73, L82, L91, L136, L215, L236 to
  L296, L298, L309, L316, L345 and L381 run in both tables.
- The `"diff"` table covers both wire orders P0b recorded: Samsung's (all
  change first, Enter key first) and LatinIME's (Backspace key first).
- Each row of the unit tables asserts the bytes sent. It then asserts that a
  following Backspace, given as the key and its shrinking text change, sends
  one `\x7f`, or, if the field is empty, that the key alone sends one. The rows cover:
  - key first and change first;
  - a merged change;
  - `commitText` with no key, where the space is kept;
  - a composing shrink, change then key, which sends one `\x7f`;
  - two `deleteSurroundingText` deletes, the second on an empty field (key,
    change, key), which send two `\x7f`;
  - a `sendKeyEvent` DEL on an empty field, which sends one `\x7f`;
  - `commitText("")`, key then change, which sends one `\x7f`;
  - an autocorrect replacement followed by Backspace;
  - a composing shrink from `hel` to empty, change then key, which sends three
    `\x7f`;
  - a batched select-all, empty change then key, which sends N `\x7f`;
  - a hardware clear, with the hook first and with the change first, which
    sends nothing; a later soft Backspace sends one;
  - a stale `keyAwaitingShrink` followed, after the expiry, by a hardware
    clear, which sends nothing.
  - two lines where the clear after Enter lands, and two lines where it
    doesn't (a stuck `\n` prefix): each letter is sent once and a following
    Backspace sends one `\x7f`.
- The unit tests inject a clock for the flag expiry instead of waiting.
- Existing CJK composition tests and #206's hardware-key tests still pass.
- The reviewer's row list (groups A to F: printable text, Backspace,
  replacements, Enter and clears, hardware clears, shared rows) is the
  contract for the `"diff"` table. It includes option A's accepted cost: a
  show-keyboard clear that fails resends the stale text.
- On a device, type `ab`, press Home, return to the app and type `c`. Only
  `c` is sent. This checks that a return without a show-keyboard reset still
  clears through blur.
- The P0 device script, which failed on the same base, now passes,
  including the second line after Enter, on Samsung Keyboard (the user's
  phone) and LatinIME (the tablet). Include a composing check on Samsung:
  its 0.5 ms change-first gap may be `setComposingText` despite
  `NO_SUGGESTIONS`.
- On the virtual tablet, hardware Backspace and Enter still work after
  typed text. Drive the virtio keyboard from the host side. `adb shell input
  keyevent` uses the virtual keyboard device, which #206's capture rejects,
  so that check would pass without testing anything. If the AOSP keyboard
  composes with the hardware keyboard attached, add a hardware Backspace on
  a one-character composing word.

### P2. Remove measured latency

The P0 numbers decide what to work on. The candidates set out in advance are:

- Get a direct path. Prefer a direct Tailscale connection over DERP or the
  Cloudflare relay, and show the connection path in the app so a relayed
  session is visible.
- Make the relay socket report its buffered amount, so that heavy output
  streams instead of forcing a snapshot every 256 KB. Keep the bound on how
  far a slow relay client can fall behind.
- Cut crypto or parse cost, if the trace shows either is material. First
  time `terminal.write` for one character in isolation, since P0a and P0b
  both measured about 11 ms from receive to parsed.
- Find the roughly 90 ms of send → recv on the phone that is not the
  Tailscale round trip. Record the app's endpoint first, then add the
  deferred server-side stamps.
- Find why paint takes about three frames after parsing on the phone.

Acceptance:

- The target stage's p50 and p90 over 30 or more keystrokes drop in a
  before/after phone trace on the same recorded path.
- `scripts/benchmark-terminal-latency.ts` shows no server regression.
- If a direct path is reached, echo stays within two frames of its round
  trip.
- A relay change adds a session-controller unit test covering two cases. A
  client reporting more than `MAX_CLIENT_BUFFERED_BYTES` still gets the
  snapshot fallback. A draining client streams.

### P3. Optional typing aids

The spike found neither aid essential, so both are opt-in.

- A line-edit box that sends whole lines. Gboard can then edit and autocorrect
  freely, and nothing the shell already has is touched.
- Local echo, using the spike's clean-room overlay design, for high-RTT
  sessions and for shells that echo slowly while a command runs.
- `keyboardType="visible-password"` as a setting. Termux uses it to stop
  Gboard composing. It probably breaks CJK, glide and voice input; check
  that on the phone before offering it, and don't make it the default.

### P4. Regression coverage

- Keep the P1 unit tables. They are the cheapest layer and cover every event
  order.
- Keep one adb typing check on the phone (Samsung Keyboard) and one on the
  tablet (LatinIME) as the P1 acceptance gate. They stay manual and are not
  in CI.
- Do not add end-to-end latency tests to CI. Keep the P0 trace as a dev tool
  instead.

## Out of scope

- Replacing the native grid with xterm.js or ghostty-web in a WebView. The
  spike found no input advantage, since both had the same Gboard problem.
  acyclic makes that choice for itself.
- mosh-style UDP transport. It is GPL-3.0, needs a native UDP module in the
  app and `mosh-server` on every host.
