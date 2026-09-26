# Where the simple dashboard came from

> **Who this is for:** anyone comparing this copy of the simple dashboard with the one that used to live on the car.
> **Read first:** [../../README.md](../../README.md) for what this repo is.
> **What's in it:** the exact source commit, how it was imported, and where each of the car repo's tests went.

This folder is now the **source of truth** for the simple dashboard's browser code. The car repo's `src/web_dashboard/web/` is the ancestor, not a mirror: changes go here, and the car no longer ships the frontend.

## The import

| | |
|---|---|
| Source repo | [sfu-racerbot/Racerbot-Car-2-Workspace](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace) |
| Source commit | `022e6faac95bbb4875939ed5f411c80ebcf92ab4` ("web_dashboard: use wss:// when the page is served over https") |
| `apps/simple/web/` | `git subtree split --prefix=src/web_dashboard/web`, then `git subtree add` — **history preserved** (27 commits) |
| `apps/simple/test/browser/` | `git subtree split --prefix=src/web_dashboard/test/browser`, then `git subtree add` — **history preserved** (7 commits) |

`git log --follow apps/simple/web/dashboard.js` walks back through the car repo's history of the file.

The folder layout (`web/` beside `test/browser/`) is the car repo's own, so every browser test still finds `../../web/dashboard.js` without a single edit.

## Where each car-repo test went

**Terminal 1, from the repo root:**

```bash
node apps/simple/test/run_all.js
```

**Working when:** it ends with `all 8 test files passed`. Each line names a file and its own `N checks passed` count.

| Car repo (pytest) | Here (plain node) | Notes |
|---|---|---|
| `test/browser/*_test.js` (7 files) | `test/browser/*_test.js` | Imported with history; run by `run_all.js` |
| `test_car_model_js.py`, `test_dashboard_js.py`, `test_draw_frames_js.py`, `test_map_panel_js.py`, `test_measure_js.py`, `test_panels_js.py`, `test_proc_panel_js.py` | `test/run_all.js` | These were only wrappers that ran a node file and checked for exit 0 plus `checks passed`. `run_all.js` does exactly that for every file |
| `test_web_assets.py` | `test/web_assets_test.js` | Every assertion ported — table below |
| every other `test_*.py` | stays on the car | They test the Python server (`protocol.py`, `mapstream.py`, `tuning.py`, …), which did not move |

<details>
<summary><b>Assertion-by-assertion map of <code>test_web_assets.py</code></b> — for a reviewer checking nothing was dropped. Skip it otherwise.</summary>

| Python test | Node check (same file order) |
|---|---|
| `test_every_element_the_script_looks_up_exists_in_its_page` ×3 params | `every element <script> looks up exists in <page>` ×3 |
| `test_no_duplicate_ids` ×2 params | `no duplicate ids in <page>` ×2 |
| `test_the_dashboard_still_loads_its_stylesheet_and_script` | same name |
| `test_the_panel_manager_loads_after_the_dashboard` | same name |
| `test_every_section_is_a_details_element` | `every section is a <details> element` |
| `test_every_section_has_a_digest_element_for_its_collapsed_headline` | same name |
| `test_the_javascript_knows_about_exactly_the_sections_that_exist` | same name |
| `test_a_checkbox_never_sits_inside_a_summary` | same name |
| `test_the_sidebar_can_receive_pointer_events` (`#overlay` not `pointer-events: none`) | same name |
| `test_the_sidebar_is_bounded_and_scrolls` | same name |
| `test_scrollable_regions_are_visibly_scrollable` | same name |
| `test_the_decision_log_scrolls` | same name |
| `test_the_view_controls_are_pinned_outside_the_scroll_region` | same name |
| `test_the_page_is_well_formed` | `the pages are well formed`, plus a new self-check of the hand-written parser (Python used `html.parser`; node has none built in, so the replacement is tested too) |
| `test_the_map_handles_pointer_events_not_just_mouse_events` | same name |
| `test_the_canvas_claims_touch_gestures_from_the_browser` | same name |
| `test_pinch_zoom_and_the_wheel_share_one_zoom_implementation` | same name |
| `test_the_phone_breakpoint_agrees_between_the_stylesheet_and_the_script` | same name |
| `test_the_half_detent_agrees_between_the_stylesheet_and_the_script` | same name |
| `test_the_sheet_moves_by_transform_only` | same name |
| `test_the_peek_height_is_a_variable_both_sides_can_read` | same name |
| `test_the_phone_strip_is_filled_by_the_dashboard` | same name |
| `test_every_font_size_goes_through_the_type_scale` | same name |
| `test_the_phone_breakpoint_rescales_every_size_in_the_scale` | same name |
| `test_the_stylesheet_has_balanced_braces` | same name |
| `test_the_measure_module_loads_before_the_dashboard` | same name, plus a new combined check that the order is exactly `measure.js → dashboard.js → panels.js` |
| `test_the_screen_to_world_inverse_exists_exactly_once` | same name |
| `test_the_measurement_overlay_never_uses_a_decision_colour` | same name |
| `test_the_measurement_readout_is_pinned_outside_the_scroll_region` | same name |
| `test_the_delete_confirmation_is_a_text_field_not_a_checkbox` | same name. The Python version also read `index.html` into a variable it never used; there is nothing to port for that line |
| `test_the_three_map_actions_are_separate_blocks` | same name |

No assertion was dropped.

</details>
