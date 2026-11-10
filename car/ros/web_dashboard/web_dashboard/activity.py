"""ROS-free decision for work whose only consumer is a connected viewer."""


def has_viewers(clients):
    # Control connections still consume stopwatch and control-panel state.
    return bool(clients)
