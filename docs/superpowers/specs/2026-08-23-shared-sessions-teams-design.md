# Shared Sessions & Teams — Design

**Date:** 2026-08-23 · **Status:** DRAFT, awaiting Michael's review
**Feeds from:** `2026-08-22-shared-sessions-research.md` (architecture candidates, license table, prior-art studies) — read that first; this document records the *decisions* and the resulting shape.

## 1. What Michael decided (2026-08-23)

The research posed eight open questions. The forks that shape the architecture are now closed:

| Fork | Decision | Consequence |
|---|---|---|
| Q1 — pairing or infrastructure? | **Both, with the VPS as the workplace for assistants.** His own work stays local; laptop shares exist for pairing. | Candidate B (VPS-resident daemon) is the destination. The relay (Candidate A's component) still ships first and grows into C. |
| Q3 — E2E or auditable? | **Trusted relay, auditable.** The relay is his own VPS. | No E2E machinery. Oversight and (later) audit work by construction. |
| Q4 — admin oversight depth? | **Live view + conversation access** — but "recording" means *resuming/reading the Claude Code conversation an assistant had*, not video/keystroke capture. | See §4: transcript access is a **filesystem consequence** of VPS-resident sessions, not a data channel to build. Phase 5 (transcript wire channel) shrinks dramatically. |
| Q5 — who is monitored? | Offshore assistant contractors (Philippines / Pakistan / Africa), **fully informed**; Michael pays for their Claude subscriptions and monitoring is an explicit working condition. Visible "being watched" indicators are considered a feature, not a concession. | Disclosed-monitoring design (§5). GDPR largely out of scope; enrolment acknowledgement still captured so notice is provable. |

Still open (do not build past them without answers): **Q2** (identity provider — GitHub OAuth recommended), **Q7** (which VPS; a dedicated box is the cheap answer and the blast-radius rule says live client VPSes are prod), **Q8** (owner's own second device).

## 2. The file-custody insight (dissolves the "catch-22")

Michael's core requirement is not terminal sharing per se — it is **custody of work product**: anything an assistant produces must be accessible to him at all times, without the assistant having to hand it over, and without giving assistants run of the VPS. His stated fear: an assistant becomes unreachable (his example: a car accident) and paid-for work is simply gone.

The knot he described ("VPS work must reach the laptop, laptop work must reach the VPS, up is also above") untangles by separating two problems the goal statement had fused:

1. **Where sessions run.** For assistants, the VPS is the workplace: they open TermX and their session is VPS-resident from the first keystroke. No manual SSH ritual — the remoteness is invisible; that is what VPS-resident sessions *are*. Files, transcripts, and asset output are **born on the VPS**. Custody is solved by physics, not by process.
2. **How files move.** Michael's own local work that must survive goes to the VPS by ordinary git remotes / sync — a file-custody policy, not terminal architecture. Nothing about the sharing feature needs to move files.

## 3. Sandbox model (assistants on the VPS)

- **One Unix account per assistant.** Their sandbox is their home directory plus explicitly granted project directories. Standard Linux permissions and groups — fifty years of battle-testing, nothing invented.
- **Access rule:** each working folder is readable by its assistant, Michael, and whoever Michael authorizes (a Unix group per project). Assistants cannot read each other's folders, other clients' work, the relay, or the daemon's state.
- **"Unattended access to mess things up"** is bounded the same way: no sudo, no membership in groups beyond their projects. The client-safe rule (zero cross-client bleed) maps to group membership.
- Each assistant's `termx-host` runs **under their own account** (systemd user services), so the daemon's OS-level authority is exactly the assistant's. Michael's admin plane is OS-level (root/group read), not a daemon backdoor.

## 4. Oversight model

Two mechanisms, both disclosed:

1. **Live view (Phase 4):** Michael opens a read-only attach to an assistant's session through the relay. Non-suppressible indicator on the assistant's side ("Michael is viewing"), participant list, append-only audit log of who viewed what and when. Warp's Teams deliberately declined to build even this; TermX ships it **with** the transparency machinery as load-bearing requirements (research §6.2).
2. **Conversation access (free with Phase 3):** assistants run Claude Code on the VPS under their own account, so their transcripts live in `~/.claude/projects/...` on the VPS as ordinary files. Michael (root or group-granted) can `cd` into the project directory and `claude --resume`, or read the JSONL directly, or point TermX's conversation viewer at it. **No transcript wire channel, no retention pipeline, no recording subsystem.** The old Phase 5 survives only as a UI convenience (browsing another user's transcripts inside TermX) — size drops from L to S/M.

What is deliberately NOT built: keystroke/video recording, retroactive PTY scrollback capture beyond the daemon's ordinary ring/history, or any covert mode. The daemon's history spill (`host/src/history.rs`) already persists session output on disk per-account; that plus transcripts answers "what did they do Tuesday" without a surveillance product.

## 5. Consent and notice (working conditions, not dark patterns)

- Enrolment: each assistant's onboarding captures an explicit acknowledgement that sessions on the VPS are visible to Michael (stored with the account record). Michael's instinct — that visible monitoring "keeps people on their toes" — is served by *indicators*, not by surprise.
- Every observed session shows the observer, always. There is no way to watch silently. This is ahead of the field's norms and is also the cheapest defensible posture.
- Assistants' subscriptions are company-paid; the stated purpose of oversight is verifying company time is spent on company work. The notice text should say exactly that.

## 6. Architecture (resolved)

**Candidate B as destination, relay-first ordering** — the research's recommended path, now confirmed:

```
[Assistant's TermX]──WS──┐
[Michael's TermX]──WS────┼──[termx-relay on VPS]──local──[termx-host × N accounts on VPS]
[Browser viewer]──WS─────┘         │
                                   └── identity, share grants, roles, audit (grows into Candidate C)
```

- The **relay** terminates auth (identity per Q2), maps principals to permitted sessions, and pipes frames to the per-account daemons. Plaintext to the relay (Q3: trusted).
- **Local sessions stay exactly as today.** Laptop-shares (pairing) register a local daemon with the relay outbound — Candidate A's flow, same relay, later phase than originally sketched since the VPS is the priority.
- The **Linux port of termx-host** is small: six `windows-sys` call sites in `session.rs` (liveness/kill/busy-probe), an `%APPDATA%` branch in `paths.rs`, Unix shell profiles. `portable-pty` already speaks Unix PTY. (The new ProbeSession busy-check needs a `/proc`-based sibling — trivial: any live child in `/proc/<pid>/task/*/children`.)

## 7. Phasing (updated from research §7)

- **Phase 0 — daemon authorization model. M. Unchanged, still first, still standalone.** Per-connection principal; capability gating on Input/Resize/CloseSession/Shutdown/SetLayout; per-session ACL scaffold; `Participants` presence message; generalize `handle_conn` off `TcpStream`. Testable entirely locally.
- **Phase 1 — Linux termx-host + per-account VPS deployment. M.** (Promoted from old Phase 3 — Q1 made the VPS the point.) Systemd user services, one daemon per assistant account, sandbox layout of §3. No relay yet: reachable over plain SSH port-forward for founder-mode testing.
- **Phase 2 — termx-relay v1 + TermX "remote host" concept. L.** Identity (Q2), session directory scoped by principal, deep links, browser viewer (xterm.js pinned to 6.0.0). Assistants start working in it here.
- **Phase 3 — share links + multi-writer. M.** Warp-style link for a session (read-only default, separate writable credential, viewer cap, expiry, revocation, participant list with one-click remove). Covers the laptop-share/pairing case via daemon-outbound registration too.
- **Phase 4 — teams & live oversight. M–L.** Roles (admin/member), admin session directory, read-only live view with the §5 indicator/audit machinery, enrolment acknowledgement capture.
- **Phase 5 — conversation viewer for other accounts. S–M.** UI affordance over the filesystem access §4 already grants.

## 8. Standing constraints

- License discipline unchanged: copy from sshx/Zellij/Upterm/tty-share (MIT/Apache) with notices; Warp and Teleport are AGPL — learn only.
- The relay VPS is prod from day one (blast-radius rule). Q7 decides which box; prefer a dedicated one.
- No third-party harness steering Claude (2026-08-03 constraint): assistants run ordinary Claude Code; TermX shares terminals and reads transcript files, nothing more.
- xterm.js version pinned identical between app and browser viewer.

## 9. Next actions

1. Michael reviews this document.
2. Answer Q2 (identity) and Q7 (which VPS) — both are cheap words now and expensive code later.
3. Then writing-plans for **Phase 0 only**.
