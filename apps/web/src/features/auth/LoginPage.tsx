import { Headset, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { useAuth } from './auth';

export const homeFor = (role: string) => (role === 'CUSTOMER' ? '/portal' : '/staff');

export function LoginPage() {
  const { status, viewer, login, logout, endedReason } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated' && viewer) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from.startsWith('/') ? from : homeFor(viewer.role)} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Please wait a minute and try again.' : err instanceof ApiError && err.status === 401 ? 'Invalid email or password.' : 'Sign-in is unavailable right now. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_28rem]">
      <aside className="nav-surface hidden flex-col justify-between bg-nav p-10 text-nav-text lg:flex">
        <div className="flex items-center gap-2 text-white">
          <Headset className="h-6 w-6 text-[#7ee0d4]" aria-hidden="true" />
          <span className="text-lg font-semibold tracking-tight">Frontdesk</span>
        </div>
        <div className="max-w-md space-y-4">
          <h2 className="text-2xl font-semibold leading-snug text-white">Support that keeps its promises.</h2>
          <p className="text-[13px] leading-relaxed">
            Independent response and resolution clocks that count only working time, a tamper-evident audit trail, and a customer portal that can never see
            internal notes.
          </p>
        </div>
        <p className="flex items-center gap-2 text-xs">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Arvo Systems support workspace
        </p>
      </aside>
      <main className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4" aria-labelledby="signin-title">
          <div className="flex items-center gap-2 lg:hidden">
            <Headset className="h-5 w-5 text-brand" aria-hidden="true" />
            <span className="font-semibold">Frontdesk</span>
          </div>
          <div>
            <h1 id="signin-title" className="text-xl font-semibold">
              Sign in
            </h1>
            <p className="mt-1 text-[13px] text-ink-2">Use your Arvo staff or customer account.</p>
          </div>
          {endedReason === 'expired' ? (
            <p role="status" className="rounded-md border border-warn/30 bg-warn-soft p-3 text-[13px] text-warn-ink">
              Your session ended. Please sign in again.
            </p>
          ) : null}
          {endedReason === 'elsewhere' ? (
            <p role="status" className="rounded-md border border-warn/30 bg-warn-soft p-3 text-[13px] text-warn-ink">
              You were signed out in another tab or window. Unsaved changes on this page were discarded.
            </p>
          ) : null}
          {endedReason === 'logout-unconfirmed' ? (
            <div role="alert" className="space-y-2 rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px] text-danger-ink">
              <p>We could not confirm sign-out with the server. Your session may still be active on this device.</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => void logout()}>
                Retry sign-out
              </Button>
            </div>
          ) : null}
          <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          {error ? (
            <p role="alert" className="text-[13px] font-medium text-danger-ink">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </main>
    </div>
  );
}
