"""Path boundary for the armed, service-only racing-line switch."""
import pytest
from web_dashboard.raceline import checked_path


def test_existing_csv_inside_root(tmp_path):
    path = tmp_path / 'line.csv'
    path.write_text('0,0,1\n')
    # oracle: invariant permitted path resolves to the actual CSV.
    assert checked_path(str(path), [str(tmp_path)]) == str(path.resolve())


@pytest.mark.parametrize('kind', ['outside', 'symlink', 'missing', 'directory', 'suffix', 'oversized', 'wrong_type'])
def test_refuses_unbounded_path(tmp_path, kind):
    root = tmp_path / 'runs'; root.mkdir()
    file = root / 'line.csv'; file.write_text('0,0,1\n')
    value = str(file)
    if kind in ('outside', 'symlink'):
        other = tmp_path / 'outside.csv'; other.write_text('0,0,1\n')
        if kind == 'outside':
            value = str(other)
        else:
            link = root / 'escape.csv'; link.symlink_to(other); value = str(link)
    elif kind == 'missing':
        value = str(root / 'missing.csv')
    elif kind == 'directory':
        value = str(root)
    elif kind == 'suffix':
        other = root / 'line.txt'; other.write_text('x'); value = str(other)
    elif kind == 'oversized':
        with file.open('wb') as stream:
            stream.truncate(8 * 1024 * 1024 + 1)
    else:
        value = 42
    # oracle: spec only an existing bounded CSV inside configured roots.
    with pytest.raises((ValueError, OSError), match='root|CSV|MiB|path|No such'):
        checked_path(value, [str(root)])


def test_worker_invokes_installed_module(tmp_path, monkeypatch):
    import subprocess
    import sys
    from pathlib import Path
    from types import SimpleNamespace
    from web_dashboard.raceline import build_apex_line
    source = tmp_path / 'raceline_profiled.csv'
    source.write_text('0,0,1\n')
    commands = []

    def child_process(command, **kwargs):
        commands.append(command)
        # Mock only the OS process boundary; geometry is covered by the
        # installed editor integration test in the workspace package.
        out = Path(command[command.index('--out') + 1])
        out.mkdir()
        (out / 'raceline_profiled.csv').write_text('1,2,1\n')
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    monkeypatch.setattr(subprocess, 'run', child_process)
    result = build_apex_line({'apexes': [{'x': 1, 'y': 2}]}, str(source), [str(tmp_path)])
    # oracle: installation contract; no source-tree script or simulator path.
    assert commands[0][:3] == [sys.executable, '-m', 'pure_pursuit.apex_line_editor']
    assert Path(result).read_text() == '1,2,1\n'
    assert Path(result).parent != source.parent
