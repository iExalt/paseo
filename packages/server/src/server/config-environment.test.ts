import { describe, expect, it } from "vitest";
import { daemonLaunchEnvironment, droppedManagedEnvOverrides } from "./config-environment.js";

describe("droppedManagedEnvOverrides", () => {
  it("names every set setting a managed launch strips", () => {
    const env = {
      PASEO_LISTEN: "127.0.0.1:7899",
      PORT: "9999",
      PASEO_CORS_ORIGINS: "",
      PASEO_HOME: "/tmp/home",
      OPENAI_API_KEY: "sk-test",
    };

    const dropped = droppedManagedEnvOverrides(env);
    const managed = daemonLaunchEnvironment({ env, home: "/tmp/home", mode: "managed" });

    expect(dropped).toEqual(["PASEO_LISTEN", "PORT"]);
    for (const key of dropped) expect(managed[key]).toBeUndefined();
    expect(managed.OPENAI_API_KEY).toBe("sk-test");
  });
});
