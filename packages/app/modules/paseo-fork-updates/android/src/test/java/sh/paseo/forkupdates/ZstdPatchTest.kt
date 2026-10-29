package sh.paseo.forkupdates

import com.github.luben.zstd.ZstdException
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class ZstdPatchTest {
  // Mirrors make-zstd-patch-fixture.mjs, which made the committed delta from these bytes.
  private fun pattern(start: Int, length: Int) = ByteArray(length) { i -> ((start + i) * 0x9e3779b1.toInt() ushr 24).toByte() }
  private val base = pattern(0, 200_000)
  private val target = (base.copyOfRange(0, 50_000) + pattern(1_000_000, 1_000) + base.copyOfRange(50_000, base.size))
    .also { for (i in 120_000 until 121_000) it[i] = (it[i].toInt() xor 0x5a).toByte() }
  private val fixture = javaClass.getResourceAsStream("zstd-patch-fixture.zst")!!.use { it.readBytes() }

  private val work = Files.createTempDirectory("zstd-patch").toFile()
  @After fun cleanUp() { work.deleteRecursively() }

  private fun file(name: String, bytes: ByteArray) = File(work, name).also { it.writeBytes(bytes) }
  private fun patch(baseBytes: ByteArray = base, delta: ByteArray = fixture, expectedBytes: Long = target.size.toLong()): ByteArray {
    val output = File(work, "out")
    applyZstdPatch(file("base", baseBytes), file("delta", delta), output, expectedBytes)
    return output.readBytes()
  }

  @Test fun rebuildsTheTargetFromTheBase() {
    assertArrayEquals(target, patch())
  }

  @Test fun rejectsOutputThatIsNotTheSignedSize() {
    assertThrows(ZstdException::class.java) { patch(expectedBytes = target.size - 1L) }
    val error = assertThrows(IllegalArgumentException::class.java) { patch(expectedBytes = target.size + 1L) }
    assertTrue(error.message!!.contains("smaller"))
  }

  @Test fun rejectsAWrongBase() {
    val otherBase = base.copyOf().also { it[100_000] = (it[100_000] + 1).toByte() }
    assertThrows(ZstdException::class.java) { patch(baseBytes = otherBase) }
  }

  @Test fun rejectsATruncatedDelta() {
    assertThrows(ZstdException::class.java) { patch(delta = fixture.copyOf(fixture.size - 8)) }
  }
}
