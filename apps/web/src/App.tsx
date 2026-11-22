import { X } from 'lucide-react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage, homeFor } from './features/auth/LoginPage';
import { useAuth } from './features/auth/auth';
import { PortalLayout, PortalList, PortalNew, PortalTicket } from './features/portal/PortalPages';
import { StaffPage } from './features/tickets/StaffPage';
import { LogoMark } from './components/ui/identity';
import { Spinner } from './components/ui/states';

/** Route guard: unauthenticated -> /login; wrong role -> own home. The server still enforces every rule. */
function RequireRole({ staff }: { staff: boolean }) {
  const { status, viewer, sessionKey } = useAuth();
  const location = useLocation();
  if (status === 'loading')
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4">
        <LogoMark className="h-9 w-9" />
        <Spinner label="Loading your workspace" />
      </div>
    );
  if (!viewer) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if ((viewer.role === 'CUSTOMER') === staff) return <Navigate to={homeFor(viewer.role)} replace />;
  // Keyed by the session context: any session change remounts the protected tree (drafts, local state, timers).
  return <Outlet key={sessionKey ?? 'none'} />;
}

function Home() {
  const { status, viewer } = useAuth();
  if (status === 'loading') return null;
  return <Navigate to={viewer ? homeFor(viewer.role) : '/login'} replace />;
}

function SwitchedNotice() {
  const { switchedNotice, dismissSwitchedNotice } = useAuth();
  if (!switchedNotice) return null;
  return (
    <div role="status" data-testid="session-switched" className="relative z-50 flex items-center justify-between gap-3 border-b border-warn/25 bg-warn-soft px-4 py-2 text-body text-warn-ink">
      <span>{switchedNotice}</span>
      <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md px-2 font-medium transition-colors hover:bg-warn/10" onClick={dismissSwitchedNotice}>
        <X className="h-3.5 w-3.5" aria-hidden="true" />
        Dismiss
      </button>
    </div>
  );
}

export function App() {
  return (
    <>
      <SwitchedNotice />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireRole staff />}>
          <Route path="/staff" element={<StaffPage />} />
        </Route>
        <Route element={<RequireRole staff={false} />}>
          <Route path="/portal" element={<PortalLayout />}>
            <Route index element={<PortalList />} />
            <Route path="new" element={<PortalNew />} />
            <Route path="tickets/:id" element={<PortalTicket />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
