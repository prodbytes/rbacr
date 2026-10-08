import { json } from '@sveltejs/kit';
import { getServices, stripeSync } from '#lib/server/services.js';
import { fetchSubscriber, subscriptionCustomer, verifyEvent } from '#lib/server/stripe.js';
import type { RequestHandler } from './$types';

/**
 * Stripe webhook for the paid-subscription sync (SPEC Q1-Q4). Authenticated
 * by Stripe's signature, not by a token or session. Every
 * `customer.subscription.*` event re-reads the customer from Stripe and
 * grants or revokes the configured role; other events are acknowledged and
 * ignored. A failure answers 500, so Stripe retries.
 */
export const POST: RequestHandler = async ({ request }) => {
	const config = stripeSync();
	if (!config) return json({ error: 'The subscription sync is not configured' }, { status: 503 });
	const event = verifyEvent(await request.text(), request.headers.get('stripe-signature'), config.webhookSecret);
	if (!event) return json({ error: 'Invalid signature' }, { status: 400 });
	const customer = subscriptionCustomer(event);
	if (!customer) return json({ received: true, ignored: event.type });
	const subscriber = await fetchSubscriber(config.apiKey, customer);
	if (!subscriber.email) return json({ received: true, ignored: 'no e-mail' });
	const { rbac } = await getServices();
	const outcome = await rbac.syncSubscriber(config.systemId, config.role, subscriber.email, subscriber.subscribed);
	// Addresses are people's: logged by Stripe customer id only.
	console.log(`stripe ${event.id} ${event.type} ${customer}: ${outcome}`);
	return json({ received: true, outcome });
};
