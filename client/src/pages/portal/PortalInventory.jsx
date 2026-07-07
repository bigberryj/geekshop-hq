import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { fetchJson } from '../../lib/api.js';
import DataTable from '../../components/DataTable.jsx';

/**
 * PortalInventory — read-only view of devices at locations the office
 * manager is authorized to see. Filterable by location_id.
 *
 * No edit affordances by design: clients view, they don't admin HQ.
 * Changes go through the account manager.
 */
export default function PortalInventory() {
  const { me } = useOutletContext();
  const [assets, setAssets] = useState([]);
  const [filterLoc, setFilterLoc] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = filterLoc ? `?location_id=${filterLoc}` : '';
    fetchJson(`/portal/assets${q}`).then(setAssets).finally(() => setLoading(false));
  }, [filterLoc]);

  const visibleLocations = me.locations || [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-bold mr-auto">Inventory</h2>
        <select className="input max-w-xs tap-target" value={filterLoc} onChange={(e) => setFilterLoc(e.target.value)}>
          <option value="">All locations</option>
          {visibleLocations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </div>
      {loading ? <div className="text-slate-500">Loading…</div> : (
        <DataTable
          columns={[
            { key: 'hostname', header: 'Hostname', primary: true },
            { key: 'type', header: 'Type' },
            { key: 'assigned_user', header: 'Assigned', hideOnMobile: true },
            { key: 'manufacturer', header: 'Make', hideOnMobile: true },
            { key: 'model', header: 'Model', hideOnMobile: true },
            { key: 'os', header: 'OS', hideOnMobile: true },
            { key: 'location_label', header: 'Location', hideOnMobile: true },
            { key: 'last_serviced_at', header: 'Last serviced', hideOnMobile: true,
              render: (a) => a.last_serviced_at ? new Date(a.last_serviced_at).toLocaleDateString() : '—' },
          ]}
          rows={assets}
          rowKey={(a) => a.id}
          empty={filterLoc ? 'No devices at this location.' : 'No devices visible to your account.'}
        />
      )}
    </div>
  );
}
