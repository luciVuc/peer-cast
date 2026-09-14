# CRYPTO.md — Cryptographic Channel Ownership

## Problem

PeerCast is a purely peer-to-peer system. Broadcasters pick a channel ID (PeerJS
peer ID) and share it with viewers. The signaling server (PeerJS) has **no
authentication** — anyone can register any ID. This means:

- **Accidental collisions:** Two broadcasters independently pick the same name.
- **Intentional squatting:** An attacker registers a victim's channel ID to
  block their broadcast or impersonate them.
- **Proof replay:** An attacker who connects as a viewer could capture a
  broadcast session's identity proof and re-use it when later squatting that
  channel ID, fooling viewers into trusting an impostor.

Since there is no central authority, traditional username/password protection
is impossible.

## Solution: Defence-in-Depth Cryptographic Channel Ownership

PeerCast uses **ECDSA P-256 keypair identity** with three complementary layers
of protection:

| Tier                           | What it does                                                                 | Where it lives                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **1** Per-viewer signed proofs | Proof is bound to the specific viewer's peer ID — captures can't be replayed | `packages/extension/lib/crypto-identity.js`, `packages/extension/offscreen.js`, `packages/extension/background.js` |
| **2** Blocking impostor UI     | Verification failure covers the video and demands explicit user action       | `packages/viewer/viewer.html`                                                                                      |
| **3** Public key pinning       | Returning viewers detect key changes across sessions via `localStorage`      | `packages/viewer/viewer.html`                                                                                      |
| **4** Authenticated PeerServer | Prevents squatting at the signaling layer (self-hosted, optional)            | See §Tier 4 below                                                                                                  |

---

### How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROADCASTER (one-time, on first install)                           │
│                                                                     │
│  1. Generate ECDSA P-256 keypair (Web Crypto API)                   │
│  2. Store keypair in chrome.storage.local (never leaves device)     │
│  3. Channel ID = base62(SHA-256(publicKeyRaw))[0:12]                │
│     e.g., "k7Xm9pQ2bN4a"                                           │
│                                                                     │
│  The channel ID IS the fingerprint of the public key.               │
│  Only the holder of the matching private key is the true owner.     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  BROADCASTER (each viewer connection — Tier 1)                      │
│                                                                     │
│  1. Viewer V connects — offscreen sends SIGN_VIEWER_PROOF to SW     │
│  2. SW signs fresh proof: ECDSA-SHA256(                             │
│       "peercast-identity-proof:<channelId>:<V.peerId>:<timestamp>", │
│       privateKey                                                    │
│     )                                                               │
│  3. Proof sent to V via PeerJS DataConnection metadata:             │
│     { publicKey, channelId, viewerPeerId, timestamp, signature }    │
│                                                                     │
│  The proof is unique per viewer — a captured proof is useless       │
│  against any other viewer connection.                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  VIEWER (on each connection)                                        │
│                                                                     │
│  TIER 1 — Cryptographic verification:                               │
│  1. Receive broadcaster's identity proof                            │
│  2. Compute: derivedId = base62(SHA-256(receivedPubKey))[0:12]      │
│  3. Check: derivedId === channelId we connected to?                 │
│     → NO = IMPOSTOR (public key doesn't match channel)              │
│  4. Check: proof.viewerPeerId === my own peer ID?                   │
│     → NO = REPLAY ATTACK (proof was captured from another session)  │
│  5. Check: timestamp within 15 minutes?                             │
│     → NO = STALE (per-viewer proofs are signed on demand)           │
│  6. Verify ECDSA signature on the payload                           │
│     → INVALID = IMPOSTOR (signature forged)                         │
│  All pass? → badge shows ✓ VERIFIED                                 │
│                                                                     │
│  TIER 2 — Blocking UI on failure:                                   │
│  If any check fails → video is paused + full-screen overlay blocks  │
│  the stream; user must click "Proceed anyway" to continue           │
│                                                                     │
│  TIER 3 — Public key pinning:                                       │
│  After first verified connection to a channel ID, the public key    │
│  is saved to localStorage. On every subsequent connection, the      │
│  incoming key is compared against the stored pin:                   │
│  → MISMATCH = amber banner warns of key change (broadcaster may     │
│    have reset identity, or this is a new person on a recycled ID)   │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Why This Defeats Attacks

| Attack Scenario                                                    | Outcome                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Attacker registers "k7Xm9pQ2bN4a" on PeerJS first                  | Viewers connect, attacker can't produce a valid proof → badge shows **"Impostor"** + blocking overlay |
| Attacker tries to forge the signature                              | Needs the private key → computationally infeasible                                                    |
| Attacker captures a proof from a legitimate session and replays it | `proof.viewerPeerId` won't match the new viewer's peer ID → **replay detected**                       |
| Attacker generates their own keypair                               | Their public key hashes to a _different_ channel ID → fingerprint mismatch detected                   |
| Attacker uses their own valid keypair for a channel they don't own | Fingerprint check fails (their key hashes to a different 12-char ID)                                  |
| Returning viewer connects after broadcaster reset identity         | Public key pin mismatch → amber banner warns, user decides whether to trust new key                   |
| Legitimate broadcaster comes online late                           | Gets "unavailable-id", retries. Viewers who connected to squatter saw "Impostor" + blocking overlay   |

---

### Tier 1 — Per-Viewer Proof Binding (Replay Prevention)

**The vulnerability in session-level proofs:** In a naive design, the broadcaster
signs a single proof at the start of the session and sends it to all viewers.
An attacker who connects as a viewer can capture this proof, later squat the
channel ID, and replay the captured proof to new viewers. Because the proof
contains the real broadcaster's public key and a valid signature, all three
cryptographic checks would pass — viewers would see "Verified" while watching
the attacker's stream.

**The fix:** Proofs are signed **per viewer**, with the viewer's PeerJS peer ID
embedded in the signed payload:

```
payload = "peercast-identity-proof:<channelId>:<viewerPeerId>:<timestamp>"
```

A captured proof is bound to the original viewer's peer ID (a random UUID-like
string generated fresh per session). Any other viewer's peer ID won't match.
The attacker would need to forge a new signature for each new viewer — which
requires the private key.

**Proof freshness:** Per-viewer proofs are signed on demand (at connection time),
so the timestamp is always very fresh. The validity window is **15 minutes**,
compared to 24 hours for legacy session-level proofs.

**Backward compatibility:** Proofs without a `viewerPeerId` field (old
broadcasters) are treated as legacy session proofs and verified with the
original 24-hour window. Viewers show "Verified" for them but without replay
protection. Old viewers that don't understand the new `viewerPeerId` field
simply ignore it.

---

### Tier 2 — Blocking Impostor UI

When verification fails, instead of a small dismissable badge, the viewer:

1. **Pauses the video** — the user is not passively watching while deciding
2. **Shows a full-screen overlay** with a red shield icon, the failure reason,
   and the channel ID
3. Provides two options:
   - **"Disconnect (recommended)"** — calls `disconnect()` cleanly
   - **"Proceed anyway — I understand the risk"** — bypasses and resumes video

The bypass is scoped to the current connection session. A fresh `connect()` or
`disconnect()` always resets `impostorBypassed`, so the overlay reappears on
every new connection that fails verification.

---

### Tier 3 — Public Key Pinning

After a viewer successfully verifies a channel's identity proof, the broadcaster's
public key is saved to `localStorage` under `peercast-pinned-key:<channelId>`.

On every subsequent connection to the same channel ID:

- The incoming proof's public key is compared against the stored pin **before**
  cryptographic verification
- If they differ, an amber warning banner appears:
  _"Broadcaster key changed — this channel was previously verified with a
  different key. The broadcaster may have reset their identity, or this could
  be a different person on a recycled channel."_
- The banner offers two options:
  - **"Trust new key"** — updates the stored pin and dismisses the banner
  - **Dismiss** — hides the banner but does not update the pin (will reappear
    next time)

This provides a persistent trust anchor without any server. Even if an attacker
generates a fresh keypair whose SHA-256 fingerprint collides with the target
channel ID (computationally infeasible at 71 bits), the pin mismatch would catch
it for returning viewers.

Auto-pinning is suppressed when a key-mismatch warning is active — the user
must explicitly trust the new key via the "Trust new key" button.

---

### Tier 4 — Authenticated PeerServer (Advanced Prevention)

**Tiers 1–3 are detective, not preventative.** They tell viewers that an
impostor is present, but cannot stop an attacker from registering your channel
ID on the signaling server in the first place. A sustained squatting attack can
prevent the legitimate broadcaster from registering at all (DoS).

**The only way to prevent squatting is to authenticate at the signaling layer.**
PeerCast supports self-hosted signaling (README "Advanced"); a custom PeerServer
can enforce cryptographic registration challenges.

#### Challenge-Response Registration Flow

```
Client (broadcaster)                  Custom PeerServer
      │                                      │
      │── WebSocket connect: id=k7Xm9pQ2 ──► │
      │                                      │─ ID matches fingerprint pattern?
      │◄── CHALLENGE { nonce: <random> } ────│  Yes → issue challenge
      │                                      │
      │── CLAIM { publicKey, signature } ───► │
      │    sign("peercast-claim:<id>:<nonce>")│─ Verify:
      │                                      │  1. SHA-256(publicKey)[0:12] === id
      │                                      │  2. ECDSA sig valid for nonce
      │◄── OPEN { src: id } ─────────────────│  Registration granted
      │                                      │
      │ [Attacker tries same id]             │
      │── WebSocket connect: id=k7Xm9pQ2 ──► │
      │◄── CHALLENGE ────────────────────────│
      │── CLAIM (no valid private key) ─────► │─ Signature fails → REJECTED
```

**Rules for custom IDs:** Channel IDs that don't match the 12-char base62
fingerprint pattern are allowed without challenge, preserving the custom-ID
use case.

**Forced eviction:** If the channel ID is currently squatted and the legitimate
owner appears with a valid proof, the server can evict the squatter immediately.

This is intentionally left as a reference architecture rather than built-in
functionality, because it requires self-hosted infrastructure. The PeerJS npm
package (`peer`) exposes `ExpressPeerServer` which can be wrapped with custom
WebSocket middleware to implement this flow.

---

## Alternative Prevention Strategies

Tier 4 (authenticated PeerServer) is the gold standard for squatting prevention
but requires writing and hosting a custom signaling server. Two lighter-weight
alternatives exist, each trading a different feature for simplicity. Both keep
Tiers 1–3 intact — the identity proof and verification logic are unchanged.

---

### Alternative A — Ephemeral Session IDs (zero infrastructure)

**Core idea:** If the PeerJS peer ID the broadcaster registers is a fresh random
value generated at broadcast-start time, an attacker has nothing to pre-register.
Squatting becomes structurally impossible — you cannot reserve a value you
cannot predict.

The persistent crypto fingerprint (`k7Xm9pQ2bN4a`) is retained as the
**channel identity and verification anchor**. It just never touches PeerJS.

#### URL format change

```
Current (persistent ID):
  PeerJS registration  =  k7Xm9pQ2bN4a         ← squattable
  Viewer link          =  viewer.html#k7Xm9pQ2bN4a

Ephemeral ID:
  PeerJS registration  =  f3a9c1b72e4d8a...    ← random UUID, unknowable in advance
  Viewer link          =  viewer.html#k7Xm9pQ2bN4a/f3a9c1b72e4d8a
                                  ↑ channel identity   ↑ session rendezvous ID
```

The viewer URL carries both parts. The viewer connects to the session ID for
the WebRTC call, and uses the channel identity to verify the identity proof
— exactly as today.

#### Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROADCASTER (each broadcast start)                                 │
│                                                                     │
│  1. Generate random session ID: sessionId = crypto.randomUUID()     │
│  2. Register sessionId on PeerJS (not the fingerprint)              │
│  3. Popup displays viewer link:                                     │
│       viewer.html#<channelId>/<sessionId>                           │
│  4. On each viewer connection: sign per-viewer proof as today       │
│     (proof still carries channelId + viewerPeerId + timestamp)      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  VIEWER                                                             │
│                                                                     │
│  1. Parse URL hash: channelId = "k7Xm9pQ2bN4a",                    │
│                     sessionId = "f3a9c1b72e4d8a"                   │
│  2. Connect to PeerJS peer sessionId                               │
│  3. Receive identity proof — verify against channelId (unchanged)  │
│  4. Tiers 1–3 apply exactly as today                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  ATTACKER                                                           │
│                                                                     │
│  Cannot squat: the session ID is a random UUID generated only at    │
│  broadcast-start. No advance knowledge → nothing to reserve.        │
└─────────────────────────────────────────────────────────────────────┘
```

#### Attack resistance

| Attack                                                                        | Outcome                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Attacker pre-registers `k7Xm9pQ2bN4a`                                         | Irrelevant — broadcaster never registers that ID                |
| Attacker guesses the random session ID                                        | 2¹²² attempts for a UUID v4 — computationally infeasible        |
| Attacker connects as a viewer, captures session ID, then tries next broadcast | Next broadcast generates a fresh UUID — captured value is stale |
| Attacker generates own keypair to pass verification                           | Fingerprint mismatch — Tier 1 catches it (same as today)        |

#### Tradeoffs

| Feature                              | Current (persistent ID)    | Ephemeral ID                         |
| ------------------------------------ | -------------------------- | ------------------------------------ |
| Squatting prevention                 | Detection only (Tiers 1–3) | ✅ Structural — nothing to squat     |
| Viewer auto-reconnect to a fixed URL | ✅                         | ❌ Session ID changes each broadcast |
| Bookmark-friendly permanent link     | ✅                         | ❌ Link is per-broadcast             |
| Additional infrastructure            | None                       | **None**                             |
| Code changes                         | None                       | Low — ID generation + URL parser     |
| Identity proof / Tiers 1–3           | Unchanged                  | **Unchanged**                        |

**Auto-reconnect is the headline cost.** Viewers who bookmark `viewer.html#k7Xm9pQ2bN4a`
and expect to rejoin automatically after a broadcast restart cannot do so — the
session ID in the URL is stale. For meeting-style workflows (send a fresh invite
link each session) the tradeoff is invisible. For always-on channels with a
permanent public URL it is a genuine regression.

#### When to choose Alternative A

- Broadcast sessions are invite-based (a new link is shared per session).
- Auto-reconnect / persistent channel URLs are not required.
- Zero additional infrastructure is a hard constraint.
- Maximum squatting resistance is more important than link permanence.

---

### Alternative B — Tiny Session Registry (minimal infrastructure)

**Core idea:** Combine ephemeral session IDs (Alternative A) with a
microscopic server-side "pin board". The broadcaster pushes its current
session ID to the registry on broadcast-start; viewers look it up via the
stable channel fingerprint before dialling. This restores auto-reconnect while
keeping PeerJS IDs ephemeral and unsquattable.

This is **significantly simpler than a custom PeerServer** — no WebSocket
middleware, no PeerJS protocol knowledge, no challenge-response state machine.
It is a single authenticated write endpoint and a single read endpoint.

#### API surface (the entire server)

```
POST /announce
  Body: { channelId, sessionPeerId, timestamp, publicKey, signature }
  Server checks:
    1. SHA-256(publicKey)[0:12] === channelId
    2. ECDSA-P256 signature valid over
       "peercast-session:<channelId>:<sessionPeerId>:<timestamp>"
    3. timestamp within 60 seconds of server time (replay window)
  On success: store channelId → { sessionPeerId, publicKey, expiresAt }
  Response: 200 OK  |  401 Unauthorized

GET /session/:channelId
  Response: { sessionPeerId, publicKey, expiresAt }  |  404 Not Found
```

#### Flow

```
Broadcaster (on broadcast start):
  1. Generate random sessionPeerId
  2. Register sessionPeerId on PeerJS
  3. Sign announcement: ECDSA(
       "peercast-session:<channelId>:<sessionPeerId>:<timestamp>",
       privateKey
     )
  4. POST /announce → registry stores channelId → sessionPeerId
  5. Viewer link:  viewer.html#k7Xm9pQ2bN4a   (unchanged — no session ID needed)

Viewer (on connect / auto-reconnect):
  1. Has channelId = "k7Xm9pQ2bN4a" from URL hash
  2. GET /session/k7Xm9pQ2bN4a  →  sessionPeerId = "f3a9c1b72e..."
  3. Connect to PeerJS peer sessionPeerId
  4. Receive and verify identity proof — Tiers 1–3 unchanged

Attacker trying to squat:
  1. POST /announce with channelId = "k7Xm9pQ2bN4a"
  2. Server verifies signature → fails (no private key) → 401 Rejected
  3. Cannot update the registry → viewers always reach the real broadcaster
```

#### Tradeoffs

| Feature                        | Tier 4 (custom PeerServer)                                             | Alternative B (registry)                                                 |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Squatting prevention           | ✅ Signaling layer                                                     | ✅ Registry layer                                                        |
| Viewer auto-reconnect          | ✅                                                                     | ✅                                                                       |
| Persistent channel URLs        | ✅                                                                     | ✅                                                                       |
| Infrastructure complexity      | High — full PeerJS server + WebSocket auth middleware + eviction logic | **Low — ~30-line stateless service**                                     |
| Deployment                     | Self-hosted PeerServer required                                        | Any serverless platform (Cloudflare Worker, AWS Lambda, Vercel function) |
| Offline / no-registry fallback | N/A                                                                    | Degrades to Tiers 1–3 (detective only) if registry unreachable           |
| PeerJS compatibility           | Requires matching PeerJS version                                       | Uses standard PeerJS unmodified                                          |

#### Implementation sketch (~30 lines, Cloudflare Worker)

```js
import { subtle } from "crypto";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Write: broadcaster announces current session
    if (req.method === "POST" && url.pathname === "/announce") {
      const { channelId, sessionPeerId, timestamp, publicKey, signature } =
        await req.json();
      const age = Math.abs(Date.now() - timestamp);
      if (age > 60_000) return new Response("stale", { status: 401 });

      // 1. Verify fingerprint: SHA-256(publicKey)[0:12] === channelId
      const raw = new Uint8Array(publicKey);
      const hash = new Uint8Array(await subtle.digest("SHA-256", raw));
      const derived = base62(hash).slice(0, 12);
      if (derived !== channelId)
        return new Response("fingerprint mismatch", { status: 401 });

      // 2. Verify ECDSA signature
      const key = await subtle.importKey(
        "raw",
        raw,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const payload = `peercast-session:${channelId}:${sessionPeerId}:${timestamp}`;
      const valid = await subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        new Uint8Array(signature),
        new TextEncoder().encode(payload),
      );
      if (!valid) return new Response("bad signature", { status: 401 });

      await env.SESSIONS.put(
        channelId,
        JSON.stringify({
          sessionPeerId,
          publicKey,
          expiresAt: Date.now() + 8 * 3600_000, // 8-hour TTL
        }),
      );
      return new Response("ok");
    }

    // Read: viewer looks up current session for a channel
    if (req.method === "GET" && url.pathname.startsWith("/session/")) {
      const channelId = url.pathname.split("/").pop();
      const entry = await env.SESSIONS.get(channelId);
      if (!entry) return new Response("not found", { status: 404 });
      const data = JSON.parse(entry);
      if (data.expiresAt < Date.now())
        return new Response("not found", { status: 404 });
      return Response.json(data);
    }

    return new Response("not found", { status: 404 });
  },
};
```

The KV store (`env.SESSIONS`) provides durability; the Worker itself is stateless.

#### When to choose Alternative B

- Persistent channel URLs and viewer auto-reconnect are required.
- A minimal hosted function is acceptable (Cloudflare Workers free tier is sufficient).
- A full custom PeerServer is too operationally complex.
- You want squatting prevention without touching PeerJS internals.

---

## Squatting Prevention — Decision Matrix

| Approach                              | Squatting prevention | Auto-reconnect | Persistent links | Infrastructure               |
| ------------------------------------- | -------------------- | -------------- | ---------------- | ---------------------------- |
| **Tiers 1–3 (current)**               | Detection only       | ✅             | ✅               | None                         |
| **Alternative A — Ephemeral IDs**     | ✅ Structural        | ❌             | ❌               | None                         |
| **Alternative B — Session Registry**  | ✅ Structural        | ✅             | ✅               | ~30-line serverless function |
| **Tier 4 — Authenticated PeerServer** | ✅ Signaling layer   | ✅             | ✅               | Full self-hosted PeerServer  |

> **The fundamental tension:** squatting is a server-side registration problem.
> Tiers 1–3 accept it cannot be prevented without infrastructure and focus on
> making it detectable and harmless to viewers. Alternatives A and B make
> squatting structurally impossible — A with zero infrastructure at the cost of
> persistent links; B with minimal infrastructure while keeping the full UX.
> Tier 4 solves it at the signaling layer but at the highest operational cost.

---

### Entropy & Collision Resistance

- Channel ID = 12 characters of base62 = **~71 bits of entropy**
- Probability of two random identities colliding: ~1 in 3.2 × 10²¹
- Finding a keypair whose fingerprint matches a target ID requires ~2⁷¹ attempts
  (computationally infeasible, comparable to Bitcoin address collision)

---

## Implementation Details

### Files

| File                                                            | Role                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/extension/lib/crypto-identity.js`                     | Core module: keygen, derivation, signing (session + per-viewer), verification |
| `packages/viewer/crypto-identity.js`                            | Vendored copy for the standalone viewer PWA (always identical to lib/)        |
| `packages/extension/background.js`                              | Identity storage, per-viewer proof signing (`SIGN_VIEWER_PROOF` handler)      |
| `packages/extension/offscreen.js`                               | Requests per-viewer proofs from background, sends via DataConnection          |
| `packages/viewer/viewer.html`                                   | Receives proof, verifies (Tier 1), blocking UI (Tier 2), key pinning (Tier 3) |
| `packages/extension/popup.html` / `packages/extension/popup.js` | Shows "owned" badge, crypto channel ID pre-fill, reset button                 |

### Storage Schema

```jsonc
// chrome.storage.local
{
  "cryptoIdentity": {
    "channelId": "k7Xm9pQ2bN4a",         // derived fingerprint
    "publicKeyRaw": [4, 123, ...],         // 65-byte uncompressed P-256 point
    "privateKeyJwk": { "kty": "EC", ... }, // JWK private key
    "publicKeyJwk": { "kty": "EC", ... }   // JWK public key
  }
}

// localStorage (viewer, per channel)
{
  "peercast-pinned-key:k7Xm9pQ2bN4a": "[4, 123, ...]"   // Tier 3 pin
}
```

### Message Flow

```
background.js                    offscreen.js               viewer
     │                                │                       │
     │ ← GET_IDENTITY (popup)         │                       │
     │ → { channelId }                │                       │
     │                                │                       │
     │ ── START { identityEnabled } ► │                       │
     │                                │                       │
     │                                │ ◄── call ──────────── │
     │                                │ ── answer(stream) ──► │
     │                                │                       │
     │ ◄─ SIGN_VIEWER_PROOF ──────── │                       │
     │    { viewerPeerId, channelId } │                       │
     │ ─► { proof } ─────────────── ► │                       │
     │                                │ ── DataConnection ──► │
     │                                │    metadata:          │
     │                                │    { type:            │
     │                                │      "identity-proof",│
     │                                │      proof: {...} }   │
     │                                │                       │
     │                                │            [Tier 1] verify proof
     │                                │            [Tier 2] block if failed
     │                                │            [Tier 3] pin / check key
     │                                │            show badge
```

### Viewer UI States

| Badge                                     | Meaning                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| 🛡️✓ **Verified** (green)                  | Proof valid — broadcaster owns this channel ID              |
| 🛡️✗ **Impostor** (red) + blocking overlay | Proof failed — possible squatter/impostor                   |
| 🛡️? **Unverified** (gray)                 | No proof received (legacy broadcaster or custom channel ID) |
| ⚠️ Key changed (amber banner)             | Valid proof but different key than previously pinned        |

### Custom Channel IDs

Broadcasters may still override the crypto-derived channel ID with a custom
string (for branding, memorability, etc.). When they do:

- **No identity proof is sent** (the crypto fingerprint doesn't match)
- Viewers see the "Unverified" badge
- The broadcaster loses the anti-squatting guarantee

The popup UI clearly communicates this trade-off.

### Identity Reset

In Advanced settings, broadcasters can reset their identity (generate a new
keypair). This is **destructive** and irreversible:

- A new channel ID is derived from the new keypair
- The old ID is abandoned (anyone can claim it)
- Viewers with bookmarks to the old ID won't find the broadcaster
- Returning viewers will see the **"Broadcaster key changed"** amber banner
  on their next connection

A confirmation dialog warns about the consequences.

---

## Threat Model Boundaries

This system **does** protect against:

- Peer ID squatting / hijacking (Tiers 1–3 detect; Tier 4 prevents)
- Impersonation on the signaling server
- Viewers unknowingly watching an impostor's stream (Tier 1 + 2)
- Proof replay attacks — captured proofs cannot be re-used for other viewers (Tier 1)
- Silent key-swap by a squatter with their own valid keypair (Tier 3)

This system **does not** protect against:

- A compromised device (attacker steals the private key from storage)
- A viewer who ignores warnings and clicks "Proceed anyway"
- Denial of service (attacker squats the ID so the real broadcaster can't register)
  — though this is mitigated by the retry loop, and Tier 4 eliminates it entirely
  for self-hosted deployments

---

## API Reference

### `PeerCastCrypto.generateKeyPair()`

Returns `{ publicKeyRaw: number[], privateKeyJwk, publicKeyJwk }`.

### `PeerCastCrypto.deriveChannelId(publicKeyRaw)`

Returns the 12-char base62 channel ID string.

### `PeerCastCrypto.signIdentityProof(privateKeyJwk, publicKeyRaw, channelId)`

**Legacy** — signs a session-level proof without viewer binding. Kept for
backward compat; new code uses `signViewerProof` instead.

Returns `{ type, publicKey, channelId, timestamp, signature }`.

### `PeerCastCrypto.signViewerProof(privateKeyJwk, publicKeyRaw, channelId, viewerPeerId)`

**New (Tier 1)** — signs a per-viewer proof that binds to a specific viewer's
peer ID. Called by `packages/extension/background.js` in response to `SIGN_VIEWER_PROOF` messages
from the offscreen host.

Returns `{ type, publicKey, channelId, viewerPeerId, timestamp, signature }`.

### `PeerCastCrypto.verifyIdentityProof(expectedChannelId, proof, myPeerId?)`

Verifies an identity proof received from a broadcaster.

- `expectedChannelId` — the channel ID the viewer connected to
- `proof` — the received proof object
- `myPeerId` — the viewer's own PeerJS peer ID (required for Tier 1 binding check)

Returns `{ valid: boolean, reason?: string }`.

Checks performed:

1. Fingerprint: `SHA-256(proof.publicKey)[0:12] === expectedChannelId`
2. Viewer binding (if `proof.viewerPeerId` present): `proof.viewerPeerId === myPeerId`
3. Freshness: ≤15 min for per-viewer proofs, ≤24h for legacy proofs
4. ECDSA signature validity

---

## Cryptographic Primitives

| Primitive        | Algorithm                 | Justification                                                           |
| ---------------- | ------------------------- | ----------------------------------------------------------------------- |
| Key generation   | ECDSA P-256               | Universal Web Crypto support, small keys (65B public), fast sign/verify |
| Fingerprint hash | SHA-256                   | Standard, preimage-resistant, available in SubtleCrypto                 |
| Encoding         | Base62 (alphanumeric)     | URL-safe, human-readable, no special characters                         |
| Signature        | ECDSA with SHA-256 digest | Compact (64B), fast verification, non-repudiable                        |
