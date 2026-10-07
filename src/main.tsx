import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyAppearance, readAppearance } from "./appearance";
import "./styles.css";

// Before the first paint, so the window never flashes another palette.
applyAppearance(readAppearance());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
