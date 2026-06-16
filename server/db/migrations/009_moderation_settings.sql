-- Byron-iter 2026-06-16: moderation settings for the junk classifier.
-- These three settings let Byron tune junk rules from the Settings page
-- without editing code:
--
--   auto_dismiss_domains   comma-separated exact-match domains
--                          (e.g. "mail.cargurus.com,googlenews-noreply.google.com")
--                          Each adds 0.6 to the score on top of anything else.
--
--   auto_keep_subjects     comma-separated substrings of subjects that
--                          should NEVER be auto-dismissed, no matter the
--                          sender. Use for "security alert", "reactivation
--                          required", "do not reply" patterns you want to
--                          guarantee-by-config.
--
--   agent_mailbox_from     comma-separated from_emails that are operational
--                          agent mail (default: johnn5wizbot@gmail.com).
--                          Used by the "Hide agent mail" toggle in the
--                          Inbox UI — agent mail stays in the DB but is
--                          hidden from the human-pending view.
--
-- We seed the agent mailbox default so the UI's toggle has a value out
-- of the box. The other two are left null (treated as empty by the
-- classifier).
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('agent_mailbox_from', 'johnn5wizbot@gmail.com'),
  ('auto_dismiss_domains', ''),
  ('auto_keep_subjects', '');
