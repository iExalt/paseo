import React, { act, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import { WorkspaceLightboxProvider, useAttachmentLightbox } from "./attachment-lightbox-context";
import type { AttachmentMetadata } from "@/attachments/types";

vi.mock("./attachment-lightbox", () => ({
  AttachmentLightbox: ({ source, onClose }: { source: unknown; onClose: () => void }) =>
    source ? (
      <button type="button" data-testid="viewer" onClick={onClose}>
        Close
      </button>
    ) : null,
}));

const attachment: AttachmentMetadata = {
  id: "workspace-lightbox-test",
  mimeType: "image/png",
  storageType: "web-indexeddb",
  storageKey: "test",
  fileName: "test.png",
  byteSize: 1,
  createdAt: 1,
};
function Opener() {
  const { open, localLightbox } = useAttachmentLightbox();
  const openImage = useCallback(() => open({ type: "attachment", metadata: attachment }), [open]);
  return (
    <>
      <button type="button" data-testid="open" onClick={openImage}>
        Open
      </button>
      {localLightbox}
    </>
  );
}
it("keeps the image retained when its opener unmounts, then releases on route loss", () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("root")!);
  try {
    act(() =>
      root.render(
        <WorkspaceLightboxProvider active>
          <Opener />
        </WorkspaceLightboxProvider>,
      ),
    );
    act(() => (document.querySelector('[data-testid="open"]') as HTMLElement).click());
    expect(collectRetainedAttachmentIds().has(attachment.id)).toBe(true);
    act(() =>
      root.render(
        <WorkspaceLightboxProvider active>
          <div />
        </WorkspaceLightboxProvider>,
      ),
    );
    expect(document.querySelector('[data-testid="viewer"]')).not.toBeNull();
    expect(collectRetainedAttachmentIds().has(attachment.id)).toBe(true);
    act(() =>
      root.render(
        <WorkspaceLightboxProvider active={false}>
          <div />
        </WorkspaceLightboxProvider>,
      ),
    );
    expect(document.querySelector('[data-testid="viewer"]')).toBeNull();
    expect(collectRetainedAttachmentIds().has(attachment.id)).toBe(false);
  } finally {
    act(() => root.unmount());
    Object.assign(globalThis, { window: oldWindow, document: oldDocument });
    dom.window.close();
  }
});
