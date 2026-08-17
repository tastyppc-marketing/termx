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
