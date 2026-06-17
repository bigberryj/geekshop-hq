import { NavLink, Outlet } from 'react-router-dom';
import { Inbox, Ticket, Calendar, Users, DollarSign, Clock, Search, Settings, Bot } from 'lucide-react';

const nav = [
  { to: '/', label: 'Inbox', icon: Inbox, end: true },
  { to: '/tickets', label: 'Tickets', icon: Ticket },
  { to: '/appointments', label: 'Appointments', icon: Calendar },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/money', label: 'Money', icon: DollarSign },
  { to: '/time', label: 'Time', icon: Clock },
  { to: '/memory', label: 'Memory', icon: Search },
  { to: '/mission-control', label: 'Mission Control', icon: Bot },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  return (
    <div className="min-h-screen flex">
      <aside className="w-56 bg-slate-900 text-slate-100 p-4 flex-shrink-0">
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
        <div className="mt-8 text-xs text-slate-500">
          <a href="/book/general" target="_blank" className="hover:text-brand-100">
            ↗ Public booking page
          </a>
        </div>
      </aside>
      <main className="flex-1 p-6 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
