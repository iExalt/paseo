import { describe, expect, test } from "vitest";
import { restoreComposerTextIfEmpty } from "./composer-restore";
import { TimelineRequestSupersededError } from "@/timeline/timeline-request";
import { runRewind, shouldRestoreComposerForRewindMode } from "./rewind-mode";

describe("restoreComposerTextIfEmpty", () => {
  test("restores the rewound message when the composer is empty", () => {
    expect(
      restoreComposerTextIfEmpty({
        currentText: "",
        rewoundText: "message before rewind",
      }),
    ).toBe("message before rewind");
  });

  test("preserves an existing composer draft", () => {
    expect(
      restoreComposerTextIfEmpty({
        currentText: "keep this draft",
        rewoundText: "message before rewind",
      }),
    ).toBe("keep this draft");
  });
});

describe("shouldRestoreComposerForRewindMode", () => {
  test("restores only conversation-mutating rewind modes", () => {
    expect(shouldRestoreComposerForRewindMode("conversation")).toBe(true);
    expect(shouldRestoreComposerForRewindMode("files")).toBe(false);
    expect(shouldRestoreComposerForRewindMode("both")).toBe(true);
  });
});

describe("runRewind", () => {
  function run(mode: "conversation" | "files", refreshTimeline: () => Promise<unknown>) {
    const restored: string[] = [];
    const result = runRewind({
      mode,
      rewind: async () => {},
      refreshTimeline,
      restoreComposer: () => restored.push("rewound message"),
    });
    return { result, restored };
  }

  test("restores the rewound message when the rewind's own reset supersedes the refresh", async () => {
    const { result, restored } = run("conversation", async () => {
      throw new TimelineRequestSupersededError();
    });
    await expect(result).resolves.toBeUndefined();
    expect(restored).toEqual(["rewound message"]);
  });

  test("restores the rewound message and still reports any other refresh failure", async () => {
    const { result, restored } = run("conversation", async () => {
      throw new Error("socket closed");
    });
    await expect(result).rejects.toThrow("socket closed");
    expect(restored).toEqual(["rewound message"]);
  });

  test("leaves the composer alone when the daemon rejects the rewind", async () => {
    const restored: string[] = [];
    await expect(
      runRewind({
        mode: "conversation",
        rewind: async () => {
          throw new Error("rewind failed");
        },
        refreshTimeline: async () => {},
        restoreComposer: () => restored.push("rewound message"),
      }),
    ).rejects.toThrow("rewind failed");
    expect(restored).toEqual([]);
  });

  test("files-only rewind neither refreshes the timeline nor restores the composer", async () => {
    let refreshed = false;
    const { result, restored } = run("files", async () => {
      refreshed = true;
    });
    await result;
    expect(refreshed).toBe(false);
    expect(restored).toEqual([]);
  });
});
