/**
 * Route registration. Mounts all /api/* and public /book/* routes.
 */

import { dashboardRoutes } from './dashboard.js';
import { ticketRoutes } from './tickets.js';
import { customerRoutes } from './customers.js';
import { memoryRoutes } from './memory.js';
import { timeRoutes } from './time-entries.js';
import { invoiceRoutes } from './invoices.js';
import { appointmentRoutes } from './appointments.js';
import { moneyRoutes } from './money.js';
import { memorySearchRoutes } from './memory-search.js';
import { settingsRoutes } from './settings.js';
import { auditRoutes } from './audit.js';
import { authRoutes } from './auth.js';
import { bookingRoutes } from './booking.js';
import { inboxRoutes } from './inbox.js';
import { agentTaskRoutes } from './agent-tasks.js';
import agentRoutes from './agents.js';

export async function registerRoutes(app, { rootDir }) {
  // Health check
  app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  await app.register(dashboardRoutes);
  await app.register(ticketRoutes);
  await app.register(customerRoutes);
  await app.register(memoryRoutes);
  await app.register(timeRoutes);
  await app.register(invoiceRoutes);
  await app.register(appointmentRoutes);
  await app.register(moneyRoutes);
  await app.register(memorySearchRoutes);
  await app.register(settingsRoutes);
  await app.register(auditRoutes);
  await app.register(authRoutes);
  await app.register(bookingRoutes);
  await app.register(inboxRoutes);
  await app.register(agentTaskRoutes);
  await app.register(agentRoutes);
}
