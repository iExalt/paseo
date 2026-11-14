import { describe, expect, it, vi } from "vitest";
import { discoverVerifiedForkRelease } from "./fork-release-discovery.ts";

const entry = (version: string, extra = {}) => ({
  tag_name: `paseo-v${version}`,
  draft: false,
  prerelease: false,
  ...extra,
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function harness() {
  const resolveTag = vi.fn(async () => "paseo-v0.1.9");
  const fetchBytes = vi.fn(async (_url: string, _what: string) => bytes([]));
  const verifyTag = vi.fn(async (tag: string) => tag);
  const discover = () => discoverVerifiedForkRelease({ resolveTag, fetchBytes, verifyTag });
  return { resolveTag, fetchBytes, verifyTag, discover };
}

describe("bounded fork release discovery", () => {
  it("verifies Latest without listing release history", async () => {
    const f = harness();
    expect(await f.discover()).toBe("paseo-v0.1.9");
    expect(f.fetchBytes).not.toHaveBeenCalled();
    expect(f.verifyTag).toHaveBeenCalledExactlyOnceWith("paseo-v0.1.9");
  });

  it("skips the failed Latest, previews, drafts and unrelated tags, then tries descending versions", async () => {
    const f = harness();
    f.verifyTag.mockRejectedValueOnce(new Error("bad signature"));
    f.fetchBytes.mockResolvedValueOnce(
      bytes([
        entry("0.1.9"),
        entry("0.1.7"),
        entry("0.1.8"),
        entry("0.2.0", { prerelease: true }),
        entry("0.3.0", { draft: true }),
        entry("0.4.0", { tag_name: "probe" }),
      ]),
    );
    expect(await f.discover()).toBe("paseo-v0.1.8");
    expect(f.verifyTag.mock.calls.flat()).toEqual(["paseo-v0.1.9", "paseo-v0.1.8"]);
    expect(f.fetchBytes).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/iExalt/paseo/releases?per_page=6&page=2",
      "the fallback release list",
    );
  });

  it.each([true, false])(
    "tries at most five additional candidates (fifth verifies: %s)",
    async (success) => {
      const f = harness();
      f.fetchBytes.mockResolvedValueOnce(
        bytes([entry("0.1.9"), ...[8, 7, 6, 5, 4].map((n) => entry(`0.1.${n}`))]),
      );
      f.verifyTag.mockImplementation(async (tag) => {
        if (tag === "paseo-v0.1.4" && success) return tag;
        throw new Error(`invalid ${tag}`);
      });
      if (success) expect(await f.discover()).toBe("paseo-v0.1.4");
      else await expect(f.discover()).rejects.toThrow("invalid paseo-v0.1.4");
      expect(f.verifyTag.mock.calls.flat()).toEqual(
        [9, 8, 7, 6, 5, 4].map((n) => `paseo-v0.1.${n}`),
      );
      expect(f.fetchBytes).toHaveBeenCalledOnce();
    },
  );

  it("falls back after Latest lookup fails and de-duplicates tags across pages", async () => {
    const f = harness();
    f.resolveTag.mockRejectedValueOnce(new Error("HTTP 404"));
    f.fetchBytes.mockResolvedValueOnce(bytes(Array(6).fill(entry("0.1.8"))));
    f.fetchBytes.mockResolvedValueOnce(bytes([entry("0.1.8"), entry("0.1.7")]));
    f.verifyTag.mockRejectedValueOnce(new Error("missing manifest"));
    expect(await f.discover()).toBe("paseo-v0.1.7");
    expect(f.verifyTag.mock.calls.flat()).toEqual(["paseo-v0.1.8", "paseo-v0.1.7"]);
  });

  it("bounds pagination even when every entry is ineligible", async () => {
    const f = harness();
    f.verifyTag.mockRejectedValue(new Error("signature mismatch"));
    f.fetchBytes.mockResolvedValue(bytes(Array(6).fill(entry("0.2.0", { prerelease: true }))));
    await expect(f.discover()).rejects.toThrow("signature mismatch");
    expect(f.fetchBytes).toHaveBeenCalledTimes(10);
    expect(f.verifyTag).toHaveBeenCalledOnce();
  });

  it("reports a fallback-list network failure without retrying indefinitely", async () => {
    const f = harness();
    f.resolveTag.mockRejectedValue(new Error("latest unavailable"));
    f.fetchBytes.mockRejectedValue(new Error("GitHub rate limit reached"));
    await expect(f.discover()).rejects.toThrow("rate limit");
    expect(f.fetchBytes).toHaveBeenCalledOnce();
    expect(f.verifyTag).not.toHaveBeenCalled();
  });

  it("rejects malformed release lists", async () => {
    const f = harness();
    f.resolveTag.mockRejectedValue(new Error("latest unavailable"));
    f.fetchBytes.mockResolvedValue(bytes({ tag_name: "paseo-v0.1.8" }));
    await expect(f.discover()).rejects.toThrow("invalid release list");
    expect(f.verifyTag).not.toHaveBeenCalled();
  });
});
