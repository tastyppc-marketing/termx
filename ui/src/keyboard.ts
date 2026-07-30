/**
 * Shared guard for app-level shortcuts: stay live inside xterm (its hidden
 * textarea IS the terminal) but never fire from rename fields, search boxes,
 * or other editors.
 */
export function isEditableElement(element: Element | null): boolean {
  return (
    element instanceof HTMLElement &&
    !element.classList.contains("xterm-helper-textarea") &&
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable)
  );
}
