package sh.paseo.forkupdates

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private const val MAX_APK_BYTES = 250L * 1024L * 1024L
private const val MAX_REDIRECTS = 5
private const val DOWNLOAD_POLL_MS = 500L
private const val DOWNLOAD_DIRECTORY = "fork-updates"
private const val GZIP_SUFFIX = ".gz"
private const val LOG_TAG = "PaseoForkUpdates"
private val forkVersion = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")
// Maps a transfer file name (the staged APK name, plus the sidecar suffix for a `.gz` or a
// delta) to its system DownloadManager id, so a download that outlived the app process is
// resumed rather than restarted, and one kind of transfer is never adopted as another.
private const val DOWNLOAD_PREFERENCES = "sh.paseo.forkupdates.downloads"
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

    Function("getInstalledVersion") {
      requireNotNull(currentPackageInfo().versionName) { "Installed app version is unavailable." }
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

    AsyncFunction("downloadAndVerifyApk") Coroutine {
        transfers: List<ApkTransfer>,
        fileName: String,
        expectedBytes: Long,
        expectedSha256: String,
        expectedPackage: String,
        expectedVersionCode: Int,
        expectedVersion: String,
        expectedCertificateSha256: String,
      ->
      require(fileName.matches(Regex("[A-Za-z0-9._-]+\\.apk"))) { "APK filename is invalid." }
      require(expectedBytes in 1..MAX_APK_BYTES) { "APK size is outside the allowed range." }
      require(transfers.isNotEmpty() && transfers.last().compression == null) {
        "APK transfers must end with the signed APK."
      }
      require(transfers.map { it.compression }.toSet().size == transfers.size) { "APK transfers are duplicated." }
      transfers.forEach { validateTransfer(it, expectedBytes) }
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
      val stagedIsValid = withContext(Dispatchers.IO) {
        destination.isFile && destination.length() == expectedBytes &&
          runCatching {
            require(hashFile(destination).equals(expectedSha256, ignoreCase = true)) {
              "Staged APK hash does not match the signed release manifest."
            }
            verifyApk(destination, expectedPackage, expectedVersionCode, expectedVersion, expectedCertificateSha256)
          }
            .isSuccess
      }
      if (stagedIsValid) {
        destination.absolutePath
      } else {
        destination.delete()
        // Sidecars are unsigned, so any failure short of a cancel (missing asset, size
        // mismatch, wrong base, corrupt data, wrong bytes) moves on to the next transfer.
        val names = transfers.map { "$fileName${transferSuffix(it)}" }
        firstVerifiedTransfer(names, ::hasLiveDownload) { index ->
          val transfer = transfers[index]
          val mode = transfer.compression ?: "apk"
          Log.i(LOG_TAG, "Fetching $expectedVersion as $mode (${transfer.bytes ?: expectedBytes} bytes)")
          runCatching {
            downloadApk(
              transfer,
              names[index],
              destination,
              File(directory, "$fileName.part"),
              expectedBytes,
              expectedSha256,
              expectedPackage,
              expectedVersionCode,
              expectedVersion,
              expectedCertificateSha256,
            )
          }
            .onSuccess { Log.i(LOG_TAG, "Verified $expectedVersion from $mode") }
            .onFailure { Log.w(LOG_TAG, "Fetching $expectedVersion as $mode failed: $it") }
            .getOrThrow()
        }
      }
    }

    AsyncFunction("findVerifiedStagedApk") {
        fileName: String,
        expectedBytes: Long,
        expectedSha256: String,
        expectedPackage: String,
        expectedVersionCode: Int,
        expectedVersion: String,
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
            verifyApk(apk, expectedPackage, expectedVersionCode, expectedVersion, expectedCertificateSha256)
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
        expectedVersion: String,
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
      verifyApk(apk, expectedPackage, expectedVersionCode, expectedVersion, expectedCertificateSha256)
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

  // The system DownloadManager owns the transfer: it keeps going while Paseo is backgrounded
  // or frozen, retries with byte ranges after network loss, and outlives the app process.
  // Integrity does not depend on it; the result is hashed and its signer checked here.
  // A gzip transfer is inflated, and a delta applied to the installed APK, into the private
  // part file before those checks.
  private suspend fun downloadApk(
    transfer: ApkTransfer,
    transferName: String,
    destination: File,
    part: File,
    expectedBytes: Long,
    expectedSha256: String,
    expectedPackage: String,
    expectedVersionCode: Int,
    expectedVersion: String,
    expectedCertificateSha256: String,
  ): String {
    val context = requireNotNull(appContext.reactContext)
    val manager = requireNotNull(context.getSystemService(DownloadManager::class.java)) {
      "Android download service is unavailable."
    }
    val preferences = context.getSharedPreferences(DOWNLOAD_PREFERENCES, Context.MODE_PRIVATE)
    val transferBytes = transfer.bytes ?: expectedBytes
    // Checked before anything downloads, and again in the chain's own order: the delta only
    // rebuilds the release from the exact APK it was made against.
    val base = if (transfer.compression == "zstd-patch") installedBase(requireNotNull(transfer.baseVersion)) else null
    val downloadId = existingDownload(manager, preferences, transferName)
      ?: enqueueDownload(context, manager, preferences, transfer.url, transferName, transferBytes, expectedVersion)
    val path = try {
      val downloaded = awaitDownload(context, manager, downloadId, transferBytes)
      withContext(Dispatchers.IO) {
        try {
          when (transfer.compression) {
            "gzip" -> downloaded.inputStream().use { input ->
              part.outputStream().use { output -> gunzipBounded(input, output, expectedBytes) }
            }
            "zstd-patch" -> applyZstdPatch(requireNotNull(base), downloaded, part, expectedBytes)
            else -> Files.copy(downloaded.toPath(), part.toPath(), REPLACE_EXISTING)
          }
          require(part.length() == expectedBytes) { "APK download is incomplete." }
          require(hashFile(part).equals(expectedSha256, ignoreCase = true)) {
            "APK hash does not match the signed release manifest."
          }
          verifyApk(part, expectedPackage, expectedVersionCode, expectedVersion, expectedCertificateSha256)
          Files.move(part.toPath(), destination.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
        } catch (error: Throwable) {
          part.delete()
          throw error
        }
        destination.parentFile?.listFiles { file -> file.name.startsWith("fork-v") && file.name.endsWith(".apk") && file != destination }
          ?.forEach(File::delete)
        destination.absolutePath
      }
    } catch (error: CancellationException) {
      // The JS runtime went away; leave the transfer running for the next attempt to adopt.
      throw error
    } catch (error: Throwable) {
      forgetDownload(manager, preferences, transferName)
      throw error
    }
    forgetDownload(manager, preferences, transferName)
    return path
  }

  // The installed APK is the delta base only when it is the release the delta was made from.
  // Sideloaded fork installs are a single APK, byte for byte the signed release asset.
  private fun installedBase(baseVersion: String): File {
    val context = requireNotNull(appContext.reactContext)
    require(currentPackageInfo().versionName == baseVersion) { "Installed app is not the delta base release." }
    val info = context.applicationInfo
    require(info.splitSourceDirs.isNullOrEmpty()) { "Installed app is split, so it can't be a delta base." }
    return File(info.sourceDir).also { require(it.canRead()) { "Installed APK is unreadable." } }
  }

  private fun hasLiveDownload(fileName: String): Boolean {
    val context = requireNotNull(appContext.reactContext)
    val manager = context.getSystemService(DownloadManager::class.java) ?: return false
    val preferences = context.getSharedPreferences(DOWNLOAD_PREFERENCES, Context.MODE_PRIVATE)
    return existingDownload(manager, preferences, fileName) != null
  }

  private fun existingDownload(
    manager: DownloadManager,
    preferences: android.content.SharedPreferences,
    fileName: String,
  ): Long? {
    val id = preferences.getLong(fileName, -1L).takeIf { it >= 0 } ?: return null
    val row = queryDownload(manager, id)
    if (row == null || row.status == DownloadManager.STATUS_FAILED) {
      forgetDownload(manager, preferences, fileName)
      return null
    }
    return id
  }

  private suspend fun enqueueDownload(
    context: Context,
    manager: DownloadManager,
    preferences: android.content.SharedPreferences,
    sourceUrl: String,
    fileName: String,
    transferBytes: Long,
    expectedVersion: String,
  ): Long {
    // Only one update downloads at a time; drop transfers for superseded releases.
    preferences.all.keys.forEach { forgetDownload(manager, preferences, it) }
    val resolvedUrl = withContext(Dispatchers.IO) { resolveDownloadUrl(sourceUrl, transferBytes) }
    requireNotNull(context.getExternalFilesDir(DOWNLOAD_DIRECTORY)) {
      "Shared update storage is unavailable."
    }.listFiles()?.forEach(File::delete)
    val request = DownloadManager.Request(Uri.parse(resolvedUrl))
      .setTitle("Paseo $expectedVersion")
      .setMimeType("application/octet-stream")
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
      .setDestinationInExternalFilesDir(context, DOWNLOAD_DIRECTORY, "$fileName.part")
      .addRequestHeader("User-Agent", "Paseo-Android-Updater")
      .addRequestHeader("Accept", "application/octet-stream")
    val id = manager.enqueue(request)
    preferences.edit().putLong(fileName, id).apply()
    return id
  }

  private suspend fun awaitDownload(
    context: Context,
    manager: DownloadManager,
    id: Long,
    transferBytes: Long,
  ): File {
    var lastReported = -1L
    while (true) {
      val row = queryDownload(manager, id) ?: throw DownloadCanceledException()
      require(row.totalBytes <= 0 || row.totalBytes == transferBytes) {
        "APK download size does not match the release."
      }
      require(row.downloadedBytes <= transferBytes) { "APK download exceeds the release size." }
      if (row.downloadedBytes != lastReported) {
        sendEvent(
          "onDownloadProgress",
          mapOf("downloadedBytes" to row.downloadedBytes.coerceAtLeast(0), "totalBytes" to transferBytes),
        )
        lastReported = row.downloadedBytes
      }
      when (row.status) {
        DownloadManager.STATUS_SUCCESSFUL -> {
          val directory = requireNotNull(context.getExternalFilesDir(DOWNLOAD_DIRECTORY)).canonicalFile
          val file = File(requireNotNull(row.localUri?.let { Uri.parse(it).path }) { "APK download has no file." }).canonicalFile
          require(file.parentFile == directory && file.isFile) { "APK download landed outside update storage." }
          return file
        }
        DownloadManager.STATUS_FAILED -> throw IllegalArgumentException("APK download failed (reason ${row.reason}).")
      }
      delay(DOWNLOAD_POLL_MS)
    }
  }

  private fun forgetDownload(manager: DownloadManager, preferences: android.content.SharedPreferences, fileName: String) {
    val id = preferences.getLong(fileName, -1L)
    if (id >= 0) manager.remove(id)
    preferences.edit().remove(fileName).apply()
  }

  private fun currentPackageInfo(): PackageInfo {
    val context = requireNotNull(appContext.reactContext)
    return context.packageManager.getPackageInfo(context.packageName, 0)
  }

  private fun verifyApk(file: File, packageName: String, versionCode: Int, version: String, certificateSha256: String) {
    val context = requireNotNull(appContext.reactContext)
    require(packageName == "sh.paseo.iexalt") { "APK package is unsupported." }
    val info = context.packageManager.getPackageArchiveInfo(
      file.absolutePath,
      PackageManager.GET_SIGNING_CERTIFICATES,
    ) ?: throw IllegalArgumentException("Downloaded file is not a readable APK.")
    require(info.packageName == packageName) { "APK package does not match this app." }
    require(info.longVersionCode == versionCode.toLong()) { "APK version does not match the release manifest." }
    require(info.versionName == version) { "APK semver does not match the release manifest." }
    val signers = info.signingInfo?.apkContentsSigners.orEmpty()
    require(signers.size == 1) { "APK must have exactly one approved signer." }
    val signerHash = MessageDigest.getInstance("SHA-256").digest(signers.single().toByteArray()).toHex()
    require(signerHash.equals(certificateSha256, ignoreCase = true)) {
      "APK signer does not match the approved Paseo fork certificate."
    }
  }
}

// One way to fetch the APK: the APK itself, its `.gz` sidecar, or a `zstd --patch-from` delta
// against the installed `baseVersion`; sidecars carry their own size. A record because Expo
// coroutine functions take at most eight arguments.
class ApkTransfer : Record {
  @Field val url: String = ""
  @Field val bytes: Long? = null
  @Field val compression: String? = null
  @Field val baseVersion: String? = null
}

private fun transferSuffix(transfer: ApkTransfer): String = when (transfer.compression) {
  "gzip" -> GZIP_SUFFIX
  "zstd-patch" -> ".delta-from-${transfer.baseVersion}.zst"
  else -> ""
}

private fun validateTransfer(transfer: ApkTransfer, expectedBytes: Long) {
  val bytes = transfer.bytes
  when (transfer.compression) {
    null -> require(bytes == null && transfer.baseVersion == null) { "APK transfer size is invalid." }
    "gzip", "zstd-patch" -> require(bytes != null && bytes in 1 until expectedBytes) { "APK transfer size is invalid." }
    else -> throw IllegalArgumentException("APK compression is unsupported.")
  }
  if (transfer.compression == "zstd-patch") {
    require(transfer.baseVersion?.matches(forkVersion) == true) { "APK delta base version is invalid." }
  } else {
    require(transfer.baseVersion == null) { "APK transfer base version is invalid." }
  }
  require(transfer.url.endsWith(".apk${transferSuffix(transfer)}")) { "APK transfer URL is invalid." }
}

private class DownloadRow(
  val status: Int,
  val reason: Int,
  val downloadedBytes: Long,
  val totalBytes: Long,
  val localUri: String?,
)

private fun queryDownload(manager: DownloadManager, id: Long): DownloadRow? =
  manager.query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
    if (!cursor.moveToFirst()) {
      null
    } else {
      DownloadRow(
        status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)),
        reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)),
        downloadedBytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
        totalBytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)),
        localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI)),
      )
    }
  }

// Walks the approved redirect chain here so DownloadManager starts at an approved host.
private fun resolveDownloadUrl(sourceUrl: String, transferBytes: Long): String {
  val connection = openAllowedConnection(sourceUrl)
  try {
    require(connection.responseCode == HttpURLConnection.HTTP_OK) {
      "APK download returned HTTP ${connection.responseCode}."
    }
    val declaredLength = connection.contentLengthLong
    require(declaredLength == -1L || declaredLength == transferBytes) {
      "APK download size does not match the release."
    }
    return connection.url.toString()
  } finally {
    connection.disconnect()
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
