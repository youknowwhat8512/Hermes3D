"""Publish agent activity and finished turns so a Hermes3D office can visualise them.

Hermes3D renders each backend profile as a character at a desk. Two things have
to reach the office for a desk to be honest: *who is working right now*, and
*what was said*. Message events on the JSON-RPC gateway are delivered only to
the client that submitted the prompt, so an office watching from the outside
sees neither when you chat somewhere else — the desktop app, Discord, the TUI,
a kanban worker.

This plugin closes that gap from inside the backend and publishes two frames on
the dashboard's event bus:

``agent.activity``
    A lifecycle frame at the start of a turn, repeated on a slow heartbeat
    while the turn runs, and again when it finishes. It carries no conversation
    content at all — profile, session, phase, and a timestamp — because its
    only job is to colour a character.

``agent.turn``
    The finished reply, so the office can show speech and gather speakers into
    a conversation circle.

Install it into each profile you want on screen; plugins are scoped to a
``HERMES_HOME``, so a profile without it stays silent. See ``install.sh``.

Observation only: the hooks never mutate the turn, never block it, and swallow
their own failures.
"""

from __future__ import annotations

import atexit
import logging
import math
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.parse import quote

from .publisher import OfficePublisher

_log = logging.getLogger(__name__)

FRAME_VERSION = 1

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9119
DEFAULT_CHANNEL = "hermes3d"

# The office shows a short preview, not a transcript. Truncating keeps a long
# answer from dominating the event bus.
MAX_TEXT_CHARS = 2_000

# A turn still marked as running after this long is assumed to have died with
# its process — a killed CLI, a crashed worker — and is closed out so the
# office does not leave that desk lit forever.
ACTIVITY_STALE_S = 15 * 60

# How often an in-flight turn re-announces itself. ``start`` is delivered once,
# to whoever happens to be subscribed at that instant, so an office that opens
# — or reloads — mid-turn would otherwise show an idle desk until the turn
# finished, which for a long turn is many minutes of lying. Repeating the frame
# bounds that lie to one interval.
DEFAULT_HEARTBEAT_S = 5.0

# Guard rails for a configured interval. Below the floor the beat is pure noise
# on the bus; above the ceiling it stops being a recovery mechanism.
MIN_HEARTBEAT_S = 1.0
MAX_HEARTBEAT_S = 60.0

# How long process exit waits for the beating thread to notice it should stop.
# It only ever sleeps on an event, so this is a safety net, not a budget.
HEARTBEAT_JOIN_S = 2.0

_publisher: Optional[OfficePublisher] = None

# Held across "decide what is active" and "publish that decision" so a heartbeat
# can never slip a repeat ``start`` in behind the ``end`` of the same turn.
_activity_lock = threading.RLock()


class ActivityTracker:
    """Which turns of this process are in flight, keyed by profile+session.

    One backend runs every profile and a profile can be running several turns
    at once (a gateway conversation while a kanban worker grinds away), so a
    single "busy" flag would go dark the moment the first of them finished.
    Tracking each ``(profile, session)`` and publishing only the transitions
    keeps the office honest without flooding the bus.
    """

    def __init__(self, stale_after_s: float = ACTIVITY_STALE_S) -> None:
        self._lock = threading.Lock()
        # key -> (started_at, platform). The platform is kept so a repeated
        # frame is identical to the one first published, not a thinner copy.
        self._started: Dict[Tuple[str, str], Tuple[float, str]] = {}
        self._stale_after_s = stale_after_s

    def start(
        self,
        profile: str,
        session_id: str,
        now: Optional[float] = None,
        platform: str = "",
    ) -> bool:
        """Record a turn. Returns True when the frame should be published."""
        at = time.time() if now is None else now
        key = (profile, session_id)
        with self._lock:
            self._expire_locked(at)
            already = key in self._started
            self._started[key] = (at, platform or "")
        # A repeat start for the same session (a retried turn, a hook fired
        # twice) is not a new transition; the office is already showing it.
        return not already

    def end(self, profile: str, session_id: str, now: Optional[float] = None) -> bool:
        """Close a turn. Returns True when the frame should be published."""
        at = time.time() if now is None else now
        key = (profile, session_id)
        with self._lock:
            self._expire_locked(at)
            existed = self._started.pop(key, None) is not None
        # Only close what we opened: an end with no start would clear a desk
        # this process never lit.
        return existed

    def expire(self, now: Optional[float] = None) -> list:
        """Drop and report turns whose end never arrived."""
        at = time.time() if now is None else now
        with self._lock:
            return self._expire_locked(at)

    def sweep(self, now: Optional[float] = None) -> Tuple[list, list]:
        """One atomic look at the world: what died, and what is still running.

        The heartbeat needs both answers from the same instant. Asking twice
        would let a turn expire between the two calls and be announced as both
        finished and still working.
        """
        at = time.time() if now is None else now
        with self._lock:
            expired = self._expire_locked(at)
            active = [
                (profile, session_id, platform)
                for (profile, session_id), (_at, platform) in self._started.items()
            ]
        return expired, active

    def _expire_locked(self, at: float) -> list:
        expired = [
            key
            for key, (started_at, _platform) in self._started.items()
            if at - started_at > self._stale_after_s
        ]
        for key in expired:
            self._started.pop(key, None)
        return expired

    def drain(self) -> list:
        """Every in-flight turn, cleared. Used when the process is going away."""
        with self._lock:
            keys = list(self._started.keys())
            self._started.clear()
        return keys


def _usable_seconds(value: Any, fallback: float) -> float:
    """Coerce an interval to something safe to sleep on, or fall back.

    A zero, negative, non-numeric, or non-finite interval would spin a thread
    at full tilt against the event bus, so anything unusable is refused rather
    than trusted. Magnitude is not judged here — see ``normalise_heartbeat_s``.
    """
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(seconds) or seconds <= 0:
        return fallback
    return seconds


def normalise_heartbeat_s(
    value: Any, fallback: float = DEFAULT_HEARTBEAT_S
) -> float:
    """Turn a *configured* interval into one worth beating at.

    The value arrives from user config, so on top of the usability check it is
    clamped: below the floor the beat is pure noise on the bus, above the
    ceiling it stops being a recovery mechanism.
    """
    return min(max(_usable_seconds(value, fallback), MIN_HEARTBEAT_S), MAX_HEARTBEAT_S)


class ActivityHeartbeat:
    """Repeats the current activity state on a slow, interruptible beat.

    The thread waits on an event rather than sleeping, so an idle backend costs
    one blocked thread and nothing else, and shutdown does not have to wait out
    an interval. Starting twice is a no-op: plugin ``register`` can run more
    than once in a process, and two beating threads would double every frame.

    The interval is only checked for usability here; a value read from config
    should come through ``normalise_heartbeat_s`` first so it is also clamped
    to a sane range.
    """

    def __init__(
        self, tick: Callable[[], None], interval_s: Any = DEFAULT_HEARTBEAT_S
    ) -> None:
        self._tick = tick
        self._interval_s = _usable_seconds(interval_s, DEFAULT_HEARTBEAT_S)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None

    @property
    def interval_s(self) -> float:
        return self._interval_s

    def is_running(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def start(self) -> bool:
        """Begin beating. Returns False when a beat is already running."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return False
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="hermes3d-office-heartbeat",
                daemon=True,
            )
            self._thread.start()
            return True

    def _run(self) -> None:
        # ``wait`` returns True only when stop was signalled, so the loop exits
        # promptly on shutdown and never publishes after it.
        while not self._stop.wait(self._interval_s):
            try:
                self._tick()
            except Exception as exc:
                # A beat that cannot publish is not a reason to kill the beat.
                _log.debug("hermes3d-office-bridge: heartbeat skipped: %s", exc)

    def stop(self, timeout: float = HEARTBEAT_JOIN_S) -> None:
        """Signal the beat and wait a bounded time for it to finish."""
        with self._lock:
            thread, self._thread = self._thread, None
        self._stop.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout)


_tracker = ActivityTracker()
_heartbeat: Optional[ActivityHeartbeat] = None
_exit_hook_registered = False


def build_turn_frame(
    *,
    profile: str,
    text: str,
    session_id: str = "",
    platform: str = "",
    at_ms: Optional[int] = None,
) -> dict:
    """Build the wire frame for one finished turn.

    ``profile`` is the agent identity: Hermes3D names each character after the
    backend profile it represents, so the two line up without a lookup table.
    """
    body = (text or "").strip()
    if len(body) > MAX_TEXT_CHARS:
        body = body[:MAX_TEXT_CHARS].rstrip() + "…"
    return {
        "v": FRAME_VERSION,
        "kind": "agent.turn",
        "profile": profile or "",
        "text": body,
        "sessionId": session_id or "",
        "platform": platform or "",
        "atMs": int(at_ms if at_ms is not None else time.time() * 1000),
    }


def build_activity_frame(
    *,
    profile: str,
    phase: str,
    session_id: str = "",
    platform: str = "",
    at_ms: Optional[int] = None,
) -> dict:
    """Build the wire frame for one lifecycle transition.

    Deliberately content-free. The office needs to know that *someone* is
    working, not what they are working on, and this frame is broadcast to every
    subscriber on the channel — so anything sensitive would leak far wider than
    the conversation it came from. That also makes a ``start`` safe to repeat
    on a heartbeat: every copy is the same handful of identifiers.
    """
    return {
        "v": FRAME_VERSION,
        "kind": "agent.activity",
        "profile": profile or "",
        "phase": phase,
        "sessionId": session_id or "",
        "platform": platform or "",
        "atMs": int(at_ms if at_ms is not None else time.time() * 1000),
    }


def build_publish_url(*, host: str, port: int, channel: str, token: str) -> str:
    """URL for the dashboard publisher endpoint.

    ``/api/pub`` accepts ``?token=`` only on an ungated (loopback) bind, which
    is the topology this plugin targets — it always publishes to the local
    backend, never across a network.
    """
    return (
        f"ws://{host}:{int(port)}/api/pub"
        f"?channel={quote(channel, safe='')}&token={quote(token, safe='')}"
    )


def _default_home_token(key: str) -> str:
    """Read ``key`` out of the default home's ``.env``.

    Profiles each get their own ``HERMES_HOME`` and their own ``.env``, so a
    profile-scoped process never sees a token pinned in the default home. That
    matters here because this token is not profile-level config: it identifies
    the one office backend every profile on the machine publishes to. Asking
    users to copy the same secret into five ``.env`` files would be worse.
    """
    from pathlib import Path

    try:
        from hermes_constants import get_default_hermes_root

        root = Path(get_default_hermes_root())
    except Exception:
        root = Path.home() / ".hermes"

    try:
        for line in (root / ".env").read_text(encoding="utf-8").splitlines():
            name, sep, value = line.partition("=")
            if sep and name.strip() == key:
                return value.strip().strip("'\"")
    except OSError:
        pass
    return ""


def _resolve_token() -> str:
    """The office backend's session token, which is a secret and lives in env.

    Pin it in ``~/.hermes/.env`` as ``HERMES3D_OFFICE_TOKEN`` — an unpinned
    backend mints a random one per start, which no subscriber can know.

    The office backend's own token variable, ``HERMES_DASHBOARD_SESSION_TOKEN``,
    deliberately is NOT the key to pin. ``.env`` loads with ``override=True``, so
    pinning that name hands the same fixed token to *every* backend on the
    machine — including the one the desktop app spawns, which mints a fresh
    token per launch and then cannot authenticate against its own gateway. Under
    a dedicated name the office backend still receives it (passed inline on the
    command line) while every other backend keeps minting its own.
    """
    import os

    token = (os.environ.get("HERMES3D_OFFICE_TOKEN") or "").strip()
    if token:
        return token
    token = _default_home_token("HERMES3D_OFFICE_TOKEN")
    if token:
        return token
    # Back-compat for setups written against the earlier guide, which pinned the
    # dashboard token. Only the pinned file counts: this process's own
    # ``HERMES_DASHBOARD_SESSION_TOKEN`` authenticates whichever backend it
    # happens to be, which is rarely the office backend it publishes to.
    return _default_home_token("HERMES_DASHBOARD_SESSION_TOKEN")


def _resolve_profile() -> str:
    """Which profile produced this turn.

    One ``hermes serve`` backend runs every profile, so the answer is per-turn
    rather than per-process; ``get_active_profile_name()`` reflects the profile
    scope in force while the hook runs.
    """
    try:
        from hermes_cli.profiles import get_active_profile_name

        return str(get_active_profile_name() or "")
    except Exception as exc:
        _log.debug("hermes3d-office-bridge: profile lookup failed: %s", exc)
        return ""


def _publish_activity(profile: str, phase: str, session_id: str, platform: str) -> None:
    if _publisher is None:
        return
    _publisher.publish(
        build_activity_frame(
            profile=profile,
            phase=phase,
            session_id=session_id,
            platform=platform,
        )
    )


def _publish_expired(expired: list) -> None:
    """Close out desks whose turn died without an end frame."""
    for profile, session_id in expired:
        _publish_activity(profile, "end", session_id, "")


def _heartbeat_tick() -> None:
    """Re-announce every in-flight turn, and close out any that died.

    Deliberately identical to the frame the turn opened with — same profile,
    same session, phase ``start`` — so a subscriber that already knows about
    the turn treats the repeat as a no-op while one that connected late learns
    the desk is busy. Taking ``_activity_lock`` keeps a repeat from landing
    after the ``end`` of the same turn, which would relight a finished desk.
    """
    if _publisher is None:
        return
    with _activity_lock:
        expired, active = _tracker.sweep()
        _publish_expired(expired)
        for profile, session_id, platform in active:
            _publish_activity(profile, "start", session_id, platform)


def _handle_pre_llm_call(**kwargs: Any) -> None:
    if _publisher is None:
        return
    try:
        profile = _resolve_profile()
        session_id = str(kwargs.get("session_id") or "")
        platform = str(kwargs.get("platform") or "")
        with _activity_lock:
            _publish_expired(_tracker.expire())
            if _tracker.start(profile, session_id, platform=platform):
                _publish_activity(profile, "start", session_id, platform)
    except Exception as exc:
        # An office that cannot draw is never a reason to disturb a turn.
        _log.debug("hermes3d-office-bridge: activity start skipped: %s", exc)


def _end_activity(profile: str, session_id: str, platform: str, phase: str = "end") -> None:
    # The lock makes "stop being active" and "say so" one step, so a heartbeat
    # cannot publish a start for a session between the two.
    with _activity_lock:
        if _tracker.end(profile, session_id):
            _publish_activity(profile, phase, session_id, platform)


def _handle_post_llm_call(**kwargs: Any) -> None:
    if _publisher is None:
        return
    profile = ""
    session_id = str(kwargs.get("session_id") or "")
    platform = str(kwargs.get("platform") or "")
    try:
        profile = _resolve_profile()
        text = str(kwargs.get("assistant_response") or "").strip()
        if text:
            _publisher.publish(
                build_turn_frame(
                    profile=profile,
                    text=text,
                    session_id=session_id,
                    platform=platform,
                )
            )
    except Exception as exc:
        _log.debug("hermes3d-office-bridge: publish skipped: %s", exc)
    finally:
        # The desk goes back to idle even when the reply could not be shown;
        # the alternative is a character stuck working forever.
        try:
            _end_activity(profile, session_id, platform)
        except Exception as exc:
            _log.debug("hermes3d-office-bridge: activity end skipped: %s", exc)


def _handle_session_end(**kwargs: Any) -> None:
    """Fallback close for turns that never reached ``post_llm_call``.

    ``post_llm_call`` is skipped when a turn is interrupted or produces no
    final response, which is exactly the case where a desk would otherwise stay
    lit. This hook fires on the way out either way.
    """
    if _publisher is None:
        return
    try:
        session_id = str(kwargs.get("session_id") or "")
        platform = str(kwargs.get("platform") or "")
        phase = "error" if kwargs.get("failed") else "end"
        _end_activity(_resolve_profile(), session_id, platform, phase)
    except Exception as exc:
        _log.debug("hermes3d-office-bridge: session end skipped: %s", exc)


def _flush_on_exit() -> None:
    """Stop the beat, close every open desk, then let queued frames drain.

    Order matters: stopping first means the beating thread cannot publish a
    ``start`` after the desks have been closed, which would leave the office
    lit by a process that no longer exists.
    """
    if _heartbeat is not None:
        try:
            _heartbeat.stop()
        except Exception as exc:
            _log.debug("hermes3d-office-bridge: heartbeat stop skipped: %s", exc)
    if _publisher is None:
        return
    try:
        for profile, session_id in _tracker.drain():
            _publish_activity(profile, "end", session_id, "")
    except Exception as exc:
        _log.debug("hermes3d-office-bridge: exit close skipped: %s", exc)
    _publisher.flush()


def register(ctx: Any) -> None:
    global _publisher, _heartbeat, _exit_hook_registered

    token = _resolve_token()
    if not token:
        _log.warning(
            "hermes3d-office-bridge: HERMES3D_OFFICE_TOKEN is unset; turns will "
            "not be published. Pin it in ~/.hermes/.env."
        )
        return

    def setting(key: str, fallback: Any) -> Any:
        try:
            value = ctx.get_config(key, fallback)
        except Exception:
            return fallback
        return fallback if value in (None, "") else value

    _publisher = OfficePublisher(
        build_publish_url(
            host=str(setting("host", DEFAULT_HOST)),
            port=int(setting("port", DEFAULT_PORT)),
            channel=str(setting("channel", DEFAULT_CHANNEL)),
            token=token,
        )
    )
    # A one-shot CLI turn ends its process the moment the hook returns, well
    # before a background send completes. Give the queue a bounded chance to
    # drain so those turns reach the office too, not just long-lived backends.
    if not _exit_hook_registered:
        atexit.register(_flush_on_exit)
        _exit_hook_registered = True
    # Registering twice in one process must not leave two threads beating: the
    # second would double every frame for the rest of the process's life.
    if _heartbeat is None:
        _heartbeat = ActivityHeartbeat(
            _heartbeat_tick,
            normalise_heartbeat_s(setting("heartbeat_s", DEFAULT_HEARTBEAT_S)),
        )
    _heartbeat.start()
    ctx.register_hook("pre_llm_call", _handle_pre_llm_call)
    ctx.register_hook("post_llm_call", _handle_post_llm_call)
    ctx.register_hook("on_session_end", _handle_session_end)
