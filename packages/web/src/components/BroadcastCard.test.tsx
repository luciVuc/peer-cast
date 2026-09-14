import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { BroadcastWithUser } from "@peer-cast/shared";
import { BroadcastCard } from "./BroadcastCard";

const broadcast: BroadcastWithUser = {
  id: "b1",
  username: "alice",
  title: "Live coding",
  description: null,
  status: "live",
  access: "public",
  source: "screen",
  peerId: null,
  startedAt: Date.now(),
  endedAt: null,
  peakViewers: 3,
  totalViews: 3,
  owner: {
    username: "alice",
    displayName: "Alice Johnson",
    about: null,
    avatarUrl: null,
    createdAt: 1,
  },
  stats: {
    viewers: 7,
    bitrateKbps: 1000,
    fps: 30,
    width: 1280,
    height: 720,
    updatedAt: Date.now(),
  },
};

describe("BroadcastCard", () => {
  it("renders title, owner, viewer count and links to the viewer page", () => {
    render(
      <MemoryRouter>
        <BroadcastCard broadcast={broadcast} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Live coding")).toBeInTheDocument();
    expect(screen.getByText(/Alice Johnson/)).toBeInTheDocument();
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByText(/👁 7/)).toBeInTheDocument();
    expect(screen.getByText(/1000 kbps/)).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/watch/alice");
  });
});
