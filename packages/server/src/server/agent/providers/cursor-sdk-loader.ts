import * as nodeModule from "node:module";

let sdk: Promise<typeof import("@cursor/sdk")> | undefined;

export function loadCursorSdk(): Promise<typeof import("@cursor/sdk")> {
  return (sdk ??= importCursorSdk());
}

async function importCursorSdk(): Promise<typeof import("@cursor/sdk")> {
  // SDK 1.5.2 couples its opt-out to loading ambient user settings. Until Cursor
  // exposes a standalone option, omit the commit-attribution request field.
  const runtime = new URL("544.js", import.meta.resolve("@cursor/sdk")).href;
  const optIn = ',commitAttributionMessage:J?"enabled":void 0';
  const unsupported = "Paseo cannot disable commit attribution with this Cursor SDK runtime.";
  if (typeof nodeModule.registerHooks !== "function") throw new Error(unsupported);

  let patched = false;
  const hook = nodeModule.registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (url !== runtime) return loaded;
      const source = loaded.source?.toString();
      const position = source?.indexOf(optIn) ?? -1;
      if (!source || position < 0 || position !== source.lastIndexOf(optIn)) {
        throw new Error(unsupported);
      }
      patched = true;
      return { ...loaded, source: source.replace(optIn, "") };
    },
  });
  try {
    await import(runtime);
  } finally {
    hook.deregister();
  }
  if (!patched) throw new Error(unsupported);
  return import("@cursor/sdk");
}
