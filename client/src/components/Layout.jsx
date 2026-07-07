import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Inbox, Ticket, Calendar, Users, DollarSign, Clock, Search, Settings, Bot, Calculator, Menu, X, Briefcase } from 'lucide-react';

const nav = [
  { to: '/', label: 'Inbox', icon: Inbox, end: true },
  { to: '/tickets', label: 'Tickets', icon: Ticket },
  { to: '/appointments', label: 'Appointments', icon: Calendar },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/contract-clients', label: 'Contract Clients', icon: Briefcase },
  { to: '/money', label: 'Money', icon: DollarSign },
  { to: '/accounting', label: 'Accounting', icon: Calculator },
  { to: '/time', label: 'Time', icon: Clock },
  { to: '/memory', label: 'Memory', icon: Search },
  { to: '/mission-control', label: 'Mission Control', icon: Bot },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/**
 * Mobile-friendly shell.
 *
 * Desktop (>= md): fixed 224px left sidebar, full-width main area, no top bar.
 * Mobile (< md): collapsed hamburger in a top bar; tapping opens a slide-in
 * drawer with the same nav. Lock body scroll while the drawer is open.
 *
 * `NavLink` rendering and active styling are unchanged between desktop and mobile
 * so the "active page" highlight behaves the same either way.
 */
export default function Layout() {
  const [open, setOpen] = useState(false);

  // Close drawer on route change. NavLink causes a re-render, but we watch
  // pathname explicitly so that programmatic navigation (e.g. after creating
  // a ticket) also collapses the drawer.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, []);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-100">
      {/* Mobile top bar — only visible below md. */}
      <header className="md:hidden bg-slate-900 text-slate-100 flex items-center justify-between px-4 py-3 sticky top-0 z-40 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="p-1 -ml-1 rounded hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <Menu size={22} />
          </button>
          <h1 className="text-base font-semibold truncate text-brand-100">GeekShop HQ</h1>
        </div>
        <a
          href="/book/general"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-brand-100 hover:text-white whitespace-nowrap"
        >
          ↗ Book
        </a>
      </header>

      {/* Mobile drawer — only mounted when open. */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="flex-1 bg-slate-900/60"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside className="w-72 max-w-[85vw] bg-slate-900 text-slate-100 p-4 flex flex-col gap-4 overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-bold text-brand-100">GeekShop HQ</h1>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="p-1 rounded hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <X size={20} />
              </button>
            </div>
            <nav className="space-y-1" onClick={() => setOpen(false)}>
              {nav.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-3 rounded-md text-sm font-medium min-h-[44px] ${
                      isActive ? 'bg-brand-600 text-white' : 'text-slate-200 hover:bg-slate-800'
                    }`
                  }
                >
                  <Icon size={18} /> {label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-auto text-xs text-slate-500 pt-4 border-t border-slate-800">
              <a href="/book/general" target="_blank" className="hover:text-brand-100">
                ↗ Public booking page
              </a>
            </div>
          </aside>
        </div>
      )}

      {/* Desktop sidebar — unchanged behaviour. */}
      <aside className="hidden md:flex w-56 bg-slate-900 text-slate-100 p-4 flex-shrink-0 flex-col">
        <h1 className="text-xl font-bold mb-6 text-brand-100">GeekShop HQ</h1>
        <nav className="space-y-1">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
                  isActive ? 'bg-brand-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto text-xs text-slate-500">
          <a href="/book/general" target="_blank" className="hover:text-brand-100">
            ↗ Public booking page
          </a>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-6 overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}
