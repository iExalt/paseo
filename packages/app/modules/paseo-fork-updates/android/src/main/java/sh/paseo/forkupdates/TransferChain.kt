package sh.paseo.forkupdates

import kotlinx.coroutines.CancellationException

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
