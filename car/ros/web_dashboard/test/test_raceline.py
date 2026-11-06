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
