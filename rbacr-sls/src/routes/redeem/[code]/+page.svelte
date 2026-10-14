<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { vpiFetch, VpiError, type Payment } from '#lib/vpi.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let failure = $state<{ status: number; message: string; payment?: Payment } | null>(null);
	let redeeming = $state(false);

	// Redeemed only when the person clicks (V8): opening the link, from any
	// site, a prefetch or a server render never redeems. Then on to what it granted.
	async function redeem() {
		redeeming = true;
		failure = null;
		try {
			await vpiFetch(fetch, '/me/redeem', { method: 'POST', body: { code: data.code } });
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			// Redeemed before (V5): show what it gave.
			if (err.status !== 409 || !/already redeemed/.test(err.message)) {
				failure = { status: err.status, message: err.message, payment: err.payment };
				redeeming = false;
				return;
			}
		}
		await goto(`/redeemed/${encodeURIComponent(data.code)}`, { replaceState: true });
	}
</script>

<svelte:head><title>Redeem {data.code} · rbacr</title></svelte:head>

<h1>Redeem a voucher</h1>
<p><code>{data.code}</code></p>
{#if !failure}
	<p>Redeeming it gives its roles to <strong>{page.data.user?.email}</strong>.</p>
	<p><button onclick={redeem} disabled={redeeming}>{redeeming ? 'Redeeming…' : 'Redeem'}</button></p>
{:else if failure.payment}
	<p class="error">
		This voucher gives {failure.payment.discountPercent}% off
		{#if failure.payment.grants}
			<strong>{failure.payment.grants.map((g) => `${g.role} in ${g.systemId}`).join(', ')}</strong>,
		{:else}
			the <strong>{failure.payment.roles.join(', ')}</strong>
			role{failure.payment.roles.length > 1 ? 's' : ''}
			{failure.payment.systemId ? `in ${failure.payment.systemId}` : 'in all systems'},
		{/if}
		and needs payment, which is not
		available yet.
	</p>
{:else}
	<p class="error">{failure.status === 404 ? 'There is no voucher with this code.' : failure.message}</p>
	<p><a href="/me">Go to my roles</a>, where you can also type a code.</p>
{/if}
