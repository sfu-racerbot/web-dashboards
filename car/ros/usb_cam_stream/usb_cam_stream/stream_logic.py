"""
stream_logic.py

The decisions camera_stream_node makes, with no rclpy, no cv2 and no
camera -- so they can be tested anywhere, including CI (see
car/ros/run_ros_free_tests.sh). The node owns the threads, the device and
the HTTP server; everything here is a plain function of its arguments, or
(Tier) plain state plus asyncio.

Needs only the standard library; looks_like_jpeg takes numpy arrays but
does not import numpy.
"""

import asyncio

MJPEG_BOUNDARY = b'racerbotframe'

PREVIEW = 'preview'
FULL = 'full'


class Tier:
    """One encoded size of the stream, shared by everyone watching it."""

    def __init__(self, name, max_width, quality):
        self.name = name
        self.max_width = int(max_width)   # 0 = leave at the source's size
        self.quality = int(quality)
        self.jpeg = None
        self.seq = 0
        # Number of connected viewers. Only the IOLoop mutates it; the
        # encode thread reads it to decide whether this tier is worth
        # encoding at all.
        self.viewers = 0
        # Futures belonging to handlers parked waiting for the next frame.
        # Only ever touched on the IOLoop thread.
        self._waiters = []

    def store(self, jpeg):
        self.jpeg = jpeg
        self.seq += 1

    # -- IOLoop-thread only ------------------------------------------------

    def wait_for_frame(self):
        # get_running_loop, not get_event_loop: this is only ever called
        # from inside a running handler coroutine, and the deprecated form
        # would quietly create a second loop if that ever stopped being true.
        future = asyncio.get_running_loop().create_future()
        self._waiters.append(future)
        return future

    def wake_waiters(self):
        for future in self._waiters:
            if not future.done():
                future.set_result(None)
        self._waiters.clear()


def tier_qualities(legacy_quality, preview_quality, full_quality):
    """(preview, full, legacy_applied). The deprecated single jpeg_quality
    knob, when set (non-zero), wins for both tiers."""
    legacy_quality = int(legacy_quality)
    if legacy_quality:
        return legacy_quality, legacy_quality, True
    return int(preview_quality), int(full_quality), False


def tier_for_request(tier_names, tier_argument, full_argument):
    """Which tier a /stream request wants, by name. Preview unless it asks
    otherwise -- the dashboard inset is the common case and the one that
    must be cheap. An unknown ?tier= falls back rather than failing, and
    the legacy ?full=<anything but '', '0', 'false'> still means full."""
    if tier_argument in tier_names:
        return tier_argument
    if full_argument not in (None, '', '0', 'false'):
        return FULL
    return PREVIEW


def scaled_size(width, height, max_width):
    """The (width, height) a frame is shrunk to for a tier, or None to keep
    it as it is: max_width 0 means the source's own size, and a frame
    already narrower than the tier is never upscaled. Aspect ratio is kept,
    and the height never rounds down to zero."""
    if not max_width or width <= max_width:
        return None
    return max_width, max(1, round(height * max_width / width))


def looks_like_jpeg(buffer) -> bool:
    """Is this the camera's raw JPEG rather than a decoded BGR image?

    A decoded frame is a 3-dimensional array; a JPEG comes back as a flat
    byte run starting with the SOI marker FF D8.
    """
    if buffer is None:
        return False
    try:
        if getattr(buffer, 'ndim', 0) != 1 or buffer.size < 4:
            return False
        return int(buffer[0]) == 0xFF and int(buffer[1]) == 0xD8
    except (TypeError, ValueError, IndexError):
        return False


def mjpeg_part(jpeg: bytes) -> bytes:
    """One part of the multipart/x-mixed-replace response an <img> reads."""
    return (
        b'--' + MJPEG_BOUNDARY + b'\r\n'
        b'Content-Type: image/jpeg\r\n'
        b'Content-Length: ' + str(len(jpeg)).encode() + b'\r\n\r\n'
        + jpeg + b'\r\n'
    )


def stream_status(now, latest_frame_time, frame_timeout_sec,
                  image_topic, device, camera_open):
    """(state, detail) for the periodic status check. For 'streaming' the
    detail is None: the node fills it in from its live counters."""
    if latest_frame_time is None:
        if image_topic:
            return ('waiting_for_image_topic',
                    f"no Image received on '{image_topic}'")
        if not camera_open:
            return 'waiting_for_camera', f"camera '{device}' is not open"
        return ('waiting_for_first_frame',
                f"camera '{device}' is open but has not produced a frame")

    frame_age_sec = now - latest_frame_time
    if frame_age_sec >= frame_timeout_sec:
        if image_topic:
            state, source = 'image_topic_stale', f"Image topic '{image_topic}'"
        else:
            state, source = 'camera_frames_stale', f"camera '{device}'"
        return state, (f'{source} has produced no frame for {frame_age_sec:.2f}s '
                       f'(limit {frame_timeout_sec:.2f}s)')
    return 'streaming', None


def should_log_status(state, last_state, now, last_log_time, period_sec):
    """Log a status line on every change of state, and otherwise at most
    once per period_sec -- never, if period_sec is 0."""
    if state != last_state:
        return True
    return period_sec > 0.0 and (
        last_log_time is None or now - last_log_time >= period_sec)
