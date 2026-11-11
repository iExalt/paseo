package sh.paseo.notifications

import java.security.MessageDigest

internal const val LIFETIME_MS = 86_400_000L
internal const val SKEW_MS = 300_000L
internal const val MAX_ENTRIES = 4096

internal data class LifecycleEvent(
  val serverId: String, val agentId: String, val registrationId: String,
  val episodeId: String, val lane: String, val issuedAt: Long, val expiresAt: Long,
  val operation: String, val reason: String = "", val title: String = "",
  val body: String = "", val workspaceId: String? = null, val tapPreview: String? = null,
) {
  val key: String get() {
    val identity = listOf(serverId, agentId, registrationId, episodeId, lane)
      .joinToString("") { "${it.length}:$it" }
    val digest = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
    return "paseo:lifecycle:v1:" + digest.joinToString("") { "%02x".format(it) }
  }
}
internal data class LifecycleEntry(val event: LifecycleEvent, val status: String)
internal data class LifecycleState(
  val hosts: Map<String, String> = emptyMap(),
  val entries: Map<String, LifecycleEntry> = emptyMap(),
  val blockedUntil: Map<String, Long> = emptyMap(),
)
internal interface LifecycleStore {
  fun read(): LifecycleState
  fun write(state: LifecycleState)
}
internal interface LifecycleEffects<T> {
  fun build(event: LifecycleEvent): T
  fun post(key: String, notification: T)
  fun cancel(key: String)
  fun visible(): Boolean
}

/** All instances in the app process share this lock, including headless React contexts. */
internal class LifecycleOwner<T>(
  private val store: LifecycleStore,
  private val effects: LifecycleEffects<T>,
  private val now: () -> Long = System::currentTimeMillis,
  private val lock: Any = processLock,
) {
  companion object { private val processLock = Any() }

  fun prepare(serverId: String, createId: () -> String): String = synchronized(lock) {
    store.read().hosts[serverId] ?: createId().also { register(serverId, it) }
  }

  fun observed(serverId: String, registrationId: String): List<String> = synchronized(lock) {
    store.read().entries.values.filter {
      it.event.serverId == serverId && it.event.registrationId == registrationId && it.status != "resolved"
    }.map { it.event.episodeId }
  }

  fun reconcile(serverId: String, registrationId: String, observed: Set<String>, active: Set<String>) = synchronized(lock) {
    val state = store.read()
    if (state.hosts[serverId] != registrationId) return@synchronized
    state.entries.values.filter {
      it.event.serverId == serverId && it.event.registrationId == registrationId &&
        it.event.episodeId in observed && it.event.episodeId !in active
    }.forEach { apply(it.event.copy(operation = "resolve")) }
  }

  fun register(serverId: String, registrationId: String?) = synchronized(lock) {
    val old = store.read()
    if (old.hosts[serverId] == registrationId) return@synchronized
    val hosts = old.hosts.toMutableMap().apply {
      if (registrationId == null) remove(serverId) else put(serverId, registrationId)
    }
    val affected = old.entries.filterValues { it.event.serverId == serverId }
    val entries = old.entries.toMutableMap()
    affected.forEach { (key, entry) -> entries[key] = entry.copy(status = "resolved") }
    store.write(old.copy(hosts = hosts, entries = entries))
    affected.keys.forEach(effects::cancel)
  }

  fun apply(event: LifecycleEvent) {
    val key = event.key
    val build = synchronized(lock) {
      val time = now()
      val old = store.read()
      if (old.hosts[event.serverId] != event.registrationId) return
      if (event.expiresAt <= event.issuedAt || event.expiresAt - event.issuedAt > LIFETIME_MS ||
        event.issuedAt > time + SKEW_MS) return
      val existing = old.entries[key]
      // The episode's lifetime is immutable, including resolution and retries.
      if (existing != null && (existing.event.issuedAt != event.issuedAt ||
          existing.event.expiresAt != event.expiresAt)) return
      val entries = old.entries.filterValues {
        it.status != "resolved" || it.event.expiresAt + SKEW_MS >= time
      }.toMutableMap()
      if (event.operation == "resolve") {
        if (key !in entries && entries.size >= MAX_ENTRIES) {
          // Refuse future alerts until every dropped tombstone's possible alert has expired.
          val until = maxOf(old.blockedUntil[event.serverId] ?: 0L, event.expiresAt)
          store.write(old.copy(entries = entries, blockedUntil = old.blockedUntil + (event.serverId to until)))
        } else {
          entries[key] = LifecycleEntry(event, "resolved")
          store.write(old.copy(entries = entries))
        }
        effects.cancel(key)
        return
      }
      if (event.operation != "alert" || event.expiresAt <= time ||
        (old.blockedUntil[event.serverId] ?: 0L) > time ||
        existing?.status == "resolved" || existing?.status == "posted" ||
        (key !in entries && entries.size >= MAX_ENTRIES)) return
      if ((event.reason == "permission") != (event.lane == "question") ||
        event.reason !in listOf("permission", "finished")) return
      entries[key] = LifecycleEntry(event, "pending")
      store.write(old.copy(entries = entries))
      true
    }
    if (!build) return
    // Expo's builder may suspend. Never hold the lock while building; resolution must win.
    val notification = effects.build(event)
    synchronized(lock) {
      val state = store.read()
      if (state.hosts[event.serverId] != event.registrationId ||
        state.entries[key]?.status != "pending" || event.expiresAt <= now()) return
      if (!effects.visible()) effects.post(key, notification)
      // Recovery retries only pending work. A normal user swipe must never recreate a row.
      store.write(state.copy(entries = state.entries + (key to LifecycleEntry(event, "posted"))))
    }
  }

  fun recover() {
    val state = synchronized(lock) { store.read() }
    state.entries.values.forEach {
      if (it.status == "pending") apply(it.event)
      else if (it.status == "resolved") synchronized(lock) { effects.cancel(it.event.key) }
    }
  }
}
