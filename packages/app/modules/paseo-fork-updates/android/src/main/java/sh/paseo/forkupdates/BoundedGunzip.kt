package sh.paseo.forkupdates

import java.io.InputStream
import java.io.OutputStream
import java.util.zip.GZIPInputStream

// The `.gz` sidecar is unsigned, so inflation stops past the signed APK size rather than
// filling the disk. GZIPInputStream checks the trailer CRC and length, and throws on
// truncated or corrupt input; the caller still hashes and verifies what was written.
internal fun gunzipBounded(input: InputStream, output: OutputStream, maxBytes: Long): Long {
  GZIPInputStream(input, 64 * 1024).use { gzip ->
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val count = gzip.read(buffer)
      if (count < 0) return total
      total += count
      require(total <= maxBytes) { "Decompressed APK exceeds the signed release size." }
      output.write(buffer, 0, count)
    }
  }
}
