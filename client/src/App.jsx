import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Inbox from './pages/Inbox.jsx';
import Tickets from './pages/Tickets.jsx';
import TicketDetail from './pages/TicketDetail.jsx';
import Appointments from './pages/Appointments.jsx';
import Customers from './pages/Customers.jsx';
import CustomerDetail from './pages/CustomerDetail.jsx';
import Money from './pages/Money.jsx';
import Accounting from './pages/Accounting.jsx';
import TaxSummaryPrintable from './pages/TaxSummaryPrintable.jsx';
import Time from './pages/Time.jsx';
import Memory from './pages/Memory.jsx';
import Settings from './pages/Settings.jsx';
import PublicBooking from './pages/PublicBooking.jsx';
import MissionControl from './pages/MissionControl.jsx';
import Agents from './pages/Agents.jsx';
import Feed from './pages/Feed.jsx';
import ContractClients from './pages/ContractClients.jsx';
import ContractClientDetail from './pages/ContractClientDetail.jsx';
import PortalShell from './components/portal/PortalShell.jsx';
import PortalLogin from './pages/portal/PortalLogin.jsx';
import PortalDashboard from './pages/portal/PortalDashboard.jsx';
import PortalInventory from './pages/portal/PortalInventory.jsx';
import PortalRequests from './pages/portal/PortalRequests.jsx';
import PortalRequestNew from './pages/portal/PortalRequestNew.jsx';
import PortalRedeem from './pages/portal/PortalRedeem.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/book/:slug" element={<PublicBooking />} />
      {/* Client portal — public surface, bare shell, no admin layout. */}
      <Route path="/portal" element={<PortalShell />}>
        <Route index element={<PortalDashboard />} />
        <Route path="login" element={<PortalLogin />} />
        <Route path="inventory" element={<PortalInventory />} />
        <Route path="requests" element={<PortalRequests />} />
        <Route path="requests/new" element={<PortalRequestNew />} />
        <Route path="redeem/:token" element={<PortalRedeem />} />
      </Route>
      <Route path="/accounting/tax-summary/print" element={<TaxSummaryPrintable />} />
      <Route path="/" element={<Layout />}>
        <Route index element={<Inbox />} />
        <Route path="tickets" element={<Tickets />} />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="appointments" element={<Appointments />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="contract-clients" element={<ContractClients />} />
        <Route path="contract-clients/:id" element={<ContractClientDetail />} />
        <Route path="money" element={<Money />} />
        <Route path="accounting" element={<Accounting />} />
        <Route path="time" element={<Time />} />
        <Route path="memory" element={<Memory />} />
        <Route path="settings" element={<Settings />} />
        <Route path="mission-control" element={<MissionControl />} />
        <Route path="mission-control/agents" element={<Agents />} />
        <Route path="mission-control/feed" element={<Feed />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
