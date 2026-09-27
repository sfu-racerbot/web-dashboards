"""
The intent panel is optional: web_dashboard works with or without the
drive_intent package (intent.py).

Both paths, with no ROS:
  * installed -> the REAL drive_intent.schema comes back, and it validates
    a real payload (so it is the schema, not merely some module);
  * missing  -> (None, reason), no exception, and a startup line that says
    the panel is off and names the topic nothing will subscribe to.

"Missing" is produced by putting None in sys.modules for drive_intent,
which is exactly how Python reports an absent package to an import -- no
stand-in for drive_intent's behaviour is involved (A1).

Needs drive_intent importable for the "installed" half: on a car that has
it, source the workspace; in this repo's CI, the workflow puts the car
workspace's src/drive_intent on PYTHONPATH (see .github/workflows/ci.yml).

    python3 -m pytest car/ros/web_dashboard/test/test_intent_optional.py -v
"""
import sys

import pytest

from web_dashboard import intent


def test_installed_drive_intent_is_loaded_and_is_the_real_schema():
    schema, reason = intent.load_schema()
    assert reason is None
    import drive_intent.schema as real
    assert schema is real
    payload = schema.build('gap_follow_node', 'gap_follow', reason='test',
                           path=[(0.0, 0.0, 0.0, 1.0), (1.0, 0.0, 0.0, 1.0)],
                           desired_speed=1.0, commanded_speed=1.0, horizon_s=1.0)
    assert schema.validate(payload) is None


def test_startup_line_when_installed_says_on_and_names_the_topic():
    schema, reason = intent.load_schema()
    line = intent.startup_message(schema, reason, '/drive_intent')
    assert line == "drive intent: on, subscribed to '/drive_intent'"


@pytest.fixture
def no_drive_intent(monkeypatch):
    for name in [n for n in sys.modules if n == 'drive_intent' or n.startswith('drive_intent.')]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.setitem(sys.modules, 'drive_intent', None)


def test_missing_drive_intent_returns_none_and_a_reason_without_raising(no_drive_intent):
    schema, reason = intent.load_schema()
    assert schema is None
    assert reason.startswith('ModuleNotFoundError')
    assert 'drive_intent' in reason


def test_startup_line_when_missing_says_off_and_that_the_rest_works(no_drive_intent):
    schema, reason = intent.load_schema()
    line = intent.startup_message(schema, reason, '/drive_intent')
    assert line.startswith('drive intent: OFF')
    assert reason in line
    assert 'everything else works' in line
    assert "Nothing subscribes to '/drive_intent'" in line
