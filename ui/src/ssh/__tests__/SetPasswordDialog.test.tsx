/**
 * The SSH set-password dialog (ssh-sessions spec §6). Modal manners are the
 * SaveSessionDialog's; what is specific here is the secret handling: the
 * existing value is never shown, the typed value is never trimmed and never
 * lands in an attribute, and Remove only exists for a host that has one.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { SetPasswordDialog } from "../SetPasswordDialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

/** A value distinctive enough that finding it anywhere it must not be is proof. */
const SECRET = "correct horse battery staple ";

async function render(
  options: {
    open?: boolean;
    alias?: string;
    hasExisting?: boolean;
    onSave?: Mock<(password: string) => void>;
    onRemove?: Mock<() => void> | undefined;
    onCancel?: Mock<() => void>;
    withRemove?: boolean;
  } = {},
) {
  const onSave: Mock<(password: string) => void> = options.onSave ?? vi.fn();
  const onCancel: Mock<() => void> = options.onCancel ?? vi.fn();
  const onRemove: Mock<() => void> = options.onRemove ?? vi.fn();
  const wire = options.withRemove ?? true;
  await act(async () =>
    root.render(
      <SetPasswordDialog
        open={options.open ?? true}
        alias={options.alias ?? "myvps"}
        hasExisting={options.hasExisting ?? false}
        onSave={onSave}
        onCancel={onCancel}
        {...(wire ? { onRemove } : {})}
      />,
    ),
  );
  return { onSave, onCancel, onRemove };
}

function field(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("[data-testid='ssh-password-input']")!;
}

function saveButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("[data-testid='ssh-password-save']")!;
}

function removeButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>("[data-testid='ssh-password-remove']");
}

function cancelButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("[data-testid='ssh-password-cancel']")!;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(target: HTMLElement, keyValue: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key: keyValue,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("SetPasswordDialog", () => {
  it("renders nothing when closed", async () => {
    await render({ open: false });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("names the host it is setting a password for", async () => {
    await render({ alias: "myvps" });
    const dialog = container.querySelector("[role='dialog']")!;

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toContain("myvps");
    expect(dialog.querySelector("h2")?.textContent).toContain("myvps");
  });

  it("masks the field, starts it empty, and autofocuses it", async () => {
    await render({ hasExisting: true });
    const input = field();

    expect(input.type).toBe("password");
    // An existing password is never read back into the UI — replacing it means
    // typing a new one, and the dialog cannot leak what it does not have.
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("says plainly that saving replaces the stored password", async () => {
    await render({ hasExisting: true });
    expect(container.textContent).toContain("Replace stored password");

    await render({ hasExisting: false });
    expect(container.textContent).not.toContain("Replace stored password");
  });

  it("keeps Save disabled until something is typed", async () => {
    await render();
    expect(saveButton().disabled).toBe(true);

    await type(field(), "x");
    expect(saveButton().disabled).toBe(false);

    await type(field(), "");
    expect(saveButton().disabled).toBe(true);
  });

  it("reports the password verbatim, spaces and all", async () => {
    const { onSave } = await render();
    await type(field(), SECRET);

    await act(async () => saveButton().click());

    // NOT trimmed: a password may legitimately end in a space.
    expect(onSave).toHaveBeenCalledExactlyOnceWith(SECRET);
  });

  it("saves on Enter, but not while the field is empty", async () => {
    const { onSave } = await render();
    await press(field(), "Enter");
    expect(onSave).not.toHaveBeenCalled();

    await type(field(), SECRET);
    await press(field(), "Enter");
    expect(onSave).toHaveBeenCalledExactlyOnceWith(SECRET);
  });

  it("whitespace alone is still a password", async () => {
    const { onSave } = await render();
    await type(field(), "  ");
    expect(saveButton().disabled).toBe(false);

    await act(async () => saveButton().click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith("  ");
  });

  it("cancels on Escape and from the Cancel button", async () => {
    const { onCancel, onSave } = await render();
    await press(field(), "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);

    await act(async () => cancelButton().click());
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers Remove only for a host that has a stored password", async () => {
    await render({ hasExisting: false });
    expect(removeButton()).toBeNull();

    const { onRemove } = await render({ hasExisting: true });
    expect(removeButton()).not.toBeNull();

    await act(async () => removeButton()!.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("omits Remove when the caller wires no remove handler", async () => {
    await render({ hasExisting: true, withRemove: false });
    expect(removeButton()).toBeNull();
  });

  it("keeps Tab inside the dialog", async () => {
    await render({ hasExisting: true });
    // With something typed every control is enabled, so the trap has to hold
    // across the whole tray (Remove, Cancel, Save) and not just up to it.
    await type(field(), "x");
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(
        "[role='dialog'] input:not(:disabled), [role='dialog'] button:not(:disabled)",
      ),
    );
    expect(focusables.length).toBeGreaterThan(1);

    const last = focusables[focusables.length - 1]!;
    last.focus();
    const forward = await press(last, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);

    const backward = await press(focusables[0]!, "Tab");
    expect(backward.defaultPrevented).toBe(false);
  });

  it("never writes the typed value into the markup", async () => {
    await render({ alias: "myvps", hasExisting: true });
    await type(field(), SECRET);

    // The value lives on the DOM property only: no attribute, no title, no
    // aria-label, nothing a screenshot or a snapshot could carry away.
    expect(container.innerHTML).not.toContain(SECRET);
    expect(container.innerHTML).not.toContain("correct horse");
  });

  it("forgets the typed value between opens", async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    await render({ onSave, onCancel });
    await type(field(), SECRET);

    await render({ open: false, onSave, onCancel });
    await render({ onSave, onCancel });

    expect(field().value).toBe("");
    expect(saveButton().disabled).toBe(true);
  });
});
