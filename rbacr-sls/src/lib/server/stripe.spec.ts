import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fetchSubscriber, subscriptionCustomer, subscriptionPeriod, verifyEvent, type StripeEvent } from './stripe';

const SECRET = 'whsec_test';
const NOW = Date.parse('2026-10-08T12:00:00Z');
const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.created', data: { object: { customer: 'cus_A1' } } });

function sign(body: string, t = NOW / 1000, secret = SECRET) {
	return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

describe('verifyEvent (Q1)', () => {
	it('accepts a correctly signed, recent event', () => {
		expect(verifyEvent(payload, sign(payload), SECRET, NOW)?.id).toBe('evt_1');
		expect(verifyEvent(payload, `v1=${'0'.repeat(64)},${sign(payload)}`, SECRET, NOW)?.id).toBe('evt_1');
	});

	it('refuses a missing, wrong, tampered or stale signature', () => {
		expect(verifyEvent(payload, null, SECRET, NOW)).toBeNull();
		expect(verifyEvent(payload, sign(payload, NOW / 1000, 'whsec_other'), SECRET, NOW)).toBeNull();
		expect(verifyEvent(payload.replace('cus_A1', 'cus_B2'), sign(payload), SECRET, NOW)).toBeNull();
		expect(verifyEvent(payload, sign(payload, NOW / 1000 - 301), SECRET, NOW)).toBeNull();
		expect(verifyEvent(payload, 't=abc,v1=zz', SECRET, NOW)).toBeNull();
	});
});

describe('subscriptionCustomer', () => {
	const event = (type: string, customer: unknown) => ({ id: 'evt', type, data: { object: { customer } } }) as StripeEvent;

	it('takes the customer of subscription events only', () => {
		expect(subscriptionCustomer(event('customer.subscription.deleted', 'cus_A1'))).toBe('cus_A1');
		expect(subscriptionCustomer(event('invoice.paid', 'cus_A1'))).toBeNull();
		expect(subscriptionCustomer(event('customer.subscription.updated', '../v1/charges'))).toBeNull();
	});
});

describe('fetchSubscriber', () => {
	const stripe = (status: number, body: object) =>
		vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

	const JAN = Date.parse('2026-01-01T00:00:00Z') / 1000;
	const FEB = Date.parse('2026-02-01T00:00:00Z') / 1000;
	const MAR = Date.parse('2026-03-01T00:00:00Z') / 1000;
	const at = (seconds: number) => new Date(seconds * 1000);

	it('reads the customer with its subscriptions, using the API key', async () => {
		const fetchFn = stripe(200, {
			email: 'a@b.com',
			subscriptions: {
				data: [
					{ status: 'canceled', current_period_start: FEB, current_period_end: MAR },
					{ status: 'active', current_period_start: JAN, current_period_end: FEB }
				]
			}
		});
		expect(await fetchSubscriber('rk_test', 'cus_A1', fetchFn)).toEqual({
			email: 'a@b.com',
			period: { startsAt: at(JAN), endsAt: at(FEB) }
		});
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe('https://api.stripe.com/v1/customers/cus_A1?expand[]=subscriptions');
		expect(init.headers.authorization).toBe('Bearer rk_test');
	});

	it('takes the period of the subscription that runs longest (Q2a)', async () => {
		const body = {
			email: 'a@b.com',
			subscriptions: {
				data: [
					{ status: 'active', current_period_start: JAN, current_period_end: FEB },
					{ status: 'trialing', current_period_start: FEB, current_period_end: MAR }
				]
			}
		};
		expect((await fetchSubscriber('k', 'cus_A1', stripe(200, body))).period).toEqual({ startsAt: at(FEB), endsAt: at(MAR) });
	});

	it('reads the period from subscription items in newer Stripe API versions', () => {
		const items = { data: [{ current_period_start: FEB, current_period_end: MAR }, { current_period_start: JAN, current_period_end: FEB }] };
		expect(subscriptionPeriod({ status: 'active', items })).toEqual({ startsAt: at(JAN), endsAt: at(MAR) });
		expect(subscriptionPeriod({ status: 'active' })).toEqual({ startsAt: null, endsAt: null });
	});

	it('counts trialing and past_due, but not unpaid, canceled or deleted customers', async () => {
		const subscribed = async (body: object) => (await fetchSubscriber('k', 'cus_A1', stripe(200, body))).period !== null;
		expect(await subscribed({ email: 'a@b.com', subscriptions: { data: [{ status: 'trialing' }] } })).toBe(true);
		expect(await subscribed({ email: 'a@b.com', subscriptions: { data: [{ status: 'past_due' }] } })).toBe(true);
		expect(await subscribed({ email: 'a@b.com', subscriptions: { data: [{ status: 'unpaid' }] } })).toBe(false);
		expect(await subscribed({ email: 'a@b.com', subscriptions: { data: [] } })).toBe(false);
		expect(await subscribed({ id: 'cus_A1', deleted: true })).toBe(false);
		expect(await subscribed({})).toBe(false);
	});

	it('throws when Stripe fails, so the webhook is retried', async () => {
		await expect(fetchSubscriber('k', 'cus_A1', stripe(500, {}))).rejects.toThrow(/500/);
		await expect(fetchSubscriber('k', 'bad/id', stripe(200, {}))).rejects.toThrow(/Invalid/);
	});
});
