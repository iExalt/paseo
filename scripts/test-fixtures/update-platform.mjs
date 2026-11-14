Object.defineProperty(process, "platform", {
  value: process.env.PASEO_UPDATE_MAC ? "darwin" : "linux",
});
Object.defineProperty(process, "arch", {
  value: process.env.PASEO_UPDATE_MAC ? "arm64" : "x64",
});
