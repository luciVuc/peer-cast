import { describe, expect, it } from "vitest";
import { CHAT_MAX_LENGTH } from "@peer-cast/shared";
import { packChat, sanitizeChat, unpackChat } from "./peer";

describe("chat protocol", () => {
  it("round-trips a chat line through the wire format", () => {
    const line = JSON.stringify(packChat("alice", "hello world"));
    const msg = unpackChat(line);
    expect(msg).toMatchObject({
      kind: "chat",
      from: "alice",
      text: "hello world",
    });
    expect(msg?.id).toBeTruthy();
    expect(msg?.ts).toBeGreaterThan(0);
  });

  it("rejects non-chat payloads", () => {
    expect(unpackChat("not json")).toBeNull();
    expect(unpackChat(JSON.stringify({ kind: "ping" }))).toBeNull();
    expect(unpackChat(JSON.stringify({ kind: "chat", text: 42 }))).toBeNull();
    expect(unpackChat(null)).toBeNull();
  });
});

describe("chat sanitization (host relay)", () => {
  it("attributes to the verified ticket name, never the wire `from`", () => {
    // A malicious viewer forging the host's name must be relabelled.
    const spoofed = packChat("Host", "drop your Discord keys");
    const out = sanitizeChat(spoofed, "alice");
    expect(out.from).toBe("alice");
    expect(out.text).toBe("drop your Discord keys");
  });

  it("falls back to Viewer when no verified identity exists", () => {
    const out = sanitizeChat(packChat("Alice", "hi"));
    expect(out.from).toBe("Viewer");
  });

  it("truncates over-long lines to CHAT_MAX_LENGTH", () => {
    const long = "x".repeat(CHAT_MAX_LENGTH + 100);
    const out = sanitizeChat(packChat("alice", long), "alice");
    expect(out.text.length).toBe(CHAT_MAX_LENGTH);
  });
});
