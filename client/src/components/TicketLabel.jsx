import { Link } from 'react-router-dom';

/**
 * Compact, admin-friendly ticket reference.
 *
 * Default format: "Brian Chen — Wi-Fi drops in the upstairs office"
 *   (customer name + subject — what you actually scan for)
 *
 * The internal UID (G-000042) is shown as a tiny monospace badge
 * with the full UID in the title (hover) tooltip. Hidden in compact mode.
 *
 * Used in Inbox, Tickets list, Time entries, and the TicketDetail header
 * so the same look + hover behavior is consistent everywhere.
 */
export default function TicketLabel({ ticket, compact = false }) {
  if (!ticket) return null;
  const subject = ticket.subject || '(no subject)';
  const uid = ticket.ticket_uid;

  if (compact) {
    // Inbox / list view: customer name + subject, UID as hover-only title
    return (
      <span>
        <span className="font-medium text-slate-800">{ticket.customer_name}</span>
        <span className="text-slate-400 mx-1">—</span>
        <span className="text-slate-700">{subject}</span>
        {uid && (
          <span
            className="ml-2 text-[10px] font-mono text-slate-400"
            title={`Internal ID: ${uid}`}
          >
            #{uid.split('-')[1]}
          </span>
        )}
      </span>
    );
  }

  // Full mode (table or detail): subject as the main link, customer + UID below
  return (
    <div>
      <div className="font-medium text-slate-800">
        <Link to={`/tickets/${ticket.id}`} className="hover:underline">
          {subject}
        </Link>
      </div>
      <div className="text-xs text-slate-500 mt-0.5">
        <Link to={`/customers/${ticket.customer_id}`} className="text-brand-600 hover:underline">
          {ticket.customer_name}
        </Link>
        {uid && (
          <span
            className="ml-2 font-mono text-slate-400"
            title={`Internal ID: ${uid} — safe to share with team, not with customers`}
          >
            {uid}
          </span>
        )}
      </div>
    </div>
  );
}
