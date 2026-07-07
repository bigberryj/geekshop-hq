import { useEffect, useState } from 'react';
import { useNavigate, useParams, useOutletContext } from 'react-router-dom';
import { fetchJson, postJson } from '../../lib/api.js';

/**
 * PortalRedeem — set-password page for a one-time invite link.
 *
 * GET /api/portal/redeem/:token first to peek the invite (and render the
 * client label + email so the user knows what they're activating).
 * POST consumes the token and creates the credential.
 */
export default function PortalRedeem() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { setMe } = useOutletContext() || {};
  const [invite, setInvite] = useState(null);
  const [err, setErr] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchJson(`/portal/redeem/${token}`)
      .then(setInvite)
      .catch((e) => setErr(e.response?.data?.reason || e.message || 'invalid_invite'));
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) {
      setErr('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setErr('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await postJson(`/portal/redeem/${token}`, { password, display_name: displayName });
      navigate('/portal', { replace: true });
    } catch (error_) {
      setErr(error_.response?.data?.error || error_.message);
    } finally {
      setBusy(false);
    }
  };

  if (err && !invite) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="card max-w-md text-center">
          <div className="text-2xl font-bold text-red-700">Invite unavailable</div>
          <p className="text-sm text-slate-600 mt-2">{err}</p>
          <p className="text-xs text-slate-400 mt-4">Ask your GeekShop account manager for a new link.</p>
        </div>
      </div>
    );
  }

  if (!invite) {
    return <div className="min-h-screen flex items-center justify-center"><div className="text-slate-500">Loading…</div></div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="bg-white rounded-lg shadow-sm border border-slate-200 p-6 w-full max-w-sm space-y-4">
        <div>
          <div className="text-xs text-slate-500">You're activating access to</div>
          <h1 className="text-xl font-bold">{invite.client?.name || 'your account'}</h1>
          <div className="text-sm text-slate-600">{invite.email}</div>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Display name</span>
          <input
            className="input tap-target mt-1"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={invite.display_name || invite.email}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">New password *</span>
          <input
            type="password"
            className="input tap-target mt-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoFocus
          />
          <span className="text-xs text-slate-500">At least 8 characters.</span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Confirm password *</span>
          <input
            type="password"
            className="input tap-target mt-1"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
          />
        </label>
        {err && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{err}</div>}
        <button type="submit" disabled={busy} className="btn-primary w-full tap-target disabled:opacity-50">
          {busy ? 'Activating…' : 'Activate access'}
        </button>
      </form>
    </div>
  );
}
