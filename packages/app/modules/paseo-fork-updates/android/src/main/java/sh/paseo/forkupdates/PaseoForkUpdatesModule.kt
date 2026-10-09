package sh.paseo.forkupdates

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest

private const val MAX_APK_BYTES = 250L * 1024L * 1024L
private const val MAX_REDIRECTS = 5
private val allowedHosts = setOf(
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "githubusercontent.com",
)

class PaseoForkUpdatesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoForkUpdates")
    Events("onDownloadProgress")

    Function("getInstalledVersionCode") {
      currentPackageInfo().longVersionCode.toInt()
    }

    Function("canInstallUnknownApps") {
      android.os.Build.VERSION.SDK_INT < 26 || appContext.reactContext
        ?.packageManager?.canRequestPackageInstalls() == true
    }

    AsyncFunction("openUnknownSourcesSettings") {
      val context = requireNotNull(appContext.reactContext)
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}"),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    AsyncFunction("fetchText") { sourceUrl: String, maxBytes: Int ->
      require(maxBytes in 1..1_048_576) { "Response size limit is invalid." }
      val connection = openAllowedConnection(sourceUrl)
      try {
        require(connection.responseCode == HttpURLConnection.HTTP_OK) {
          "GitHub returned HTTP ${connection.responseCode}."
        }
        val declaredLength = connection.contentLengthLong
        require(declaredLength == -1L || declaredLength <= maxBytes) {
          "GitHub response exceeds the size limit."
        }
        val bytes = connection.inputStream.use { input ->
          val output = java.io.ByteArrayOutputStream(minOf(maxBytes, 8192))
          val buffer = ByteArray(8192)
          var total = 0
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            require(total <= maxBytes) { "GitHub response exceeds the size limit." }
            output.write(buffer, 0, count)
          }
          output.toByteArray()
        }
        Charsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes))
          .toString()
      } finally {
        connection.disconnect()
      }
    }

    AsyncFunction("downloadAndVerifyApk") {
        sourceUrl: String,
        fileName: String,
        expectedBytes: Long,
        expectedSha256: String,
        expectedPackage: String,
        expectedVersionCode: Int,
        expectedCertificateSha256: String,
      ->
      require(fileName.matches(Regex("[A-Za-z0-9._-]+\\.apk"))) { "APK filename is invalid." }
      require(expectedBytes in 1..MAX_APK_BYTES) { "APK size is outside the allowed range." }
      require(expectedSha256.matches(Regex("[a-fA-F0-9]{64}"))) { "APK hash is invalid." }
      require(expectedCertificateSha256.matches(Regex("[a-fA-F0-9]{64}"))) {
        "APK certificate hash is invalid."
      }
      require(expectedPackage == "sh.paseo.iexalt") { "APK package is unsupported." }
      require(expectedVersionCode > currentPackageInfo().longVersionCode) {
        "APK version is not newer than the installed app."
      }

      val directory = File(requireNotNull(appContext.reactContext).filesDir, "fork-updates")
      require(directory.isDirectory || directory.mkdirs()) { "Could not prepare private update storage." }
      val destination = File(directory, fileName)
      val stagedIsValid = destination.isFile && destination.length() == expectedBytes &&
        runCatching {
          require(hashFile(destination).equals(expectedSha256, ignoreCase = true)) {
            "Staged APK hash does not match the signed release manifest."
          }
          verifyApk(destination, expectedPackage, expectedVersionCode, expectedCertificateSha256)
        }
          .isSuccess
      if (stagedIsValid) {
        destination.absolutePath
      } else {
        destination.delete()
        downloadApk(
          sourceUrl,
          destination,
          File(directory, "$fileName.part"),
          expectedBytes,
          expectedSha256,
          expectedPackage,
          expectedVersionCode,
          expectedCertificateSha256,
        )
      }
    }

    AsyncFunction("findVerifiedStagedApk") {
        fileName: String,
        expectedBytes: Long,
        expectedSha256: String,
        expectedPackage: String,
        expectedVersionCode: Int,
        expectedCertificateSha256: String,
      ->
      require(fileName.matches(Regex("[A-Za-z0-9._-]+\\.apk"))) { "APK filename is invalid." }
      require(expectedVersionCode > currentPackageInfo().longVersionCode) {
        "APK version is not newer than the installed app."
      }
      val directory = File(requireNotNull(appContext.reactContext).filesDir, "fork-updates").canonicalFile
      val apk = File(directory, fileName).canonicalFile
      if (apk.parentFile != directory || !apk.isFile || apk.length() != expectedBytes) {
        null
      } else {
        if (!hashFile(apk).equals(expectedSha256, ignoreCase = true)) {
          null
        } else {
          try {
            verifyApk(apk, expectedPackage, expectedVersionCode, expectedCertificateSha256)
            apk.absolutePath
          } catch (_: IllegalArgumentException) {
            null
          }
        }
      }
    }

    AsyncFunction("openInstaller") {
        absolutePath: String,
        expectedBytes: Long,
        expectedSha256: String,
        expectedPackage: String,
        expectedVersionCode: Int,
        expectedCertificateSha256: String,
      ->
      val context = requireNotNull(appContext.reactContext)
      val directory = File(context.filesDir, "fork-updates").canonicalFile
      val apk = File(absolutePath).canonicalFile
      require(apk.parentFile == directory && apk.isFile) { "Verified APK is not in private update storage." }
      require(expectedVersionCode > currentPackageInfo().longVersionCode) {
        "APK version is not newer than the installed app."
      }
      require(apk.length() == expectedBytes && hashFile(apk).equals(expectedSha256, ignoreCase = true)) {
        "Staged APK no longer matches the signed release manifest."
      }
      verifyApk(apk, expectedPackage, expectedVersionCode, expectedCertificateSha256)
      val authority = "${context.packageName}.FileSystemFileProvider"
      require(context.packageManager.resolveContentProvider(authority, 0) != null) {
        "Expo FileSystem content provider is unavailable."
      }
      val contentUri = FileProvider.getUriForFile(context, authority, apk)
      val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
    }
  }

  private fun downloadApk(
    sourceUrl: String,
    destination: File,
    part: File,
    expectedBytes: Long,
    expectedSha256: String,
    expectedPackage: String,
    expectedVersionCode: Int,
    expectedCertificateSha256: String,
  ): String {
    part.delete()
    try {
      val connection = openAllowedConnection(sourceUrl)
      try {
        require(connection.responseCode == HttpURLConnection.HTTP_OK) {
          "APK download returned HTTP ${connection.responseCode}."
        }
        val declaredLength = connection.contentLengthLong
        require(declaredLength == -1L || declaredLength == expectedBytes) {
          "APK download size does not match the signed release manifest."
        }
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        var lastProgressAt = 0L
        connection.inputStream.use { input ->
          FileOutputStream(part).use { fileOutput ->
            val output = fileOutput.buffered()
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              total += count
              require(total <= expectedBytes && total <= MAX_APK_BYTES) {
                "APK download exceeds the signed release size."
              }
              digest.update(buffer, 0, count)
              output.write(buffer, 0, count)
              if (total - lastProgressAt >= 512L * 1024L || total == expectedBytes) {
                sendEvent(
                  "onDownloadProgress",
                  mapOf("downloadedBytes" to total, "totalBytes" to expectedBytes),
                )
                lastProgressAt = total
              }
            }
            output.flush()
            fileOutput.fd.sync()
          }
        }
        require(total == expectedBytes) { "APK download is incomplete." }
        val actualHash = digest.digest().toHex()
        require(actualHash.equals(expectedSha256, ignoreCase = true)) {
          "APK hash does not match the signed release manifest."
        }
        verifyApk(part, expectedPackage, expectedVersionCode, expectedCertificateSha256)
        Files.move(part.toPath(), destination.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
        destination.parentFile?.listFiles { file -> file.name.endsWith(".apk") && file != destination }
          ?.forEach(File::delete)
        destination.absolutePath
      } finally {
        connection.disconnect()
      }
    } catch (error: Throwable) {
      part.delete()
      throw error
    }
  }

  private fun currentPackageInfo(): PackageInfo {
    val context = requireNotNull(appContext.reactContext)
    return context.packageManager.getPackageInfo(context.packageName, 0)
  }

  private fun verifyApk(file: File, packageName: String, versionCode: Int, certificateSha256: String) {
    val context = requireNotNull(appContext.reactContext)
    require(packageName == "sh.paseo.iexalt") { "APK package is unsupported." }
    val info = context.packageManager.getPackageArchiveInfo(
      file.absolutePath,
      PackageManager.GET_SIGNING_CERTIFICATES,
    ) ?: throw IllegalArgumentException("Downloaded file is not a readable APK.")
    require(info.packageName == packageName) { "APK package does not match this app." }
    require(info.longVersionCode == versionCode.toLong()) { "APK version does not match the release manifest." }
    val signers = info.signingInfo?.apkContentsSigners.orEmpty()
    require(signers.size == 1) { "APK must have exactly one approved signer." }
    val signerHash = MessageDigest.getInstance("SHA-256").digest(signers.single().toByteArray()).toHex()
    require(signerHash.equals(certificateSha256, ignoreCase = true)) {
      "APK signer does not match the approved Paseo fork certificate."
    }
  }
}

private fun openAllowedConnection(source: String): HttpURLConnection {
  var current = URI(source)
  repeat(MAX_REDIRECTS + 1) { redirect ->
    require(
      current.scheme == "https" && current.host in allowedHosts &&
        current.userInfo == null && (current.port == -1 || current.port == 443),
    ) { "Release URL or redirect host is not approved." }
    val connection = URL(current.toString()).openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = false
    connection.connectTimeout = 20_000
    connection.readTimeout = 30_000
    connection.setRequestProperty("Accept-Encoding", "identity")
    connection.setRequestProperty("User-Agent", "Paseo-Android-Updater")
    connection.setRequestProperty(
      "Accept",
      if (current.host == "api.github.com") "application/vnd.github+json" else "application/octet-stream",
    )
    if (current.host == "api.github.com") {
      connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
    }
    try {
      val code = connection.responseCode
      if (code in 300..399) {
        val location = connection.getHeaderField("Location")
        connection.disconnect()
        require(redirect < MAX_REDIRECTS && !location.isNullOrBlank()) { "Release redirect limit was exceeded." }
        current = current.resolve(location)
      } else {
        if (code !in 200..299) {
          connection.disconnect()
          throw IllegalArgumentException("Release server returned HTTP $code.")
        }
        return connection
      }
    } catch (error: Throwable) {
      connection.disconnect()
      throw error
    }
  }
  throw IllegalArgumentException("Release redirect limit was exceeded.")
}

private fun hashFile(file: File): String {
  val digest = MessageDigest.getInstance("SHA-256")
  file.inputStream().buffered().use { input ->
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      digest.update(buffer, 0, count)
    }
  }
  return digest.digest().toHex()
}

private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte) }
