import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders inline emphasis as elements, not as literal syntax", () => {
    const { container } = render(<Markdown>{"I stream **daily**"}</Markdown>);
    expect(screen.getByText("daily").tagName).toBe("STRONG");
    expect(container.textContent).toBe("I stream daily");
  });

  it("renders GFM features (lists, strikethrough)", () => {
    const { container } = render(
      <Markdown>{"- one\n- two\n\n~~gone~~"}</Markdown>,
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("del")).not.toBeNull();
  });

  it("escapes raw HTML instead of injecting it", () => {
    const { container } = render(
      <Markdown>{'<img src=x onerror="alert(1)"> <b>hi</b>'}</Markdown>,
    );
    // The payload is shown as text; no element is created from it.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>hi</b>");
  });

  it("strips javascript: link targets", () => {
    const { container } = render(
      <Markdown>{"[click](javascript:alert(1))"}</Markdown>,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).not.toContain("javascript:");
  });

  it("marks off-site links as external and referrer-free", () => {
    const { container } = render(
      <Markdown>{"[site](https://example.com)"}</Markdown>,
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("renders nothing for empty or whitespace-only content", () => {
    const { container } = render(<Markdown>{"   \n  "}</Markdown>);
    expect(container).toBeEmptyDOMElement();
  });
});
