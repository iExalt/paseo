
test("preserves transcript bytes when a rewind marker cuts no rows", () => {
  const content = [chain("u1", null), rewindTo("u1"), ""].join("\r\n");
  expect(dropRewoundBranches(content)).toBe(content);
});
