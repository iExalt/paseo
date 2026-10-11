const fs = require("node:fs");
// Observe the product worker's loader choices; never preload or redirect its addon.
process.once("exit", (code) => {
  const addons = Object.keys(require.cache).filter((name) => name.endsWith(".node"));
  const sherpa = addons.find((name) => name.endsWith("sherpa-onnx.node"));
  fs.writeFileSync(
    process.env.PASEO_SPEECH_LOADER_RECEIPT,
    JSON.stringify({
      code,
      executable: process.execPath,
      electron: process.versions.electron,
      architecture: process.arch,
      addons,
      onnxruntime: sherpa ? require.cache[sherpa].exports.onnxruntimeVersion : null,
      sharedObjects: process.report.getReport().sharedObjects,
    }),
    { flag: "wx" },
  );
});
