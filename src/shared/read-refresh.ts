/** A bounded check of the existing window-answer marks, performed by the sync status read. */
export interface ReadRefreshCheck {
  from: number | null;
  cursor: number;
  configuration: string;
  reset: boolean;
  /** Additional dependencies owned by each registered screen, beyond its interval marks. */
  dependencies: Record<string, string>;
  /** Request paths whose registered dependencies did not change since `from`. */
  unchanged: string[];
}

export interface ApiRefresh {
  unchanged: readonly string[];
  /** Raw percentage readings still refresh live consumers before their window sums are published. */
  live?: boolean;
}

export function readRefreshDecision(previous: ReadRefreshCheck | undefined, next: ReadRefreshCheck | undefined) {
  const safe = !!previous && !!next && !next.reset && next.from === previous.cursor
    && next.cursor >= previous.cursor && next.configuration === previous.configuration;
  return {
    changed: !!next && (!previous || next.reset || next.cursor !== previous.cursor || next.configuration !== previous.configuration
      || Object.entries(next.dependencies).some(([path, stamp]) => previous.dependencies[path] !== stamp)),
    refresh: safe ? { unchanged: next!.unchanged.filter(path => previous!.dependencies[path] !== undefined
      && previous!.dependencies[path] === next!.dependencies[path]) } as ApiRefresh : undefined,
  };
}
