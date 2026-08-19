import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const ShellComponentsPage = lazy(() =>
  import("./design/ShellComponentsPage").then(({ ShellComponentsPage: Page }) => ({ default: Page })),
);

class ShellComponentsErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  public state = { hasError: false };

  public static getDerivedStateFromError() {
    return { hasError: true };
  }

  public componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error("[shell-components] failed to load", error, info.componentStack);
  }

  public render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main role="alert">
        <h1>Component showcase unavailable</h1>
        <p>The showcase could not be loaded. The editor is still available.</p>
        <a href={`${window.location.pathname}${window.location.hash}`}>Open editor</a>
      </main>
    );
  }
}

const shellMode = new URLSearchParams(window.location.search).get("shell");
const content = shellMode === "components"
  ? (
    <ShellComponentsErrorBoundary>
      <Suspense fallback={<main role="status" aria-live="polite">Loading component showcase…</main>}>
        <ShellComponentsPage />
      </Suspense>
    </ShellComponentsErrorBoundary>
  )
  : <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {content}
  </React.StrictMode>,
);
