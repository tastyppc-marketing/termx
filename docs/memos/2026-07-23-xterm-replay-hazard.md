# xterm.js replay auto-response hazard — T4 hardening spec

*Produced by an Opus 4.8 research agent 2026-07-23; adopted by the supervisor as binding for T4/T9. Grounded in `host/src/session.rs` (`strip_dsr`), `host/src/protocol.rs` (Replay contract), `BACKLOG.md` §5, and xterm.js 6 sources (links at bottom).*

## TL;DR

Replaying historical PTY bytes into xterm.js makes it **auto-answer stale queries into the live shell's stdin**. The host strips only literal `ESC[6n`; xterm.js also auto-answers **DA1/DA2/DA3, DSR 5n, DECXCPR `ESC[?6n`, window-state reports, DECRQM, DECRQSS, XTVERSION, and OSC 4/10/11/12 color queries** — every reply rides `onData`, the same channel as user keystrokes.

**Binding mitigation: client-side parser-hook suppression scoped to the replay write** + `term.reset()` before replay + live frames held until the replay write's completion callback. NOT `onData` gating (it would eat user keystrokes typed during a long replay parse).

## Auto-response table (what to suppress)

| Query in replay | Trigger | xterm.js reply |
|---|---|---|
| DA1 | `ESC[c` / `ESC[0c` | `ESC[?1;2c` |
| DA2 | `ESC[>c` / `ESC[>0c` | `ESC[>0;276;0c` |
| DA3 | `ESC[=c` | DCS reply |
| DSR status | `ESC[5n` | `ESC[0n` |
| CPR | `ESC[6n` | `ESC[{row};{col}R` — *host-stripped, never in ring* |
| DECXCPR | `ESC[?6n` | `ESC[?{row};{col}R` — **host does NOT strip** |
| Window state | `ESC[?15n` etc. | CSI `t` reply |
| DECRQM | `ESC[{Ps}$p` / `ESC[?{Ps}$p` | `ESC[{Ps};{Pm}$y` |
| DECRQSS | `DCS $q {Pt} ST` | `ESC P 1$r{Pt} ST` |
| XTVERSION | `ESC[>q` / `ESC[>0q` | `ESC P >\|xterm.js({ver}) ST` |
| OSC 4/10/11/12 with `?` payload | `ESC]11;?BEL` etc. | `ESC]11;rgb:... BEL` |

XTGETTCAP is unimplemented in xterm.js — not a risk. `ESC[?9001h/l` (win32-input-mode) is not a query but a stateful toggle — see below.

## Attach sequence (normative for TerminalPane)

1. Fresh `Terminal` per attach, or `term.reset()` first (clears stale modes; RIS emits nothing outbound).
2. Register suppression handlers returning `true` for: CSI finals `c` (plain/`>`/`=` prefixes), `n` (plain/`?` prefixes), `$p` (plain/`?` prefixes), `>q`; DCS `$q`. Pure queries, no display side effect — consume silently.
3. OSC 4/10/11/12 handlers **inspect the payload**: query (`?`) → suppress; SET → `return false` so the built-in color set still applies. Blanket suppression would drop legitimate replayed color changes.
4. `term.write(replayBytes, callback)` — callback fires after full parse.
5. In the callback: dispose all suppression handlers, then flush held live frames.
6. **Queue live output frames until step 5** so the suppression window covers exactly the replay bytes. If replay is chunked, dispose in the LAST chunk's callback.

Mid-sequence replay start (ring evicted mid-escape): display-only concern — parser resyncs at the next `ESC`, worst case one garbled leading fragment. `reset()` + accept it (per BACKLOG §5). No reply risk: a truncated fragment is never a complete query.

**win32-input-mode:** ConPTY (portable-pty 0.9) emits `ESC[?9001h` and expects matching key encoding; the replayed toggle may be present, absent (evicted), or stale. Do not depend on it — configure xterm's Windows PTY handling explicitly and re-assert expected input mode after replay.

## T4 review checklist (seed ring → reattach → observe child stdin)

1. Ring `ESC[c` → no `ESC[?1;2c` injected.
2. Ring `ESC[5n` → no `ESC[0n` injected.
3. Live `ESC[6n` → never present in ring (strip_dsr regression guard).
4. Ring `ESC[?6n` → no CPR injected (the host-strip gap — demonstrate bug, then fix).
5. Ring `ESC[?1049$p` + DECRQSS → no `$y` / `$r` replies.
6. Ring `ESC[>0q` → no XTVERSION DCS reply.
7. OSC dual-use: `ESC]11;?BEL` suppressed AND `ESC]11;rgb:0000/0000/8080BEL` still renders navy.
8. Replay starting mid-sequence → no crash, resync, no reply.
9. Post-replay live `ESC[c` → xterm DOES answer (suppression correctly disposed).
10. Ring `ESC[?9001h` → typed keys still encode correctly after reattach.

## Sources

- Parser hooks (newest-first, `return true` stops built-ins): https://xtermjs.org/docs/guides/hooks/
- VT features: https://xtermjs.org/docs/api/vtfeatures/
- InputHandler.ts (report registrations, `triggerDataEvent`→`onData`): https://github.com/xtermjs/xterm.js/blob/master/src/common/InputHandler.ts
- IParser: https://xtermjs.org/docs/api/terminal/interfaces/iparser/
- Terminal.write callback / reset: https://xtermjs.org/docs/api/terminal/classes/terminal/
- CPR discussion: https://github.com/xtermjs/xterm.js/discussions/5145
- ConPTY DA1 passthrough: https://deepwiki.com/microsoft/terminal/2.4-conpty-and-vt-io
- win32-input-mode: https://github.com/microsoft/terminal/pull/6309, https://github.com/microsoft/terminal/issues/6859
