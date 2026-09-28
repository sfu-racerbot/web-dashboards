"""
The camera stream's decisions, with no ROS, no OpenCV and no camera.

stream_logic.py was split out of camera_stream_node so these run in CI
(car/ros/run_ros_free_tests.sh, the ROS_FREE list) as well as under colcon.
Needs python3 + pytest + numpy only:

    python3 -m pytest car/ros/usb_cam_stream/test/test_stream_logic.py -v

The node-level behaviour (encoding, passthrough, the encode thread) stays
in test_stream_tiers.py and test_camera_stream_node.py, which need rclpy.
"""
import asyncio

import numpy as np
import pytest

from usb_cam_stream import stream_logic
from usb_cam_stream.stream_logic import (
    FULL, PREVIEW, Tier, looks_like_jpeg, mjpeg_part, scaled_size,
    should_log_status, stream_status, tier_for_request, tier_qualities,
)

TIERS = {PREVIEW: None, FULL: None}


def test_importing_the_logic_pulls_in_neither_ros_nor_opencv():
    """The point of the split. Checked in a fresh interpreter, because this
    process may already have imported rclpy/cv2 via another test file."""
    import subprocess
    import sys
    code = ('import sys; import usb_cam_stream.stream_logic; '
            'bad = [m for m in ("rclpy", "cv2", "cv_bridge", "tornado") if m in sys.modules]; '
            'print(",".join(bad)); sys.exit(1 if bad else 0)')
    out = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True,
                         env={'PYTHONPATH': ':'.join(sys.path)})
    assert out.returncode == 0, (out.stdout, out.stderr)


# --------------------------------------------------------------------------
# Which tier a request gets
# Oracle: the endpoint table in car/docs/usb-camera-livestream.md (and
# camera_stream_node's module docstring) -- /stream is the preview,
# /stream?tier=full the full stream. The legacy ?full= flag is specified
# only by tier_for_request's own docstring: any value but None, '', '0',
# 'false' means full.
# --------------------------------------------------------------------------

@pytest.mark.parametrize('tier_arg, full_arg, expected', [
    (None, None, PREVIEW),        # a plain /stream
    ('preview', None, PREVIEW),
    ('full', None, FULL),
    ('full', '0', FULL),          # an explicit tier wins over the legacy flag
    ('preview', '1', PREVIEW),
    (None, '1', FULL),            # legacy ?full=1
    (None, 'true', FULL),
    (None, 'yes', FULL),          # anything but the four "off" spellings
    (None, '', PREVIEW),
    (None, '0', PREVIEW),
    (None, 'false', PREVIEW),
    ('bogus', None, PREVIEW),     # unknown tier: fall back, never fail
    ('bogus', '1', FULL),
    ('', None, PREVIEW),
    ('FULL', None, PREVIEW),      # case-sensitive: not a tier name
])
def test_tier_for_request(tier_arg, full_arg, expected):
    assert tier_for_request(TIERS, tier_arg, full_arg) == expected


def test_a_tier_is_only_chosen_if_the_node_has_it():
    # A node configured with only a preview never hands out 'full' by name.
    assert tier_for_request({PREVIEW: None}, 'full', None) == PREVIEW


# --------------------------------------------------------------------------
# Tier qualities, and the deprecated single knob
# Oracle: car/docs/usb-camera-livestream.md, parameter reference --
# jpeg_quality is deprecated and "if set, it is applied to both tiers";
# 0 (its declared default) is unset.
# --------------------------------------------------------------------------

def test_tier_qualities_are_independent_when_the_legacy_knob_is_unset():
    assert tier_qualities(0, 65, 90) == (65, 90, False)


def test_the_legacy_knob_overrides_both_tiers():
    assert tier_qualities(80, 65, 90) == (80, 80, True)


def test_tier_qualities_accept_the_float_or_str_a_yaml_may_carry():
    assert tier_qualities('0', 65.0, '90') == (65, 90, False)


# --------------------------------------------------------------------------
# Preview sizing
# Oracle: closed form -- width capped at max_width, height scaled by the
# same factor, rounded, never below one pixel; never upscaled.
# --------------------------------------------------------------------------

@pytest.mark.parametrize('w, h, max_w', [
    (1280, 720, 480), (1920, 1080, 480), (640, 480, 320), (1281, 721, 480),
])
def test_a_wide_frame_is_shrunk_to_the_tier_width_keeping_its_aspect(w, h, max_w):
    new_w, new_h = scaled_size(w, h, max_w)
    assert new_w == max_w
    assert new_h == round(h * max_w / w)
    assert abs(new_w / new_h - w / h) < w / h * 0.01   # aspect kept within 1%


def test_1280x720_at_480_is_480x270():
    assert scaled_size(1280, 720, 480) == (480, 270)   # 720 * 480/1280


def test_a_frame_exactly_at_the_tier_width_is_left_alone():
    assert scaled_size(480, 270, 480) is None


def test_a_frame_one_pixel_wider_than_the_tier_is_shrunk():
    assert scaled_size(481, 270, 480) == (480, round(270 * 480 / 481))


def test_a_narrower_frame_is_never_upscaled():
    assert scaled_size(320, 240, 480) is None


@pytest.mark.parametrize('max_w', [0, None])
def test_max_width_zero_means_the_sources_own_size(max_w):
    assert scaled_size(1920, 1080, max_w) is None


def test_a_very_flat_frame_never_scales_to_zero_rows():
    # 4000x1 at 480 wide would round to 0 rows; cv2.resize rejects that.
    assert scaled_size(4000, 1, 480) == (480, 1)


# --------------------------------------------------------------------------
# Recognising the camera's own JPEG
# Oracle: the JPEG SOI marker is FF D8 (ITU-T T.81, B.2.1); a decoded
# OpenCV frame is an (h, w, 3) array.
# --------------------------------------------------------------------------

def _jpeg_like(n=16):
    buf = np.zeros(n, dtype=np.uint8)
    buf[0], buf[1] = 0xFF, 0xD8
    return buf


def test_a_flat_buffer_starting_with_soi_is_a_jpeg():
    assert looks_like_jpeg(_jpeg_like())


def test_the_smallest_accepted_buffer_is_four_bytes():
    assert looks_like_jpeg(_jpeg_like(4))
    assert not looks_like_jpeg(_jpeg_like(4)[:3])


@pytest.mark.parametrize('buffer', [
    None,
    np.zeros(16, dtype=np.uint8),                            # no SOI
    np.array([0xD8, 0xFF, 0, 0], dtype=np.uint8),            # bytes swapped
    np.array([0xFF, 0xD9, 0, 0], dtype=np.uint8),            # EOI, not SOI
    np.zeros((48, 64, 3), dtype=np.uint8),                   # a decoded frame
    np.full((4, 4, 3), 0xFF, dtype=np.uint8),                # decoded, starts FF
    # A decoded one-column grayscale frame whose first pixels happen to be
    # FF, D8: 2-D, so not a JPEG, even though int(buffer[0]) works on it.
    np.array([[0xFF], [0xD8], [0], [0]], dtype=np.uint8),
    np.zeros(0, dtype=np.uint8),                             # empty
    b'\xff\xd8\x00\x00',                                     # bytes, not an array
    'not a buffer',
])
def test_anything_else_is_not_a_jpeg(buffer):
    assert not looks_like_jpeg(buffer)


# --------------------------------------------------------------------------
# The multipart frame an <img src="/stream"> reads
# Oracle: RFC 2046 section 5.1.1 -- "--" + boundary + CRLF, part headers,
# blank line, body; Content-Length is the body's byte count.
# --------------------------------------------------------------------------

@pytest.mark.parametrize('jpeg', [b'', b'\xff\xd8abc\xff\xd9', bytes(range(256)) * 40])
def test_mjpeg_part_frames_the_jpeg_exactly(jpeg):
    part = mjpeg_part(jpeg)
    head, body = part.split(b'\r\n\r\n', 1)
    lines = head.split(b'\r\n')
    assert lines[0] == b'--racerbotframe'
    assert b'Content-Type: image/jpeg' in lines
    assert f'Content-Length: {len(jpeg)}'.encode() in lines
    assert body == jpeg + b'\r\n'


def test_the_boundary_matches_the_one_the_handler_advertises():
    assert stream_logic.MJPEG_BOUNDARY == b'racerbotframe'
    assert mjpeg_part(b'x').startswith(b'--' + stream_logic.MJPEG_BOUNDARY + b'\r\n')


# --------------------------------------------------------------------------
# Status: which state the stream is in
# Oracle: car/docs/usb-camera-livestream.md ("reports whether the node is
# waiting for a device/topic or first frame ... stale input") for which
# situations are told apart; the state names are the node's log vocabulary
# (CAMERA [<state>]), unchanged by the split; and the rule "stale at or
# past frame_timeout_sec" is stream_status's.
# --------------------------------------------------------------------------

def _status(latest, now=100.0, timeout=2.0, topic='', device='/dev/video0', cap=True):
    return stream_status(now, latest, timeout, topic, device, cap)


def test_waiting_for_a_topic_that_has_sent_nothing():
    state, detail = _status(None, topic='/cam/image')
    assert state == 'waiting_for_image_topic'
    assert "'/cam/image'" in detail


def test_waiting_for_a_camera_that_is_not_open():
    assert _status(None, cap=False)[0] == 'waiting_for_camera'


def test_waiting_for_a_camera_that_is_open_but_silent():
    assert _status(None, cap=True)[0] == 'waiting_for_first_frame'


def test_topic_mode_never_reports_the_camera_even_with_no_device():
    assert _status(None, topic='/t', cap=False)[0] == 'waiting_for_image_topic'


def test_a_fresh_frame_is_streaming_with_the_detail_left_to_the_node():
    assert _status(99.0) == ('streaming', None)


def test_just_under_the_timeout_is_still_streaming():
    assert _status(100.0 - 1.999)[0] == 'streaming'


def test_exactly_at_the_timeout_is_stale():
    state, detail = _status(98.0)
    assert state == 'camera_frames_stale'
    assert '2.00s' in detail and 'limit 2.00s' in detail


def test_a_stale_topic_is_named_as_a_topic():
    state, detail = _status(90.0, topic='/cam/image')
    assert state == 'image_topic_stale'
    assert "Image topic '/cam/image'" in detail
    assert '10.00s' in detail


def test_a_frame_stamped_in_the_future_is_not_stale():
    # monotonic clocks do not go backwards, but a negative age must not
    # read as "stale" if one ever did -- even one far past the timeout.
    assert _status(110.0)[0] == 'streaming'


# --------------------------------------------------------------------------
# Status: when a line is logged
# Oracle: the rule in should_log_status's docstring -- every change of
# state, else at most once per period, never repeated at period 0.
# --------------------------------------------------------------------------

def test_a_change_of_state_is_always_logged():
    assert should_log_status('streaming', 'waiting_for_camera', 10.0, 9.99, 5.0)
    assert should_log_status('streaming', None, 10.0, None, 0.0)


def test_the_same_state_is_not_repeated_within_the_period():
    assert not should_log_status('streaming', 'streaming', 14.99, 10.0, 5.0)


def test_the_same_state_is_repeated_once_the_period_has_passed():
    assert should_log_status('streaming', 'streaming', 15.0, 10.0, 5.0)


def test_period_zero_never_repeats_a_state():
    assert not should_log_status('streaming', 'streaming', 1e9, 0.0, 0.0)


def test_the_same_state_with_no_previous_log_time_is_logged():
    assert should_log_status('streaming', 'streaming', 10.0, None, 5.0)


# --------------------------------------------------------------------------
# A tier's frame store and its waiters
# Oracle: the handler's contract -- a new seq on every store, and every
# parked viewer woken exactly once, the list emptied.
# --------------------------------------------------------------------------

def test_a_tier_counts_every_stored_frame():
    tier = Tier(PREVIEW, '480', '65')
    assert (tier.max_width, tier.quality, tier.jpeg, tier.seq) == (480, 65, None, 0)
    tier.store(b'a')
    tier.store(b'b')
    assert (tier.jpeg, tier.seq) == (b'b', 2)


def test_waking_resolves_every_parked_viewer_once():
    async def scenario():
        tier = Tier(FULL, 0, 90)
        first, second = tier.wait_for_frame(), tier.wait_for_frame()
        second.cancel()                 # a viewer that went away
        tier.wake_waiters()
        assert first.done() and first.result() is None
        assert tier._waiters == []
        tier.wake_waiters()             # nothing left to wake: no error
        later = tier.wait_for_frame()
        assert not later.done()
        tier.wake_waiters()
        assert later.done()
    asyncio.run(scenario())


def test_waiting_outside_a_running_loop_raises_rather_than_making_one():
    with pytest.raises(RuntimeError, match='no running event loop'):
        Tier(PREVIEW, 480, 65).wait_for_frame()
