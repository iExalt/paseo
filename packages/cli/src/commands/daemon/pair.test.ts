import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import { generateLocalPairingOffer } from "@getpaseo/server/pairing";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { resolveLocalPairingOffer, withAppUrl } from "./pair.js";

test("offline pairing requires relay consent and saves it in the selected home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-offline-pair-"));
  const home = path.join(root, "home");
  try {
    expect(await resolveLocalPairingOffer({ paseoHome: home })).toMatchObject({
      relayEnabled: false,
      url: null,
    });
    expect(existsSync(home)).toBe(false);
    const offer = await resolveLocalPairingOffer({ paseoHome: home, enableRelay: true });
    expect(offer.relayEnabled).toBe(true);
    expect(offer.url).toContain("offer=");
    expect(
      JSON.parse(await readFile(path.join(home, "config.json"), "utf8")).daemon.relay.enabled,
    ).toBe(true);
    expect(existsSync(path.join(home, "server-id"))).toBe(true);
    expect(existsSync(path.join(home, "daemon-keypair.json"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--app-url points the link and QR at the app without changing the offer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pair-app-url-"));
  const home = path.join(root, "home");
  try {
    const original = await resolveLocalPairingOffer({ paseoHome: home, enableRelay: true });
    const rebased = await withAppUrl(original, "paseo://");
    const direct = await generateLocalPairingOffer({ paseoHome: home, appBaseUrl: "paseo://" });

    expect(rebased.url).toMatch(/^paseo:\/\/\/#offer=/);
    expect(parseConnectionOfferFromUrl(rebased.url!)).toEqual(
      parseConnectionOfferFromUrl(original.url!),
    );
    expect(rebased).toEqual(direct);
    expect(rebased.qr).not.toEqual(original.qr);
    await expect(withAppUrl(original, "paseo")).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
