"""Viewer activity transitions, run by the ROS-free test runner."""

from web_dashboard.activity import has_viewers


def test_work_follows_first_connection_and_last_disconnect():
    clients = set()
    # oracle: invariant viewer-only work is useful exactly while a connection exists.
    assert has_viewers(clients) is False
    clients.add('relay')
    assert has_viewers(clients) is True
    clients.add('control')
    clients.remove('relay')
    assert has_viewers(clients) is True
    clients.remove('control')
    assert has_viewers(clients) is False
