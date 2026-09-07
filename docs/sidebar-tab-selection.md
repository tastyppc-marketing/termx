# Selecting sidebar tabs

- Click a tab to open it and select only that tab.
- Shift-click another tab to highlight the range between the anchor and that tab, including both ends. Only visible tabs participate; collapsed groups are skipped.
- Ctrl-click a tab to add or remove it individually. On macOS, Command-click also works.
- Ctrl+Shift-click adds a range to the existing selection.
- With a sidebar tab focused, Shift+Up/Down extends or shrinks the range; Ctrl+Space (or Command+Space) toggles the focused tab. Enter opens it and returns to a single selection.

A normal or Ctrl-click sets the range anchor. Repeated Shift-clicks keep that anchor, so the range can grow, shrink, or reverse. Selecting with modifiers keeps the current terminal open; its narrow right-edge marker identifies it within the highlighted rows.

Selection is local to the sidebar and clears on reload. Opening a different tab through another control starts a new selection. Workspace activity updates preserve selection; closing, moving away, or hiding a row removes it from selection.

This feature highlights tabs. Existing close buttons, context menus, and drag operations continue to act on their individual tab or group.
