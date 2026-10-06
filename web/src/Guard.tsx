// A fence around a part of the window: when what is inside it cannot be drawn (a record it does
// not expect), that part says so in one line and the rest of the window stays as it is.
import { Component, type ReactNode } from "react";

/** what: the part's name in the line ("the timeline"). resetKey: when it changes (another sidebar
 *  row, another tab, the next version of the data) the content is drawn again. */
export class Guard extends Component<{ what: string; resetKey?: unknown; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e : new Error(String(e)) }; }
  componentDidCatch(e: unknown) { console.error(`${this.props.what} could not be shown:`, e); }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="guard-fail note" role="alert" data-what={this.props.what}>
        Couldn't show {this.props.what}.
        {error.message && <span className="menu-note">{error.message}</span>}
      </div>
    );
  }
}
