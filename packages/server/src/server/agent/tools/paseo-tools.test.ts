        getPluginTools: () => [],
    const patch = vi.fn(async (input: { replyRules: Array<{ source: string; flags: string }> }) => {
      await Promise.resolve();
    await expect(catalog.executeTool("clear_daemon_notification_rules", {})).resolves.toMatchObject(
      {
        structuredContent: { replyRules: [] },
      },
    );
    expect(currentRules).toEqual([]);

    patch.mockRejectedValueOnce(new Error("config write failed"));
    await expect(
      catalog.executeTool("set_daemon_notification_rules", { replyRules: [] }),
    ).rejects.toThrow("config write failed");
    patch.mockRejectedValueOnce(new Error("config write failed"));
    await expect(catalog.executeTool("clear_daemon_notification_rules", {})).rejects.toThrow(
      "config write failed",
    );
