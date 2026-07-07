#!/usr/bin/env node
/**
 * One-off: email Byron the details + zip download for the
 * Hide Variable Product Price plugin v1.1.0.
 *
 * Task T-6CDA0E requeue — Byron asked for "the johnny 5 email" + a
 * download link for the zip + GitHub-hosted auto-updates wired.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import nodemailer from 'nodemailer';

// Load server/.env the same way server/index.js does, so SMTP creds are
// present even when this runs from a cron / systemd unit that doesn't
// inherit them.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..', '..');
try {
  const envPath = resolve(rootDir, 'server/.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch { /* ignore */ }

const TO = process.env.BYRON_GMAIL_USER || 'byron@geekshop.ca';

const subject = '[J5] Hide Variable Product Price v1.1.0 — GitHub updater wired + zip attached (T-6CDA0E)';

const body = `Hi Byron,

v1.1.0 of Hide Variable Product Price is built, the GitHub repo is up, and
the zip is attached to this email. From v1.1.0 onwards, future versions of
this plugin will update through WordPress automatically — no more manual
uploads once the GitHub token is in place.

================================================================
1. WHAT'S NEW IN v1.1.0
================================================================

  - Bundled GitHub-hosted auto-updates via YahnisElsts/plugin-update-checker
    v5.7 (same library + same wiring we baked into divi-to-brizy-converter).
  - New GitHub repo: https://github.com/bigberryj/hide-variable-price
    (private, owned by bigberryj).
  - First GitHub release published: v1.1.0.
  - .github/workflows/release-plugin.yml — builds + attaches
    hide-variable-price.zip on every GitHub release.
  - readme.txt — WordPress.org-shaped readme with Stable tag + changelog.
  - No behaviour change to the three-layer hide pattern. v1.0.0's hide
    logic, sanitiser, and tests are untouched.

================================================================
2. DOWNLOAD THE ZIP
================================================================

The zip is attached to this email: hide-variable-price.zip (192 KB).

Mirror (authenticated GitHub access only — log in as bigberryj):
  https://github.com/bigberryj/hide-variable-price/releases/download/v1.1.0/hide-variable-price.zip

GitHub release page (also authenticated):
  https://github.com/bigberryj/hide-variable-price/releases/tag/v1.1.0

Local path (for future reference):
  /home/byron/projects/hide-variable-price/build/hide-variable-price.zip

================================================================
3. INSTALL ON WORDPRESS
================================================================

This is the FIRST install — Plugin Update Checker can't bootstrap itself, so
this one needs to be manual:

  1. Save the attached zip somewhere on the WP server (or your laptop).
  2. WP Admin → Plugins → Add New → Upload Plugin → Choose File → pick
     hide-variable-price.zip → Install Now.
  3. Click "Replace active and continue" if WP asks (it won't be active yet
     on a fresh install).
  4. Activate Plugin.

WooCommerce must already be active (the plugin header has
"Requires Plugins: woocommerce"). WP 6.5+ will refuse to activate it
otherwise.

================================================================
4. ENABLE AUTO-UPDATES (so future releases don't need manual uploads)
================================================================

The repo is private, so PUC needs a GitHub access token. Generate a
fine-grained token at https://github.com/settings/tokens with:

  Resource owner:  bigberryj
  Repository:      bigberryj/hide-variable-price (only this repo)
  Permission:      Contents  →  Read-only

Then add it to wp-config.php BEFORE the "That's all, stop editing!" line:

  define( 'HVP_GITHUB_ACCESS_TOKEN', 'github_pat_XXXXXXXXXXXX' );

(Or as an environment variable: HVP_GITHUB_ACCESS_TOKEN=github_pat_XXX.)

Once that's in place, WP will pick up future releases on its usual
update-check cadence (about every 12 hours). The update will appear under
Plugins with the same "update now" button as any other plugin.

================================================================
5. CONFIGURATION (UNCHANGED FROM v1.0.0)
================================================================

Settings → Hide Variable Price.

  - Enabled          master switch (off = no filtering)
  - Mode             all / categories_only / products_only
  - Hidden categories  WooCommerce product_cat term IDs
  - Hidden products    WooCommerce product IDs

The sanitiser is strict: only the literal 1 enables; mode must be one of
the three whitelisted values; non-positive IDs are dropped.

================================================================
6. HOW RELEASES WORK FROM NOW ON
================================================================

  1. Bump Version: header AND HVP_VERSION constant AND HVP_VERSION in
     qa/phpstan-wordpress-stubs.php AND Stable tag: in readme.txt (all
     four must match).
  2. Add an entry to readme.txt changelog.
  3. git add . && git commit && git push
  4. git tag v1.Y.Z && git push --tags
  5. gh release create v1.Y.Z --generate-notes
     (or use the GitHub UI; either way the workflow attaches the zip)
  6. WordPress shows the update on its next cache refresh.

Full release procedure is documented in the plugin's AGENTS.md
(/home/byron/projects/hide-variable-price/AGENTS.md).

================================================================
7. WHERE EVERYTHING LIVES
================================================================

  Plugin source:      /home/byron/projects/hide-variable-price/
  GitHub repo:        https://github.com/bigberryj/hide-variable-price
  Latest release:     https://github.com/bigberryj/hide-variable-price/releases/tag/v1.1.0
  Build evidence:     /home/byron/projects/hide-variable-price/evidence/2026-06-25-updater-and-zip.md
  v1.0.0 evidence:    /home/byron/projects/hide-variable-price/evidence/2026-06-25-initial-build.md
  AGENTS.md:          /home/byron/projects/hide-variable-price/AGENTS.md
  readme.txt:         /home/byron/projects/hide-variable-price/readme.txt

================================================================
8. FOLLOW-UPS YOU MIGHT WANT
================================================================

  - Generate the GitHub token and add HVP_GITHUB_ACCESS_TOKEN to
    wp-config.php on the live site (needed for auto-updates to work).
  - Confirm WP picks up v1.1.0 in Plugins after the update cache refresh
    (about 12 hours).
  - Live-test on the Brizy site: pick a product in one of your hidden
    categories, confirm the variation price block stays empty as you
    change options. If a Brizy template wraps the price in a class not
    covered by .woocommerce-variation-price / .single_variation .price,
    add it to HVP_Hvp::print_hide_css() in includes/class-hvp.php.

Ping me on Telegram if you want me to queue any of those as separate
tasks.

— J5
`;

const ZIP_PATH = '/home/byron/projects/hide-variable-price/build/hide-variable-price.zip';
if (!existsSync(ZIP_PATH)) {
  console.error(JSON.stringify({ sent: false, error: `zip missing at ${ZIP_PATH}` }));
  process.exit(2);
}

const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

try {
  const info = await t.sendMail({
    from: process.env.SMTP_FROM || `GeekShop HQ <${process.env.SMTP_USER}>`,
    to: TO,
    subject,
    text: body,
    attachments: [
      {
        filename: 'hide-variable-price.zip',
        path: ZIP_PATH,
        contentType: 'application/zip',
      },
    ],
  });
  console.log(JSON.stringify({
    sent: true,
    message_id: info.messageId,
    to: TO,
    subject,
    attachment: ZIP_PATH,
  }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ sent: false, error: err.message }, null, 2));
  process.exit(1);
}
