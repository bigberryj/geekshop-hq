import { Link } from 'react-router-dom';

/**
 * DataTable — responsive table/card view.
 *
 * On md+ (>= 768px) renders a real <table>.
 * Below md, renders each row as a stacked card with `primary` text first.
 *
 * Props:
 *   columns: [{ key, header, render?, primary?, hideOnMobile?, align?, width? }]
 *   rows:    array of objects
 *   rowKey:  string | (row) => string|number
 *   onRowClick?: (row) => void       — when set, rows are buttons (a11y: keyboard reachable)
 *   empty?:  string                   — empty-state message
 *   mobilePrimary?: key name          — overrides column[].primary for the card header
 *
 * Why this exists:
 *   The old "card overflow-hidden table" pattern forces the user to horizontally
 *   scroll inside a tiny viewport on a phone. Cards collapse cleanly without scroll.
 *
 * Usage:
 *   <DataTable
 *     columns={[
 *       { key: 'subject', header: 'Subject', primary: true,
 *         render: (t) => <Link to={`/tickets/${t.id}`}>{t.subject}</Link> },
 *       { key: 'status', header: 'Status' },
 *       { key: 'priority', header: 'Priority', hideOnMobile: true },
 *       { key: 'last_message_at', header: 'Last activity', hideOnMobile: true,
 *         render: (t) => t.last_message_at ? new Date(t.last_message_at).toLocaleString() : '—' },
 *     ]}
 *     rows={tickets}
 *     rowKey="id"
 *   />
 */
export default function DataTable({
  columns,
  rows,
  rowKey = 'id',
  onRowClick,
  empty = 'No rows.',
  cardClassName = '',
}) {
  const keyOf = (row, i) => (typeof rowKey === 'function' ? rowKey(row, i) : row[rowKey] ?? i);

  // Columns visible on mobile (default: all except those flagged hideOnMobile).
  // `primary` flags the column whose value becomes the card title; falls back to first column.
  const desktopCols = columns;
  const mobileCols = columns.filter((c) => !c.hideOnMobile);
  const primaryCol = columns.find((c) => c.primary) || columns[0];

  return (
    <>
      {/* Mobile (< md): stacked cards. */}
      <div className="md:hidden space-y-2">
        {rows.length === 0 && (
          <div className="card text-center text-sm text-slate-500">{empty}</div>
        )}
        {rows.map((row, i) => {
          const cls = ['card', 'p-3', onRowClick ? 'cursor-pointer active:scale-[0.99] transition-transform' : '', cardClassName].filter(Boolean).join(' ');
          const inner = (
            <div className="min-w-0">
              {primaryCol && (
                <div className="font-medium text-sm truncate">
                  {primaryCol.render ? primaryCol.render(row, i) : String(row[primaryCol.key] ?? '')}
                </div>
              )}
              {mobileCols
                .filter((c) => c !== primaryCol)
                .map((c) => (
                  <div key={c.key} className="flex items-baseline gap-2 text-xs mt-1">
                    <span className="text-slate-500 uppercase tracking-wide">{c.header}</span>
                    <span className="text-slate-800 truncate">
                      {c.render ? c.render(row, i) : String(row[c.key] ?? '—')}
                    </span>
                  </div>
                ))}
            </div>
          );
          return onRowClick ? (
            <button
              key={keyOf(row, i)}
              type="button"
              onClick={() => onRowClick(row)}
              className={cls + ' text-left w-full'}
            >
              {inner}
            </button>
          ) : (
            <div key={keyOf(row, i)} className={cls}>{inner}</div>
          );
        })}
      </div>

      {/* Desktop (>= md): real table, scrolls horizontally if ever too wide. */}
      <div className="hidden md:block card overflow-hidden p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              {desktopCols.map((c) => (
                <th
                  key={c.key}
                  className={`px-3 py-2 whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''} ${c.headerClassName || ''}`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={desktopCols.length} className="px-3 py-4 text-center text-slate-500">
                  {empty}
                </td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr
                key={keyOf(row, i)}
                className={`border-t hover:bg-slate-50 ${onRowClick ? 'cursor-pointer' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {desktopCols.map((c) => (
                  <td
                    key={c.key}
                    className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : ''} ${c.cellClassName || ''}`}
                  >
                    {c.render ? c.render(row, i) : (row[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
