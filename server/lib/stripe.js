/**
 * Stripe wrapper.
 *
 * Lazy-loads the Stripe client only when STRIPE_SECRET_KEY is set. This
 * keeps tests + dev (no Stripe) importable and side-effect-free.
 *
 * Two surfaces:
 *   - createCheckoutForInvoice({ invoice, app }) → { url, session_id, payment_intent_id }
 *       Creates a Stripe Checkout Session in "pay invoice total" mode
 *       with metadata.invoice_id so the webhook can flip the invoice paid.
 *   - verifyWebhook({ rawBody, signatureHeader }) → Stripe.Event
 *       Used by the /api/accounting/stripe/webhook route. Verifies the
 *       signature with STRIPE_WEBHOOK_SECRET and returns the parsed event.
 *       Throws Stripe.errors.StripeSignatureVerificationError on bad sig.
 *
 * The webhook handler that consumes these events lives in
 * routes/accounting.js — see POST /api/accounting/stripe/webhook.
 */

import Stripe from 'stripe';

let _stripe = null;

export function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function stripeWebhookConfigured() {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

export function getStripe() {
  if (!stripeConfigured()) return null;
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
      // Don't retry on 4xx — the handler is what decides.
      maxNetworkRetries: 2,
    });
  }
  return _stripe;
}

/**
 * Create a Stripe Checkout Session for an invoice.
 *
 * @param {object} args
 * @param {object} args.invoice  full invoice row (must have id, invoice_uid, total_cents, customer_name, customer_email)
 * @param {string} [args.success_url]
 * @param {string} [args.cancel_url]
 * @returns {Promise<{ url: string, session_id: string, payment_intent: string|null }>}
 */
export async function createCheckoutForInvoice({ invoice, success_url, cancel_url }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('stripe_not_configured');

  const origin = process.env.APP_URL || 'http://localhost:5173';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: invoice.customer_email || undefined,
    line_items: [
      {
        price_data: {
          currency: 'cad',
          unit_amount: Number(invoice.total_cents),
          product_data: {
            name: `Invoice ${invoice.invoice_uid}`,
            description: `Payment for ${invoice.customer_name || 'customer'}`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      invoice_id: String(invoice.id),
      invoice_uid: invoice.invoice_uid,
    },
    payment_intent_data: {
      metadata: {
        invoice_id: String(invoice.id),
        invoice_uid: invoice.invoice_uid,
      },
    },
    success_url: success_url || `${origin}/accounting/invoices/${invoice.id}?stripe=success&session={CHECKOUT_SESSION_ID}`,
    cancel_url: cancel_url || `${origin}/accounting/invoices/${invoice.id}?stripe=cancelled`,
  });
  return {
    url: session.url,
    session_id: session.id,
    payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
  };
}

/**
 * Verify a Stripe webhook signature and return the parsed event.
 *
 * Caller is responsible for rawBody (raw, unparsed bytes — NOT JSON.parse'd).
 *
 * @param {object} args
 * @param {string|Buffer} args.rawBody
 * @param {string} args.signatureHeader  value of 'stripe-signature' header
 * @returns {import('stripe').Stripe.Event}
 * @throws if signature verification fails or secret not configured
 */
export function verifyWebhook({ rawBody, signatureHeader }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('stripe_not_configured');
  if (!stripeWebhookConfigured()) throw new Error('stripe_webhook_not_configured');
  return stripe.webhooks.constructEvent(
    rawBody,
    signatureHeader,
    process.env.STRIPE_WEBHOOK_SECRET,
  );
}

/**
 * Injectable Stripe client for tests. Lets the test suite monkey-patch
 * createCheckoutForInvoice / verifyWebhook so we can exercise the route
 * layer without hitting the real Stripe API.
 */
export function __setStripeForTests(stripeImpl) {
  _stripe = stripeImpl;
}
