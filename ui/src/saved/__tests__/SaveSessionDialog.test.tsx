import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  SaveSessionDialog,
  type SaveSessionPrefill,
} from "../SaveSessionDialog";

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

function prefill(overrides: Partial<SaveSessionPrefill> = {}): SaveSessionPrefill {
  return {
    name: "Parser work",
    description: "",
    cwd: "C:\\Dev\\TermX",
    conversationLabel: "Parser work (claude)",
    updatesExisting: false,
    ...overrides,
  };
}

type SaveMock = Mock<
  (result: { name: string; description: string; cwd: string }) => void
>;

async function render(
  options: {
    open?: boolean;
    prefill?: SaveSessionPrefill;
    onSave?: SaveMock;
    onCancel?: Mock<() => void>;
  } = {},
) {
  const onSave: SaveMock = options.onSave ?? vi.fn();
  const onCancel: Mock<() => void> = options.onCancel ?? vi.fn();
  await act(async () =>
    root.render(
      <SaveSessionDialog
        open={options.open ?? true}
        prefill={options.prefill ?? prefill()}
        onSave={onSave}
        onCancel={onCancel}
      />,
    ),
  );
  return { onSave, onCancel };
}

function nameField(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("[data-testid='save-session-name']")!;
}

function descriptionField(): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>(
    "[data-testid='save-session-description']",
  )!;
}

function cwdField(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("[data-testid='save-session-cwd']")!;
}

/** The overline above the folder input — "Folder" locally, "Remote folder" over SSH. */
function folderLabel(): string | undefined {
  return container
    .querySelector("label[for='save-session-cwd'] .save-session__label")
    ?.textContent ?? undefined;
}

function saveButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("[data-testid='save-session-save']")!;
}

function cancelButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("[data-testid='save-session-cancel']")!;
}

/**
 * Type into a controlled field. React tracks the value setter, so a plain
 * `field.value = …` is invisible to onChange — go through the native setter
 * (the pattern used by the rail and TerminalPane tests).
 */
async function type(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(
  target: HTMLElement,
  keyValue: string,
): Promise<KeyboardEvent> {
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

describe("SaveSessionDialog", () => {
  it("renders nothing when closed", async () => {
    await render({ open: false });
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("prefills name, description and folder, and names the conversation", async () => {
    await render({
      prefill: prefill({
        name: "Parser work",
        description: "The tokenizer rewrite",
        cwd: "C:\\Dev\\TermX",
        conversationLabel: "Parser work (claude)",
      }),
    });

    expect(nameField().value).toBe("Parser work");
    expect(descriptionField().value).toBe("The tokenizer rewrite");
    expect(cwdField().value).toBe("C:\\Dev\\TermX");
    expect(
      container.querySelector("[data-testid='save-session-conversation']")?.textContent,
    ).toBe("Resumes: Parser work (claude)");
  });

  it("says a bare-shell save restores the folder only", async () => {
    await render({ prefill: prefill({ conversationLabel: null }) });
    expect(
      container.querySelector("[data-testid='save-session-conversation']")?.textContent,
    ).toBe("No conversation — restores the folder only");
  });

  it("autofocuses the name field with its text selected", async () => {
    await render();
    const name = nameField();
    expect(document.activeElement).toBe(name);
    expect(name.selectionStart).toBe(0);
    expect(name.selectionEnd).toBe("Parser work".length);
  });

  it("disables Save until the name is non-blank", async () => {
    await render();
    expect(saveButton().disabled).toBe(false);

    await type(nameField(), "   ");
    expect(saveButton().disabled).toBe(true);

    await type(nameField(), " Renamed ");
    expect(saveButton().disabled).toBe(false);
  });

  it("disables Save when the folder is blank", async () => {
    // An empty folder would only ever produce resume's "folder no longer
    // exists ()" refusal, so it never gets saved in the first place.
    await render();
    expect(saveButton().disabled).toBe(false);

    await type(cwdField(), "   ");
    expect(saveButton().disabled).toBe(true);

    await type(cwdField(), "C:\\Dev\\TermX");
    expect(saveButton().disabled).toBe(false);
  });

  it("reports the trimmed edited values on Save", async () => {
    const { onSave } = await render();
    await type(nameField(), "  Renamed  ");
    await type(descriptionField(), "  two\nlines  ");
    await type(cwdField(), "  C:\\Work\\ops  ");

    await act(async () => saveButton().click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      name: "Renamed",
      description: "two\nlines",
      cwd: "C:\\Work\\ops",
    });
  });

  it("labels the primary button Update when the save replaces an entry", async () => {
    await render({ prefill: prefill({ updatesExisting: true }) });
    expect(saveButton().textContent).toBe("Update");

    await render({ prefill: prefill({ updatesExisting: false }) });
    expect(saveButton().textContent).toBe("Save");
  });

  it("saves on Enter in the name field, but not while the name is blank", async () => {
    const { onSave } = await render();
    await press(nameField(), "Enter");
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      name: "Parser work",
      description: "",
      cwd: "C:\\Dev\\TermX",
    });

    onSave.mockClear();
    await type(nameField(), "  ");
    await press(nameField(), "Enter");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cancels on Escape and from the Cancel button", async () => {
    const { onCancel, onSave } = await render();
    await press(nameField(), "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);

    await act(async () => cancelButton().click());
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog", async () => {
    await render();
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(
        "[role='dialog'] input, [role='dialog'] textarea, [role='dialog'] button",
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

  it("says nothing about SSH for a local save", async () => {
    await render();
    expect(container.querySelector("[data-testid='save-session-ssh']")).toBeNull();
    expect(folderLabel()).toBe("Folder");

    // An explicit null is the same statement as omitting the field.
    await render({ prefill: prefill({ sshLabel: null }) });
    expect(container.querySelector("[data-testid='save-session-ssh']")).toBeNull();
    expect(folderLabel()).toBe("Folder");
  });

  it("names the host and calls the folder remote for an SSH save", async () => {
    await render({ prefill: prefill({ sshLabel: "SSH: root@myvps", cwd: "/root/apps" }) });

    const host = container.querySelector("[data-testid='save-session-ssh']");
    expect(host?.textContent).toBe("SSH: root@myvps");
    // The folder field carries a remote path, and the label has to say so —
    // "Folder" reads as a local one, which is what resume would then look for.
    expect(folderLabel()).toBe("Remote folder");
    expect(cwdField().value).toBe("/root/apps");
  });

  it("puts the host line above the conversation line", async () => {
    await render({ prefill: prefill({ sshLabel: "SSH: root@myvps" }) });

    const lines = [
      ...container.querySelectorAll<HTMLElement>(
        "[data-testid='save-session-ssh'], [data-testid='save-session-conversation']",
      ),
    ];
    expect(lines.map((line) => line.dataset.testid)).toEqual([
      "save-session-ssh",
      "save-session-conversation",
    ]);
  });

  it("saves an SSH prefill unchanged — the host is not the dialog's business", async () => {
    const { onSave } = await render({
      prefill: prefill({ sshLabel: "SSH: root@myvps", cwd: "/root/apps" }),
    });

    await act(async () => saveButton().click());

    // The caller already knows the host; the dialog reports only what it edits.
    expect(onSave).toHaveBeenCalledExactlyOnceWith({
      name: "Parser work",
      description: "",
      cwd: "/root/apps",
    });
  });

  it("re-seeds the fields from the prefill each time it opens", async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    await render({ onSave, onCancel });
    await type(nameField(), "abandoned edit");

    await render({ open: false, onSave, onCancel });
    await render({
      prefill: prefill({ name: "Deploy script", cwd: "C:\\Work\\ops" }),
      onSave,
      onCancel,
    });

    expect(nameField().value).toBe("Deploy script");
    expect(cwdField().value).toBe("C:\\Work\\ops");
  });
});
