"""Bound the dashboard's CSV parameter write to saved-run roots; no ROS."""
from pathlib import Path


def checked_path(value, roots):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError('choose a profiled CSV path on the car')
    path = Path(value).expanduser().resolve(strict=True)
    allowed = [Path(root).expanduser().resolve(strict=True) for root in roots]
    if not any(path.is_relative_to(root) and path != root for root in allowed):
        raise ValueError('racing line must be inside a configured saved-map root')
    if path.suffix.lower() != '.csv' or not path.is_file():
        raise ValueError('racing line must be an existing CSV file')
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('racing line exceeds 8 MiB')
    return str(path)


def build_apex_line(document, source, roots):
    """Run bounded offline validation in a worker, then return the new CSV."""
    import datetime
    import json
    import subprocess
    import sys
    import tempfile
    source = Path(checked_path(source, roots))
    if source.name != 'raceline_profiled.csv':
        raise ValueError('automatic apex edits need a saved run raceline_profiled.csv')
    if not isinstance(document, dict) or len(json.dumps(document)) > 65536:
        raise ValueError('invalid or oversized apex document')
    if not 1 <= len(document.get('apexes', [])) <= 100:
        raise ValueError('choose between 1 and 100 apexes')
    out = source.parent / ('apex_edit_' + datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f'))
    with tempfile.TemporaryDirectory(prefix='racerbot-apex-') as temp:
        request = Path(temp) / 'apexes.json'
        request.write_text(json.dumps(document, allow_nan=False))
        result = subprocess.run([sys.executable, '-m', 'pure_pursuit.apex_line_editor', '--run', str(source.parent),
            '--apexes', str(request), '--out', str(out)], capture_output=True, text=True,
            timeout=60, check=False)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout or 'apex validation failed')[-2000:])
    return checked_path(str(out / 'raceline_profiled.csv'), roots)
