/**
 * Regression coverage for the responsive header / mobile drawer.
 *
 * Two defects lived here:
 *
 *   1. The drawer was gated on `{user && drawerOpen && …}`, so for a signed-out
 *      visitor the burger button opened nothing at all — the whole menu was
 *      unreachable on a phone. Silent: nothing errored, the button just did
 *      nothing.
 *   2. Once the drawer works for everyone, the top-bar Sign in / Register links
 *      must be hidden below `sm` (they crowd the bar next to the logo and the
 *      burger) while remaining present at `sm` and up — otherwise the only way
 *      to register on a phone would be through a menu.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const useGetConfigQuery = vi.fn(() => ({ data: undefined }));

vi.mock("../store/api", () => ({
  useGetConfigQuery: () => useGetConfigQuery(),
  useEndBroadcastMutation: () => [vi.fn()],
  api: { util: { resetApiState: vi.fn() } },
}));

let authState: { accessToken: string | null; user: unknown } = {
  accessToken: null,
  user: null,
};

vi.mock("../store", () => ({
  useAppDispatch: () => () => {},
  useAppSelector: (sel: (s: unknown) => unknown) =>
    sel({
      auth: authState,
      broadcast: {
        status: "idle",
        active: null,
        stats: null,
      },
      toast: { toasts: [] },
    }),
}));

vi.mock("../store/authSlice", () => ({
  loggedOut: { type: "auth/loggedOut" },
}));
vi.mock("../store/broadcastSlice", () => ({
  broadcastStopped: { type: "broadcast/stopped" },
}));
vi.mock("../store/toastSlice", () => ({
  addToast: Object.assign(vi.fn(), { type: "toast/add" }),
  errorMessage: (e: unknown, f: string) =>
    (e as { message?: string })?.message ?? f,
}));

import { Layout } from "./Layout";

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<p>Home</p>} />
          <Route path="dashboard" element={<p>Dashboard</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** jsdom has no layout, so Tailwind's responsive visibility classes are inert.
 *  Assert on the class contract instead — that is what actually ships. */
function isHiddenBelowSm(el: Element): boolean {
  return (
    el.className.includes("hidden") && el.className.includes("sm:inline-flex")
  );
}

describe("responsive header actions", () => {
  beforeEach(() => {
    authState = { accessToken: null, user: null };
  });

  it("hides Sign in / Register below sm and shows them from sm up", () => {
    renderLayout();
    const signIn = screen.getByRole("link", { name: "Sign in" });
    const register = screen.getByRole("link", { name: "Register" });

    expect(isHiddenBelowSm(signIn)).toBe(true);
    expect(isHiddenBelowSm(register)).toBe(true);
  });

  it("opens a working menu for a signed-out visitor", () => {
    renderLayout();

    // Regression: the burger previously did nothing at all without a user.
    act(() => screen.getByRole("button", { name: "Open menu" }).click());

    const menu = screen.getByRole("dialog", { name: "Menu" });
    expect(menu).toBeInTheDocument();
    // Both destinations are reachable inside the drawer.
    const links = Array.from(menu.querySelectorAll("a")).map((a) =>
      a.textContent?.trim(),
    );
    expect(links).toContain("Sign in");
    expect(links).toContain("Create account");
    // And they point at the right routes.
    const hrefs = Array.from(menu.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/login");
    expect(hrefs).toContain("/register");
  });

  it("closes the menu via the close button", () => {
    renderLayout();
    act(() => screen.getByRole("button", { name: "Open menu" }).click());
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Close menu" }).click());
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  });

  it("closes the menu on Escape (it is an aria-modal dialog)", () => {
    renderLayout();
    act(() => screen.getByRole("button", { name: "Open menu" }).click());
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
  });

  it("still shows the signed-in drawer without the auth links", () => {
    authState = {
      accessToken: "t",
      user: {
        username: "alice",
        displayName: "Alice",
        about: null,
        avatarUrl: null,
        createdAt: 1,
        email: "alice@example.com",
        role: "user",
        emailVerified: true,
        updatedAt: 1,
      },
    };
    renderLayout();
    act(() => screen.getByRole("button", { name: "Open menu" }).click());

    const menu = screen.getByRole("dialog", { name: "Menu" });
    const hrefs = Array.from(menu.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/broadcast");
    // No duplicate auth entry points for someone already signed in.
    expect(hrefs).not.toContain("/login");
    expect(hrefs).not.toContain("/register");
    // The header also shows Sign out at >= sm, so scope to the drawer.
    const menuButtons = Array.from(menu.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(menuButtons.join(" ")).toMatch(/sign out/i);
  });
});
