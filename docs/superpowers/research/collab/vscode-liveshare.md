# VS Code Live Share + VS Code Tunnels / Dev Tunnels — product study for TermX session sharing

**Study date:** 2026-08-22
**Studied by:** research subagent (product-study lane)
**Target repo:** C:\Dev\TermX
**Report path:** C:\Dev\TermX\docs\superpowers\research\collab\vscode-liveshare.md

**Method note.** Live Share is **closed source**: there is no implementation to read. Everything below is drawn from Microsoft's public documentation, the Live Share security writeup, the Visual Studio devblog announcing enterprise policies, and the Dev Tunnels security doc. Claims are tagged **[VERIFIED-DOC]** when a Microsoft doc states them explicitly (usually with a quote), **[INFERRED]** when I am reasoning from doc behaviour to likely implementation, and **[ABSENT]** when the docs are silent on something TermX cares about (a silence that is itself a finding).

---

## 0. Headline for the impatient

Live Share is the field's best **consent-and-roles** prior art, not its best transport prior art. Three things it gets right that TermX must copy:

1. **Terminal access is a separate, explicit, per-terminal grant** — not a property of "being in the session." A guest who is fully joined and co-editing still has **no terminal** unless the host shares one, and only the host can create one.
2. **Read-only is a first-class, visible session state**, surfaced in the status bar on *both* sides ("Host: Sharing Read-only" / "Guest: Joined Read-only"), not a hidden flag.
3. **Every join is announced to the host with a one-click eject**, and approval can be escalated from notify-after to approve-before by a setting — with an org policy that can *force* approve-before.

And one thing Live Share is missing that TermX's admin-oversight feature makes mandatory: **there is no audit trail**. Live Share is designed for *symmetric consent between peers who both have a UI*. Admin oversight is *asymmetric*, and asymmetry is exactly where an audit log stops being nice-to-have.

**Status flag:** as of the 2026-05-22 docs revision, **"Visual Studio Live Share is in maintenance mode, with no additional features planned."** [VERIFIED-DOC] Study it as a finished design, not a moving target. Microsoft's own forward path for remote work is **tunnels**, which is why this study covers both.

---

## 1. License verdict

| Artifact | License | Verdict for TermX |
| --- | --- | --- |
| Live Share extension (VS Code + VS) | Proprietary Microsoft product license (`https://aka.ms/vsls-license`). "The software is licensed, not sold. Microsoft reserves all other rights… you will not share, publish, distribute, or lease the software." [VERIFIED-DOC] | **Learn only.** No source exists to borrow; the EULA forbids redistribution. |
| `github.com/microsoft/live-share` | Feedback/issue-tracker + docs repo, **not source**. Docs under CC-BY-4.0; code samples under MIT. [VERIFIED-DOC] | **Learn only** for docs; the CC-BY-4.0 docs may be quoted/adapted **with attribution**. Do not paste doc prose into TermX UI copy without attribution or a rewrite. |
| `github.com/microsoft/live-share-sdk` (Teams/M365 Fluid-based "Live Share SDK") | Separate "Microsoft Live Share SDK" license — proprietary, pre-release variants for Turbo/React. **Different product**; it is the Teams Fluid collaboration SDK, not VS Code Live Share. | **Ignore** — wrong product, and proprietary anyway. |
| Dev Tunnels service | Proprietary Azure service. Client CLI partially open-sourced (the VS Code Server tunnel implementation is stated to be open-sourced on GitHub) [VERIFIED-DOC, unverified as to which exact repo/license]. | **Learn only** unless a specific repo+license is confirmed. |
| Microsoft Learn doc text | Standard Microsoft Learn terms; the `microsoft/live-share` mirror is CC-BY-4.0. | Quote with attribution. |

**Net:** TermX may **learn from** Live Share and tunnels freely. TermX may **not borrow code** — none is published, and the EULA is restrictive. The one reusable asset is *design vocabulary* (role names, setting names, state labels), which is not copyrightable as an idea; TermX should still write its own strings rather than copy Microsoft's UI copy verbatim.

---

## 2. Architecture (docs level)

### 2.1 Live Share topology

```
  HOST machine                          Live Share service (Azure)         GUEST machine
  ┌──────────────────────┐              ┌────────────────────────┐        ┌──────────────┐
  │ VS Code / VS         │  publish     │ - user auth (MSA/AAD/  │  fetch │ VS Code / VS │
  │ + vsls-agent         │─ session ────▶   GitHub)              │◀───────│ + vsls-agent │
  │ (SSH SERVER role)    │  metadata:   │ - session discovery    │  link  │ (SSH client) │
  │ owns ALL content:    │  host pubkey │ - issues guest JWT     │        └──────┬───────┘
  │ files, terminals,    │  + endpoint  │ - NEVER sees content   │               │
  │ debug, ports         │              └───────────┬────────────┘               │
  └──────────┬───────────┘                          │                            │
             │  DIRECT mode: LAN TCP 5990-5999      │ RELAY mode: Azure Relay    │
             │  (SSH over the wire)                 │ (*.servicebus.windows.net) │
             └──────────────── SSH session, end-to-end encrypted ────────────────┘
                     code · terminals · shared ports · debug all ride HERE
```

**[VERIFIED-DOC]** Key statements, quoted:

- *"When initiating a session between peers, Live Share attempts to establish a peer-to-peer connection, and only if that isn't possible (e.g. due to firewalls/NATs), does it fall back to using a cloud relay."*
- *"in both connection types (P2P or relay), all data transmitted between peers is end-to-end encrypted using the SSH protocol. In the case of a relay connection, the SSH encryption is layered on top of TLS-encrypted WebSockets. This means that Live Share doesn't depend on the cloud relay service for security. Even if the relay was compromised, it could not decrypt any of the Live Share communication."*
- *"The role of the Live Share service is limited to user authentication and session discovery. The service itself does not store or ever have access any of the content of a session. All user content in Live Share is transmitted over the SSH session. That includes code, terminals, shared servers, and any other collaboration features."*
- **Content never leaves the host.** *"all content that is shared is kept on the host's machine and not synchronized to the cloud or on the guest's machine"* — the guest gets a *remote view*, not a copy. Temp files the guest's editor creates are cleaned up on session end.

### 2.2 Crypto and peer authentication (the part TermX should copy literally)

**[VERIFIED-DOC]**

- SSH Diffie-Hellman key exchange → AES session key; **key rotated periodically during the session**; *"The shared session secret and all encryption keys are only maintained in-memory by both sides… They are never written to disk or sent to any service (including Live Share)."*
- **Host authenticates itself to the guest by public key.** *"When a host shares a Live Share session, it generates a unique RSA public/private key-pair for the session. The host private key is kept only in memory in the host process… The host public key is published to the Live Share service along with the session connection information (IP address and/or relay endpoint) where guests can access it via the invitation link."* The guest verifies the host holds the matching private key.
- **Guest authenticates itself to the host by a signed JWT.** *"The token is a signed JWT issued by the Live Share service that includes claims about the user identity (obtained via MSA, AAD, or GitHub sign-in). The token also has claims that indicate the guest is allowed to access that specific Live Share session… The host validates that token and checks the claims (and depending on options may prompt the host user) before allowing the guest to join."*

This is the crucial structural point: **the invitation link is not the credential.** The link carries a non-guessable *session identifier*; the actual credential is a service-issued, identity-bearing, session-scoped JWT. The link gets you the right to *ask*; the JWT says *who is asking*; the host decides. Compare with tmate/sshx-style designs where the link *is* the capability — Live Share deliberately splits "discovery" from "authorization."

### 2.3 Connection modes

| Mode | Host behaviour | Guest behaviour | Requirement |
| --- | --- | --- | --- |
| **Auto** (default) | accepts direct **or** relayed | tries direct, falls back to relay | mixed per-guest in one session |
| **Direct** | direct only, no relay | tries direct, gives up if it fails | inbound TCP 5990-5999 on host; firewall entry for `vsls-agent` / `code` |
| **Relay** | no direct, **no port opened on host** | always relayed | outbound `*.servicebus.windows.net:443` |

Set via `liveshare.connectionMode` = `auto` | `direct` | `relay` (restart required). [VERIFIED-DOC]

Required endpoints in all modes: `*.liveshare.vsengsaas.visualstudio.com:443`, `*.online.visualstudio.com`; VS Code additionally `download.microsoft.com:443`. [VERIFIED-DOC]

### 2.4 Tunnels / Remote Tunnels (Microsoft's forward path)

**[VERIFIED-DOC]**

- **Outbound-only.** *"VS Code will make outbound connections to a service hosted in Azure; no firewall changes are generally necessary, and VS Code doesn't set up any network listeners."*
- **Same-identity requirement.** Hosting and connecting both require *"the same Github or Microsoft account on each end."* This is a fundamentally different trust model from Live Share: tunnels are **remote access to your own machine**, Live Share is **inviting others into your machine**.
- SSH is layered **over** the tunnel for end-to-end encryption; preferred cipher AES-256-CTR.
- Machine registration: `code tunnel` registers a named machine; URL is `https://vscode.dev/tunnel/<machine_name>/<folder_name>`. Revocation is `code tunnel unregister` or via the Remote Explorer UI, and *"you can revoke tunnel access from your GitHub account at any time."*
- **Liveness = presence.** *"The remote machine will only be reachable through a tunnel while VS Code remains running there."* No daemon, no session survives the process. (This is precisely the property TermX's persistent ConPTY daemon is *designed to beat* — worth noting as a TermX advantage, not a gap.)
- Org control is coarse and network-level: allow/deny `global.rel.tunnels.api.visualstudio.com`.

### 2.5 Dev Tunnels access-token model (the best single structure to steal)

**[VERIFIED-DOC]** — from the Dev Tunnels security doc:

- **Default private.** *"By default, tunnels and tunnel ports are private and only accessible to the user who created the tunnel."*
- Access can be widened deliberately: `--allow-anonymous`, `--tenant` (Entra tenant), `--organization` (a GitHub org, via installing a Dev Tunnels GitHub app so the service can check membership).
- **Four capability-scoped token types**, all scoped to one tunnel:
  - **client access token** — connect to ports.
  - **host access token** — host the tunnel and accept connections, *but not change it*.
  - **manage ports access token** — add/delete ports.
  - **management access token** — everything including ACLs and deletion.
- *"All of the tokens are limited to the current tunnel; they don't grant access to any of the current user's other tunnels."*
- **Tokens expire (currently 24 hours).** *"Tokens can only be refreshed using an actual user identity that has manage-scope access to the tunnel (not just a management access token)."* — i.e. **a bearer token can never bootstrap its own immortality.**
- Web clients pass `X-Tunnel-Authorization: tunnel <TOKEN>` — a **deliberately non-standard header** so it cannot collide with the tunneled app's own `Authorization`.
- **Anti-phishing interstitial** on first visit to a web-forwarding URL, with documented skip conditions (non-GET, no `text/html` in Accept, explicit skip header, token header present, or the user already continued).
- Port visibility in VS Code's Ports view is **Private by default**; flipping to Public is an explicit right-click action, and Private requires the visitor to sign in with the same GitHub account. [VERIFIED-DOC]

---

## 3. Roles, capabilities, and the consent design

### 3.1 The role model

**[VERIFIED-DOC]** *"All collaboration activities… involve a single collaboration session host and one or more guests. The host is the person who started the collaboration session and anyone that joins is a guest."*

Two roles only. No "co-host," no delegation, no admin. Everything is decided by the host. The capability difference:

> *"Collaboration session hosts can use all of their tools and services but guests are only given access to the specific things the host has shared with them."*

That is the whole philosophy in one sentence: **the host's capability set is ambient; the guest's is enumerated.**

### 3.2 The capability matrix (what a guest can do, by default)

| Capability | Guest default | How it changes | Enforcement point |
| --- | --- | --- | --- |
| See/navigate shared file tree | yes | `.vsls.json` `hideFiles` / `excludeFiles` / `gitignore` | **host process** — excluded files are never opened for the guest even via Go-to-Definition, follow, or debug step-in |
| Edit files | yes | session-level **read-only mode** chosen by host at share time | host |
| Run arbitrary commands via Code Actions / CodeLens | **no** | `liveshare.languages.allowGuestCommandControl: true` | host |
| **Terminal — read output** | **no** in VS; **read-only auto-shared** in VS Code (`liveshare.autoShareTerminals`, default true) | host shares a terminal | host |
| **Terminal — type commands** | **no** | host explicitly starts a **read/write** terminal | host |
| **Create a terminal** | **never** | not configurable | host — *"Only hosts can start shared terminals"* |
| Choose which host ports are shared | **never** | not configurable — *"For security reasons, guests can't control which ports on the host's computer are shared."* | host |
| Access a shared port | yes once shared | host shares/unshares per port | host |
| Debug: add/remove breakpoints, inspect variables | yes (even in read-only sessions) | — | host |
| Debug: step | yes in normal sessions, **no in read-only** | read-only mode | host |
| Debug: run console/REPL commands | yes | (this is the documented risk: *"a risk of a malicious actor running a command you would not want them to run"*) | host |
| Follow / focus others | yes | — | client UX |
| Chat | yes | org policy can disable | host/policy |

**Every single enforcement point is the host process.** The relay enforces nothing; the service enforces only identity and session membership. [VERIFIED-DOC by the "role of the Live Share service is limited to user authentication and session discovery" statement + the per-feature docs.]

### 3.3 Terminal access as the model case

This is the part TermX should study line by line, because a terminal manager's *entire* product is the thing Live Share treats as its most dangerous capability.

**[VERIFIED-DOC]**, quoted:

- *"By default, terminals aren't shared because they give guests at least read-only access to the output of commands you run (if not the ability to run commands themselves). This default configuration allows you to run commands in local terminals with reduced risk and share only when you need to."*
- *"only hosts can start shared terminals. This limitation prevents guests from starting one up and doing something you aren't expecting."*
- *"you can choose whether to make the terminal read-only or read/write. When the terminal is read/write, everyone can type in the terminal, including the host. So, as a host, you can easily intervene if a guest is doing something you don't like."*
- *"Keep in mind that read/write access gives guests the same access to your terminal that you have. They can run any command on your computer that you can."*
- *"If a collaboration session is in read-only mode, only read-only terminals can be shared by the host."* — **the session-level restriction dominates the per-terminal one.** A composition rule, not two independent knobs.
- Unsharing: *"To end a terminal session, enter exit, close the terminal window, or select the Unshare terminal button… Everyone will be disconnected."*
- The host keeps a private channel: *"anything you want to keep to yourself you can run in an unshared terminal."*

Design principles visible here:
1. **Per-object grant, not per-session.** Sharing a session shares zero terminals.
2. **Creation is a host-only privilege** even when writing is granted. Guests operate *inside* an object the host instantiated.
3. **The host is always a co-writer of a read/write terminal** — the ability to "intervene" is stated as a *security feature*, not an accident. Write access is never exclusive to the guest.
4. **Restrictions compose downward** (read-only session ⇒ read-only terminals only).
5. **An unshared escape hatch always exists.** Consent granularity is meaningless if the only options are "all" and "nothing."

### 3.4 Join flow, end to end

**[VERIFIED-DOC]**

1. Host signs in (AAD work/school, MSA, or GitHub). Sign-in is required **to be a host**.
2. Host opens a folder; optionally adds `.vsls.json` hide/exclude rules **before** sharing.
3. Host runs *Live Share: Start collaboration session (Share)*. A **new unique, non-guessable session identifier** is generated and the **invitation link is auto-copied to the clipboard**. Firewall may prompt to open 5990-5999 (optional; declining just forces relay).
4. Optional: host flips the session to **read-only** from the toast that appears right after sharing.
5. Host sends the link out-of-band (email/Teams/Slack). Docs are blunt: *"you should only share with people you trust, and you should think through the implications of what you're sharing."*
6. Guest either opens the link in a browser (which launches the local tool via protocol handler) or pastes it into *Live Share: Join collaboration session*. A signed-in guest presents a service-issued JWT; an **anonymous guest must type a display name** and is **read-only**.
7. **Host consent gate** — three configurable postures:
   - default: guest joins immediately, **host gets a notification with a Remove button**;
   - `liveshare.guestApprovalRequired: true`: **host must approve before the guest joins** (guest sees "waiting on the host to approve" in their status bar);
   - anonymous guests: `liveshare.anonymousGuestApproval` = `prompt` (default) | `accept` | `reject` — **anonymous guests are prompted regardless of the signed-in setting.**
8. Session state is visible in the status bar on both sides, including distinct read-only variants.
9. Eject at any time: hover/right-click a participant in the Live Share view → **Remove participant** — *"even if you have dismissed a join notification."*
10. Host stops the session: *"All guests will be notified that the session is over. After the session is over, guests won't be able to access the content. Any temp files will automatically be cleaned up."*
11. **The link dies with the session.** *"the identifier in the link is 'non-guessable' and is only valid for the duration of a single collaboration session."*

That last point is the expiry model: **no TTL, no revocation list — the credential's lifetime is exactly the resource's lifetime.** Elegant, and it removes an entire class of "stale link" bugs. (Dev Tunnels, hosting a longer-lived resource, uses the opposite approach: 24-hour token TTL with identity-gated refresh.)

### 3.5 Multi-writer / presence semantics

**[VERIFIED-DOC]**

- **Editing:** genuine concurrent multi-writer with per-participant cursors and selections; *"you are not forced into editing the same file at all times so you can opportunistically collaborate and act independently."* Optimistic concurrency; conflict resolution is not documented publicly. [INFERRED: OT or a CRDT-like model inside the host.]
- **Terminal:** *"When the terminal is read/write, everyone can type in the terminal, including the host."* **No turn-taking, no write lock, no input arbitration is documented.** [VERIFIED-DOC that everyone can type; **[ABSENT]** on any queueing/locking/echo-attribution mechanism.] In practice this is the same naive interleaving as tmate/screen multi-user: bytes from N writers land in one PTY stdin. Live Share's answer to the resulting mess is *social* (only grant write when needed; host can intervene), not *technical*.
- **Presence:** participant list in the Live Share viewlet showing each participant's location in the shared code; **follow** (guests auto-follow the host on join) and **focus** (request everyone follow you, delivered as a notification). Presence is *positional*, and that is what makes "who is watching me" legible.
- **Join notification is unconditional** — the host is *always* told someone arrived, even in the permissive default.

### 3.6 Enterprise policy layer

**[VERIFIED-DOC]** Seven policies, Windows Group Policy ADMX/ADML, deployable via Intune settings catalog or Local Group Policy Editor, stored under `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\VisualStudio\LiveShare`, **Visual Studio only — explicitly *not* VS Code** ("Do these policies apply to Visual Studio Code? No.").

| Policy | Effect |
| --- | --- |
| **Allow only domain accounts** | Guests must be in an allowed domain; **the host too must be signed in with an allowed domain account**; multiple domains separated by `;` |
| **Disable read-write terminals** | Host cannot share a writeable terminal **and the guest's "request write access" option is suppressed** |
| **Disable shared servers** | No port sharing, no terminal-triggered auto-share; the Shared Servers node and its commands are **hidden**, not just disabled |
| **Require direct connection** | Forces `connectionMode: direct` — no relay-based guests |
| **Disable anonymous guests** | Forces `anonymousGuestApproval: reject` |
| **Enforce accepting/rejecting a guest** | Forces `guestApprovalRequired: true` |
| **Disable chat** | No chat for host or guest |

Two structural observations worth stealing:

- **Policies are the *same knobs* as the user settings, pinned.** Four of the seven are literally "enforce this existing setting to this value." The org layer is not a parallel mechanism; it is a **lattice on top of the user layer**, which is why it's cheap to implement and impossible to get semantically inconsistent.
- **"Disable read-write terminals" also suppresses the guest's *request*.** Removing the capability removes the *ask*, so there is no social pressure on the host to override policy. That is a real UX-security insight.

Also of note, and referenced by the guest-write-request suppression: **a guest can request write access to a terminal**, i.e. there is a documented *elevation request* path. [VERIFIED-DOC by the policy text; the request UI itself is **[ABSENT]** from the terminal-sharing how-to.]

### 3.7 What Live Share does NOT have — and TermX will need

- **[ABSENT] No audit log.** Nothing in the security doc, features doc, or policy doc mentions a record of who joined, when, what they ran, or what they saw. The entire accountability model is *live notification to a human who is present*. That works for peer collaboration; it fails completely for admin oversight, where the observed party may be absent, and for after-the-fact dispute.
- **[ABSENT] No admin/observer role.** There is no third role that can watch without being invited by the host. Microsoft's design says: **the machine owner is the only authority.** An admin-oversight feature is a deliberate departure from that, and therefore must carry its own compensating controls.
- **[ABSENT] No self-hosted relay.** Issue #539 asked for exactly this (org can't use Azure Relay, can't do direct connections) and was **closed with no documented Microsoft implementation or commitment**. The documented answer is "use direct mode," which is a LAN answer, not a self-hosting answer. Same for Dev Tunnels: *no mention of self-hosting the tunnel service — it operates solely as a Microsoft-managed service*.
- **[ABSENT] No per-guest capability differentiation.** Read-only is a **session** property, not a per-guest one (except that *anonymous* guests are forced read-only). You cannot have Alice read-write and Bob read-only in the same session.
- **[ABSENT] No terminal-level indicator of who is watching.** The participant list shows code positions. Nothing documented shows "3 guests are attached to this terminal" *on the terminal*.

---

## 4. Self-hosting assessment (owner's VPS)

**Live Share's server side is not self-hostable.** [VERIFIED-DOC by absence + issue #539's outcome.] But the *architecture* is, and that is the useful finding:

The Live Share cloud does exactly **two** jobs: (a) authenticate users and mint session-scoped identity JWTs, (b) hold a directory mapping `session-id → {host public key, host endpoint/relay address}`. Everything else is host-to-guest SSH. Both jobs are small enough to run on a single VPS:

| Live Share component | TermX self-hosted equivalent | Effort |
| --- | --- | --- |
| Identity provider (MSA/AAD/GitHub) | GitHub OAuth app, or a local user table on the VPS; TermX is single-tenant so even a static roster works | small |
| Token issuer (signed JWT with identity + session claims) | Sign JWTs on the VPS with a keypair; claims `{sub, session_id, role, exp}` | small |
| Session directory (id → host pubkey + endpoint) | A table in the TermX daemon or a tiny VPS service | small |
| Azure Relay | The TermX daemon **is already reachable** on the VPS — for VPS-resident sessions there is *nothing to relay*. A relay is only needed for the desktop-host case (Ibrahim joining a session on Michael's Windows box behind NAT). | medium, and **deferrable** |
| E2E SSH layer | For VPS-resident sessions, TLS/WSS to the daemon is the direct analogue; the daemon *is* the trusted endpoint. Live Share's "don't trust the relay" property only matters once a relay exists. | n/a until relay exists |

**Recommendation:** TermX's roadmap (VPS-resident sessions + Ibrahim collaboration) lands in the *easy* half of this table. The VPS **is** the host; guests connect *inbound* to it; no NAT traversal, no relay, no P2P fallback, no direct/relay mode duality. TermX gets Live Share's security posture almost for free and should **not** build a relay until a desktop-hosted-session scenario actually demands it. Do inherit the *structural* separation, though: **the thing that hands out credentials should be distinct from the thing that streams PTY bytes**, even when both run on the same VPS box — because that separation is what lets you later add a relay, or an org SSO, without touching the daemon.

---

## 5. TermX today, and where these principles attach

**Verified from source:**

- `C:\Dev\TermX\host\src\protocol.rs` — `ClientMsg::Auth { token: String }` is the *entire* auth model. One shared bearer secret. No identity, no role, no expiry, no per-session scoping. `AuthOk` immediately returns the **full session list**.
- `C:\Dev\TermX\host\src\server.rs:411-434` — the auth gate: first text frame within 5s must equal the daemon's token, else `AuthErr`. Line ~49 and ~801: the token is a single value held by the runtime and reused by every client.
- `server.rs:695` — `Ok(Frame::Input { session_id, data })` is written straight to the PTY for **any** authenticated client. **Every attached client is a writer.** There is no read-only path in the protocol at all.
- `ClientMsg::Attach { session_id, replay, since_offset }` — attach is unauthorized beyond the global token: any client may attach to any session id.
- `SessionInfo { id, profile, cwd, cols, rows, alive, pid }` — **no attached-client count, no observer list.** The protocol cannot express "who is watching this session."
- `HostMsg` has no participant/presence/join message of any kind.

So the gap is precise: **TermX's token is a capability for the whole daemon; Live Share's token is an identity scoped to one session, evaluated by the host, against a per-object grant table.**

---

## 6. The 3-5 principles TermX should steal

### P1 — Split the credential into *identity* + *scope*, and make the link the weakest of the three

**Live Share:** invitation link = non-guessable session id (discovery only, dies with the session). Guest JWT = identity + "may access *this* session." Host = the authority that evaluates both.
**Dev Tunnels:** four capability-scoped token types, all limited to one tunnel, 24h expiry, **refresh requires a real user identity with manage scope — a bearer token cannot renew itself.**

**Map onto TermX:** replace the single `Auth { token }` with a claims-bearing token. Concretely, extend the protocol rather than break it:

```rust
Auth {
    token: String,           // keep: existing owner/admin token path stays wire-compatible
}
// new variant, additive:
Join {
    grant: String,           // signed: { sub, session_ids: [..], role, exp, jti }
}
```

Rules to carry over verbatim:
- **A join grant names specific session ids.** `AuthOk`'s session list must be filtered to the grant's scope — today it returns everything. A guest invited to session 7 must not learn that sessions 1-6 exist.
- **Grants expire.** Either Live Share-style ("valid for the life of the session", which suits ephemeral pairing) or Dev Tunnels-style (short TTL + identity-gated refresh, which suits a long-lived VPS). For TermX's VPS case, take **Dev Tunnels': a short TTL, and refreshing requires the owner's identity, never the grant itself.**
- **Default private.** Dev Tunnels' *"tunnels and tunnel ports are private and only accessible to the user who created the tunnel"* should be TermX's default for every session: shared with nobody until an explicit act.

### P2 — Grants are **per session object**, and *creating* a session is never delegated

**Live Share:** sharing a workspace shares **zero** terminals. Only the host can create a shared terminal. Read/write is chosen **per terminal, at creation time**. The host retains unshared terminals as a private channel.

**Map onto TermX:** the natural TermX unit is the ConPTY session, which maps 1:1 onto "a shared terminal." So:
- A grant carries `session_ids: [u32]`, not "all sessions." TermX's sidebar already groups sessions — share at the session or group level, never daemon-wide.
- `ClientMsg::CreateSession` must be **owner-only**. A guest with a grant may `Attach`, `Resize`(?), `ReadHistory`, and possibly `Input` — but must never spawn a shell. This is a one-line authorization check in `server.rs`'s dispatch and it is the single highest-value guard in the whole feature.
- `CloseSession`, `SetLayout`, `Shutdown` are likewise owner-only. (`Shutdown` reachable by a guest token would be an outright vulnerability.)
- Keep an **unshared default**: sessions the owner never shared are invisible to guests, and the owner needs somewhere to run `aws sts get-session-token` unobserved. Live Share's *"anything you want to keep to yourself you can run in an unshared terminal"* is the exact affordance.

### P3 — Read-only must be enforced at the daemon and *displayed on both sides*

**Live Share:** read-only is a session state with its own status-bar variants on host **and** guest (`Host: Sharing Read-only`, `Guest: Joined Read-only`); restrictions **compose downward** (read-only session ⇒ only read-only terminals may be shared); the org policy that disables read-write terminals **also hides the guest's request-for-write affordance**.

**Map onto TermX:** the enforcement point is `server.rs:695`, the `Frame::Input` arm. Today it forwards unconditionally. It must become:

```rust
Ok(Frame::Input { session_id, data }) => {
    if !conn.may_write(session_id) {
        // reply Error { context: "input", message: "read-only grant" } and DROP
    }
    ...
}
```

Non-negotiables borrowed from Live Share:
- **The daemon is the enforcement point, never the UI.** A read-only guest running a patched client must be rejected by the Rust host. (Live Share's whole model is "the host process decides"; the relay and the service enforce nothing.)
- **Both sides see the state.** The guest sees "read-only" in their tab/status strip; the owner sees, per session, that a read-only viewer is attached. TermX's `SessionInfo` needs new fields to carry this — it currently has none.
- **Compose downward.** If a session/group is shared read-only, no per-guest override can promote it. One direction only.
- **If write is disallowed, hide the ask.** No greyed-out "request write" button that pressures the owner.

### P4 — Announce every join, make ejection one click, and offer approve-before as a setting the org can pin

**Live Share:** the host is **always** notified on join, with **Remove** inline; the notification is recoverable (remove from the participant list later); `guestApprovalRequired` escalates to approve-before; anonymous guests are **always** prompted regardless; the enterprise policy layer is largely **the same knobs, pinned**.

**Map onto TermX:** the protocol has no participant concept at all — this is new surface, and it is the cheapest trust win available:

```rust
// HostMsg additions
ParticipantJoined { session_id, participant: ParticipantInfo },
ParticipantLeft   { session_id, participant_id },
Participants      { session_id, participants: Vec<ParticipantInfo> },
JoinRequest       { request_id, participant: ParticipantInfo, session_id },  // approve-before
// ClientMsg additions (owner only)
ApproveJoin { request_id, allow: bool, role: Role },
RemoveParticipant { participant_id },
```

And borrow the **three-posture ladder** exactly: *notify-after* (default, fast) → *approve-before* (a setting) → *reject* (policy). Michael's single-tenant setup means "policy" is just a config file the owner writes, not Group Policy — but the *lattice* shape (settings that a higher layer can pin) is worth keeping from day one, because retrofitting it is what makes enterprise features ugly.

Also copy Live Share's honesty about the residual risk: the docs say plainly *"read/write access gives guests the same access to your terminal that you have. They can run any command on your computer that you can."* TermX's share dialog should say the equivalent in one sentence. Understated consent UI is how these features get products in trouble.

### P5 — For admin oversight, add the two things Live Share deliberately never needed: an **unsuppressible observed indicator** and an **audit trail**

This is where TermX must **go beyond** the prior art, and the reason is structural. Live Share's accountability model is: *the machine owner personally invited you, is present, and is watching the participant list.* Admin monitoring of a live terminal inverts all three — the observed user did not invite the observer, may not be present, and is not the authority.

Compensating controls, derived by inverting each Live Share assumption:

1. **Observed-user indicator that the observer cannot suppress.** Live Share's join notification is *unconditional* — copy that property and harden it. When an admin attaches to a user's session, the user's TermX shows a persistent, always-on indicator (tab badge + status strip: "watched by <name> since 14:22"), rendered from daemon state, not from a client-side flag the admin's client could omit. **There must be no protocol path that produces a silent observer.** If someone can attach without the indicator, the feature is spyware.
2. **Scoping, and scoping by default to nothing.** Take Dev Tunnels' "private by default": an admin grant must name sessions (or a group), carry a TTL, and never mean "all sessions on this daemon, forever." Admin oversight of a *shared/team* session is defensible; ambient read access to every terminal a user ever opens is not.
3. **Observation is read-only by default, and elevation is a separate, logged, consented act.** Live Share requires the host to *create* a read/write terminal. TermX's analogue: an admin write grant should require the observed user's live approval (the `JoinRequest` machinery from P4, pointed the other way), and must be visibly distinct in the UI from read-only observation.
4. **Append-only audit trail — the thing Live Share has no equivalent of.** Records: grant issued (by whom, to whom, scope, TTL), attach/detach with timestamps, role at attach, any elevation, and the fact of eviction. **The observed user can read their own audit rows** — a log only the admin can see is not an accountability mechanism, it's surveillance with paperwork. Do *not* log PTY input bytes by default: TermX already spills scrollback to disk (`history.rs`), and quietly turning that into an admin-readable keystroke record is a much bigger consent question than "who attached." Log *access events*, not *content*, unless the user opts in explicitly.
5. **The observed user can always end it.** Live Share's host can remove any participant at any time, even one they earlier approved. TermX's observed user should be able to eject an admin observer from a session they own — and if organizational policy forbids that, the UI must say so *before* the session starts, not after.

The one-line test for the whole feature: **would the observed user be surprised, after the fact, by anything the audit log shows?** If yes, the consent design is wrong.

---

## 7. Direct answers to the brief

- **Roles model:** exactly two — host (ambient capability) and guest (enumerated capability). Guests are further split into *signed-in* and *anonymous*; anonymous are forced read-only and always prompt for approval. No per-guest capability differentiation; read-only is a session property. No admin/observer role exists.
- **Consent/visibility:** unconditional join notification with inline Remove; optional approve-before (`liveshare.guestApprovalRequired`); anonymous approval tri-state (`prompt`/`accept`/`reject`); read-only session states surfaced in the status bar on both sides; participant list with positional presence and follow/focus; file-level hide/exclude via `.vsls.json`, committable to source control.
- **Terminal access opt-in per session:** confirmed. VS shares no terminals by default; VS Code auto-shares **read-only** (`liveshare.autoShareTerminals`, default true, disable-able). Read/write requires an explicit host action per terminal. Only hosts create shared terminals. Read-only sessions can only produce read-only terminals. Org policy can kill read/write terminals globally *and* suppress the guest's request for write.
- **Tunnel/relay architecture (docs level):** P2P-first with Azure Relay fallback; SSH end-to-end in both modes (SSH-over-TLS-WebSockets when relayed); service scope limited to auth + discovery; relay does not persist or inspect traffic; content never leaves the host machine. Remote Tunnels/Dev Tunnels are outbound-only to an Azure service, SSH layered over the tunnel, same-identity on both ends, private-by-default with four capability-scoped 24h tokens.
- **Identity/auth:** link carries a non-guessable per-session id valid only for that session's lifetime; the actual credential is a service-signed JWT carrying identity claims (MSA/AAD/GitHub) plus session-access claims, validated by the **host**, which additionally holds a per-session in-memory RSA keypair so guests can authenticate the host. AAD tenants may need admin consent for the `User.Read` delegated permission.
- **Self-hosting the server side:** **not possible** for Live Share (request closed, no implementation) or Dev Tunnels. But the server side is only auth + directory, both trivially reimplementable on a VPS — and for VPS-resident TermX sessions the relay is unnecessary entirely.
- **Multi-writer:** true concurrent co-editing with cursors; terminals are naive multi-writer ("everyone can type, including the host") with **no documented arbitration** — the host's ability to type over a guest is presented as the intervention mechanism.

---

## 8. Sources

- [Security - Live Share (Microsoft Learn)](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security) — roles, wire encryption, peer auth, JWT, invitations, guest approval settings, read-only mode, `.vsls.json`, terminal sharing, AAD admin consent
- [Connectivity - Visual Studio Live Share (Microsoft Learn)](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity) — direct/relay/auto modes, ports 5990-5999, required endpoints, `vsls-agent`
- [Live Share features (Microsoft Learn)](https://learn.microsoft.com/en-us/visualstudio/liveshare/overview/features) — host/guest definition, co-editing, follow/focus, co-debugging, shared servers/terminals, access controls, maintenance-mode banner
- [Share a server or terminal with Live Share in VS Code (Microsoft Learn)](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-server-visual-studio-code) — terminal share flow, read-only vs read/write, host-only creation, unshare, read-only session composition rule
- [Share a project and join a session in VS Code (Microsoft Learn)](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-project-join-session-visual-studio-code) — full share/join/leave/stop flow, session states table, link regeneration, approval setting
- [Configure Visual Studio using Group Policy Administrative Templates - Live Share (Microsoft Learn)](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/policies-visual-studio) — the seven policies, registry path, Intune/ADMX deployment, VS-only scope
- [Live Share: Enterprise Policies are here! (Visual Studio Blog)](https://devblogs.microsoft.com/visualstudio/ls-policies/) — policy rationale, host-side enforcement
- [Visual Studio Live Share - maintenance mode (Microsoft Learn)](https://learn.microsoft.com/en-us/visualstudio/liveshare/maintenance-mode) — status as of 2026
- [Developing with Remote Tunnels (VS Code docs)](https://code.visualstudio.com/docs/remote/tunnels) — outbound-only, same-account requirement, SSH over tunnel, machine registration/unregister, liveness
- [Dev tunnels security (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security) — private by default, four token types, 24h expiry, identity-gated refresh, `X-Tunnel-Authorization`, anti-phishing interstitial, tenant/GitHub-org access
- [Port Forwarding (VS Code docs)](https://code.visualstudio.com/docs/debugtest/port-forwarding) — private/public port visibility, org control via domain allow/deny
- [Self-hosted VSLS Relay · Issue #539 · microsoft/live-share](https://github.com/microsoft/live-share/issues/539) — self-hosting request, closed without documented implementation
- [microsoft/live-share README](https://github.com/microsoft/live-share/blob/main/README.md) — repo is feedback/docs only; CC-BY-4.0 docs, MIT samples, proprietary product license
- [Microsoft Secures Visual Studio Live Share Sessions (Visual Studio Magazine, 2022-08-25)](https://visualstudiomagazine.com/articles/2022/08/25/live-share-security.aspx) — secondary coverage of the policy release

### TermX files referenced (verified by reading)

- `C:\Dev\TermX\host\src\protocol.rs` — `ClientMsg::Auth { token }`, `Attach`, `SessionInfo`, binary `Frame::Input`/`Frame::Output`
- `C:\Dev\TermX\host\src\server.rs` — auth gate (~L411-434), unconditional input forwarding (~L695), per-attached-session forwarder tasks
- `C:\Dev\TermX\host\src\history.rs` — disk-spilled scrollback (relevant to the audit-content question in P5)
