package sh.paseo.forkupdates

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred

internal const val LOG_TAG = "PaseoForkUpdates"

internal fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte) }

/** How a session install ended without replacing this process. */
class InstallOutcome(val status: Int, val message: String?) {
  val canceled: Boolean get() = status == PackageInstaller.STATUS_FAILURE_ABORTED
}

// Installs a verified APK through a PackageInstaller session rather than the system installer
// screens. With UPDATE_PACKAGES_WITHOUT_USER_ACTION, Android 12+ lets Paseo update itself without
// asking; Android 16 did so even while Google's installer was the installer of record. A device
// that still wants confirmation gets Android's screen instead. A successful update kills this
// process, so the caller only ever sees failures. Paseo can't
// reopen itself afterwards: Android 16 blocks the new process from starting an activity, from a
// status receiver and from an activity PendingIntent the installer sends alike.
internal object SessionInstall {
  private const val ACTION_STATUS = "sh.paseo.forkupdates.INSTALL_STATUS"
  private val waiters = ConcurrentHashMap<Int, CompletableDeferred<InstallOutcome>>()

  suspend fun install(context: Context, apk: File, expectedSha256: String): InstallOutcome {
    val installer = context.packageManager.packageInstaller
    // A session left by an earlier attempt, such as a confirmation the user walked away from,
    // would hold its copy of the APK until it expires, and its caller would wait forever.
    waiters.keys.toList().forEach { waiters.remove(it)?.complete(InstallOutcome(PackageInstaller.STATUS_FAILURE_ABORTED, null)) }
    installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(context.packageName)
      setSize(apk.length())
      setInstallReason(PackageManager.INSTALL_REASON_USER)
      if (Build.VERSION.SDK_INT >= 31) {
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
      }
    }
    val sessionId = installer.createSession(params)
    val outcome = CompletableDeferred<InstallOutcome>()
    waiters[sessionId] = outcome
    try {
      installer.openSession(sessionId).use { session ->
        // Hashes the bytes the session receives, so the file can't change between the
        // caller's checks and the install.
        val digest = MessageDigest.getInstance("SHA-256")
        session.openWrite("base.apk", 0, apk.length()).use { output ->
          apk.inputStream().use { input ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              digest.update(buffer, 0, count)
              output.write(buffer, 0, count)
            }
          }
          session.fsync(output)
        }
        require(digest.digest().toHex().equals(expectedSha256, ignoreCase = true)) {
          "Staged APK no longer matches the signed release manifest."
        }
        Log.i(LOG_TAG, "Committing install session $sessionId")
        session.commit(statusSender(context, sessionId))
      }
    } catch (error: Throwable) {
      waiters.remove(sessionId)
      runCatching { installer.abandonSession(sessionId) }
      throw error
    }
    return try {
      outcome.await()
    } finally {
      waiters.remove(sessionId)
    }
  }

  fun onStatus(context: Context, intent: Intent) {
    if (intent.action != ACTION_STATUS) return
    val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
    Log.i(LOG_TAG, "Install session $sessionId status $status ${message.orEmpty()}")
    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
        if (confirm == null) {
          waiters.remove(sessionId)?.complete(InstallOutcome(PackageInstaller.STATUS_FAILURE, "No confirmation screen."))
        } else {
          context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      }
      PackageInstaller.STATUS_SUCCESS -> Unit
      else -> waiters.remove(sessionId)?.complete(InstallOutcome(status, message))
    }
  }

  private fun statusSender(context: Context, sessionId: Int) =
    PendingIntent.getBroadcast(
      context,
      sessionId,
      Intent(context, InstallStatusReceiver::class.java).setAction(ACTION_STATUS),
      // Mutable so the installer can attach the status extras.
      PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
    ).intentSender
}

class InstallStatusReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) = SessionInstall.onStatus(context, intent)
}
