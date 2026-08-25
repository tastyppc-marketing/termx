/**
 * The status bar's one promise: the focused pane's working directory, FULL,
 * never shortened to a tail or a branch name. Chips are secondary chrome.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
