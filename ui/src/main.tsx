import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("TermX root element #root is missing");
}

// Multi-window spec: an aux window loads the same UI with `?window=aux-<n>`
// and bootstraps into that slot; no parameter means the main window.
const windowId = new URLSearchParams(window.location.search).get("window");

createRoot(root).render(<App {...(windowId ? { windowId } : {})} />);
