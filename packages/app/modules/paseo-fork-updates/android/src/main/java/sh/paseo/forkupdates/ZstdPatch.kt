package sh.paseo.forkupdates

import com.github.luben.zstd.ZstdDecompressCtx
import com.github.luben.zstd.ZstdDictDecompress
import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.READ
import java.nio.file.StandardOpenOption.TRUNCATE_EXISTING
import java.nio.file.StandardOpenOption.WRITE

// Rebuilds an APK from a `zstd --patch-from=<base>` delta, using the installed APK as base.
// The delta is unsigned, so the output is mapped at exactly the signed APK size and decoded
// in one pass: zstd can't write past it, and a short result is rejected. A wrong base fails
// the frame checksum; the caller still hashes and verifies what was written. One-shot
// decoding needs no window buffer, unlike streaming, which allocates up to the APK size.
internal fun applyZstdPatch(base: File, delta: File, output: File, expectedBytes: Long) {
  require(expectedBytes in 1..Int.MAX_VALUE) { "Signed APK size is out of range." }
  require(delta.length() in 1 until expectedBytes) { "APK delta size is out of range." }
  FileChannel.open(base.toPath(), READ).use { baseChannel ->
    FileChannel.open(delta.toPath(), READ).use { deltaChannel ->
      FileChannel.open(output.toPath(), READ, WRITE, CREATE, TRUNCATE_EXISTING).use { outputChannel ->
        val baseBytes = baseChannel.map(FileChannel.MapMode.READ_ONLY, 0, baseChannel.size())
        val deltaBytes = deltaChannel.map(FileChannel.MapMode.READ_ONLY, 0, deltaChannel.size())
        val outputBytes = outputChannel.map(FileChannel.MapMode.READ_WRITE, 0, expectedBytes)
        val written = ZstdDictDecompress(baseBytes, true).use { dictionary ->
          ZstdDecompressCtx().use { context ->
            context.loadDict(dictionary)
            context.decompressDirectByteBuffer(
              outputBytes, 0, expectedBytes.toInt(), deltaBytes, 0, deltaBytes.limit())
          }
        }
        require(written.toLong() == expectedBytes) { "Patched APK is smaller than the signed release size." }
        outputBytes.force()
      }
    }
  }
}
