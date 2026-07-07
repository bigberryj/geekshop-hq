import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchJson, postJson } from '../../lib/api.js';

/**
 * PortalLogin — email + password login for office managers.
 *
 * Uses a public PortalShell wrapper. Sets the hq_csid cookie via the
 * server response so the subsequent /portal/me call succeeds.
 */
export default function PortalLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // If already logged in, jump straight in.
  useEffect(() => {
    fetchJson('/portal/me')
      .then((me) => {
        if (me) navigate('/portal', { replace: true });
      })
      .catch(() => { /* not logged in */ });
  }, [navigate]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await postJson('/portal/login', { email, password });
      // Use a full document navigation after login so the shell rehydrates
      // from the freshly-set HttpOnly hq_csid cookie. This avoids auth-state
      // races where the login route and protected dashboard can bounce between
      // each other in the same React render tree.
      window.location.replace('/portal');
    } catch (err) {
      setError('Invalid email or password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="bg-white rounded-lg shadow-sm border border-slate-200 p-6 w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-bold">Client Portal</h1>
          <p className="text-xs text-slate-500">Office manager sign-in</p>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input
            type="email"
            className="input tap-target mt-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Password</span>
          <input
            type="password"
            className="input tap-target mt-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>
        {error && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{error}</div>}
        <button type="submit" disabled={busy} className="btn-primary w-full tap-target disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="text-xs text-slate-500 text-center pt-2 border-t">
          Need access? Ask your GeekShop account manager to send you an invite link.
        </div>
      </form>
    </div>
  );
}
