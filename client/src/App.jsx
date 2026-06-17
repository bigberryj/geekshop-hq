import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Inbox from './pages/Inbox.jsx';
import Tickets from './pages/Tickets.jsx';
import TicketDetail from './pages/TicketDetail.jsx';
import Appointments from './pages/Appointments.jsx';
import Customers from './pages/Customers.jsx';
import CustomerDetail from './pages/CustomerDetail.jsx';
import Money from './pages/Money.jsx';
import Time from './pages/Time.jsx';
import Memory from './pages/Memory.jsx';
import Settings from './pages/Settings.jsx';
import PublicBooking from './pages/PublicBooking.jsx';
import MissionControl from './pages/MissionControl.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/book/:slug" element={<PublicBooking />} />
      <Route path="/" element={<Layout />}>
        <Route index element={<Inbox />} />
        <Route path="tickets" element={<Tickets />} />
        <Route path="tickets/:id" element={<TicketDetail />} />
        <Route path="appointments" element={<Appointments />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="money" element={<Money />} />
        <Route path="time" element={<Time />} />
        <Route path="memory" element={<Memory />} />
        <Route path="settings" element={<Settings />} />
        <Route path="mission-control" element={<MissionControl />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
