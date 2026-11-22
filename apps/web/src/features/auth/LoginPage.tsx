import { ArrowRight, Clock3, Lock, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { LogoMark } from '@/components/ui/identity';
import { Notice } from '@/components/ui/notice';
import { ApiError } from '@/lib/api';
import { useAuth } from './auth';

export const homeFor = (role: string) => (role === 'CUSTOMER' ? '/portal' : '/staff');

const FACTS = [
  { icon: Clock3, text: 'SLA clocks count working hours only' },
  { icon: ShieldCheck, text: 'Append-only audit trail' },
  { icon: Lock, text: 'Internal notes never reach customers' },
];

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
    <div className="fd-login-backdrop flex min-h-full flex-col">
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:py-16">
        <div className="mb-7 flex flex-col items-center text-center">
          <LogoMark className="h-11 w-11 drop-shadow-sm" />
          <p className="mt-3 text-heading font-semibold tracking-[-0.02em] text-ink">Frontdesk</p>
          <p className="mt-0.5 text-body text-ink-3">Arvo Systems support workspace</p>
        </div>

        <form
          onSubmit={submit}
          aria-labelledby="signin-title"
          className="glass-strong w-full max-w-[25rem] space-y-5 rounded-xl border border-white/70 p-6 shadow-pop ring-1 ring-ink/[0.06] sm:p-7"
        >
          <div>
            <h1 id="signin-title" className="text-heading font-semibold tracking-[-0.01em] text-ink">
              Sign in
            </h1>
            <p className="mt-1 text-body text-ink-2">Use your Arvo staff or customer account.</p>
          </div>
          {endedReason === 'expired' ? (
            <Notice tone="warn" role="status">
              Your session ended. Please sign in again.
            </Notice>
          ) : null}
          {endedReason === 'elsewhere' ? (
            <Notice tone="warn" role="status">
              You were signed out in another tab or window. Unsaved changes on this page were discarded.
            </Notice>
          ) : null}
          {endedReason === 'logout-unconfirmed' ? (
            <Notice
              tone="bad"
              role="alert"
              action={
                <Button type="button" variant="secondary" size="sm" onClick={() => void logout()}>
                  Retry sign-out
                </Button>
              }
            >
              <p>We could not confirm sign-out with the server. Your session may still be active on this device.</p>
            </Notice>
          ) : null}
          <div className="space-y-4">
            <Field label="Email">
              {(p) => <Input {...p} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.example" className="h-10" />}
            </Field>
            <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="h-10" />}</Field>
          </div>
          {error ? (
            <Notice tone="bad" role="alert">
              {error}
            </Notice>
          ) : null}
          <Button type="submit" variant="primary" size="lg" className="group w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
            {busy ? null : <ArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />}
          </Button>
        </form>

        <ul className="mt-8 flex max-w-xl flex-wrap justify-center gap-x-5 gap-y-2 text-meta text-ink-3">
          {FACTS.map(({ icon: Icon, text }) => (
            <li key={text} className="inline-flex items-center gap-1.5">
              <Icon className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
