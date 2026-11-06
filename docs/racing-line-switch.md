# Select a racing line

Stop the car, release LB, and arm tuning. Under Manual Apex Mode, enter the absolute path of a validated profiled CSV on the car and press **Use in pure pursuit**. The dashboard displays acceptance or the controller's refusal reason.

The path must resolve to an existing CSV of at most 8 MiB inside a configured saved-map root. Symlinks cannot escape those roots. The file must use the current localization map frame. The dashboard sends only a parameter-service request to `pure_pursuit_node`; it publishes no ROS topic. The node refuses replacement unless joystick and stopped odometry are fresh. This write is protected by the existing per-connection tuning arm and role checks; it does not save the selection to tuning YAML.

Automatic apex edits use the armed `tuning_control` action `apex`. The dashboard finds the editor in the workspace and runs one bounded worker (60-second timeout), coalescing newer edits. It uses the current racing line's source CSV, never a browser-supplied executable. A validated result is sent as `pending_waypoints_file`. This prepares a line while stopped with LB released; a later observed LB press activates it before driving. Unknown/stale stop status prevents activation. The UI reports queued status and confirms application from the new racing-line broadcast.
