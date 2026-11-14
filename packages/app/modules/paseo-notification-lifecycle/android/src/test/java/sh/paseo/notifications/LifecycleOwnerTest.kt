package sh.paseo.notifications

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors

class LifecycleOwnerTest {
  private class Store : LifecycleStore {
    var state = LifecycleState()
    var fail = false
    override fun read() = state.copy(hosts = state.hosts.toMap(), entries = state.entries.toMap())
    override fun write(state: LifecycleState) { check(!fail); this.state = state }
  }
  private class Effects : LifecycleEffects<String> {
    val posts = mutableListOf<String>()
    val rows = mutableSetOf<String>()
    var buildAction: () -> Unit = {}
    var postAction: () -> Unit = {}
    override fun build(event: LifecycleEvent): String { buildAction(); return event.key }
    override fun post(key: String, notification: String) { postAction(); posts.add(key); rows.add(key) }
    override fun cancel(key: String) { rows.remove(key) }
    override fun visible() = false
  }
  private val time = 1_000L
  private fun event(episode: String = "A", lane: String = "question", host: String = "host") =
    LifecycleEvent(host, "agent", "registration", episode, lane, time, time + LIFETIME_MS,
      "alert", if (lane == "question") "permission" else "finished", "Title", "Body")
  private fun createOwner(store: Store, effects: Effects, clock: () -> Long = { time }) = LifecycleOwner(store, effects, clock)

  @Test fun resolutionDuringBuildWinsAtFinalPost() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    owner.register("host", "registration")
    val started = CountDownLatch(1); val release = CountDownLatch(1)
    effects.buildAction = { started.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
    val pool = Executors.newSingleThreadExecutor()
    try {
      val future = pool.submit { owner.apply(event()) }
      assertTrue(started.await(5, TimeUnit.SECONDS))
      owner.apply(event().copy(operation = "resolve"))
      release.countDown(); future.get(5, TimeUnit.SECONDS)
      assertTrue(effects.posts.isEmpty())
    } finally { release.countDown(); pool.shutdownNow() }
  }

  @Test fun exactResolutionKeepsNewEpisodeOtherLaneAndHost() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    owner.register("host", "registration"); owner.register("other", "registration")
    val events = listOf(event(), event("B"), event("C", "attention"), event("D", host = "other"))
    events.forEach(owner::apply)
    owner.apply(event().copy(operation = "resolve"))
    assertEquals(events.drop(1).map { it.key }.toSet(), effects.rows)
  }

  @Test fun tombstoneSurvivesOwnerRecreationAndDuplicateResolution() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    owner.register("host", "registration")
    owner.apply(event().copy(operation = "resolve"))
    val recovered = createOwner(store, effects)
    recovered.recover(); recovered.apply(event()); recovered.apply(event().copy(operation = "resolve"))
    assertTrue(effects.posts.isEmpty())
  }

  @Test fun postedEntryDoesNotReappearAfterUserSwipeOrDuplicate() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    owner.register("host", "registration"); owner.apply(event()); effects.rows.clear()
    createOwner(store, effects).recover(); owner.apply(event())
    assertEquals(1, effects.posts.size); assertTrue(effects.rows.isEmpty())
  }

  @Test fun persistenceFailurePreventsOsEffect() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    owner.register("host", "registration"); store.fail = true
    try { owner.apply(event()); fail("Expected durable write failure") } catch (_: IllegalStateException) {}
    assertTrue(effects.posts.isEmpty())
  }

  @Test fun pendingPostIsRecoveredAfterBuilderFailure() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    owner.register("host", "registration"); effects.buildAction = { error("crash") }
    try { owner.apply(event()); fail("Expected builder failure") } catch (_: IllegalStateException) {}
    effects.buildAction = {}; createOwner(store, effects).recover()
    assertEquals(setOf(event().key), effects.rows)
  }

  @Test fun hostRemovalWhileBuildingInvalidatesPostAndOldRegistration() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    owner.register("host", "registration")
    effects.buildAction = { owner.register("host", null) }
    owner.apply(event()); owner.register("host", "new-registration")
    effects.buildAction = {}; owner.apply(event())
    assertTrue(effects.posts.isEmpty())
  }

  @Test fun expiryDuringBuildAndChangedEpisodeLifetimeCannotPost() {
    val store = Store(); val effects = Effects(); var clock = time
    val owner = createOwner(store, effects) { clock }
    owner.register("host", "registration")
    effects.buildAction = { clock = event().expiresAt }
    owner.apply(event()); assertTrue(effects.posts.isEmpty())
    clock = time; effects.buildAction = {}
    owner.apply(event().copy(issuedAt = time + 1, expiresAt = time + LIFETIME_MS + 1))
    assertTrue(effects.posts.isEmpty())
  }
  @Test fun catchUpOnlyResolvesEntriesObservedBeforeTheRequest() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    owner.prepare("host") { "registration" }; owner.apply(event())
    val observed = owner.observed("host", "registration").toSet()
    owner.apply(event("B", "attention"))
    owner.reconcile("host", "registration", observed, emptySet())
    assertEquals(setOf(event("B", "attention").key), effects.rows)
    owner.apply(event()); assertEquals(1, effects.rows.size)
  }

  @Test fun prepareKeepsRegistrationUntilExplicitRemoval() {
    val store = Store(); val effects = Effects(); val owner = createOwner(store, effects)
    assertEquals("first", owner.prepare("host") { "first" })
    assertEquals("first", owner.prepare("host") { "second" })
    owner.register("host", null)
    assertEquals("second", owner.prepare("host") { "second" })
  }

}
