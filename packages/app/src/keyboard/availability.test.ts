import { keyboardShortcutsAvailable } from "./availability";
import { describe, expect, it } from "vitest";
import { createHardwareKeyboardPresence } from "./internal/hardware-presence";
import { buildEffectiveBindings } from "./keyboard-shortcuts";
import { createKeyboardPipeline } from "./internal/pipeline";
import { createOverlayRegistry } from "./internal/overlays";
import { nativeKeyboardInput } from "./internal/sources/contract";

describe("hardware keyboard availability", () => {
  it("publishes connection changes and cleans up the capability subscription", () => {
    let present = false;
    const changes = new Set<() => void>();
    const presence = createHardwareKeyboardPresence({
      read: () => present,
      watch: (changed) => {
        changes.add(changed);
        return () => {
          changes.delete(changed);
        };
      },
    });
    const observed: boolean[] = [];
    const release = presence.subscribe(() => observed.push(presence.getSnapshot()));
    expect(presence.getSnapshot()).toBe(false);
    present = true;
    for (const changed of changes) changed();
    expect(presence.getSnapshot()).toBe(true);
    for (const changed of changes) changed();
    present = false;
    for (const changed of changes) changed();
    expect(observed).toEqual([true, false]);
    release();
    expect(changes.size).toBe(0);
  });

  it("routes compact Electron input independently of hint availability", () => {
    const presence = createHardwareKeyboardPresence({ read: () => false, watch: () => () => {} });
    const actions: string[] = [];
    const pipeline = createKeyboardPipeline({
      getContext: () => ({ isMac: true, usesDesktopBindings: true, commandCenterOpen: false }),
      getBindings: () => buildEffectiveBindings({}),
      isCapturing: () => false,
      dispatch: (match) => {
        actions.push(match.action);
        return true;
      },
      overlays: createOverlayRegistry(),
    });
    pipeline.keyDown(
      nativeKeyboardInput(
        {
          key: "k",
          code: "KeyK",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          repeat: false,
          preventDefault() {},
          stopPropagation() {},
        },
        "other",
      ),
    );
    expect(presence.getSnapshot()).toBe(false);
    expect(actions).toEqual(["command-center.toggle"]);
    pipeline.dispose();
  });
});

describe("keyboardShortcutsAvailable", () => {
  it("needs a wide layout, and a hardware keyboard on native", () => {
    const cases = [
      { isNative: false, isCompact: false, hasHardwareKeyboard: false, expected: true },
      { isNative: false, isCompact: true, hasHardwareKeyboard: false, expected: false },
      { isNative: true, isCompact: false, hasHardwareKeyboard: true, expected: true },
      { isNative: true, isCompact: false, hasHardwareKeyboard: false, expected: false },
      { isNative: true, isCompact: true, hasHardwareKeyboard: true, expected: false },
    ];
    for (const { expected, ...environment } of cases) {
      expect(keyboardShortcutsAvailable(environment), JSON.stringify(environment)).toBe(expected);
    }
  });
});
