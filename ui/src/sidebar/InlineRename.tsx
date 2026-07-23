import { useLayoutEffect, useRef } from "react";

export interface InlineRenameProps {
  value: string;
  ariaLabel: string;
  onCommit(value: string): void;
  onCancel(): void;
}

export function InlineRename({
  value,
  ariaLabel,
  onCommit,
  onCancel,
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
    if (next.length === 0) {
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
      maxLength={64}
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
