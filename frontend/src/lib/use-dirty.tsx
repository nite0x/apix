import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';

const DirtyContext = createContext<(key: string, dirty: boolean) => void>(() => {});

export function DirtyProvider({ children }: { children: ReactNode }) {
  const [scopes, setScopes] = useState<Set<string>>(() => new Set());
  const register = useCallback((key: string, dirty: boolean) => {
    setScopes(previous => {
      if (previous.has(key) === dirty) return previous;
      const next = new Set(previous); if (dirty) next.add(key); else next.delete(key); return next;
    });
  }, []);
  const dirty = scopes.size > 0;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm('当前有未保存的修改，确定离开？')) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  return <DirtyContext.Provider value={register}>{children}</DirtyContext.Provider>;
}

export function useDirty(dirty: boolean) {
  const register = useContext(DirtyContext); const key = useId();
  useEffect(() => { register(key, dirty); return () => register(key, false); }, [register, key, dirty]);
}
