"use client";

import * as Sentry from "@sentry/nextjs";
import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

function DefaultFallback({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-surface-1 px-6 py-12 text-center">
      <p className="text-base font-semibold text-text-primary">Something went wrong</p>
      <p className="max-w-xs text-sm text-text-muted">
        An unexpected error occurred. Our team has been notified.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-dark"
      >
        Try again
      </button>
    </div>
  );
}

// React requires class components for error boundaries — no hook equivalent exists.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack: string }) {
    Sentry.captureException(error, { extra: { ...errorInfo } });
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <DefaultFallback onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}
