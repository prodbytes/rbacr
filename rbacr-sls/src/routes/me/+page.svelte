<script lang="ts">
	import { goto } from '$app/navigation';
	import { formValues, vpiFetch, VpiError, type Payment } from '#lib/vpi.js';
	import SystemCard from '#lib/SystemCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let systems = $derived(
		Object.entries(data.roles).map(([id, roles]) => ({
			card: data.systems[id] ?? { id, name: id, url: data.urls[id] ?? null, description: null, screenshotUrl: null, maintenance: false },
			roles
		}))
	);
	let redeem = $state<{ error?: string; payment?: Payment }>({});

	async function onRedeem(e: SubmitEvent) {
		const { code } = formValues(e);
		try {
			await vpiFetch(fetch, '/me/redeem', { method: 'POST', body: { code } });
			// On to what it granted (V8).
			await goto(`/redeemed/${encodeURIComponent(code.trim())}`);
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			redeem = { error: err.message, payment: err.payment };
		}
	}
</script>

<h1>My roles</h1>
{#if data.globalRoles.length}
	<p>
		Global roles:
		{#each data.globalRoles as role (role)}<span class="badge">{role}</span>{' '}{/each}
	</p>
{/if}
{#if data.root}
	<p class="muted">
		As <strong>root</strong> you hold every role in every system, and you can create systems and define their
		roles under <a href="/systems">Systems</a>.
	</p>
{/if}

{#if systems.length}
	<div class="cards">
		{#each systems as { card, roles } (card.id)}<SystemCard {card} {roles} />{/each}
	</div>
{:else}
	<p class="muted">You don't hold any roles yet. Redeem a voucher or ask an administrator.</p>
{/if}

<h2>Redeem a voucher</h2>
<form class="row" onsubmit={onRedeem}>
	<input name="code" placeholder="2026Q4-OTTER-FALCON-LEMUR" required autocomplete="off" />
	<button>Redeem</button>
</form>
{#if redeem.payment}
	<p class="error">
		This voucher gives {redeem.payment.discountPercent}% off the <strong>{redeem.payment.roles.join(', ')}</strong>
		role{redeem.payment.roles.length > 1 ? 's' : ''}
		{redeem.payment.systemId ? `in ${redeem.payment.systemId}` : 'in all systems'}, and needs payment, which is not
		available yet.
	</p>
{:else if redeem.error}<p class="error">{redeem.error}</p>{/if}

<style>
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 1rem;
	}
</style>
