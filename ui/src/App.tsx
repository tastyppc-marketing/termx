import { TerminalPane } from "./terminal/TerminalPane";

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">TermX</div>
        <div className="app-subtitle">Terminal workspace</div>
      </header>
      <main className="app-main">
        <TerminalPane />
      </main>
    </div>
  );
}
