import { describe, expect, it } from "vitest";
import {
  FIT_TRANSFORM,
  clampTransform,
  fitContentSize,
  isActivePinchUpdate,
  isPointInsideTransformedContent,
  panContent,
  zoomContentAtPoint,
  wheelPanDelta,
} from "./geometry";

const viewport = { width: 800, height: 600 };
const fittedContent = { width: 800, height: 400 };

describe("zoomable viewport geometry", () => {
  it("rejects Android's terminal pinch update after a touch has lifted", () => {
    expect(isActivePinchUpdate(1, 2)).toBe(false);
    expect(isActivePinchUpdate(2, 2)).toBe(true);
  });

  it("fits content inside the viewport without changing its aspect ratio", () => {
    expect(fitContentSize({ width: 1600, height: 800 }, viewport)).toEqual(fittedContent);
    expect(fitContentSize({ width: 400, height: 800 }, viewport)).toEqual({
      width: 300,
      height: 600,
    });
  });

  it("fits within presentation padding and caps without shrinking the zoom viewport", () => {
    expect(
      fitContentSize({ width: 1600, height: 800 }, viewport, {
        padding: 20,
        maxWidth: 600,
        maxHeight: 500,
      }),
    ).toEqual({ width: 600, height: 300 });
  });

  it("keeps images at original size when they fit while preserving diagram upscaling", () => {
    const image = { width: 320, height: 200 };
    expect(fitContentSize(image, viewport, { allowUpscale: false })).toEqual(image);
    expect(fitContentSize(image, viewport)).toEqual({ width: 800, height: 500 });
  });

  it.each([
    [
      { width: 1200, height: 800 },
      { width: 1440, height: 1000 },
      { width: 1200, height: 800 },
    ],
    [
      { width: 2400, height: 1200 },
      { width: 1440, height: 900 },
      { width: 1408, height: 704 },
    ],
    [
      { width: 1200, height: 2400 },
      { width: 375, height: 812 },
      { width: 343, height: 686 },
    ],
    [
      { width: 1200, height: 2400 },
      { width: 1440, height: 900 },
      { width: 434, height: 868 },
    ],
  ])("fits image %j to screen %j without fixed presentation caps", (image, screen, expected) => {
    const fitted = fitContentSize(image, screen, { padding: 16, allowUpscale: false });
    expect(fitted.width).toBeCloseTo(expected.width);
    expect(fitted.height).toBeCloseTo(expected.height);
  });

  it("distinguishes backdrop taps from taps on transformed content", () => {
    expect(
      isPointInsideTransformedContent({
        point: { x: 400, y: 300 },
        transform: FIT_TRANSFORM,
        fittedContent,
        viewport,
      }),
    ).toBe(true);
    expect(
      isPointInsideTransformedContent({
        point: { x: 400, y: 50 },
        transform: FIT_TRANSFORM,
        fittedContent,
        viewport,
      }),
    ).toBe(false);
    expect(
      isPointInsideTransformedContent({
        point: { x: 10, y: 10 },
        transform: { scale: 2, x: 0, y: 0 },
        fittedContent,
        viewport,
      }),
    ).toBe(true);
  });

  it("returns to the centered fit transform at the minimum scale", () => {
    expect(
      clampTransform({ scale: 0.5, x: 200, y: -200 }, fittedContent, viewport, {
        minScale: 1,
        maxScale: 8,
      }),
    ).toEqual(FIT_TRANSFORM);
  });

  it("keeps the focal content point under the cursor while zooming", () => {
    expect(
      zoomContentAtPoint({
        transform: FIT_TRANSFORM,
        scale: 2,
        focalPoint: { x: 600, y: 300 },
        fittedContent,
        viewport,
        limits: { minScale: 1, maxScale: 8 },
      }),
    ).toEqual({ scale: 2, x: -200, y: 0 });
  });

  it("clamps panning to the scaled content edges", () => {
    expect(
      panContent({
        transform: { scale: 2, x: 0, y: 0 },
        delta: { x: 900, y: -900 },
        fittedContent,
        viewport,
        limits: { minScale: 1, maxScale: 8 },
      }),
    ).toEqual({ scale: 2, x: 400, y: -100 });
  });

  it.each([
    [0, { x: -2, y: 3 }],
    [1, { x: -32, y: 48 }],
    [2, { x: -1600, y: 1800 }],
  ])("converts wheel delta mode %i to viewport panning pixels", (deltaMode, expected) => {
    expect(wheelPanDelta({ deltaX: 2, deltaY: -3, deltaMode }, viewport)).toEqual(expected);
  });

  it("allows Mermaid consumers to zoom below fit without inventing translation", () => {
    expect(
      clampTransform({ scale: 0.25, x: 100, y: 100 }, fittedContent, viewport, {
        minScale: 0.25,
        maxScale: 8,
      }),
    ).toEqual({ scale: 0.25, x: 0, y: 0 });
  });
});
