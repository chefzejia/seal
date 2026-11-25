interface ReviewNavigationHost {
  selectSession(sessionId: string): void;
  beginNavigation(): AbortSignal;
  openReview(): void;
}
interface NavigationState {
  request: { sessionId: string; signal: AbortSignal } | null;
  error: string;
}

/** Selection precedes cancellation ownership; commit runs after the target render. */
export class ReviewNavigation {
  private state: NavigationState = { request: null, error: "" };
  private listeners = new Set<() => void>();
  constructor(private readonly host: ReviewNavigationHost) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: NavigationState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  open(sessionId: string) {
    try {
      this.host.selectSession(sessionId);
      const signal = this.host.beginNavigation();
      this.publish({ request: { sessionId, signal }, error: "" });
    } catch (error) {
      this.fail(error);
    }
  }
  commit(renderedSessionId: string | undefined) {
    const request = this.state.request;
    if (!request || request.sessionId !== renderedSessionId) return;
    if (request.signal.aborted) {
      this.publish({ request: null, error: "" });
      return;
    }
    try {
      this.host.openReview();
      this.publish({ request: null, error: "" });
    } catch (error) {
      this.fail(error);
    }
  }
  private fail(error: unknown) {
    this.publish({
      request: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
