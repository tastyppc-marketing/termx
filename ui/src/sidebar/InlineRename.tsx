import { useLayoutEffect, useRef } from "react";

export interface InlineRenameProps {
  value: string;
  ariaLabel: string;
  onCommit(value: string): void;
  onCancel(): void;
  /**
   * Names must not be blank, so by default an empty commit cancels. Fields
   * where blank MEANS "clear it" (a saved session's description) opt in.
   */
  allowEmpty?: boolean;
  maxLength?: number;
  placeholder?: string;
}

export function InlineRename({
  value,
  ariaLabel,
  onCommit,
  onCancel,
  allowEmpty = false,
  maxLength = 64,
  placeholder,
}: InlineRenameProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const cancel = () => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    onCancel();
  };

  const commit = () => {
    if (settledRef.current) {
      return;
    }
    const next = inputRef.current?.value.trim() ?? "";
    if (next.length === 0 && !allowEmpty) {
      cancel();
      return;
    }
    // A name the user did not change is not a name the user chose. A name
    // field opens on what the surface is CALLED, which is not always what it
    // is NAMED: an unnamed pane shows the name derived from its profile and
    // folder, an unnamed tab the same, an unnamed window its active tab's.
    // Committing that back would pin the derivation as an explicit name —
    // silently, since the label reads the same either way — and the only
    // thing the user would notice is that it had stopped following along.
    // Losing focus is not an act of naming, and neither is Enter on an
    // untouched field (Michael, 2026-09-15: pane names "not saving").
    //
    // Only for name fields. `allowEmpty` marks the ones that edit a stored
    // value directly (a saved session's description), where the field opens on
    // the value itself and writing it back is exactly what was asked.
    if (!allowEmpty && next === value.trim()) {
      cancel();
      return;
    }
    settledRef.current = true;
    onCommit(next);
  };

  return (
    <input
      ref={inputRef}
      className="inline-rename"
      defaultValue={value}
      aria-label={ariaLabel}
      maxLength={maxLength}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
}
