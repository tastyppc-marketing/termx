/**
 * The status bar's one promise: the focused pane's working directory, FULL,
 * never shortened to a tail or a branch name. Chips are secondary chrome.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatusBar } from "../StatusBar";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(ui: React.ReactElement) {
  await act(async () => root.render(ui));
}

describe("StatusBar", () => {
  it("shows the focused pane's working directory in full", async () => {
    const cwd = "C:\\Users\\mjfos\\code\\seo-service-builder\\output\\fetterplaceco";
    await render(<StatusBar cwd={cwd} profile="powershell" sshHost={null} />);

    const path = container.querySelector(".status-bar__cwd")!;
    expect(path.textContent).toBe(cwd);
    // The tooltip carries the same full path for when the bar is narrow.
    expect(path.getAttribute("title")).toBe(cwd);
  });

  it("chips the profile, and the ssh host when the pane is remote", async () => {
    await render(<StatusBar cwd="/srv/app" profile="powershell" sshHost="myvps" />);

    expect(
      container.querySelector("[data-testid='status-bar-profile']")?.textContent,
    ).toBe("powershell");
    expect(
      container.querySelector("[data-testid='status-bar-ssh']")?.textContent,
    ).toBe("ssh · myvps");
  });

  it("shows a quiet placeholder when nothing is focused", async () => {
    await render(<StatusBar cwd={null} profile={null} sshHost={null} />);

    expect(container.querySelector(".status-bar__cwd")?.textContent).toBe("—");
    expect(container.querySelector("[data-testid='status-bar-profile']")).toBeNull();
    expect(container.querySelector("[data-testid='status-bar-ssh']")).toBeNull();
  });
});

/** The path element, whichever of the two shapes the bar chose to render. */
function pathElement(): HTMLElement {
  return container.querySelector<HTMLElement>(".status-bar__cwd")!;
}

function openButton(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='status-bar-open-cwd']");
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("StatusBar — opening the working directory", () => {
  const cwd = "C:\\Dev\\TermX\\ui";

  it("hands the full path to the opener when the path is clicked", async () => {
    const onOpenCwd = vi.fn();
    await render(
      <StatusBar cwd={cwd} profile="powershell" sshHost={null} onOpenCwd={onOpenCwd} />,
    );

    await click(openButton()!);

    expect(onOpenCwd).toHaveBeenCalledExactlyOnceWith(cwd);
  });

  it(
    "renders the path as a real button, so Tab reaches it and Enter activates " +
      "it without any key handling of our own",
    async () => {
      await render(
        <StatusBar cwd={cwd} profile={null} sshHost={null} onOpenCwd={vi.fn()} />,
      );

      const path = pathElement();
      expect(path.tagName).toBe("BUTTON");
      // `type="button"` matters even outside a form: the default is `submit`.
      expect(path.getAttribute("type")).toBe("button");
      expect(path.textContent).toBe(cwd);
      expect(path.getAttribute("title")).toBe(cwd);
    },
  );

  it("stays a plain span when no opener is wired", async () => {
    await render(<StatusBar cwd={cwd} profile={null} sshHost={null} />);

    expect(pathElement().tagName).toBe("SPAN");
    expect(openButton()).toBeNull();
  });

  it("offers nothing to click when the focused pane has no known folder", async () => {
    await render(
      <StatusBar cwd={null} profile={null} sshHost={null} onOpenCwd={vi.fn()} />,
    );

    expect(pathElement().tagName).toBe("SPAN");
    expect(openButton()).toBeNull();
    expect(pathElement().textContent).toBe("—");
  });

  it(
    "does not open a window when the click merely ends a drag-select of the " +
      "path — copying the path off the bar has to keep working",
    async () => {
      const onOpenCwd = vi.fn();
      await render(
        <StatusBar cwd={cwd} profile={null} sshHost={null} onOpenCwd={onOpenCwd} />,
      );
      const button = openButton()!;
      const original = window.getSelection;
      window.getSelection = () =>
        ({
          toString: () => "C:\\Dev",
          anchorNode: button.firstChild,
        }) as unknown as Selection;

      try {
        await click(button);
      } finally {
        window.getSelection = original;
      }

      expect(onOpenCwd).not.toHaveBeenCalled();
    },
  );

  it("still opens when the selection lives somewhere else on screen", async () => {
    const onOpenCwd = vi.fn();
    await render(
      <StatusBar cwd={cwd} profile={null} sshHost={null} onOpenCwd={onOpenCwd} />,
    );
    const elsewhere = document.createElement("p");
    document.body.append(elsewhere);
    const original = window.getSelection;
    window.getSelection = () =>
      ({ toString: () => "unrelated", anchorNode: elsewhere }) as unknown as Selection;

    try {
      await click(openButton()!);
    } finally {
      window.getSelection = original;
      elsewhere.remove();
    }

    expect(onOpenCwd).toHaveBeenCalledExactlyOnceWith(cwd);
  });
});
