<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { vpiFetch, VpiError, type Payment } from '#lib/vpi.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let failure = $state<{ status: number; message: string; payment?: Payment } | null>(null);

	// Redeemed from the browser, once the page is up, so a prefetch or server
	// render never redeems; then on to what it granted.
	onMount(async () => {
		try {
			await vpiFetch(fetch, '/me/redeem', { method: 'POST', body: { code: data.code } });
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			// Redeemed before (V5): show what it gave.
			if (err.status !== 409 || !/already redeemed/.test(err.message)) {
				failure = { status: err.status, message: err.message, payment: err.payment };
				return;
			}
		}
		await goto(`/redeemed/${encodeURIComponent(data.code)}`, { replaceState: true });
	});
</script>

<svelte:head><title>Redeem {data.code} · rbacr</title></svelte:head>

<h1>Redeem a voucher</h1>
<p><code>{data.code}</code></p>
{#if !failure}
	<p class="muted" aria-live="polite">Redeeming…</p>
{:else if failure.payment}
	<p class="error">
		This voucher gives {failure.payment.discountPercent}% off the <strong>{failure.payment.roles.join(', ')}</strong>
		role{failure.payment.roles.length > 1 ? 's' : ''}
		{failure.payment.systemId ? `in ${failure.payment.systemId}` : 'in all systems'}, and needs payment, which is not
		available yet.
	</p>
{:else}
	<p class="error">{failure.status === 404 ? 'There is no voucher with this code.' : failure.message}</p>
	<p><a href="/me">Go to my roles</a>, where you can also type a code.</p>
{/if}
