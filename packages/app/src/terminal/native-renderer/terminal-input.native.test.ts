import { describe, expect, it } from "vitest";

import {
  createTerminalTextInputState,
  resolveTerminalInputFocusRequest,
  TERMINAL_INPUT_CONTEXT_MENU_HIDDEN,
  TERMINAL_INPUT_HITBOX_SIZE,
} from "./terminal-input.native";
import {
  createNativeTerminalKeyEvent,
  forwardNativeTerminalKey,
  type NativeTerminalKeyEvent,
} from "./terminal-key-events";

function inputData(change: { data: string; shouldClear: boolean }): string {
  return change.data;
}

describe.each(["keyThenDiff", "diff"] as const)(
  "native terminal typed input (%s)",
  (printableSource) => {
    it("dispatches appended text once and ignores reset clears", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(inputData(input.receiveTextChange("h"))).toEqual("h");
      expect(inputData(input.receiveTextChange("hi"))).toEqual("i");

      input.reset();

      expect(input.receiveTextChange("")).toEqual({ data: "", shouldClear: false });
      expect(inputData(input.receiveTextChange(" there"))).toEqual(" there");
    });

    it("dispatches single-line multi-character inserts as one text payload", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("npm run typecheck")).toEqual({
        data: "npm run typecheck",
        shouldClear: false,
      });
    });

    it("does not dispatch raw multiline hidden-input paste", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("printf one\nprintf two")).toEqual({
        data: "",
        shouldClear: true,
      });
    });

    it("does not dispatch raw carriage-return hidden-input paste", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("printf one\rprintf two")).toEqual({
        data: "",
        shouldClear: true,
      });
    });

    it("does not translate replacement edits into terminal text", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(inputData(input.receiveTextChange("abc"))).toEqual("abc");
      expect(input.receiveTextChange("aXc")).toEqual({ data: "", shouldClear: false });
    });

    it("accepts the same long keyboard clipboard item twice", () => {
      const input = createTerminalTextInputState({ printableSource });
      const longText = "x".repeat(512);

      expect(input.receiveTextChange(longText)).toEqual({ data: longText, shouldClear: false });

      input.reset();

      expect(input.receiveTextChange(longText)).toEqual({ data: longText, shouldClear: false });
    });

    it("translates software keyboard terminal control keys", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveKeyPress("Backspace")).toEqual({ data: "\x7f", shouldClear: false });
      expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });
      expect(input.receiveKeyPress("Return")).toEqual({ data: "\r", shouldClear: true });
      expect(input.receiveKeyPress("return")).toEqual({ data: "\r", shouldClear: true });
      expect(input.receiveTextChange("hello\n")).toEqual({ data: "", shouldClear: true });
    });

    it("accepts the same keyboard clipboard item after terminal focus synchronization", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("echo clipboard item")).toEqual({
        data: "echo clipboard item",
        shouldClear: false,
      });

      input.reset();

      expect(input.receiveTextChange("echo clipboard item")).toEqual({
        data: "echo clipboard item",
        shouldClear: false,
      });
    });

    it("does not replay a stale IME suggestion when the native clear leaves composing text behind", () => {
      const input = createTerminalTextInputState({ printableSource });
      let typed = "";

      for (const key of "resta") {
        typed += key;
        input.receiveKeyPress(key);
        input.receiveTextChange(typed);
      }

      expect(input.receiveTextChange("restaurant ")).toEqual({
        data: "urant ",
        shouldClear: false,
      });

      expect(input.receiveTextChange("restaurant x")).toEqual({
        data: "x",
        shouldClear: false,
      });
    });

    it("types Hangul by rubbing out the syllable the IME rewrites in place", () => {
      const input = createTerminalTextInputState({ printableSource });

      // 한글: the composing syllable is rewritten on every jamo, never appended.
      expect(input.receiveTextChange("ㅎ")).toEqual({ data: "ㅎ", shouldClear: false });
      expect(input.receiveTextChange("하")).toEqual({ data: "\x7f하", shouldClear: false });
      expect(input.receiveTextChange("한")).toEqual({ data: "\x7f한", shouldClear: false });
      expect(input.receiveTextChange("한ㄱ")).toEqual({ data: "ㄱ", shouldClear: false });
      expect(input.receiveTextChange("한그")).toEqual({ data: "\x7f그", shouldClear: false });
      expect(input.receiveTextChange("한글")).toEqual({ data: "\x7f글", shouldClear: false });
    });

    it("types Hangul when a final consonant migrates into the next syllable", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("안")).toEqual({ data: "안", shouldClear: false });
      // Typing ㅣ moves ㄴ off 안 and onto the new syllable: 안 → 아니.
      expect(input.receiveTextChange("아니")).toEqual({ data: "\x7f아니", shouldClear: false });
    });

    it("commits a Chinese pinyin reading as Han characters", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("n")).toEqual({ data: "n", shouldClear: false });
      expect(input.receiveTextChange("ni")).toEqual({ data: "i", shouldClear: false });
      expect(input.receiveTextChange("nih")).toEqual({ data: "h", shouldClear: false });
      expect(input.receiveTextChange("niha")).toEqual({ data: "a", shouldClear: false });
      expect(input.receiveTextChange("nihao")).toEqual({ data: "o", shouldClear: false });
      expect(input.receiveTextChange("你好")).toEqual({
        data: "\x7f\x7f\x7f\x7f\x7f你好",
        shouldClear: false,
      });
    });

    it("updates a multi-character Chinese candidate", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("nihao")).toEqual({ data: "nihao", shouldClear: false });
      expect(input.receiveTextChange("你好")).toEqual({
        data: "\x7f\x7f\x7f\x7f\x7f你好",
        shouldClear: false,
      });
      expect(input.receiveTextChange("拟好")).toEqual({
        data: "\x7f\x7f拟好",
        shouldClear: false,
      });
    });

    it("commits and converts a Japanese reading", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("nihongo")).toEqual({ data: "nihongo", shouldClear: false });
      expect(input.receiveTextChange("にほんご")).toEqual({
        data: "\x7f\x7f\x7f\x7f\x7f\x7f\x7fにほんご",
        shouldClear: false,
      });
      expect(input.receiveTextChange("日本語")).toEqual({
        data: "\x7f\x7f\x7f\x7f日本語",
        shouldClear: false,
      });
    });

    it("does not dispatch Hangul through the keypress path", () => {
      const input = createTerminalTextInputState({ printableSource });

      // The IME reports the jamo it is composing; the text change reports the
      // syllable. Dispatching both would put two conflicting characters on the wire.
      expect(input.receiveKeyPress("ㅎ")).toEqual({ data: "", shouldClear: false });
      expect(input.receiveTextChange("ㅎ")).toEqual({ data: "ㅎ", shouldClear: false });
      expect(input.receiveKeyPress("ㅏ")).toEqual({ data: "", shouldClear: false });
      expect(input.receiveTextChange("하")).toEqual({ data: "\x7f하", shouldClear: false });
    });

    it("still swallows non-CJK replacement edits", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("teh")).toEqual({ data: "teh", shouldClear: false });
      expect(input.receiveTextChange("the")).toEqual({ data: "", shouldClear: false });
    });

    it("does not treat a non-Hangul trailing edit as composition", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("ls -a")).toEqual({ data: "ls -a", shouldClear: false });
      expect(input.receiveTextChange("ls -l")).toEqual({ data: "", shouldClear: false });
    });

    it("stops rubbing out once a swallowed replacement leaves the terminal ahead", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("teh")).toEqual({ data: "teh", shouldClear: false });
      // Swallowed: the terminal still holds teh while the buffer moved to the.
      expect(input.receiveTextChange("the")).toEqual({ data: "", shouldClear: false });
      // A composition rewrite here would delete text from an already-desynced terminal.
      expect(input.receiveTextChange("他们")).toEqual({ data: "", shouldClear: false });
    });

    it("resumes composition once the line is cleared", () => {
      const input = createTerminalTextInputState({ printableSource });

      expect(input.receiveTextChange("teh")).toEqual({ data: "teh", shouldClear: false });
      expect(input.receiveTextChange("the")).toEqual({ data: "", shouldClear: false });

      input.reset();

      expect(input.receiveTextChange("nihao")).toEqual({ data: "nihao", shouldClear: false });
      expect(input.receiveTextChange("你好")).toEqual({
        data: "\x7f\x7f\x7f\x7f\x7f你好",
        shouldClear: false,
      });
    });
  },
);

describe("native terminal typed input, key then diff (iOS)", () => {
  it("dispatches printable keypresses when focused input does not report text changes", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    expect(input.receiveKeyPress("p")).toEqual({ data: "p", shouldClear: false });
    expect(input.receiveKeyPress("w")).toEqual({ data: "w", shouldClear: false });
    expect(input.receiveKeyPress("d")).toEqual({ data: "d", shouldClear: false });
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });
  });

  it("does not duplicate printable keypresses when the native text change also arrives", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    expect(input.receiveKeyPress("p")).toEqual({ data: "p", shouldClear: false });
    expect(input.receiveTextChange("p")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveKeyPress("w")).toEqual({ data: "w", shouldClear: false });
    expect(input.receiveTextChange("pw")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveKeyPress("d")).toEqual({ data: "d", shouldClear: false });
    expect(input.receiveTextChange("pwd")).toEqual({ data: "", shouldClear: false });
  });

  it("keeps anticipated text aligned after software keyboard Backspace", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    expect(input.receiveKeyPress("a")).toEqual({ data: "a", shouldClear: false });
    expect(input.receiveKeyPress("b")).toEqual({ data: "b", shouldClear: false });
    expect(input.receiveKeyPress("c")).toEqual({ data: "c", shouldClear: false });
    expect(input.receiveKeyPress("Backspace")).toEqual({ data: "\x7f", shouldClear: false });
    expect(input.receiveTextChange("ab")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveKeyPress("X")).toEqual({ data: "X", shouldClear: false });
    expect(input.receiveTextChange("abX")).toEqual({ data: "", shouldClear: false });
  });

  it("clears accumulated hidden input text after terminal submit", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    for (const key of "echo hello") {
      input.receiveKeyPress(key);
    }
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });

    input.reset();

    expect(input.receiveTextChange("")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveTextChange("y")).toEqual({ data: "y", shouldClear: false });
  });

  it("ignores late newline text change after Return keypress submits", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    for (const key of "echo hello") {
      input.receiveKeyPress(key);
    }
    expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });

    input.reset();

    expect(input.receiveTextChange("echo hello\n")).toEqual({ data: "", shouldClear: false });
  });

  it("keeps anticipated text aligned when Backspace decomposes a syllable", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    expect(input.receiveTextChange("한")).toEqual({ data: "한", shouldClear: false });
    // The rubout already removed the whole syllable, so the redraw is a plain append.
    expect(input.receiveKeyPress("Backspace")).toEqual({ data: "\x7f", shouldClear: false });
    expect(input.receiveTextChange("하")).toEqual({ data: "하", shouldClear: false });
  });

  it("keeps CJK composition enabled after Backspace removes an emoji", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    expect(input.receiveTextChange("😀")).toEqual({ data: "😀", shouldClear: false });
    expect(input.receiveKeyPress("Backspace")).toEqual({ data: "\x7f", shouldClear: false });

    expect(input.receiveTextChange("nihao")).toEqual({ data: "nihao", shouldClear: false });
    expect(input.receiveTextChange("你好")).toEqual({
      data: "\x7f\x7f\x7f\x7f\x7f你好",
      shouldClear: false,
    });
  });

  it("does not backspace terminal content after a swallowed replacement", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    expect(input.receiveTextChange("teh")).toEqual({ data: "teh", shouldClear: false });
    expect(input.receiveTextChange("the")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveKeyPress("Backspace")).toEqual({ data: "", shouldClear: false });
    expect(input.receiveTextChange("th")).toEqual({ data: "", shouldClear: false });
  });

  it("keeps replacement desync protection after Backspace empties the hidden input", () => {
    const input = createTerminalTextInputState({ printableSource: "keyThenDiff" });

    expect(input.receiveTextChange("teh")).toEqual({ data: "teh", shouldClear: false });
    // Autocorrect changes the buffer but cannot rewrite the terminal.
    expect(input.receiveTextChange("the")).toEqual({ data: "", shouldClear: false });

    for (const text of ["th", "t", ""]) {
      expect(input.receiveKeyPress("Backspace")).toEqual({ data: "", shouldClear: false });
      expect(input.receiveTextChange(text)).toEqual({ data: "", shouldClear: false });
    }

    expect(input.receiveTextChange("nihao")).toEqual({ data: "nihao", shouldClear: false });
    // The terminal still contains `teh`, so this must not rub it out.
    expect(input.receiveTextChange("你好")).toEqual({ data: "", shouldClear: false });
  });
});

describe("native terminal input keys and focus", () => {
  it("emits semantic terminal key events for native arrow keypresses", () => {
    const input = createTerminalTextInputState();

    expect(input.receiveKeyPress("ArrowUp")).toEqual({
      data: "",
      key: "ArrowUp",
      shouldClear: false,
    });
  });

  it("forwards native arrow key events to the terminal key path", () => {
    const events: NativeTerminalKeyEvent[] = [];

    forwardNativeTerminalKey({
      event: createNativeTerminalKeyEvent("ArrowUp"),
      onTerminalKey: (event) => {
        events.push(event);
      },
    });

    expect(events).toEqual([
      {
        key: "ArrowUp",
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
      },
    ]);
  });

  it("keeps the hidden input from owning terminal long-press selection", () => {
    expect({
      contextMenuHidden: TERMINAL_INPUT_CONTEXT_MENU_HIDDEN,
      hitboxSize: TERMINAL_INPUT_HITBOX_SIZE,
    }).toEqual({
      contextMenuHidden: true,
      hitboxSize: 1,
    });
  });

  it("does not disturb an already-focused input while the keyboard is visible", () => {
    expect(
      resolveTerminalInputFocusRequest({ isInputFocused: true, isKeyboardVisible: true }),
    ).toEqual("none");
    expect(
      resolveTerminalInputFocusRequest({ isInputFocused: true, isKeyboardVisible: false }),
    ).toEqual("refocus");
    expect(
      resolveTerminalInputFocusRequest({ isInputFocused: false, isKeyboardVisible: false }),
    ).toEqual("focus");
  });
});

// Android: printable text comes only from the text diff. Events are written as
// `c` (text change), `k` (keypress), `hook` (a captured hardware key clearing
// the field), `reset` (focus, blur or show-keyboard) and `at` (clock, ms).
// "AOSP" rows follow the AOSP keyboard's order and "Samsung" rows Samsung
// Keyboard's, both traced on devices (docs/MOBILE_TERMINAL_PLAN.md, P0b).
type InputEvent =
  | readonly ["c" | "k", string]
  | readonly ["at", number]
  | readonly ["hook"]
  | readonly ["reset"];

function createDiffInput() {
  let clock = 0;
  const input = createTerminalTextInputState({ printableSource: "diff", now: () => clock });
  function play(...events: InputEvent[]): string {
    let sent = "";
    for (const event of events) {
      if (event[0] === "at") clock = event[1];
      else if (event[0] === "hook") input.noteHardwareClear();
      else if (event[0] === "reset") input.reset();
      else if (event[0] === "c") sent += input.receiveTextChange(event[1]).data;
      else sent += input.receiveKeyPress(event[1]).data;
    }
    return sent;
  }
  return { input, play };
}

describe("native terminal typed input, diff (Android)", () => {
  describe("printable text", () => {
    it("sends each letter once whichever event comes first", () => {
      const { play } = createDiffInput();
      expect(play(["c", "l"], ["k", "l"], ["c", "ls"], ["k", "s"])).toBe("ls");
      expect(play(["k", " "], ["c", "ls "])).toBe(" ");
    });

    it("sends a merged change once", () => {
      const { play } = createDiffInput();
      expect(play(["c", "ab"], ["k", "a"], ["k", "b"])).toBe("ab");
    });

    it("keeps a committed space that has no key", () => {
      const { play } = createDiffInput();
      expect(play(["c", "git"], ["c", "git "])).toBe("git ");
    });

    it("sends nothing for a printable key without a text change", () => {
      const { play } = createDiffInput();
      expect(play(["k", "x"])).toBe("");
    });
  });

  describe("Backspace", () => {
    it.each([
      [
        "AOSP, key first",
        [
          ["k", "Backspace"],
          ["c", "a"],
        ] as InputEvent[],
      ],
      [
        "Samsung, change first",
        [
          ["c", "a"],
          ["k", "Backspace"],
        ] as InputEvent[],
      ],
    ])("deletes one character: %s", (_order, events) => {
      const { play } = createDiffInput();
      play(["c", "ab"]);
      expect(play(...events)).toBe("\x7f");
      expect(play(["at", 1000], ["k", "Backspace"], ["c", ""])).toBe("\x7f");
    });

    it("deletes to empty and then past the field, AOSP order", () => {
      const { play } = createDiffInput();
      play(["c", "a"]);
      expect(play(["k", "Backspace"], ["c", ""])).toBe("\x7f");
      expect(play(["k", "Backspace"])).toBe("\x7f");
    });

    it("deletes to empty, Samsung order", () => {
      const { play } = createDiffInput();
      play(["c", "a"]);
      expect(play(["c", ""], ["k", "Backspace"])).toBe("\x7f");
      expect(play(["k", "Backspace"])).toBe("\x7f");
    });

    it("deletes a whole composing word or selection that empties at once", () => {
      const { play } = createDiffInput();
      play(["c", "hel"]);
      expect(play(["c", ""], ["k", "Backspace"])).toBe("\x7f\x7f\x7f");
      play(["c", "abcd"]);
      expect(play(["c", ""], ["k", "Backspace"])).toBe("\x7f".repeat(4));
    });

    it("realigns after Backspace so the next letter is sent once", () => {
      const { play } = createDiffInput();
      expect(play(["c", "ab"], ["k", "Backspace"], ["c", "a"], ["c", "ac"], ["k", "c"])).toBe(
        "ab\x7fc",
      );
    });

    it("does not pair a key with a shrink after the window expires", () => {
      const { play } = createDiffInput();
      play(["c", "ab"]);
      expect(play(["at", 0], ["c", "a"], ["at", 150], ["k", "Backspace"])).toBe("\x7f");
      expect(play(["at", 160], ["c", ""])).toBe("\x7f");
    });
  });

  describe("replacements", () => {
    it("keeps Backspace working after a swallowed autocorrect", () => {
      const { play } = createDiffInput();
      expect(play(["c", "teh"], ["c", "the"])).toBe("teh");
      expect(play(["k", "Backspace"], ["c", "th"])).toBe("\x7f");
    });

    it("keeps the CJK rubout off after a swallowed autocorrect until a reset", () => {
      const { play } = createDiffInput();
      play(["c", "teh"], ["c", "the"]);
      expect(play(["c", "thenihao"], ["c", "the你好"])).toBe("nihao");
      expect(play(["reset"], ["c", "nihao"], ["c", "你好"])).toBe("nihao\x7f\x7f\x7f\x7f\x7f你好");
    });

    it("types the spike's case: Backspace into a sent word, then retype", () => {
      const { play } = createDiffInput();
      let typed = "";
      let sent = "";
      for (const letter of "hello world") {
        typed += letter;
        sent += play(["c", typed], ["k", letter]);
      }
      for (const text of ["hello worl", "hello wor", "hello wo"]) {
        sent += play(["k", "Backspace"], ["c", text]);
      }
      sent += play(["c", "hello wol"], ["k", "l"], ["c", "hello wold"], ["k", "d"]);
      expect(sent).toBe("hello world\x7f\x7f\x7fld");
    });
  });

  describe("Enter and field clears", () => {
    it("sends Enter once when the clear lands, AOSP order", () => {
      const { input, play } = createDiffInput();
      play(["c", "ls"]);
      expect(input.receiveTextChange("ls\n")).toEqual({ data: "", shouldClear: true });
      expect(input.receiveKeyPress("Enter")).toEqual({ data: "\r", shouldClear: true });
      expect(play(["reset"], ["c", "x"])).toBe("x");
    });

    it("sends Enter once when the clear lands, Samsung order", () => {
      const { play } = createDiffInput();
      expect(
        play(["c", "ls"], ["k", "Enter"], ["reset"], ["c", "ls\n"], ["reset"], ["c", "x"]),
      ).toBe("ls\rx");
    });

    it.each([
      [
        "AOSP",
        [
          ["c", "ls\n"],
          ["k", "Enter"],
        ] as InputEvent[],
      ],
      [
        "Samsung",
        [
          ["k", "Enter"],
          ["c", "ls\n"],
        ] as InputEvent[],
      ],
    ])("diffs against the old line when the clear never lands: %s", (_order, enter) => {
      const { play } = createDiffInput();
      play(["c", "ls"]);
      expect(play(...enter, ["reset"])).toBe("\r");
      expect(play(["c", "ls\nx"], ["c", "ls\nxy"])).toBe("xy");
      expect(play(["k", "Backspace"], ["c", "ls\nx"])).toBe("\x7f");
    });

    it("does not resend the old line on Backspace after a stuck clear, AOSP order", () => {
      const { play } = createDiffInput();
      play(["c", "ls"], ["c", "ls\n"], ["k", "Enter"], ["reset"]);
      expect(play(["k", "Backspace"], ["c", "ls"])).toBe("\x7f");
      expect(play(["c", "lsx"])).toBe("x");
      expect(play(["at", 1000], ["k", "Backspace"], ["c", "ls"])).toBe("\x7f");
    });

    it.each([
      [
        "AOSP",
        [
          ["c", "ls\n"],
          ["k", "Enter"],
        ] as InputEvent[],
      ],
      [
        "Samsung",
        [
          ["k", "Enter"],
          ["c", "ls\n"],
        ] as InputEvent[],
      ],
    ])("sends a fast first letter after Backspace on an empty prompt: %s", (_order, enter) => {
      const { play } = createDiffInput();
      play(["c", "ls"], ...enter, ["reset"]);
      expect(play(["at", 0], ["k", "Backspace"], ["at", 50], ["c", "l"], ["k", "l"])).toBe("\x7fl");
    });

    it("resends the old line on Backspace after a stuck clear, Samsung order (known gap)", () => {
      // A change-first Backspace into a stuck line looks like typing a new line
      // that starts the same way; see the plan's known gaps.
      const { play } = createDiffInput();
      play(["c", "ls"], ["c", "ls\n"], ["k", "Enter"], ["reset"]);
      expect(play(["c", "ls"], ["k", "Backspace"], ["c", "lsx"])).toBe("lsx");
    });

    it.each([
      [
        "AOSP",
        "ls",
        [
          ["c", "ls\n"],
          ["k", "Enter"],
        ] as InputEvent[],
      ],
      [
        "Samsung",
        "ls",
        [
          ["k", "Enter"],
          ["c", "ls\n"],
        ] as InputEvent[],
      ],
      [
        "AOSP",
        "y",
        [
          ["c", "y\n"],
          ["k", "Enter"],
        ] as InputEvent[],
      ],
      [
        "Samsung",
        "y",
        [
          ["k", "Enter"],
          ["c", "y\n"],
        ] as InputEvent[],
      ],
    ])("sends a repeated line in full after a clear lands: %s %s", (_order, line, enter) => {
      const { play } = createDiffInput();
      let typed = "";
      for (const letter of line) {
        typed += letter;
        play(["c", typed]);
      }
      play(...enter, ["reset"]);
      typed = "";
      let sent = "";
      for (const letter of line) {
        typed += letter;
        sent += play(["c", typed], ["k", letter]);
      }
      expect(sent).toBe(line);
    });

    it("keeps the stuck-clear marker across a show-keyboard reset", () => {
      const { play } = createDiffInput();
      play(["c", "ls"], ["c", "ls\n"], ["k", "Enter"], ["reset"], ["reset"]);
      expect(play(["c", "ls\nx"])).toBe("x");
    });

    it("sends Enter on an empty field", () => {
      const { play } = createDiffInput();
      expect(play(["c", "\n"], ["k", "Enter"], ["reset"], ["c", "x"])).toBe("\rx");
    });

    it("does not resend a multi-line paste whose clear never lands", () => {
      const { play } = createDiffInput();
      expect(
        play(["c", "printf one\nprintf two"], ["reset"], ["c", "printf one\nprintf twox"]),
      ).toBe("x");
    });

    it("resends stale text when a show-keyboard clear never lands (accepted cost)", () => {
      const { play } = createDiffInput();
      expect(play(["c", "abc"], ["reset"], ["c", "abcd"])).toBe("abcabcd");
    });
  });

  describe("hardware keys (#206)", () => {
    it("sends nothing for the field clear when the hook comes first", () => {
      const { play } = createDiffInput();
      play(["c", "abc"]);
      expect(play(["hook"], ["c", ""])).toBe("");
      expect(play(["k", "Backspace"])).toBe("\x7f");
    });

    it("sends nothing for the field clear when the change comes first", () => {
      const { play } = createDiffInput();
      play(["c", "abc"]);
      expect(play(["c", ""], ["hook"])).toBe("");
      expect(play(["k", "Backspace"])).toBe("\x7f");
    });

    it("does not pair a stale Backspace key with a later hardware clear", () => {
      const { play } = createDiffInput();
      play(["c", "abc"]);
      expect(play(["at", 0], ["k", "Backspace"], ["at", 150], ["c", ""], ["hook"])).toBe("");
    });

    it("keeps the replacement desync across a hardware clear", () => {
      const { play } = createDiffInput();
      play(["c", "teh"], ["c", "the"], ["hook"], ["c", ""]);
      expect(play(["c", "nihao"], ["c", "你好"])).toBe("nihao");
    });
  });
});
