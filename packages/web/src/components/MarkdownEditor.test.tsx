import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarkdownEditor } from "./MarkdownEditor";

function setup(value = "", maxLength = 500) {
  const onChange = vi.fn();
  const onDirty = vi.fn();
  render(
    <MarkdownEditor
      label="About"
      value={value}
      onChange={onChange}
      onDirty={onDirty}
      maxLength={maxLength}
    />,
  );
  return { onChange, onDirty };
}

describe("MarkdownEditor", () => {
  it("starts on the Write tab with the source in a textarea", () => {
    setup("**bold**");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("**bold**");
    expect(screen.getByRole("tab", { name: "Write" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("reports edits to the caller and flags unsaved changes", () => {
    const { onChange, onDirty } = setup();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    expect(onChange).toHaveBeenCalledWith("hi");
    expect(onDirty).toHaveBeenCalled();
  });

  it("previews the rendered markdown on the Preview tab", () => {
    setup("I stream **daily**");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByText("daily").tagName).toBe("STRONG");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows an empty state when there is nothing to preview", () => {
    setup("");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByText("Nothing to preview yet.")).toBeInTheDocument();
  });

  it("counts characters against the limit", () => {
    setup("12345", 5);
    expect(screen.getByText("5 / 5")).toBeInTheDocument();
    expect(screen.queryByText(/over the limit/)).toBeNull();
  });

  it("does not hard-cap input — it flags the overflow instead", () => {
    // Guards against reintroducing `maxLength` on the textarea, which would
    // silently swallow keystrokes.
    setup("x".repeat(10), 5);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea).not.toHaveAttribute("maxLength");
    expect(screen.getByText("10 / 5")).toBeInTheDocument();
    expect(screen.getByText(/5 characters over the limit/)).toBeInTheDocument();
  });

  it("uses a singular character label at one over", () => {
    setup("x".repeat(6), 5);
    expect(
      screen.getByText(/1 character over the limit —/),
    ).toBeInTheDocument();
  });
});
