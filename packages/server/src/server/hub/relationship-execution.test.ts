    expect(first).toMatchObject({
      payload: { success: true, executionId: "first-execution", error: null },
    });
    expect(second).toMatchObject({
      payload: { success: true, executionId: "second-execution", error: null },
    });
