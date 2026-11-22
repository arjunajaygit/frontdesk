import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage, homeFor } from './features/auth/LoginPage';
import { useAuth } from './features/auth/auth';
import { PortalLayout, PortalList, PortalNew, PortalTicket } from './features/portal/PortalPages';
import { StaffPage } from './features/tickets/StaffPage';
import { LoadingRows } from './components/ui/states';

/** Route guard: unauthenticated -> /login; wrong role -> own home. The server still enforces every rule. */
function RequireRole({ staff }: { staff: boolean }) {
  const { status, viewer, sessionKey } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div className="mx-auto max-w-md p-8"><LoadingRows rows={3} /></div>;
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
    <div role="status" data-testid="session-switched" className="flex items-center justify-between gap-3 border-b border-warn/30 bg-warn-soft px-4 py-2 text-[13px] text-warn-ink">
      <span>{switchedNotice}</span>
      <button type="button" className="font-medium underline" onClick={dismissSwitchedNotice}>
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
