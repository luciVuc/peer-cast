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
let broadcastStatus: "idle" | "starting" | "live" | "ending" = "idle";

vi.mock("../store", () => ({
  useAppDispatch: () => () => {},
  useAppSelector: (sel: (s: unknown) => unknown) =>
    sel({
      auth: authState,
      broadcast: {
        status: broadcastStatus,
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

/** Visible only from `bp` and up. */
function showsAt(el: Element, bp: "sm" | "lg"): boolean {
  return (
    el.className.includes(`${bp}:block`) && el.className.includes("hidden")
  );
}

describe("responsive header actions", () => {
  beforeEach(() => {
    authState = { accessToken: null, user: null };
    broadcastStatus = "idle";
  });

  const signedIn = (role = "user") => {
    authState = {
      accessToken: "t",
      user: {
        username: "alice",
        displayName: "Alice Johnson",
        about: null,
        avatarUrl: null,
        createdAt: 1,
        email: "alice@example.com",
        role,
        emailVerified: true,
        updatedAt: 1,
      },
    };
  };

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
    signedIn();
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

  describe("signed-in top bar", () => {
    beforeEach(signedIn);

    it("hides the idle Go live action below sm, since the drawer carries it", () => {
      renderLayout();
      const goLive = screen.getByRole("link", { name: "Start a broadcast" });
      expect(isHiddenBelowSm(goLive)).toBe(true);
    });

    it("keeps the Live status pill visible at every width", () => {
      broadcastStatus = "live";
      renderLayout();
      const live = screen.getByRole("link", {
        name: "Manage your live broadcast",
      });
      // Status feedback, not navigation: it must NOT collapse into the drawer.
      expect(live.className).not.toMatch(/\bhidden\b/);
      expect(live.className).toContain("whitespace-nowrap");
    });

    it("gives the avatar link an accessible name", () => {
      renderLayout();
      // Without this a screen reader announces "AJ, link" — the initials carry
      // no meaning about where the link goes.
      expect(
        screen.getByRole("link", { name: /your account \(alice johnson\)/i }),
      ).toBeInTheDocument();
    });

    it("keeps Dashboard and Sign out collapsed below sm", () => {
      renderLayout();
      expect(
        isHiddenBelowSm(screen.getByRole("link", { name: "Dashboard" })),
      ).toBe(true);
      expect(
        isHiddenBelowSm(screen.getByRole("button", { name: "Sign out" })),
      ).toBe(true);
    });

    it("shows an Admin link in the drawer for an admin account", () => {
      signedIn("admin");
      renderLayout();
      act(() => screen.getByRole("button", { name: "Open menu" }).click());
      const menu = screen.getByRole("dialog", { name: "Menu" });
      const hrefs = Array.from(menu.querySelectorAll("a")).map((a) =>
        a.getAttribute("href"),
      );
      expect(hrefs).toContain("/admin");
    });

    it("does not offer an Admin link to a normal account", () => {
      renderLayout();
      act(() => screen.getByRole("button", { name: "Open menu" }).click());
      const menu = screen.getByRole("dialog", { name: "Menu" });
      const hrefs = Array.from(menu.querySelectorAll("a")).map((a) =>
        a.getAttribute("href"),
      );
      expect(hrefs).not.toContain("/admin");
    });

    it("never lets a nav label wrap onto a second line", () => {
      renderLayout();
      // "Go live" and "Sign out" both wrapped at narrow widths before this, which
      // is what pushed the bar past its container and caused the overflow.
      // The Go live link is labelled "Start a broadcast" via aria-label, so
      // query by accessible name rather than visible text.
      const labelled = [
        screen.getByRole("link", { name: "Start a broadcast" }),
        screen.getByRole("button", { name: "Sign out" }),
        screen.getByRole("link", { name: "Dashboard" }),
      ];
      for (const el of labelled) {
        expect(el.className).toContain("whitespace-nowrap");
      }
    });

    it("shows the desktop search form only from lg, not sm", () => {
      renderLayout();
      const form = document.querySelector("header form")!;
      // Between sm and lg the full inline nav is present, and a `flex-1` input
      // absorbs all the slack and collapses to an unusable sliver. The search
      // icon covers that range instead.
      expect(showsAt(form, "lg")).toBe(true);
      expect(form.className).not.toContain("sm:block");
      expect(form.className).toContain("min-w-0");
    });

    it("keeps the search icon available below lg", () => {
      renderLayout();
      const search = screen.getByRole("button", { name: /search/i });
      expect(search.className).toContain("lg:hidden");
    });
  });
});
