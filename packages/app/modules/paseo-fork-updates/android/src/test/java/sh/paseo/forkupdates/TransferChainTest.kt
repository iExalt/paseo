package sh.paseo.forkupdates

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class TransferChainTest {
  private val names = listOf("delta", "gz", "apk")

  private fun run(live: String? = null, outcomes: Map<String, Throwable?>): Pair<List<String>, Result<String>> {
    val attempted = mutableListOf<String>()
    val result = runCatching {
      runBlocking {
        firstVerifiedTransfer(names, { it == live }) { index ->
          val name = names[index]
          attempted += name
          outcomes[name]?.let { throw it }
          name
        }
      }
    }
    return attempted to result
  }

  @Test fun usesTheFirstTransferThatVerifies() {
    val (attempted, result) = run(outcomes = mapOf("delta" to null))
    assertEquals(listOf("delta"), attempted)
    assertEquals("delta", result.getOrThrow())
  }

  @Test fun failsOverToTheSignedApk() {
    val failure = IllegalArgumentException("bad")
    val (attempted, result) = run(outcomes = mapOf("delta" to failure, "gz" to failure, "apk" to null))
    assertEquals(names, attempted)
    assertEquals("apk", result.getOrThrow())
  }

  @Test fun reportsTheSignedApkFailureWhenEverythingFails() {
    val earlier = listOf(IllegalArgumentException("delta"), IllegalArgumentException("gz"))
    val last = IllegalStateException("apk")
    val (_, result) = run(outcomes = mapOf("delta" to earlier[0], "gz" to earlier[1], "apk" to last))
    assertSame(last, result.exceptionOrNull())
    assertEquals(earlier, last.suppressed.toList())
  }

  @Test fun stopsOnACancel() {
    for (cancel in listOf(DownloadCanceledException(), CancellationException("gone"))) {
      val (attempted, result) = run(outcomes = mapOf("delta" to cancel))
      assertEquals(listOf("delta"), attempted)
      assertSame(cancel, result.exceptionOrNull())
    }
  }

  @Test fun resumesAtTheLiveTransfer() {
    val (attempted, result) = run(live = "gz", outcomes = mapOf("gz" to null))
    assertEquals(listOf("gz"), attempted)
    assertEquals("gz", result.getOrThrow())
    assertEquals(listOf("apk"), run(live = "apk", outcomes = mapOf("apk" to null)).first)
  }

  @Test fun acceptsEachTransferMode() {
    validateTransfer(null, null, null, "https://x/paseo.apk", 100)
    validateTransfer("gzip", 40, null, "https://x/paseo.apk.gz", 100)
    validateTransfer("zstd-patch", 4, "0.13.0", "https://x/paseo.apk.delta-from-0.13.0.zst", 100)
    validateTransferModes(listOf("zstd-patch", "gzip", null))
  }

  @Test fun rejectsBadTransfers() {
    fun rejects(compression: String?, bytes: Long?, baseVersion: String?, url: String) =
      assertThrows(IllegalArgumentException::class.java) { validateTransfer(compression, bytes, baseVersion, url, 100) }
    for (base in listOf("../0.1.0", "0.1.0/x", "0.1", "01.0.0", "0.1.0-beta")) {
      rejects("zstd-patch", 4, base, "https://x/paseo.apk.delta-from-$base.zst")
    }
    rejects("gzip", 40, "0.1.0", "https://x/paseo.apk.gz")
    rejects(null, null, "0.1.0", "https://x/paseo.apk")
    rejects("zstd-patch", 4, "0.1.0", "https://x/paseo.apk.delta-from-0.0.9.zst")
    rejects("zstd-patch", 100, "0.1.0", "https://x/paseo.apk.delta-from-0.1.0.zst")
    rejects("gzip", 0, null, "https://x/paseo.apk.gz")
    rejects(null, 50, null, "https://x/paseo.apk")
    rejects("brotli", 4, null, "https://x/paseo.apk.br")
    rejects("gzip", 40, null, "https://x/paseo.apk")
    for (modes in listOf(emptyList(), listOf(null, "gzip"), listOf("gzip", "gzip", null), listOf(null, null))) {
      assertThrows(IllegalArgumentException::class.java) { validateTransferModes(modes) }
    }
  }
}
