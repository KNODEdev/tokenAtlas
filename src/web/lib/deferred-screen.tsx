import { Component, lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { LoadingStatus } from "../components/LoadingStatus";
import { ErrorState } from "../components/ui";
import { useI18n } from "./i18n";

class ScreenLoadBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Keep the shell mounted while a secondary screen's code is fetched. */
export function deferredScreen<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  const Screen = lazy(load);
  return function DeferredScreen(props: P) {
    const { t } = useI18n();
    return <ScreenLoadBoundary fallback={<ErrorState message={t("Unable to load view", "Nie można wczytać widoku")} onRetry={() => window.location.reload()} />}>
      <Suspense fallback={<LoadingStatus label={t("Loading view", "Wczytywanie widoku")} />}>
        <Screen {...props} />
      </Suspense>
    </ScreenLoadBoundary>;
  };
}
