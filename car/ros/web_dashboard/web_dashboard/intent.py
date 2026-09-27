"""
Optional `/drive_intent` support: the intent arrow and decision panel.

The schema for `/drive_intent` lives in the `drive_intent` package, which
belongs to the car workspace that publishes it (for SFU Racerbot,
sfu-racerbot/Racerbot-Car-2-Workspace, `src/drive_intent`) -- not to this
repo. A car that has no `drive_intent` package still gets a working
dashboard: the intent panel is simply off, and the node says so once at
startup.

Why optional rather than a hard dependency: a hard `<depend>` would make
every other team's `rosdep install` and `colcon build` fail on a package
they have never heard of, for one panel out of twenty.

No ROS, Tornado or network imports, so test/test_intent_optional.py tests
both paths directly.
"""

import importlib


def load_schema():
    """Import `drive_intent.schema` if it is installed.

    Returns (schema_module, None) when it is, and (None, reason) when it is
    not -- never raises, because a missing optional panel must not stop the
    dashboard from starting.
    """
    try:
        schema = importlib.import_module('drive_intent.schema')
    except ImportError as exc:
        return None, f'{type(exc).__name__}: {exc}'
    return schema, None


def startup_message(schema, reason, topic):
    """The one line the node logs at startup about the intent panel."""
    if schema is not None:
        return f"drive intent: on, subscribed to '{topic}'"
    return (f"drive intent: OFF -- the drive_intent package is not installed "
            f"({reason}). The intent arrow and decision panel stay empty; "
            f"everything else works. Nothing subscribes to '{topic}'.")
