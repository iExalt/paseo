function assistant(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date(0) } as StreamItem;
    assistant("a", "one **match** and `match`, then\n\n```\nmatch\n```"),
  it("numbers a message's occurrences in reading order, code blocks included", () => {
      itemId: "a",
    expect(locateMessageMatch(items, "a", "match", 2)).toMatchObject({ itemId: "a", index: 2 });
