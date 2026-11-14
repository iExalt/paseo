export async function loadRootAfterPreferenceRecovery<Root>(input: {
  recover: () => Promise<void>;
  loadRoot: () => Promise<Root>;
}): Promise<Root> {
  await input.recover();
  return input.loadRoot();
}
