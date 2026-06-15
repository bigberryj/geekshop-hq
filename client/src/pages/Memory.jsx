import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson } from '../lib/api.js';
import { Search } from 'lucide-react';

export default function Memory() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (q.length < 2) { setResults([]); return; }
    const t = setTimeout(() => fetchJson(`/memory/search?q=${encodeURIComponent(q)}`).then(setResults), 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Memory search</h2>
      <p className="text-sm text-slate-500 mb-4">Search across all customer memory entries. <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-xs">cmd+k</kbd> equivalent.</p>
      <div className="card mb-4">
        <div className="flex items-center gap-2">
          <Search size={18} className="text-slate-400" />
          <input
            className="input flex-1 border-0 shadow-none focus:ring-0"
            placeholder="What's Linda's printer model? When did Brian's AP go down?"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </div>
      </div>
      <div>
        {results.length === 0 && q.length >= 2 && <p className="text-slate-500 text-sm text-center py-6">No matches.</p>}
        <ul className="space-y-2">
          {results.map((r) => (
            <li key={r.id} className="card flex items-start justify-between">
              <div>
                <span className="badge-yellow mr-2">{r.category}</span>
                {r.key && <span className="font-mono text-xs text-slate-500 mr-2">{r.key}:</span>}
                <span>{r.value}</span>
                <span className="text-xs text-slate-400 ml-2">({r.source}, conf {r.confidence})</span>
              </div>
              <Link to={`/customers/${r.customer_id}`} className="text-sm text-brand-600 hover:underline">{r.customer_name}</Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
