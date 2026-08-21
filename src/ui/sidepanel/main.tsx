import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "./App";
import "../design-system.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("sidepanel root element missing");
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
