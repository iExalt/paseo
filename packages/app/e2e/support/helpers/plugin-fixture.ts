import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { PASEO_PLUGIN_API_VERSION } from "@getpaseo/protocol/plugin-requirements";

export const pluginRequirements = { paseo: `>=${PASEO_PLUGIN_API_VERSION}` };

export async function copyPluginExample(name: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-example-"));
  try {
    await cp(path.resolve(__dirname, "../../../../../plugin-examples", name), directory, {
      recursive: true,
    });
    const manifestPath = path.join(directory, "paseo-plugin.json");
    const manifest = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await readFile(manifestPath, "utf8")));
    // Examples target the retained plugin API independently of the fork release.
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, requirements: pluginRequirements }),
    );
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
