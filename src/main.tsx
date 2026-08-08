import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ShellComparisonPage } from "./design/ShellComparisonPage";
import { ShellReference } from "./design/ShellReference";
import "./index.css";

const shellMode = new URLSearchParams(window.location.search).get("shell");
const content = shellMode === "reference"
  ? <ShellReference />
  : shellMode === "compare"
    ? <ShellComparisonPage />
    : <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {content}
  </React.StrictMode>,
);
