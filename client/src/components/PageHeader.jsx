import { Link } from 'react-router-dom';

/**
 * PageHeader — consistent title + optional back-link + actions row.
 *
 * On mobile (< md), actions wrap below the title. Use one of:
 *   <PageHeader title="Tickets" actions={<button/>} />
 *   <PageHeader title="Tickets" backTo="/customers" backLabel="All customers" actions={...} />
 *
 * Keeps every page header the same shape, which is the cheapest mobile win.
 */
export default function PageHeader({ title, subtitle, backTo, backLabel = '← Back', actions }) {
  return (
    <header className="mb-4 md:mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-2">
      <div className="min-w-0">
        {backTo && (
          <Link to={backTo} className="text-sm text-slate-500 hover:underline">
            {backLabel}
          </Link>
        )}
        <h2 className="text-2xl font-bold">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
