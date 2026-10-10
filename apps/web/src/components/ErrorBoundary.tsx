import { Component, type ReactNode } from 'react';

/**
 * Renders children; if a child throws during render, swap in a small fallback
 * panel instead of letting React unmount the whole tree to a blank screen.
 *
 * Maks hit this in dev: a markdown edge case inside `renderMarkdownLite`
 * threw, React swallowed it, and the dark `.ai-surface` background was the
 * only thing left on screen — looked like a black screen. With this boundary
 * the user sees a red-tinted message naming the panel, plus a Reload button.
 *
 * Intentionally NOT placed at the App root — we still want real render bugs
 * in the chrome (HomePage, NotebookPage shell) to fail loudly so the dev
 * sees the overlay. Local boundaries around SummaryPanel / ChatPanel are
 * the right granularity.
 */
export class PanelErrorBoundary extends Component<
  { children: ReactNode; panel: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Surface to devtools; don't crash the rest of the UI.
    console.error(`[${this.props.panel}] render failed:`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <p className="font-medium">Внутренняя ошибка панели «{this.props.panel}».</p>
          <p className="mt-1 text-xs opacity-80">
            {this.state.error.message ?? String(this.state.error)}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-2 rounded-md border border-red-300 px-2 py-1 text-xs font-medium hover:bg-red-100 dark:hover:bg-red-900/40"
          >
            Повторить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}