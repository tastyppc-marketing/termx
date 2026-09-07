# Pane maximize verification

Request: maximize one pane inside a split tab, switch panes easily, and return
to the split arrangement while workspace tabs remain accessible.

The pane controls now offer Maximize. A dedicated bar provides a pane picker
and Restore split view. Ctrl+Shift+Enter toggles the view; key repeat is
consumed so holding the shortcut cannot send Enter into a terminal. Selecting
a pane focuses its contents after revealing it. Maximization stays local and
does not rewrite the shared layout or its split sizes.

Validation:

- Full UI suite: 153 files, 2,397 tests passed.
- Final split suite after the keyboard-repeat fix: 78 tests across eight files.
- Adjacent App suites: 90 tests across nine files.
- TypeScript checking passed; independent source review cleared.
- Browser verification used the actual SplitLayout and xterm components with
  a controlled attachment client. Maximize, pane selection, restore,
  Ctrl+Shift+Enter, search focus, and switching away/back all worked. The
  original 35/65 split returned and the client stayed at two attachments and
  zero detachments throughout maximize, switching and restore.

The component tests also cover plugin iframe identity, dead panes, hidden-tab
shortcut isolation, preserved unfinished input, remote pane removal/addition,
split actions, and keeping hidden siblings awake. Browser verification did not
use the user's running terminals. Plugin iframe content cannot forward
shortcuts across its origin; the controls remain available in TermX chrome.

Usage: [Maximize a split pane](../pane-maximize.md).
