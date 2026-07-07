import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * Modal — consistent mobile-friendly dialog.
 *
 * On phones (below md) renders as a bottom sheet (slides up, rounded top, full
 * width, capped at 90vh). On md+ renders as a centered dialog.
 *
 * - Esc closes.
 * - Body scroll is locked while open.
 * - Backdrop click closes unless onClose is missing.
 * - title and footer are optional. Footer buttons live in the same row.
 *
 * Props:
 *   open, onClose, title, children, footer, maxWidthClassName (default 'max-w-2xl')
 */
export default function Modal({ open, onClose, title, children, footer, maxWidthClassName = 'max-w-2xl' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-slate-900/60 p-0 md:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-white shadow-xl w-full ${maxWidthClassName} flex flex-col rounded-t-xl md:rounded-lg max-h-[90vh] md:max-h-[85vh] overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4 border-b border-slate-200 shrink-0">
            <h3 className="text-base md:text-lg font-semibold truncate">{title}</h3>
            <button
              type="button"
              className="text-slate-500 hover:text-slate-900 shrink-0 ml-2 p-1 -mr-1 md:mr-0"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="p-4 md:p-6 overflow-y-auto flex-1 overscroll-contain">{children}</div>
        {footer && (
          <div className="px-4 py-3 md:px-6 md:py-4 border-t border-slate-200 flex flex-wrap justify-end gap-2 shrink-0 bg-white">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
