/**
 * The top menubar: Workspace · View · Plugins · Settings.
 *
 * It behaves the way every desktop menubar has behaved for forty years, and
 * that consistency is the feature: click a label to open it, then slide along
 * the bar and the menus follow the pointer without a second click. Esc, a
 * click outside, or picking a row closes. Only ever one is open.
 *
 * Direction B chrome, copied from the `PaneFlyout` recipe: square corners, a
 * hairline frame on `--surface-2`, and elevation from `--shadow-overlay`
 * alone. The one flourish is the register mark — a 2px `--accent` rule under
 * the open label, flush against the header's bottom hairline, so the open menu
 * reads as hanging off the bar rather than floating near it.
 *
 * The bar owns no actions. Every row is a model from `menus.ts` whose
 * `onSelect` is a call some other surface already makes.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { MenuRow } from "./menus";
import "./Menubar.css";

/**
 * One entry on the bar.
 *
 * `menu` is the common case: a list of row models. `panel` is for a menu whose
 * contents are not a flat list — the Plugins launcher, whose rows carry status
 * dots and placement chips — and it renders whatever it likes, so long as its
 * clickable rows are `button[role="menuitem"]`; the bar's arrow-key walk finds
 * them by that selector alone. `item` is a label with no dropdown at all.
 */
export type MenuSpec =
  | { kind: "menu"; id: string; label: string; rows: readonly MenuRow[] }
  | {
      kind: "panel";
      id: string;
      label: string;
      /** `close` dismisses the menu; call it when a row is acted on. */
      render(close: () => void): ReactNode;
    }
  | { kind: "item"; id: string; label: string; onSelect(): void };

export interface MenubarProps {
  menus: readonly MenuSpec[];
}

/**
 * The slice of a keyboard event the bar actually reads. React's synthetic
 * event and the DOM's own both satisfy it, which is what lets one handler
 * serve the nav and the window listener below without a second copy of the
 * navigation rules.
 */
interface MenubarKeyEvent {
  readonly key: string;
  readonly target: EventTarget | null;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export function Menubar({ menus }: MenubarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  // Set when a menu is opened from the keyboard: the first row takes focus as
  // soon as it exists. A pointer-opened menu leaves focus where it was, so the
  // pointer can keep sliding along the bar.
  const focusFirstRef = useRef(false);
  // Where focus was when the menu opened, so picking a row hands it back. The
  // bar sits above a terminal: a pointer open leaves focus in that terminal
  // (the labels refuse the mousedown below), and returning to the LABEL would
  // send every keystroke after "New tab" to a button instead of the shell.
  // A keyboard open records the label, which is exactly where Esc must return.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpenId((current) => {
      if (current !== null && restoreFocus) {
        // Synchronously, before any row action runs: an action that opens a
        // dialog of its own records the focused element as the one to return
        // to, and that should be where the user came from.
        const back = returnFocusRef.current;
        if (back !== null && back.isConnected) {
          back.focus();
        } else {
          // Nothing to go back to (or it left the document while the menu was
          // open): the label the user is standing on is the honest answer.
          labelRefs.current.get(current)?.focus();
        }
      }
      return null;
    });
  }, []);

  // Opening is the moment the return address is taken. Switching menus with an
  // open bar is NOT an open, so the address survives sliding along the labels.
  const openMenu = (id: string) => {
    if (openId === null) {
      const active = document.activeElement;
      returnFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
    setOpenId(id);
  };

  // A click anywhere else is a dismissal — the same rule the context menus and
  // the rail flyout keep. Capture, so a menu cannot be left open by a handler
  // that stops propagation on its way up.
  useEffect(() => {
    if (openId === null) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && navRef.current?.contains(event.target)) {
        return;
      }
      close(false);
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [openId, close]);

  // The nav's own handler only sees keys typed INTO the bar. A pointer-opened
  // menu deliberately left focus in the terminal, so Escape and the arrows
  // have to be picked up at the window while a menu is open; anything typed
  // inside the bar is already handled and must not run twice.
  const keyHandlerRef = useRef<(event: MenubarKeyEvent) => void>(() => undefined);
  useEffect(() => {
    if (openId === null) {
      return;
    }
    const handleWindowKey = (event: KeyboardEvent) => {
      if (event.target instanceof Node && navRef.current?.contains(event.target)) {
        return;
      }
      keyHandlerRef.current(event);
    };
    window.addEventListener("keydown", handleWindowKey);
    return () => window.removeEventListener("keydown", handleWindowKey);
  }, [openId]);

  useLayoutEffect(() => {
    if (openId === null || !focusFirstRef.current) {
      return;
    }
    focusFirstRef.current = false;
    enabledRows(dropdownRef.current)[0]?.focus();
  }, [openId]);

  const openIndex = menus.findIndex((menu) => menu.id === openId);

  const stepMenu = (delta: 1 | -1) => {
    const openable = menus.filter((menu) => menu.kind !== "item");
    if (openable.length === 0 || openIndex < 0) {
      return;
    }
    const here = openable.findIndex((menu) => menu.id === openId);
    const next = openable[(here + delta + openable.length) % openable.length];
    if (next) {
      setOpenId(next.id);
      labelRefs.current.get(next.id)?.focus();
    }
  };

  const handleKeyDown = (event: MenubarKeyEvent) => {
    // A panel may claim a key for itself (the Plugins rows walk their
    // placement chips with Left/Right); a claimed key never also moves the bar.
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "Escape") {
      if (openId !== null) {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (openId === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      stepMenu(event.key === "ArrowRight" ? 1 : -1);
      return;
    }

    const target = event.target instanceof Node ? event.target : null;
    const insideMenu = target !== null && dropdownRef.current?.contains(target) === true;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // Typed from outside the bar with a menu open: the pointer opened it and
      // left focus in the terminal, so the arrows walk the open menu's rows.
      const strayFromOutside =
        openId !== null &&
        (target === null || navRef.current?.contains(target) !== true);
      if (!insideMenu && !strayFromOutside) {
        const menuId = labelIdOf(event.target);
        const spec = menus.find((menu) => menu.id === menuId);
        if (!spec || spec.kind === "item") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        focusFirstRef.current = true;
        openMenu(spec.id);
        return;
      }
      const rows = enabledRows(dropdownRef.current);
      if (rows.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const at = rows.indexOf(document.activeElement as HTMLElement);
      rows[at < 0 ? 0 : (at + delta + rows.length) % rows.length]?.focus();
      return;
    }

    if ((event.key === "Enter" || event.key === " ") && insideMenu) {
      const active = document.activeElement;
      // Anything the menu calls a menuitem, INCLUDING the controls a panel
      // arranges on its own axis: the down-walk steps over a chip, but a chip
      // that has focus is still a thing you press Enter on.
      if (active instanceof HTMLElement && isMenuControl(active, dropdownRef.current)) {
        // preventDefault also suppresses the click a browser would synthesise
        // from Enter/Space on a button, so the row fires exactly once.
        event.preventDefault();
        event.stopPropagation();
        active.click();
      }
    }
  };

  keyHandlerRef.current = handleKeyDown;

  return (
    <nav
      ref={navRef}
      className="menubar"
      data-testid="menubar"
      role="menubar"
      aria-label="Main menu"
      onKeyDown={handleKeyDown}
    >
      {menus.map((spec) => {
        const open = spec.id === openId;
        return (
          <span className="menubar__slot" role="none" key={spec.id}>
            <button
              type="button"
              ref={(element) => {
                if (element) {
                  labelRefs.current.set(spec.id, element);
                } else {
                  labelRefs.current.delete(spec.id);
                }
              }}
              className={`menubar__item${open ? " menubar__item--open" : ""}`}
              data-menu-id={spec.id}
              role="menuitem"
              {...(spec.kind === "item"
                ? {}
                : { "aria-haspopup": "menu" as const, "aria-expanded": open })}
              onClick={() => {
                if (spec.kind === "item") {
                  close(false);
                  spec.onSelect();
                  return;
                }
                if (open) {
                  close(false);
                } else {
                  openMenu(spec.id);
                }
              }}
              // Sliding along an open bar switches menus without a click. With
              // nothing open, crossing the bar is just crossing the bar.
              // A label never takes focus from the pointer: the terminal
              // under the bar keeps it, and keeps receiving what is typed.
              onMouseDown={(event) => event.preventDefault()}
              onPointerEnter={() => {
                if (openId !== null && spec.kind !== "item") {
                  openMenu(spec.id);
                } else if (openId !== null && spec.kind === "item") {
                  // A plain label has nothing to show; the open menu closes
                  // rather than following the pointer onto a dead end.
                  close(false);
                }
              }}
            >
              {spec.label}
              {spec.kind === "item" ? null : (
                <span className="menubar__caret" aria-hidden="true">
                  ▾
                </span>
              )}
            </button>
            {open && spec.kind !== "item" ? (
              <Dropdown panelRef={dropdownRef} label={spec.label}>
                {spec.kind === "panel" ? (
                  spec.render(() => close(true))
                ) : (
                  <MenuRowList rows={spec.rows} onPick={() => close(true)} />
                )}
              </Dropdown>
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * The panel itself. Kept apart so the clamp — a menu near the right edge rides
 * back inside the window instead of hanging off it — lives in one place, and
 * so a panel menu inherits it for free.
 */
function Dropdown({
  panelRef,
  label,
  children,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  label: string;
  children: ReactNode;
}) {
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const overflow = rect.right - (window.innerWidth - 8);
    setShift(overflow > 0 ? -overflow : 0);
  }, [panelRef, label]);

  return (
    <div
      ref={panelRef}
      className="menubar__dropdown"
      data-testid="menubar-dropdown"
      role="menu"
      aria-label={label}
      style={shift === 0 ? undefined : { left: shift }}
    >
      {children}
    </div>
  );
}

/**
 * A flat list of row models — what a `kind: "menu"` entry renders. A panel menu
 * draws its own contents instead, because the things it lists are not rows of
 * this shape (a plugin row carries a status dot and a strip of chips).
 */
function MenuRowList({
  rows,
  onPick,
}: {
  rows: readonly MenuRow[];
  onPick(): void;
}) {
  return (
    <>
      {rows.map((row) =>
        row.kind === "separator" ? (
          <div className="menubar__divider" role="separator" key={row.id} />
        ) : (
          <button
            type="button"
            key={row.id}
            className="menubar__row"
            data-row-id={row.id}
            role="menuitem"
            disabled={row.disabled}
            onClick={() => {
              onPick();
              row.onSelect();
            }}
          >
            <span className="menubar__label">{row.label}</span>
            {row.shortcut !== undefined ? (
              <span className="menubar__key">{row.shortcut}</span>
            ) : row.state !== undefined ? (
              <span
                className={`menubar__key${row.state ? " menubar__key--on" : ""}`}
              >
                {row.state ? "on" : "off"}
              </span>
            ) : null}
          </button>
        ),
      )}
    </>
  );
}

/**
 * The rows the UP/DOWN walk may land on, in document order.
 *
 * `data-menu-skip` is how a panel keeps a control out of the vertical walk
 * while leaving it a real menu item: the Plugins launcher's placement chips sit
 * BESIDE a row on their own Left/Right axis, and letting Down visit each of
 * them would turn one plugin into four stops on the way past it.
 */
function enabledRows(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) {
    return [];
  }
  return [
    ...menu.querySelectorAll<HTMLElement>(
      "button[role='menuitem']:not([data-menu-skip])",
    ),
  ].filter(
    (row) =>
      !(row instanceof HTMLButtonElement && row.disabled) &&
      row.getAttribute("aria-disabled") !== "true",
  );
}

/** Any enabled menu item inside this menu, walked-over chips included. */
function isMenuControl(element: HTMLElement, menu: HTMLElement | null): boolean {
  return (
    menu !== null &&
    menu.contains(element) &&
    element.matches("button[role='menuitem']") &&
    !(element instanceof HTMLButtonElement && element.disabled) &&
    element.getAttribute("aria-disabled") !== "true"
  );
}

/** The menu id of the bar label an event came from, if it came from one. */
function labelIdOf(target: EventTarget | null): string | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(".menubar__item")?.dataset.menuId ?? null
    : null;
}
