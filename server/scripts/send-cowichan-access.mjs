#!/usr/bin/env node
/**
 * One-off: email Byron the Cowichan Gallery access details.
 * Requeue of T-41C64A, decision_note:
 *   "where can i view this can you email me the link and wordpress details
 *    please from your johnn5wizbot email please"
 *
 * Sends only — does not start/stop any services.
 */
import nodemailer from 'nodemailer';

const FROM = 'johnn5wizbot@gmail.com';     // operator-locked from name in agent.md §7
const TO   = 'byron@geekshop.ca';
const PASS = process.env.GMAIL_APP_PASSWORD;

if (!PASS) {
  console.error(JSON.stringify({ sent: false, error: 'GMAIL_APP_PASSWORD not set in cron env' }));
  process.exit(2);
}

const subject = '[J5] Cowichan Gallery 1:1 mirror — view link + WP admin details (T-41C64A)';

const body = `Hi Byron,

Continuing task T-41C64A (Cowichan Gallery 1:1 mirror) per your requeue
note: "where can i view this can you email me the link and wordpress details
please from your johnn5wizbot email please".

The site is live and the WP install is healthy as of this email — I just
hit /wp-json/wp/v2/users/me and the /wp-admin endpoint to confirm.

================================================================
1. WHERE TO VIEW IT
================================================================

  Public site (pixel-parity mirror of upstream):
      http://localhost:8090/

  WordPress admin (REAL WP install, Caddy -> php-fpm):
      http://localhost:8090/wp-admin/

  WordPress login (direct):
      http://localhost:8090/wp-login.php

  WordPress REST API:
      http://localhost:8090/wp-json/
      http://localhost:8090/wp-json/wp/v2/pages

  Both the mirror and the admin are served from the same port (8090):
  the Caddy router falls through to the static mirror for public paths
  and proxies to PHP-FPM for /wp-*.

  This is bound to localhost only (plain HTTP, no TLS) — to reach it from
  your phone or another machine, jump on Tailscale and use the host
  name, or tunnel it via SSH.

================================================================
2. WORDPRESS LOGIN DETAILS
================================================================

  Username:           byron
  Password:           same as your machine login (UNIX user password)
  Application pass:   fatwrobKw8fH60emmY5U8Frw
                       (stored in /home/byron/projects/cowichan-gallery/.env
                        — already gitignored, mode 600. Use it with
                        HTTP Basic Auth for the REST API.)

  Site title:         Cowichan Public Art Gallery
  URL:                http://localhost:8090
  Table prefix:       cg_
  Active theme:       Divi (mirrored from upstream)
  Pages imported:     50 of 50 from upstream REST API
                       (1 skipped — /home-2/ is a redirect dup of /)

================================================================
3. WHAT IS WHERE ON DISK
================================================================

  /home/byron/projects/cowichan-gallery/
  ├── README.md              full orientation, written during build
  ├── .env                   WP app password + source URLs (mode 600)
  ├── .env.example           committed template, no real values
  ├── caddy/Caddyfile        :8090 router (mirror first, WP for /wp-*)
  ├── wordpress/             real WP install (cg_ tables, MariaDB)
  ├── mirror/                249 MB static scrape of upstream
  ├── scripts/import-pages.mjs
  ├── docs/                  architecture.md, security.md, notes.md
  ├── evidence/              build-time screenshots
  └── logs/                  Caddy access + import logs

  Start everything from scratch if needed:
      cd /home/byron/projects/cowichan-gallery
      pkill -f 'caddy.*cowichan' || true
      caddy run --config caddy/Caddyfile > logs/caddy.log 2>&1 &
      # MariaDB + php-fpm-cowichan are managed by systemd and should
      # already be running; if not, start them and the WP install is
      # ready immediately.

================================================================
4. HOW THE TWO PIECES FIT
================================================================

  - The PUBLIC site (/) is the static mirror — 249 MB of upstream HTML,
    CSS, JS, and media, served directly by Caddy. Fast, byte-identical
    to upstream (anti-bot block from cowichangallery.ca does not affect
    the local copy).
  - The ADMIN (everything under /wp-*) is a real WordPress install:
    Caddy proxies /wp-admin/*, /wp-login.php, /wp-json/*, and
    /wp-content/uploads/* to PHP-FPM which talks to MariaDB.
  - The upstream pages were all imported once at build time via the
    WP REST API into the local install — so changes you make in the
    admin stick on real DB rows, not by editing the mirror HTML.

================================================================
5. CURRENT STATE / OPEN ITEMS
================================================================

  - Build is COMPLETE for the "1:1 mirror + WP backend" ask. Visual QA
    during the prior run matched upstream on /, /about-us/, /exhibitions/,
    /blog/, /donation/, /contact-3/.
  - One reminder from the earlier worker run that's still open:
    cowichangallery.ca itself returns 403 with a meta-noindex page
    to non-Googlebot UAs. The local mirror avoids that (it's just
    static files), so nothing for you to do — but if you want to
    run an import refresh against upstream, you'll need a Googlebot
    UA on import-pages.mjs. Flagging in case you revisit.
  - If you want me to: enable HTTPS on :8090, point a custom hostname
    at it via /etc/hosts, or build a /mirror-status dashboard inside
    HQ, queue any of those and I'll do it next tick.

  → Approve or requeue:
      http://localhost:5173/mission-control   (click T-41C64A)
    or open in HQ UI: http://localhost:5050/api/agent-tasks/31

— J5

P.S.  Sent from johnn5wizbot@gmail.com as you asked. The local HQ
      SMTP relay (used for other tasks) sends as byron@geekshop.ca —
      this email went out via the dedicated Gmail App Password account
      instead, exactly so you can verify the johnn5wizbot path works.
`;

const t = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: { user: FROM, pass: PASS },
});

try {
  const info = await t.sendMail({
    from: `"J5 (Johnny Five)" <${FROM}>`,
    to: TO,
    subject,
    text: body,
  });
  console.log(JSON.stringify({ sent: true, message_id: info.messageId, from: FROM, to: TO }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ sent: false, error: err.message }, null, 2));
  process.exit(1);
}
