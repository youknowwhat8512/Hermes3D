"""Tests for the office bridge plugin's lifecycle frames.

Run from the repository root:

    ~/.hermes/hermes-agent/venv/bin/python -m unittest \
        discover -s plugins/hermes3d-office-bridge -p 'test_*.py'

The plugin imports ``.publisher`` relatively, so the package is loaded by name
rather than by file path.
"""

from __future__ import annotations

import importlib.util
import sys
import threading
import time
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent


def _load_plugin():
    """Import the plugin package under a stable name."""
    package = "hermes3d_office_bridge_under_test"
    if package in sys.modules:
        return sys.modules[package]
    spec = importlib.util.spec_from_file_location(
        package,
        PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[package] = module
    spec.loader.exec_module(module)
    return module


bridge = _load_plugin()


class BuildActivityFrameTests(unittest.TestCase):
    def test_carries_only_state_never_conversation(self):
        frame = bridge.build_activity_frame(
            profile="clody",
            phase="start",
            session_id="s-1",
            platform="discord",
            at_ms=1_700_000_000_000,
        )
        self.assertEqual(
            frame,
            {
                "v": bridge.FRAME_VERSION,
                "kind": "agent.activity",
                "profile": "clody",
                "phase": "start",
                "sessionId": "s-1",
                "platform": "discord",
                "atMs": 1_700_000_000_000,
            },
        )
        self.assertNotIn("text", frame)

    def test_stamps_its_own_time_when_none_is_given(self):
        frame = bridge.build_activity_frame(profile="clody", phase="end")
        self.assertIsInstance(frame["atMs"], int)
        self.assertGreater(frame["atMs"], 0)


class ActivityTrackerTests(unittest.TestCase):
    def setUp(self):
        self.tracker = bridge.ActivityTracker(stale_after_s=60)

    def test_publishes_the_transition_into_and_out_of_work(self):
        self.assertTrue(self.tracker.start("clody", "s-1", now=0))
        self.assertTrue(self.tracker.end("clody", "s-1", now=1))

    def test_a_repeated_start_is_not_a_new_transition(self):
        self.assertTrue(self.tracker.start("clody", "s-1", now=0))
        self.assertFalse(self.tracker.start("clody", "s-1", now=1))

    def test_concurrent_sessions_of_one_profile_are_tracked_separately(self):
        self.assertTrue(self.tracker.start("clody", "s-1", now=0))
        self.assertTrue(self.tracker.start("clody", "s-2", now=1))
        # Each session reports its own close; the bridge decides when the
        # character actually goes idle.
        self.assertTrue(self.tracker.end("clody", "s-1", now=2))
        self.assertTrue(self.tracker.end("clody", "s-2", now=3))

    def test_two_profiles_do_not_share_a_session_slot(self):
        self.assertTrue(self.tracker.start("clody", "s-1", now=0))
        self.assertTrue(self.tracker.start("findy", "s-1", now=0))
        self.assertTrue(self.tracker.end("clody", "s-1", now=1))
        self.assertTrue(self.tracker.end("findy", "s-1", now=1))

    def test_an_end_with_no_start_is_not_published(self):
        self.assertFalse(self.tracker.end("clody", "s-unknown", now=0))

    def test_a_turn_that_never_ended_expires(self):
        self.tracker.start("clody", "s-1", now=0)
        self.assertEqual(self.tracker.expire(now=61), [("clody", "s-1")])
        # Once expired the desk is closed, so a late end changes nothing.
        self.assertFalse(self.tracker.end("clody", "s-1", now=62))

    def test_a_live_turn_is_not_expired(self):
        self.tracker.start("clody", "s-1", now=0)
        self.assertEqual(self.tracker.expire(now=59), [])

    def test_drain_reports_and_clears_everything_in_flight(self):
        self.tracker.start("clody", "s-1", now=0)
        self.tracker.start("findy", "s-2", now=0)
        self.assertEqual(sorted(self.tracker.drain()), [("clody", "s-1"), ("findy", "s-2")])
        self.assertEqual(self.tracker.drain(), [])


class ActivitySweepTests(unittest.TestCase):
    """``sweep`` is what the heartbeat sees; it must be one consistent moment."""

    def setUp(self):
        self.tracker = bridge.ActivityTracker(stale_after_s=60)

    def test_reports_every_live_turn_with_the_platform_it_started_on(self):
        self.tracker.start("clody", "s-1", now=0, platform="discord")
        self.tracker.start("findy", "s-2", now=0, platform="cli")
        expired, active = self.tracker.sweep(now=10)
        self.assertEqual(expired, [])
        self.assertEqual(
            sorted(active), [("clody", "s-1", "discord"), ("findy", "s-2", "cli")]
        )

    def test_an_expired_turn_is_reported_dead_and_never_also_alive(self):
        self.tracker.start("clody", "s-1", now=0)
        self.tracker.start("findy", "s-2", now=50)
        expired, active = self.tracker.sweep(now=61)
        self.assertEqual(expired, [("clody", "s-1")])
        self.assertEqual(active, [("findy", "s-2", "")])

    def test_nothing_in_flight_is_a_cheap_empty_answer(self):
        self.assertEqual(self.tracker.sweep(now=0), ([], []))


class NormaliseHeartbeatTests(unittest.TestCase):
    """A configured interval is user input, so it is never trusted as given."""

    def test_a_sensible_interval_is_kept(self):
        self.assertEqual(bridge.normalise_heartbeat_s(7), 7.0)
        self.assertEqual(bridge.normalise_heartbeat_s("2.5"), 2.5)

    def test_an_unusable_interval_falls_back_to_the_default(self):
        for value in (0, -5, None, "", "soon", float("nan"), float("inf")):
            self.assertEqual(
                bridge.normalise_heartbeat_s(value),
                bridge.DEFAULT_HEARTBEAT_S,
                msg=repr(value),
            )

    def test_extremes_are_clamped_rather_than_rejected(self):
        self.assertEqual(bridge.normalise_heartbeat_s(0.01), bridge.MIN_HEARTBEAT_S)
        self.assertEqual(bridge.normalise_heartbeat_s(9_999), bridge.MAX_HEARTBEAT_S)

    def test_the_shipped_default_recovers_a_desk_within_five_seconds(self):
        self.assertEqual(bridge.DEFAULT_HEARTBEAT_S, 5.0)


class ActivityHeartbeatTests(unittest.TestCase):
    """The beating thread itself: it must be startable once and stoppable."""

    def test_it_ticks_until_it_is_stopped(self):
        ticks = threading.Event()
        count = []

        def tick():
            count.append(1)
            ticks.set()

        beat = bridge.ActivityHeartbeat(tick, interval_s=0.01)
        self.addCleanup(beat.stop)
        self.assertTrue(beat.start())
        self.assertTrue(ticks.wait(2), "heartbeat never ticked")
        beat.stop()
        self.assertFalse(beat.is_running())
        settled = len(count)
        time.sleep(0.05)
        # Nothing beats after stop; a late frame would relight a closed desk.
        self.assertEqual(len(count), settled)

    def test_starting_twice_does_not_double_the_beat(self):
        beat = bridge.ActivityHeartbeat(lambda: None, interval_s=0.01)
        self.addCleanup(beat.stop)
        self.assertTrue(beat.start())
        self.assertFalse(beat.start())

    def test_a_failing_tick_does_not_kill_the_beat(self):
        seen = []
        ready = threading.Event()

        def tick():
            seen.append(1)
            if len(seen) >= 3:
                ready.set()
            raise RuntimeError("publisher exploded")

        beat = bridge.ActivityHeartbeat(tick, interval_s=0.01)
        self.addCleanup(beat.stop)
        beat.start()
        self.assertTrue(ready.wait(2), "heartbeat stopped after a failing tick")

    def test_stopping_a_beat_that_never_started_is_harmless(self):
        bridge.ActivityHeartbeat(lambda: None).stop()

    def test_a_nonsense_interval_is_normalised_before_it_is_slept_on(self):
        self.assertEqual(
            bridge.ActivityHeartbeat(lambda: None, interval_s=-1).interval_s,
            bridge.DEFAULT_HEARTBEAT_S,
        )

    def test_a_fast_test_interval_is_honoured_verbatim(self):
        # The config clamp lives in ``normalise_heartbeat_s``; the thread only
        # refuses values it cannot sleep on, so tests can beat sub-second.
        self.assertEqual(
            bridge.ActivityHeartbeat(lambda: None, interval_s=0.01).interval_s, 0.01
        )


class HookPublishingTests(unittest.TestCase):
    """The hooks publish through the module-level publisher; capture it."""

    def setUp(self):
        self.published = []

        class FakePublisher:
            def publish(_self, frame):
                self.published.append(frame)
                return True

            def flush(_self, timeout=0):
                return None

        self._saved_publisher = bridge._publisher
        self._saved_tracker = bridge._tracker
        self._saved_resolve = bridge._resolve_profile
        bridge._publisher = FakePublisher()
        bridge._tracker = bridge.ActivityTracker()
        bridge._resolve_profile = lambda: "clody"

    def tearDown(self):
        bridge._publisher = self._saved_publisher
        bridge._tracker = self._saved_tracker
        bridge._resolve_profile = self._saved_resolve

    def kinds(self):
        return [(frame["kind"], frame.get("phase")) for frame in self.published]

    def test_a_turn_publishes_start_then_turn_then_end(self):
        bridge._handle_pre_llm_call(session_id="s-1", platform="discord")
        bridge._handle_post_llm_call(
            session_id="s-1", platform="discord", assistant_response="done"
        )
        self.assertEqual(
            self.kinds(),
            [("agent.activity", "start"), ("agent.turn", None), ("agent.activity", "end")],
        )

    def test_a_reply_that_could_not_be_published_still_frees_the_desk(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_post_llm_call(session_id="s-1", assistant_response="   ")
        self.assertEqual(
            self.kinds(), [("agent.activity", "start"), ("agent.activity", "end")]
        )

    def test_an_interrupted_turn_is_closed_by_session_end(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_session_end(session_id="s-1", failed=False)
        self.assertEqual(
            self.kinds(), [("agent.activity", "start"), ("agent.activity", "end")]
        )

    def test_a_failed_turn_is_closed_as_an_error(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_session_end(session_id="s-1", failed=True)
        self.assertEqual(
            self.kinds(), [("agent.activity", "start"), ("agent.activity", "error")]
        )

    def test_session_end_after_a_normal_finish_does_not_double_close(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_post_llm_call(session_id="s-1", assistant_response="done")
        bridge._handle_session_end(session_id="s-1")
        self.assertEqual(
            self.kinds(),
            [("agent.activity", "start"), ("agent.turn", None), ("agent.activity", "end")],
        )

    def test_no_state_frame_ever_carries_conversation_text(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_post_llm_call(session_id="s-1", assistant_response="secret")
        for frame in self.published:
            if frame["kind"] == "agent.activity":
                self.assertEqual(set(frame) & {"text", "userMessage"}, set())

    def test_a_running_turn_is_re_announced_so_a_late_office_sees_it(self):
        bridge._handle_pre_llm_call(session_id="s-1", platform="discord")
        self.published.clear()
        bridge._heartbeat_tick()
        # Same identity as the original start, so a subscriber that already
        # knows about the turn ignores it and a new one learns the desk is busy.
        self.assertEqual(
            self.published,
            [
                {
                    "v": bridge.FRAME_VERSION,
                    "kind": "agent.activity",
                    "profile": "clody",
                    "phase": "start",
                    "sessionId": "s-1",
                    "platform": "discord",
                    "atMs": self.published[0]["atMs"],
                }
            ],
        )

    def test_the_repeat_carries_no_conversation_content(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        self.published.clear()
        bridge._heartbeat_tick()
        for frame in self.published:
            self.assertEqual(
                set(frame),
                {"v", "kind", "profile", "phase", "sessionId", "platform", "atMs"},
            )

    def test_a_finished_turn_stops_being_announced(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_post_llm_call(session_id="s-1", assistant_response="done")
        self.published.clear()
        bridge._heartbeat_tick()
        self.assertEqual(self.published, [])

    def test_a_failed_turn_stops_being_announced(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_session_end(session_id="s-1", failed=True)
        self.published.clear()
        bridge._heartbeat_tick()
        self.assertEqual(self.published, [])

    def test_every_concurrent_turn_gets_its_own_repeat(self):
        bridge._resolve_profile = lambda: "clody"
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_pre_llm_call(session_id="s-2")
        bridge._resolve_profile = lambda: "findy"
        bridge._handle_pre_llm_call(session_id="s-1")
        self.published.clear()
        bridge._heartbeat_tick()
        self.assertEqual(
            sorted((f["profile"], f["sessionId"]) for f in self.published),
            [("clody", "s-1"), ("clody", "s-2"), ("findy", "s-1")],
        )
        self.assertEqual({f["phase"] for f in self.published}, {"start"})

    def test_one_finished_turn_does_not_silence_its_sibling(self):
        bridge._handle_pre_llm_call(session_id="s-1")
        bridge._handle_pre_llm_call(session_id="s-2")
        bridge._handle_post_llm_call(session_id="s-1", assistant_response="done")
        self.published.clear()
        bridge._heartbeat_tick()
        self.assertEqual(
            [(f["phase"], f["sessionId"]) for f in self.published], [("start", "s-2")]
        )

    def test_a_turn_that_died_is_closed_by_the_beat_not_repeated(self):
        bridge._tracker = bridge.ActivityTracker(stale_after_s=0)
        bridge._handle_pre_llm_call(session_id="s-1")
        self.published.clear()
        time.sleep(0.01)
        bridge._heartbeat_tick()
        self.assertEqual(self.kinds(), [("agent.activity", "end")])
        # And once closed it is gone for good, not resurrected next beat.
        self.published.clear()
        bridge._heartbeat_tick()
        self.assertEqual(self.published, [])

    def test_a_beat_with_nothing_running_publishes_nothing(self):
        bridge._heartbeat_tick()
        self.assertEqual(self.published, [])

    def test_the_beat_is_inert_without_a_publisher(self):
        bridge._publisher = None
        bridge._heartbeat_tick()
        self.assertEqual(self.published, [])


class ShutdownOrderTests(unittest.TestCase):
    """Exit must silence the beat before it closes the desks.

    Reversed, the beating thread could publish a ``start`` after the ``end``
    and leave the office lit by a process that has gone away.
    """

    def setUp(self):
        self.events = []
        published = self.events

        class RecordingPublisher:
            def publish(_self, frame):
                published.append(("publish", frame["phase"]))
                return True

            def flush(_self, timeout=0):
                published.append(("flush", None))

        class RecordingHeartbeat:
            def stop(_self, timeout=0):
                published.append(("stop", None))

        self._saved = (bridge._publisher, bridge._tracker, bridge._heartbeat)
        bridge._publisher = RecordingPublisher()
        bridge._tracker = bridge.ActivityTracker()
        bridge._heartbeat = RecordingHeartbeat()

    def tearDown(self):
        bridge._publisher, bridge._tracker, bridge._heartbeat = self._saved

    def test_stop_then_close_then_flush(self):
        bridge._tracker.start("clody", "s-1")
        bridge._flush_on_exit()
        self.assertEqual(
            self.events, [("stop", None), ("publish", "end"), ("flush", None)]
        )

    def test_exit_with_nothing_running_still_stops_the_beat(self):
        bridge._flush_on_exit()
        self.assertEqual(self.events, [("stop", None), ("flush", None)])


if __name__ == "__main__":
    unittest.main()
