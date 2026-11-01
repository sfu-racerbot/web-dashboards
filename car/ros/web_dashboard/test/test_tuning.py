"""
Unit tests for web_dashboard.tuning -- spec parsing, request clamping, and
the comment-preserving YAML writer. No ROS, no Tornado, no network, no
browser. Run with:

    python3 -m pytest car/ros/web_dashboard/test/test_tuning.py -v

The YAML tests lean on the real config files in this workspace rather than
only synthetic fixtures: the whole point of the line-surgery writer is
that it survives the *actual* files, which are dense with the comments
explaining why each number is what it is.
"""
import json
import os
import sys

import pytest
import yaml

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from web_dashboard import tuning  # noqa: E402

# Snapshots of two real, heavily commented driving-node configs: SFU
# Racerbot car 2's pure_pursuit.yaml and gap_follow.yaml, copied verbatim
# from sfu-racerbot/Racerbot-Car-2-Workspace at e314f96 when this package
# moved here. The LIVE files are round-tripped by that workspace's own
# gap_follow/pure_pursuit live-tuning tests (the other half of the
# live_tunable_spec contract, car/docs/web-dashboard.md).
FIXTURES = os.path.join(os.path.dirname(__file__), 'fixtures')

SAMPLE_YAML = """\
some_node:
  ros__parameters:
    # Why max_speed is what it is.
    max_speed: 4.0
    min_speed: 0.5     # trailing comment
    enable_thing: true

    # A trailing comment block.
other_node:
  ros__parameters:
    max_speed: 9.0
"""


def _spec(**overrides):
    param = {
        'name': 'max_speed', 'group': 'Speed', 'label': 'max speed',
        'kind': 'float', 'min': 0.5, 'max': 4.0, 'step': 0.1,
        'unit': 'm/s', 'safety': False, 'description': 'how fast',
    }
    param.update(overrides)
    return json.dumps({'version': 1, 'node': 'n', 'params': [param]})


# ---------------------------------------------------------------------------
# parse_spec
# ---------------------------------------------------------------------------

def test_parse_spec_reads_a_well_formed_catalogue():
    params, error = tuning.parse_spec(_spec())
    assert error is None
    assert len(params) == 1
    assert params[0]['name'] == 'max_speed'
    assert params[0]['min'] == 0.5 and params[0]['max'] == 4.0


def test_parse_spec_rejects_an_unsupported_version():
    text = json.dumps({'version': 99, 'params': []})
    params, error = tuning.parse_spec(text)
    assert params == []
    assert 'not supported' in error


@pytest.mark.parametrize('text', ['', 'not json at all', '[]', '{}'])
def test_parse_spec_survives_junk(text):
    """A node mid-restart, a different version, or the wrong node entirely
    must produce a message, never an exception."""
    params, error = tuning.parse_spec(text)
    assert params == []
    assert error


def test_parse_spec_drops_unusable_entries_but_keeps_the_rest():
    text = json.dumps({'version': 1, 'params': [
        {'name': 'good', 'group': 'g', 'kind': 'float', 'min': 0, 'max': 1},
        {'name': 'no_kind', 'group': 'g', 'min': 0, 'max': 1},
        {'name': 'bad_kind', 'group': 'g', 'kind': 'string', 'min': 0, 'max': 1},
        {'name': 'inverted', 'group': 'g', 'kind': 'float', 'min': 5, 'max': 1},
    ]})
    params, error = tuning.parse_spec(text)
    assert error is None
    assert [p['name'] for p in params] == ['good']


# ---------------------------------------------------------------------------
# coerce_request
# ---------------------------------------------------------------------------

def test_coerce_request_clamps_rather_than_refusing():
    param = tuning.parse_spec(_spec())[0][0]
    assert tuning.coerce_request(param, 99.0) == (4.0, None)
    assert tuning.coerce_request(param, -5.0) == (0.5, None)
    assert tuning.coerce_request(param, 2.0) == (2.0, None)


def test_coerce_request_refuses_wrong_types():
    param = tuning.parse_spec(_spec())[0][0]
    for bad in (True, 'fast', None, [1]):
        value, error = tuning.coerce_request(param, bad)
        assert value is None and error


def test_coerce_request_refuses_non_finite():
    param = tuning.parse_spec(_spec())[0][0]
    for bad in (float('inf'), float('nan')):
        value, error = tuning.coerce_request(param, bad)
        assert value is None and error


def test_coerce_request_bool_needs_a_real_bool():
    param = tuning.parse_spec(_spec(kind='bool'))[0][0]
    assert tuning.coerce_request(param, True) == (True, None)
    assert tuning.coerce_request(param, 1)[0] is None


# ---------------------------------------------------------------------------
# format_scalar
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('value,expected', [
    (4.0, '4.0'), (0.35, '0.35'), (0.05, '0.05'), (60.0, '60.0'),
    (0.0, '0.0'), (True, 'true'), (False, 'false'),
])
def test_format_scalar(value, expected):
    assert tuning.format_scalar(value) == expected


def test_format_scalar_keeps_floats_floating():
    """A whole-number double written as bare `4` reloads as an int and the
    node refuses to launch -- one run *after* the tune was saved."""
    assert yaml.safe_load(tuning.format_scalar(2.0)) == 2.0
    assert isinstance(yaml.safe_load(tuning.format_scalar(2.0)), float)


# ---------------------------------------------------------------------------
# update_yaml_values
# ---------------------------------------------------------------------------

def test_update_yaml_rewrites_only_the_requested_values():
    updated, changed, added = tuning.update_yaml_values(
        SAMPLE_YAML, 'some_node', {'max_speed': 2.5})
    assert changed == ['max_speed'] and added == []
    loaded = yaml.safe_load(updated)
    assert loaded['some_node']['ros__parameters']['max_speed'] == 2.5
    assert loaded['some_node']['ros__parameters']['min_speed'] == 0.5
    # The other node's identically named key is untouched.
    assert loaded['other_node']['ros__parameters']['max_speed'] == 9.0


def test_update_yaml_preserves_comments():
    updated, _, _ = tuning.update_yaml_values(
        SAMPLE_YAML, 'some_node', {'max_speed': 2.5, 'min_speed': 0.25})
    assert '# Why max_speed is what it is.' in updated
    assert 'min_speed: 0.25     # trailing comment' in updated


def test_update_yaml_appends_a_missing_key():
    updated, changed, added = tuning.update_yaml_values(
        SAMPLE_YAML, 'some_node', {'brand_new': 1.5})
    assert changed == [] and added == ['brand_new']
    assert yaml.safe_load(updated)['some_node']['ros__parameters']['brand_new'] == 1.5


def test_update_yaml_handles_bools():
    updated, _, _ = tuning.update_yaml_values(
        SAMPLE_YAML, 'some_node', {'enable_thing': False})
    assert yaml.safe_load(updated)['some_node']['ros__parameters']['enable_thing'] is False


def test_update_yaml_rejects_an_unknown_node():
    with pytest.raises(ValueError):
        tuning.update_yaml_values(SAMPLE_YAML, 'nope_node', {'max_speed': 1.0})


def test_update_yaml_rejects_a_file_without_ros_parameters():
    with pytest.raises(ValueError):
        tuning.update_yaml_values('some_node:\n  other: 1\n', 'some_node',
                                  {'max_speed': 1.0})


@pytest.mark.parametrize('package,node', [
    ('pure_pursuit', 'pure_pursuit_node'),
    ('gap_follow', 'gap_follow_node'),
])
def test_update_yaml_round_trips_real_configs(package, node):
    """Real files (snapshots, see FIXTURES), mostly comments explaining
    the numbers.

    Asserts the two properties that make "save" safe to click: every
    comment survives, and no value other than the requested one moves.
    """
    path = os.path.join(FIXTURES, f'car2_{package}.yaml')
    original = open(path).read()
    updated, changed, added = tuning.update_yaml_values(
        original, node, {'max_speed': 1.25})
    assert changed == ['max_speed'] and added == []

    def comments(text):
        return [line.strip() for line in text.splitlines()
                if line.strip().startswith('#')]

    assert comments(updated) == comments(original)
    before = yaml.safe_load(original)[node]['ros__parameters']
    after = yaml.safe_load(updated)[node]['ros__parameters']
    assert set(before) == set(after)
    assert {k: v for k, v in after.items() if before[k] != v} == {'max_speed': 1.25}


# ---------------------------------------------------------------------------
# values_needing_save
# ---------------------------------------------------------------------------

def test_values_needing_save_only_reports_real_differences():
    pending = tuning.values_needing_save(
        SAMPLE_YAML, 'some_node',
        {'max_speed': 4.0, 'min_speed': 1.25, 'enable_thing': True})
    assert pending == {'min_speed': 1.25}


def test_values_needing_save_includes_keys_absent_from_the_file():
    pending = tuning.values_needing_save(
        SAMPLE_YAML, 'some_node', {'not_in_file': 0.5})
    assert pending == {'not_in_file': 0.5}


def test_values_needing_save_falls_back_to_everything_on_an_unreadable_file():
    """Better to write the whole tune than to silently save none of it."""
    pending = tuning.values_needing_save('', 'some_node', {'max_speed': 1.0})
    assert pending == {'max_speed': 1.0}


def test_values_needing_save_treats_bools_as_bools():
    pending = tuning.values_needing_save(
        SAMPLE_YAML, 'some_node', {'enable_thing': False})
    assert pending == {'enable_thing': False}


# ---------------------------------------------------------------------------
# layered config references and save planning
# ---------------------------------------------------------------------------

LAYERED_SHARED = """\
node_x:
  ros__parameters:
    shared_only: 1.0
    both: 2.0
"""

LAYERED_OVERLAY = """\
node_x:
  ros__parameters:
    both: 3.0
    overlay_only: 4.0
"""


def test_split_config_refs():
    assert tuning.split_config_refs('a/x.yaml') == ['a/x.yaml']
    assert tuning.split_config_refs('a/x.yaml|b/y.yaml') == [
        'a/x.yaml', 'b/y.yaml']
    assert tuning.split_config_refs(' a/x.yaml | b/y.yaml ') == [
        'a/x.yaml', 'b/y.yaml']
    assert tuning.split_config_refs('|a/x.yaml||b/y.yaml|') == [
        'a/x.yaml', 'b/y.yaml']
    assert tuning.split_config_refs('') == []


def test_layered_save_single_file_matches_today():
    text = """\
node_x:
  ros__parameters:
    max_speed: 2.5
    min_speed: 1.0
"""
    live = {'max_speed': 3.5, 'min_speed': 1.0}
    assert tuning.plan_layered_save([text], 'node_x', live) == {
        0: tuning.values_needing_save(text, 'node_x', live)}
    assert tuning.plan_layered_save([text], 'node_x', live) == {
        0: {'max_speed': 3.5}}
    assert tuning.plan_layered_save(
        [LAYERED_SHARED], 'node_x', {'shared_only': 1.0, 'both': 2.0}) == {}


def test_layered_save_key_in_overlay_goes_to_overlay():
    assert tuning.plan_layered_save(
        [LAYERED_SHARED, LAYERED_OVERLAY], 'node_x', {'both': 5.0}) == {
            1: {'both': 5.0}}


def test_layered_save_compares_with_effective_value():
    files = [LAYERED_SHARED, LAYERED_OVERLAY]
    assert tuning.plan_layered_save(files, 'node_x', {'both': 3.0}) == {}
    assert tuning.plan_layered_save(files, 'node_x', {'both': 2.0}) == {
        1: {'both': 2.0}}


def test_layered_save_key_in_shared_only_goes_to_shared():
    assert tuning.plan_layered_save(
        [LAYERED_SHARED, LAYERED_OVERLAY], 'node_x', {'shared_only': 5.0}) == {
            0: {'shared_only': 5.0}}


def test_layered_save_key_in_neither_goes_to_first():
    assert tuning.plan_layered_save(
        [LAYERED_SHARED, LAYERED_OVERLAY], 'node_x', {'brand_new': 6.0}) == {
            0: {'brand_new': 6.0}}


def test_layered_save_file_without_the_node_block_is_skipped():
    absent = 'other_node:\n  ros__parameters:\n    both: 99.0\n'
    assert tuning.plan_layered_save(
        [LAYERED_SHARED, absent], 'node_x', {'both': 4.0}) == {
            0: {'both': 4.0}}
    assert tuning.plan_layered_save(
        [absent, LAYERED_OVERLAY], 'node_x', {'both': 5.0}) == {
            1: {'both': 5.0}}


def test_layered_save_three_files_last_holder_wins():
    middle = """\
node_x:
  ros__parameters:
    both: 4.0
"""
    last = """\
node_x:
  ros__parameters:
    both: 7.0
"""
    assert tuning.plan_layered_save(
        [LAYERED_SHARED, middle, last], 'node_x', {'both': 5.0}) == {
            2: {'both': 5.0}}


def test_layered_save_rejects_a_malformed_file():
    malformed = 'node_x: [not valid'
    with pytest.raises(ValueError, match='file index 1'):
        tuning.plan_layered_save(
            [LAYERED_SHARED, malformed], 'node_x', {'both': 5.0})


def test_save_layered_writes_each_value_to_its_holder(tmp_path):
    shared = tmp_path / 'shared.yaml'
    overlay = tmp_path / 'overlay.yaml'
    shared_text = """\
node_x:
  ros__parameters:
    shared_only: 1.0  # shared comment
    both: 2.0
other_node:
  ros__parameters:
    untouched: true
"""
    overlay_text = """\
node_x:
  ros__parameters:
    both: 3.0  # overlay comment
    overlay_only: 4.0
"""
    shared.write_text(shared_text)
    overlay.write_text(overlay_text)
    result = tuning.save_layered(
        [str(shared), str(overlay)], 'node_x',
        {'shared_only': 5.0, 'both': 6.0, 'overlay_only': 7.0})
    assert result == [(str(shared), 1), (str(overlay), 2)]
    assert shared.read_text() == """\
node_x:
  ros__parameters:
    shared_only: 5.0  # shared comment
    both: 2.0
other_node:
  ros__parameters:
    untouched: true
"""
    assert overlay.read_text() == """\
node_x:
  ros__parameters:
    both: 6.0  # overlay comment
    overlay_only: 7.0
"""


def test_save_layered_writes_nothing_when_a_file_is_unreadable(tmp_path):
    shared = tmp_path / 'shared.yaml'
    missing = tmp_path / 'missing.yaml'
    original = LAYERED_SHARED
    shared.write_text(original)
    with pytest.raises(OSError):
        tuning.save_layered(
            [str(shared), str(missing)], 'node_x', {'both': 5.0})
    assert shared.read_text() == original


def test_save_layered_writes_nothing_when_a_file_does_not_parse(tmp_path):
    shared = tmp_path / 'shared.yaml'
    overlay = tmp_path / 'overlay.yaml'
    shared_text = LAYERED_SHARED
    malformed = 'node_x: [not valid'
    shared.write_text(shared_text)
    overlay.write_text(malformed)
    with pytest.raises(ValueError):
        tuning.save_layered(
            [str(shared), str(overlay)], 'node_x', {'both': 5.0})
    assert shared.read_text() == shared_text
    assert overlay.read_text() == malformed
