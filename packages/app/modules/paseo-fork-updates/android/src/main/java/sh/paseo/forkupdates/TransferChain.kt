package sh.paseo.forkupdates

import kotlinx.coroutines.CancellationException

internal const val GZIP_SUFFIX = ".gz"
private val forkVersion = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")

// The offered transfers: each mode at most once, and the signed APK (no compression) last.
internal fun validateTransferModes(modes: List<String?>) {
  require(modes.isNotEmpty() && modes.last() == null) { "APK transfers must end with the signed APK." }
  require(modes.toSet().size == modes.size) { "APK transfers are duplicated." }
}

// The suffix a transfer adds to the staged APK name, in both its URL and its DownloadManager
// name, which is why the base version must be plain semver.
internal fun transferSuffix(compression: String?, baseVersion: String?): String = when (compression) {
  "gzip" -> GZIP_SUFFIX
  "zstd-patch" -> ".delta-from-$baseVersion.zst"
  else -> ""
}

internal fun validateTransfer(compression: String?, bytes: Long?, baseVersion: String?, url: String, expectedBytes: Long) {
  when (compression) {
    null -> require(bytes == null) { "APK transfer size is invalid." }
    "gzip", "zstd-patch" -> require(bytes != null && bytes in 1 until expectedBytes) { "APK transfer size is invalid." }
    else -> throw IllegalArgumentException("APK compression is unsupported.")
  }
  if (compression == "zstd-patch") {
    require(baseVersion?.matches(forkVersion) == true) { "APK delta base version is invalid." }
  } else {
    require(baseVersion == null) { "APK transfer base version is invalid." }
  }
  require(url.endsWith(".apk${transferSuffix(compression, baseVersion)}")) { "APK transfer URL is invalid." }
}

// The user removed the transfer, so no fallback may start another one.
internal class DownloadCanceledException : IllegalArgumentException("APK download was canceled.")

// Tries each transfer in order (smallest first, the signed APK last) until one yields a
// verified APK. Unsigned transfers fail over on any error short of a cancel. A transfer
// that outlived the process resumes the chain at its position, so an earlier transfer that
// already failed is not fetched again. At most one transfer is ever live, because enqueuing
// one forgets every other, so the first live transfer is the only one.
internal suspend fun <T> firstVerifiedTransfer(
  names: List<String>,
  hasLiveDownload: (String) -> Boolean,
  attempt: suspend (index: Int) -> T,
): T {
  require(names.isNotEmpty()) { "No APK transfer was offered." }
  val start = names.indexOfFirst(hasLiveDownload).coerceAtLeast(0)
  val failures = mutableListOf<Throwable>()
  for (index in start..names.lastIndex) {
    try {
      return attempt(index)
    } catch (error: Throwable) {
      if (error is CancellationException || error is DownloadCanceledException) throw error
      if (index == names.lastIndex) throw error.also { failures.forEach(it::addSuppressed) }
      failures += error
    }
  }
  error("unreachable")
}
