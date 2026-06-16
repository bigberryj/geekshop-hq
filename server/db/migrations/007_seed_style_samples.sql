-- Seed style_samples from the 3 existing admin messages in ticket_messages.
-- These are real replies Byron already wrote — they become the first
-- training data for the AI voice profile.
INSERT INTO style_samples (source, text, context)
SELECT 'admin_message', body, 'reply in ticket ' || ticket_id
FROM ticket_messages
WHERE sender = 'admin' AND LENGTH(body) > 30
ORDER BY id;
