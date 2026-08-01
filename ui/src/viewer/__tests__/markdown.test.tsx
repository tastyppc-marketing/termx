import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "../markdown";

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

async function render(source: string): Promise<void> {
  await act(async () => root.render(<>{renderMarkdown(source)}</>));
}

describe("renderMarkdown", () => {
  it("renders level one through four headings and joins paragraph lines", async () => {
    await render(
      "# One\n## Two\n### Three\n#### Four\n\nFirst line\nsecond line",
    );

    expect(container.querySelector("h1")?.textContent).toBe("One");
    expect(container.querySelector("h2")?.textContent).toBe("Two");
    expect(container.querySelector("h3")?.textContent).toBe("Three");
    expect(container.querySelector("h4")?.textContent).toBe("Four");
    expect(container.querySelector("p")?.textContent).toBe(
      "First line second line",
    );
  });

  it("renders bold, italic, and inline code as semantic elements", async () => {
    await render("Use **bold**, *care*, and `npm test`.");

    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("care");
    expect(container.querySelector("code")?.textContent).toBe("npm test");
  });

  it("groups adjacent unordered and ordered list items", async () => {
    await render("- alpha\n* beta\n\n1. first\n2. second");

    expect(
      Array.from(container.querySelectorAll("ul > li"), (item) => item.textContent),
    ).toEqual(["alpha", "beta"]);
    expect(
      Array.from(container.querySelectorAll("ol > li"), (item) => item.textContent),
    ).toEqual(["first", "second"]);
  });

  it("renders fenced code blocks without injecting highlighting markup", async () => {
    await render("```ts\nconst value = 1 < 2;\n```");

    const code = container.querySelector("pre > code");
    expect(code?.textContent).toBe("const value = 1 < 2;");
    expect(code?.children).toHaveLength(0);
  });

  it("groups blockquote lines into a semantic quote", async () => {
    await render("> first line\n> second **line**");

    const quote = container.querySelector("blockquote");
    expect(quote?.textContent).toBe("first line second line");
    expect(quote?.querySelector("strong")?.textContent).toBe("line");
  });

  it("renders GFM pipe tables with header and body cells", async () => {
    await render("| Name | Value |\n| --- | ---: |\n| alpha | 1 |");

    expect(
      Array.from(container.querySelectorAll("thead th"), (cell) => cell.textContent),
    ).toEqual(["Name", "Value"]);
    expect(
      Array.from(container.querySelectorAll("tbody td"), (cell) => cell.textContent),
    ).toEqual(["alpha", "1"]);
  });

  it("renders links as titled text that cannot navigate", async () => {
    await render("Read [the guide](https://example.com/guide).");

    const label = container.querySelector<HTMLElement>("[title]");
    expect(label?.textContent).toBe("the guide");
    expect(label?.title).toBe("https://example.com/guide");
    expect(container.querySelector("a")).toBeNull();
  });

  it("nests deeper list items inside the item above them", async () => {
    await render("- outer\n  - inner one\n  - inner two\n- second outer");

    const top = container.querySelectorAll(":scope > ul > li");
    expect(Array.from(top, (item) => item.firstChild?.textContent)).toEqual([
      "outer",
      "second outer",
    ]);
    expect(
      Array.from(top[0].querySelectorAll("ul > li"), (item) => item.textContent),
    ).toEqual(["inner one", "inner two"]);
  });

  it("renders thematic breaks instead of gluing them into a paragraph", async () => {
    await render("before\n\n---\n\nafter");

    expect(container.querySelector("hr")).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll("p"), (item) => item.textContent),
    ).toEqual(["before", "after"]);
    expect(container.querySelector("table")).toBeNull();
  });

  it("leaves underscores inside identifiers alone", async () => {
    await render("Call `x` on snake_case_name, then _really_ read it.");

    expect(container.querySelector("p")?.textContent).toBe(
      "Call x on snake_case_name, then really read it.",
    );
    expect(container.querySelector("em")?.textContent).toBe("really");
  });

  it("does not read a piped paragraph followed by a rule as a table", async () => {
    await render("a | b\n---");

    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("a | b");
    expect(container.querySelector("hr")).not.toBeNull();
  });

  it("renders raw HTML as literal text instead of DOM", async () => {
    await render("<strong>not bold</strong> <script>unsafe()</script>");

    expect(container.textContent).toBe(
      "<strong>not bold</strong> <script>unsafe()</script>",
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});
