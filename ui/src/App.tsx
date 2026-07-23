import { LocalEchoTerminal } from "./demo/LocalEchoTerminal";

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">TermX</div>
        <div className="app-subtitle">M2 scaffold · local-echo demo (no host yet)</div>
      </header>
      <main className="app-main">
        <LocalEchoTerminal />
      </main>
    </div>
  );
}
