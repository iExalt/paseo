function configureCompileSdk(source) {
  const configured =
    "compileSdk { version = release(rootProject.ext.compileSdkVersion) { minorApiLevel = 2 } }";
  if (source.includes(configured)) return source;
  const compileSdk = /^( +)compileSdk rootProject\.ext\.compileSdkVersion$/m;
  if (!compileSdk.test(source)) {
    throw new Error("Could not find the Android app's compile SDK configuration");
  }
  return source.replace(compileSdk, `$1${configured}`);
}

module.exports = configureCompileSdk;
