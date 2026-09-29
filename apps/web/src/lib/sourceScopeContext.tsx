/**
 * SourceScope context — shared by SourcesPanel (controls) and
 * ChatPanel (consumer). Owns one useSourceScope() instance per
 * notebook; both panels read/write through useSourceScopeContext().
 *
 * Why context and not prop drilling: NotebookPage renders BOTH the
 * three-column layout (Sources left, Chat right) and the notebooklm
 * layout (SourcesStrip top, Chat below). Lifting state to NotebookPage
 * works but means a prop cascade through several intermediate
 * components. Context keeps the change local.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { Source } from './types';
import {
  scopeToSourceIds,
  useSourceScope,
  type UseSourceScopeResult,
} from './useSourceScope';

const SourceScopeContext = createContext<UseSourceScopeResult | null>(null);

export function SourceScopeProvider({
  notebookId,
  sources,
  children,
}: {
  notebookId: string;
  sources: Source[] | undefined;
  children: ReactNode;
}) {
  const scope = useSourceScope(notebookId, sources);
  return (
    <SourceScopeContext.Provider value={scope}>
      {children}
    </SourceScopeContext.Provider>
  );
}

export function useSourceScopeContext(): UseSourceScopeResult {
  const ctx = useContext(SourceScopeContext);
  if (!ctx) {
    throw new Error(
      'useSourceScopeContext must be used inside <SourceScopeProvider>',
    );
  }
  return ctx;
}

export { scopeToSourceIds };
