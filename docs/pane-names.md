# Saved pane names

Double-click a terminal pane's title to name it. Each pane has its own name,
independent of its tab and OS window. Explicit names are saved with the workspace
layout and restored when TermX reopens. Headers, minimized-pane chips, and the
sidebar pane preview use the same names.

Names stay with a pane when it is split, moved into another tab or window,
extracted into its own tab, or restarted in place after its terminal ends.
An ended pane keeps its name until the pane is dismissed. A newly created pane
gets its normal profile/folder label. Existing names lost before this update
cannot be recovered; name those panes again after reopening the updated UI.

A pane with no name of its own falls back in one order: the tab's name, but
only for the first pane in the tab, then the profile/folder label. The first
pane is the one the sidebar row stands for, and that row already shows the
tab's name, so the two never disagree about the same terminal. Naming a tab
while it holds a single pane therefore labels that pane, and splitting beside
it no longer takes the label away: the new neighbour gets the profile/folder
label instead, which is what keeps two panes of the same profile in the same
folder apart.

The layout-v3 pane leaf accepts an optional `title` string of 1–64 characters.
Unnamed panes omit the field, so existing layouts remain readable without a
migration. The layout store trims names and treats a blank or null rename as
clearing the explicit name. Names use the existing layout persistence and
cross-window synchronization path. They belong to the saved pane, so replacing
its terminal session ID retains the label without copying it to unrelated panes.

This update only changes the UI. Reopen the updated TermX UI to activate it;
the background host and active terminal sessions can keep running.
