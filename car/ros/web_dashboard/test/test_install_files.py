"""
Does the package install every launch and config file it has?

`ros2 launch web_dashboard foxglove_bridge_launch.py` only works if that
file, and the YAML it loads from the share directory, were installed. A
file present in the source tree but missing from setup.py's data_files
still passes every other test here (they read the source tree), and fails
only on the car -- for the bridge, at boot, in a systemd unit nobody is
watching.

Oracle: the directory listings of launch/ and config/ themselves (an
invariant: whatever is there ships), plus the three files the site and
the systemd unit name explicitly (car/README.md).

setup.py is exec'd with setuptools.setup() stubbed, so this checks the
real declaration rather than a copy of it.

    python3 -m pytest car/ros/web_dashboard/test/test_install_files.py -v
"""
import os

import pytest

_PKG = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def _installed():
    """{share subdirectory: set of basenames} as setup.py declares them."""
    import setuptools

    captured = {}
    real_setup, cwd = setuptools.setup, os.getcwd()
    setuptools.setup = lambda **kwargs: captured.update(kwargs)
    try:
        os.chdir(_PKG)  # setup.py globs relative paths, exactly as colcon runs it
        with open('setup.py') as handle:
            exec(compile(handle.read(), 'setup.py', 'exec'), {'__name__': '__main__'})
    finally:
        setuptools.setup = real_setup
        os.chdir(cwd)
    out = {}
    for destination, sources in captured['data_files']:
        out.setdefault(destination, set()).update(os.path.basename(p) for p in sources)
    return out


@pytest.mark.parametrize('subdir, suffix', [('launch', '.py'), ('config', '.yaml')])
def test_every_file_on_disk_is_installed(subdir, suffix):
    on_disk = {n for n in os.listdir(os.path.join(_PKG, subdir)) if n.endswith(suffix)}
    assert on_disk, f'{subdir}/ is empty -- the listing this test relies on is wrong'
    installed = _installed().get(f'share/web_dashboard/{subdir}', set())
    assert on_disk - installed == set()


@pytest.mark.parametrize('subdir, name', [
    ('launch', 'web_dashboard_launch.py'),
    ('launch', 'foxglove_bridge_launch.py'),   # the systemd unit starts this
    ('config', 'foxglove_bridge.yaml'),        # ...which loads this
    ('config', 'web_dashboard.yaml'),
])
def test_the_files_the_unit_and_docs_name_are_installed(subdir, name):
    assert name in _installed().get(f'share/web_dashboard/{subdir}', set())


def test_the_old_frontend_is_not_installed():
    """The pages are the site's (apps/simple). Nothing may install a web/
    directory for the node to serve -- it serves no pages any more."""
    assert not any(d.endswith('/web') for d in _installed())
    assert not os.path.exists(os.path.join(_PKG, 'web'))
