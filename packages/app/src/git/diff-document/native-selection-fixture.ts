import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { buildDiffDocumentModel } from "./model";
import { nativeSelectionPositionAtBodyPoint } from "./native-selection";
import type {
  BuildDiffDocumentModelInput,
  DiffCharacterPosition,
  DiffDocumentModel,
  DiffLineRow,
} from "./types";

// Shared models for the native selection tests. Every grapheme is 10px wide;
// the code column starts at gutterWidth + 8.
const measurer = { measure: (text: string) => Array.from(text).length * 10 };
export const LINE_HEIGHT = 18;

export function pointAt(
  model: DiffDocumentModel,
  row: DiffLineRow,
  locationX: number,
  horizontalOffsets: Record<string, number>,
  lockCellIndex?: number,
): DiffCharacterPosition | null {
  const file = model.files[row.fileIndex]!;
  return nativeSelectionPositionAtBodyPoint({
    model,
    file,
    locationX,
    locationY: row.top - file.bodyTop + 2,
    horizontalOffsets,
    lockCellIndex,
  });
}

export function positionIn(
  row: DiffLineRow,
  cellIndex: number,
  sourceOffset: number,
): DiffCharacterPosition {
  const cell = row.cells[cellIndex]!;
  return {
    fileIndex: row.fileIndex,
    rowIndex: row.index,
    cellIndex,
    side: cell.reviewTarget?.side ?? (cellIndex === 0 ? "old" : "new"),
    sourceOffset,
  };
}

export function lineRow(
  model: DiffDocumentModel,
  predicate: (row: DiffLineRow) => boolean,
): DiffLineRow {
  const row = model.rows.find(
    (candidate): candidate is DiffLineRow => candidate.kind === "line" && predicate(candidate),
  );
  if (!row) throw new Error("Expected a matching line row");
  return row;
}

export function build(overrides: Partial<BuildDiffDocumentModelInput>): DiffDocumentModel {
  return buildDiffDocumentModel({
    files: [diffFile("src/a.ts")],
    collapsedFilePaths: new Set(),
    layout: "unified",
    wrapLines: false,
    viewportWidth: 400,
    typography: { family: "monospace", size: 12, lineHeight: LINE_HEIGHT },
    measureText: measurer,
    palette: {
      surface: "#000",
      headerSurface: "#111",
      border: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      addition: "green",
      deletion: "red",
      additionBackground: "#010",
      deletionBackground: "#100",
      emptyBackground: "#111",
      selection: "blue",
      headerActiveSurface: "#222",
      headerBorder: "#333",
      statusSuccess: "green",
      statusDanger: "red",
      statusWarning: "orange",
      syntax: {},
    },
    labels: { binary: "Binary", tooLarge: "Too large" },
    ...overrides,
  });
}

export function diffFile(path: string): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 2,
    deletions: 2,
    hunks: [
      {
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "header", content: "@@ -1,2 +1,2 @@" },
          { type: "remove", content: "old-one" },
          { type: "remove", content: "old-two" },
          { type: "add", content: "new-one" },
          { type: "add", content: "new-two" },
        ],
      },
    ],
  };
}

export function deletedFile(): ParsedDiffFile {
  return {
    path: "src/deleted.ts",
    isNew: false,
    isDeleted: true,
    additions: 0,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 0,
        newCount: 0,
        lines: [
          { type: "header", content: "@@ -1,1 +0,0 @@" },
          { type: "remove", content: "gone" },
        ],
      },
    ],
  };
}
