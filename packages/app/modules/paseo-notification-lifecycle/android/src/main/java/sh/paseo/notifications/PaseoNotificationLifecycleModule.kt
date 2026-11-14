package sh.paseo.notifications

import android.content.Context
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.Exceptions
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.presentation.builders.ExpoNotificationBuilder
import expo.modules.notifications.notifications.triggers.ChannelAwareTrigger
import expo.modules.notifications.service.delegates.SharedPreferencesNotificationCategoriesStore
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private fun JSONObject.event(): LifecycleEvent {
  require(getInt("v") == 1)
  fun identity(key: String) = getString(key).also { require(it.isNotEmpty() && it.length <= 512) }
  fun uuid(key: String) = identity(key).also { require(UUID.fromString(it).toString() == it.lowercase()) }
  val operation = getString("operation").also { require(it == "alert" || it == "resolve") }
  val lane = getString("lane").also { require(it == "attention" || it == "question") }
  val preview = optJSONObject("preview")
  val reason = if (operation == "alert") getString("reason") else ""
  if (operation == "alert") {
    require(reason in listOf("finished", "permission"))
    require((reason == "permission") == (lane == "question"))
    require(preview != null && preview.getString("title").length <= 220 && preview.getString("body").length <= 1000)
  }
  val issuedAt = getLong("issuedAt").also { require(it >= 0 && it <= Long.MAX_VALUE - LIFETIME_MS - SKEW_MS) }
  val expiresAt = getLong("expiresAt").also { require(it > issuedAt && it - issuedAt <= LIFETIME_MS) }
  val tapPreview = optJSONObject("tapPreview")?.toString()?.also { require(it.length <= 4000) }
  return LifecycleEvent(identity("serverId"), identity("agentId"), uuid("registrationId"), uuid("episodeId"),
    lane, issuedAt, expiresAt, operation, reason, preview?.optString("title") ?: "",
    preview?.optString("body") ?: "", if (has("workspaceId")) identity("workspaceId") else null, tapPreview)
}
private fun LifecycleEvent.json(): JSONObject = JSONObject().apply {
  put("v", 1); put("serverId", serverId); put("agentId", agentId)
  put("registrationId", registrationId); put("episodeId", episodeId); put("lane", lane)
  put("issuedAt", issuedAt); put("expiresAt", expiresAt); put("operation", operation)
  if (operation == "alert") {
    put("reason", reason); put("preview", JSONObject().put("title", title).put("body", body))
    workspaceId?.let { put("workspaceId", it) }
    tapPreview?.let { put("tapPreview", JSONObject(it)) }
  }
}

private class PreferencesStore(context: Context) : LifecycleStore {
  private val prefs = context.getSharedPreferences("paseo-notification-lifecycle-v1", Context.MODE_PRIVATE)
  override fun read(): LifecycleState {
    val raw = prefs.getString("state", null) ?: return LifecycleState()
    val json = JSONObject(raw)
    val hosts = json.getJSONObject("hosts")
    val blocked = json.getJSONObject("blockedUntil")
    val entries = json.getJSONArray("entries")
    return LifecycleState(
      hosts.keys().asSequence().associateWith { hosts.getString(it) },
      (0 until entries.length()).associate {
        val row = entries.getJSONObject(it)
        val event = row.getJSONObject("event").event()
        event.key to LifecycleEntry(event, row.getString("status"))
      },
      blocked.keys().asSequence().associateWith { blocked.getLong(it) },
    )
  }
  override fun write(state: LifecycleState) {
    val entries = JSONArray()
    state.entries.values.forEach { entries.put(JSONObject().put("event", it.event.json()).put("status", it.status)) }
    val raw = JSONObject().put("hosts", JSONObject(state.hosts)).put("blockedUntil", JSONObject(state.blockedUntil))
      .put("entries", entries).toString()
    check(prefs.edit().putString("state", raw).commit()) { "Notification lifecycle persistence failed" }
  }
}

class PaseoNotificationLifecycleModule : Module() {
  private fun owner(): LifecycleOwner<android.app.Notification> {
    val context = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()
    return LifecycleOwner(PreferencesStore(context), object : LifecycleEffects<android.app.Notification> {
      override fun build(event: LifecycleEvent): android.app.Notification = runBlocking {
        val data = JSONObject().put("serverId", event.serverId).put("agentId", event.agentId)
          .put("reason", event.reason).put("paseoLifecycle", event.json())
        event.workspaceId?.let { data.put("workspaceId", it) }
        event.tapPreview?.let { data.put("preview", JSONObject(it)) }
        val content = NotificationContent.Builder().setTitle(event.title).setText(event.body)
          .setBody(data).setAutoDismiss(true).build()
        val request = NotificationRequest(event.key, content, ChannelAwareTrigger("default"))
        ExpoNotificationBuilder(context, Notification(request), SharedPreferencesNotificationCategoriesStore(context))
          .build().also { it.flags = it.flags or android.app.Notification.FLAG_ONLY_ALERT_ONCE }
      }
      override fun post(key: String, notification: android.app.Notification) {
        NotificationManagerCompat.from(context).notify(key, 0, notification)
        Log.i("PaseoPushLifecycle", "posted key=$key")
      }
      override fun cancel(key: String) {
        NotificationManagerCompat.from(context).cancel(key, 0)
        Log.i("PaseoPushLifecycle", "canceled key=$key")
      }
      override fun visible() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
    })
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoNotificationLifecycle")
    AsyncFunction("prepareHost") { serverId: String ->
      require(serverId.isNotEmpty() && serverId.length <= 512)
      owner().prepare(serverId) { UUID.randomUUID().toString() }
    }
    AsyncFunction("observed") { serverId: String, registrationId: String -> owner().observed(serverId, registrationId) }
    AsyncFunction("reconcile") { serverId: String, registrationId: String, observed: List<String>, active: List<String> ->
      owner().reconcile(serverId, registrationId, observed.toSet(), active.toSet())
    }
    AsyncFunction("registerHost") { serverId: String, registrationId: String? ->
      require(serverId.isNotEmpty() && serverId.length <= 512)
      registrationId?.let { require(UUID.fromString(it).toString() == it.lowercase()) }
      owner().register(serverId, registrationId)
    }
    AsyncFunction("apply") { raw: String ->
      val event = JSONObject(raw).event()
      owner().apply(event)
      Log.i("PaseoPushLifecycle", "processed operation=${event.operation} key=${event.key}")
    }
    AsyncFunction("recover") { owner().recover() }
  }
}
