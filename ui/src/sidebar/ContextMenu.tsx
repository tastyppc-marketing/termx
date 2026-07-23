import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export interface MenuPoint {
  x: number;
  y: number;
}

export function clampMenuPoint(
  point: MenuPoint,
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
  padding = 8,
): MenuPoint {
  const maxX = Math.max(padding, viewport.width - menuSize.width - padding);
  const maxY = Math.max(padding, viewport.height - menuSize.height - padding);
  return {
    x: Math.min(Math.max(point.x, padding), maxX),
    y: Math.min(Math.max(point.y, padding), maxY),
  };
}

export interface ContextMenuProps {
  label: string;
  point: MenuPoint;
  onClose(): void;
  children: ReactNode;
}

export function ContextMenu({ label, point, onClose, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const settledRef = useRef(false);
  const [position, setPosition] = useState(() => clampMenuPoint(
    point,
    { width: 0, height: 0 },
    { width: window.innerWidth, height: window.innerHeight },
  ));

  const restoreFocus = useCallback(() => {
    if (openerRef.current?.isConnected) {
      openerRef.current.focus();
    }
  }, []);

  const close = useCallback(() => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    restoreFocus();
    onClose();
  }, [onClose, restoreFocus]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const rect = menu.getBoundingClientRect();
    setPosition(clampMenuPoint(
      point,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
    enabledItems(menu)[0]?.focus();
  }, [label, point.x, point.y]);

  useLayoutEffect(() => () => restoreFocus(), [restoreFocus]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        close();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [close]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const items = enabledItems(menu);
    if (items.length === 0) {
      return;
    }
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = activeIndex < 0
        ? 0
        : (activeIndex + delta + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      items[activeIndex < 0 ? 0 : activeIndex]?.click();
    }
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ position: "fixed", left: position.x, top: position.y }}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>("button[role='menuitem']"))
    .filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true");
}
