package sh.paseo.forkupdates

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.zip.GZIPOutputStream
import kotlin.random.Random
import org.junit.Assert.*
import org.junit.Test

class BoundedGunzipTest {
  // Random bytes repeated four times: compressible, but spans many inflate buffers.
  private val apk = Random(7).nextBytes(100_000).let { block -> block + block + block + block }
  private val gzip = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write(apk) } }.toByteArray()

  private fun gunzip(input: ByteArray, maxBytes: Long): ByteArray {
    val output = ByteArrayOutputStream()
    assertEquals(gunzipBounded(ByteArrayInputStream(input), output, maxBytes), output.size().toLong())
    return output.toByteArray()
  }

  @Test fun inflatesExactlyTheSignedSize() {
    assertArrayEquals(apk, gunzip(gzip, apk.size.toLong()))
  }

  @Test fun stopsOncePastTheSignedSize() {
    val error = assertThrows(IllegalArgumentException::class.java) { gunzip(gzip, apk.size - 1L) }
    assertTrue(error.message!!.contains("exceeds"))
  }

  @Test fun rejectsTruncatedAndCorruptInput() {
    assertThrows(IOException::class.java) { gunzip(gzip.copyOf(gzip.size / 2), apk.size.toLong()) }
    // Flips a CRC byte in the trailer, so only the integrity check can catch it.
    val corrupt = gzip.copyOf().also { it[it.size - 6] = (it[it.size - 6] + 1).toByte() }
    assertThrows(IOException::class.java) { gunzip(corrupt, apk.size.toLong()) }
  }
}
