// Node tooling and portable clients share one fork-version contract.
export {
  parseForkVersion,
  compareForkVersions,
  forkAndroidVersionCode,
  forkReleaseTag,
  forkVersionFromTag,
} from "../packages/protocol/src/fork-version.ts";
