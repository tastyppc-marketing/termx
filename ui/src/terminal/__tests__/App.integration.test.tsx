import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../demo/LocalEchoTerminal", () => ({
  LocalEchoTerminal: () => <div data-testid="local-echo" />,
}));
vi.mock("../TerminalPane", () => ({
  TerminalPane: () => <div data-testid="real-terminal-pane" />,
}));

import App from "../../App";

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("App terminal integration", () => {
  it("renders the real terminal pane instead of the local echo demo", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<App />));

    expect(container.querySelector("[data-testid='real-terminal-pane']")).not.toBeNull();
    expect(container.querySelector("[data-testid='local-echo']")).toBeNull();

    await act(async () => root.unmount());
  });
});
