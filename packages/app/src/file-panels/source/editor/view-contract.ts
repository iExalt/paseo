import type { Ref } from "react";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { FileEditorModel } from "./model";
import type { EditorVisualTheme } from "./visual-theme";

export interface FileEditorHandle {
  /** Resolves once every edit the view holds has reached the model. */
  flush(): Promise<void>;
}

export interface FileEditorViewProps {
  ref?: Ref<FileEditorHandle>;
  model: FileEditorModel;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  vimEnabled: boolean;
  theme: EditorVisualTheme;
  onCursorChange(position: { line: number; column: number }): void;
  onVimModeChange(mode: string | null): void;
}
