import { Outlet, Link, NavLink, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { fetchJson, postJson } from '../../lib/api.js';
import { LogOut, LayoutDashboard, Package, FileText, Loader2 } from 'lucide-react';

/**
 * PortalShell — bare top-bar chrome for the contract-client portal.
 *
 * No HQ layout, no admin nav. Office managers see only their slice of
 * the contract client's data and can sign out.
 */
export default function PortalShell() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    fetchJson('/portal/me')
      .then(setMe)
      .catch((err) => {
        // 401 is expected when not logged in
        if (err.response?.status !== 401) setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  const logout = async () => {
    await postJson('/portal/logout');
    setMe(null);
    navigate('/portal/login');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="animate-spin text-slate-400" />
      </div>
    );
  }

  if (!me) {
    const publicPortalRoute = location.pathname === '/portal/login' || location.pathname.startsWith('/portal/redeem/');
    if (!publicPortalRoute) {
      return <Navigate to="/portal/login" replace state={{ from: location.pathname }} />;
    }
    // Login + redeem routes render via Outlet below.
    return (
      <div className="min-h-screen bg-slate-100">
        <Outlet context={{ me: null, setMe }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-100">
      <header className="bg-white shadow-sm border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <Link to="/portal" className="font-semibold text-brand-700 mr-auto">
            {me.client?.name || 'Client Portal'}
          </Link>
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            <PortalNavLink to="/portal" end icon={LayoutDashboard}>Dashboard</PortalNavLink>
            <PortalNavLink to="/portal/inventory" icon={Package}>Inventory</PortalNavLink>
            <PortalNavLink to="/portal/requests" icon={FileText}>Requests</PortalNavLink>
          </nav>
          <div className="flex items-center gap-2 text-sm border-l pl-3 ml-1 border-slate-200">
            <span className="text-slate-600 hidden md:inline">{me.display_name || me.email}</span>
            <button type="button" onClick={logout} className="btn-ghost tap-target inline-flex items-center gap-1">
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full p-4">
        {error && <div className="mb-3 p-3 bg-red-50 text-red-700 rounded">{error}</div>}
        <Outlet context={{ me, setMe }} />
      </main>
    </div>
  );
}

function PortalNavLink({ to, icon: Icon, children, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `inline-flex items-center gap-1 px-2 py-1 rounded text-sm font-medium ${
          isActive ? 'bg-brand-100 text-brand-700' : 'text-slate-600 hover:bg-slate-100'
        }`
      }
    >
      <Icon size={14} /> {children}
    </NavLink>
  );
}
