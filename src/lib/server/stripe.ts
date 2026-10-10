import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Validity } from './rbac';

/**
 * The Substack integration (SPEC "Substack integration"). Substack has no API or
 * webhooks for subscribers, but its paid subscriptions live in the writer's
 * own Stripe account, which does have webhooks. rbacr receives that
 * account's `customer.subscription.*` events and re-reads the customer from
 * Stripe, so the outcome never depends on event order or retries.
 */

/** How old a signed event may be (Stripe's recommended default). */
const TOLERANCE_SECONDS = 300;

/** Subscription statuses that keep the role: paying, trialing, or in Stripe's retry window. */
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

const CUSTOMER_RE = /^cus_[A-Za-z0-9]+$/;

export interface StripeEvent {
	id: string;
	type: string;
	data: { object: Record<string, unknown> };
}

/**
 * Checks the `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=…]`): an
 * HMAC-SHA256 of `<t>.<payload>` with the endpoint's signing secret, made
 * within the tolerance. Returns the parsed event, or null if it doesn't verify.
 */
export function verifyEvent(payload: string, header: string | null, secret: string, now = Date.now()): StripeEvent | null {
	if (!header) return null;
	const parts = header.split(',').map((p) => p.trim().split('='));
	const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
	if (!Number.isInteger(timestamp) || Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return null;
	const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest();
	const matches = parts
		.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/.test(v ?? ''))
		.some(([, v]) => timingSafeEqual(Buffer.from(v, 'hex'), expected));
	if (!matches) return null;
	try {
		const event = JSON.parse(payload);
		return typeof event?.type === 'string' && event.data?.object ? event : null;
	} catch {
		return null;
	}
}

/** The customer a `customer.subscription.*` event is about, or null for other events. */
export function subscriptionCustomer(event: StripeEvent): string | null {
	if (!event.type.startsWith('customer.subscription.')) return null;
	const customer = event.data.object.customer;
	return typeof customer === 'string' && CUSTOMER_RE.test(customer) ? customer : null;
}

export interface Subscriber {
	email: string | null;
	/**
	 * The current billing period of their entitled subscription (the one
	 * running longest when there are several), or null when they hold none.
	 */
	period: Validity | null;
}

interface StripeSubscription {
	status?: string;
	current_period_start?: number;
	current_period_end?: number;
	items?: { data?: { current_period_start?: number; current_period_end?: number }[] };
}

const fromUnix = (seconds: number | undefined) => (Number.isFinite(seconds) ? new Date(seconds! * 1000) : null);

/**
 * A subscription's current billing period. Stripe API versions before
 * 2025-03-31 put it on the subscription, later ones on each subscription
 * item; the period is then the span of its items' periods. A bound Stripe
 * doesn't give is open (null).
 */
export function subscriptionPeriod(s: StripeSubscription): Validity {
	const items = s.items?.data ?? [];
	const starts = items.map((i) => i.current_period_start).filter(Number.isFinite) as number[];
	const ends = items.map((i) => i.current_period_end).filter(Number.isFinite) as number[];
	return {
		startsAt: fromUnix(s.current_period_start ?? (starts.length ? Math.min(...starts) : undefined)),
		endsAt: fromUnix(s.current_period_end ?? (ends.length ? Math.max(...ends) : undefined))
	};
}

/** The period that lasts longest; an open end lasts forever. */
const longest = (periods: Validity[]): Validity | null =>
	periods.reduce<Validity | null>((best, p) => {
		if (!best) return p;
		const end = (v: Validity) => v.endsAt?.getTime() ?? Infinity;
		return end(p) > end(best) ? p : best;
	}, null);

/**
 * Reads a customer and their current subscriptions from Stripe. A deleted
 * customer is unsubscribed. Throws when Stripe can't answer, so the webhook
 * fails and Stripe retries it.
 */
export async function fetchSubscriber(apiKey: string, customerId: string, fetchFn: typeof fetch = fetch): Promise<Subscriber> {
	if (!CUSTOMER_RE.test(customerId)) throw new Error(`Invalid Stripe customer id ${customerId}`);
	const res = await fetchFn(`https://api.stripe.com/v1/customers/${customerId}?expand[]=subscriptions`, {
		headers: { authorization: `Bearer ${apiKey}` }
	});
	if (res.status === 404) return { email: null, period: null };
	if (!res.ok) throw new Error(`Stripe answered ${res.status} for customer ${customerId}`);
	const customer = await res.json();
	const email = typeof customer.email === 'string' ? customer.email : null;
	if (customer.deleted) return { email, period: null };
	const subscriptions: StripeSubscription[] = customer.subscriptions?.data ?? [];
	const entitled = subscriptions.filter((s) => ENTITLED_STATUSES.has(s.status ?? ''));
	return { email, period: longest(entitled.map(subscriptionPeriod)) };
}
