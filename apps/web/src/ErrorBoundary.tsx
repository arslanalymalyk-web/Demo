import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "./i18n";

/** If one screen throws while drawing, the rest of the application keeps working and the person is told in words. Nothing from the error is shown. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error("screen failed to draw", error.message, info.componentStack?.split("\n")[1]?.trim()); }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="note err" role="alert">
        <strong>{t("This screen could not be shown.")}</strong>
        <p style={{ margin: "6px 0 10px" }}>{t("The rest of TIGERIS still works. Try again, or go back to the Command Centre.")}</p>
        <div className="row"><button onClick={() => this.setState({ failed: false })}>{t("Try again")}</button><a className="btn" href="#/">{t("Back to the Command Centre")}</a></div>
      </div>
    );
  }
}
