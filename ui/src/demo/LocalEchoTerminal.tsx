import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const PROMPT = "termx> ";

/**
 * Scaffold-only local-echo terminal.
 * Proves xterm.js bundles and renders; no host WebSocket yet (T3/T4).
 */
export function LocalEchoTerminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      fontSize: 14,
      theme: {
        background: "#0f1115",
        foreground: "#e6e6e6",
        cursor: "#7aa2f7",
        selectionBackground: "#334155",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    let line = "";
    const writePrompt = () => {
      term.write(PROMPT);
    };

    term.writeln("TermX local-echo demo");
    term.writeln("Type anything and press Enter. Host connection arrives in later tasks.");
    term.writeln("");
    writePrompt();

    const onData = term.onData((data) => {
      for (const ch of data) {
        if (ch === "\r") {
          term.write("\r\n");
          if (line.length > 0) {
            term.writeln(`echo: ${line}`);
          }
          line = "";
          writePrompt();
          continue;
        }
        if (ch === "\x7f" || ch === "\b") {
          if (line.length > 0) {
            line = line.slice(0, -1);
            term.write("\b \b");
          }
          continue;
        }
        if (ch === "\x03") {
          term.write("^C\r\n");
          line = "";
          writePrompt();
          continue;
        }
        // Printable ASCII only for the scaffold demo.
        if (ch >= " " && ch <= "~") {
          line += ch;
          term.write(ch);
        }
      }
    });

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        // Container may be detached during teardown.
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      onData.dispose();
      term.dispose();
    };
  }, []);

  return <div className="terminal-host" ref={containerRef} data-testid="local-echo-terminal" />;
}
