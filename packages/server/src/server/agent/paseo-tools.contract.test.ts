import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { setWorkspaceNotifications } from "../notification-policy.js";
  const delivery = serverDeliveries.get(catalog);
        const updated = await setWorkspaceNotifications(
    // The fork steers by default for every caller (upstream interrupts top-level sends).
    { agentScoped: false, behavior: undefined, available: true, steered: true },
    // The fork holds a steer the provider cannot take until the turn ends instead of interrupting.
    { agentScoped: true, behavior: undefined, available: false, steered: false, deferred: true },
    async (row) => {
      const { agentScoped, behavior, available, steered } = row;
      const deferred = "deferred" in row && row.deferred;
        expect(client.sessions[1]!.prompts).toHaveLength(steered || deferred ? 1 : 2);
        expect(manager.getAgent(child.id)!.activeTurnId === originalTurn).toBe(steered || deferred);
      // The direct catalog client rejects where an MCP client would return isError.
      await expect(
        mcp.callTool({
          name: "send_agent_prompt",
          arguments: { agentId: child.id, prompt: "Must not dispatch" },
        }),
      ).rejects.toThrow();
