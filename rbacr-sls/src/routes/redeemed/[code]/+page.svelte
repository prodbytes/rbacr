<script lang="ts">
	import { formatDate } from '#lib/vpi.js';
	import SystemCard from '#lib/SystemCard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let r = $derived(data.redemption);
	let roles = $derived(r.roles.length ? r.roles : [...new Set(data.systems.flatMap((s) => s.roles))]);
</script>

<svelte:head><title>Voucher redeemed · rbacr</title></svelte:head>

<div class="done">
	<h1><span class="ok" aria-hidden="true">✓</span> Roles granted</h1>
	<p>
		Voucher <code>{r.code}</code> gave you
		{#each roles as role, i (role)}{i ? (i === roles.length - 1 ? ' and ' : ', ') : ''}<strong>{role}</strong>{/each}{r.systemId
			? ''
			: ` in every system that has ${roles.length > 1 ? 'them' : 'it'}`}.
		<span class="muted">Redeemed {formatDate(r.redeemedAt)}.</span>
	</p>
</div>

{#if data.systems.length}
	<h2>Where you can use {roles.length > 1 ? 'them' : 'it'}</h2>
	<div class="cards">
		{#each data.systems as system (system.id)}<SystemCard card={system} roles={system.roles} />{/each}
	</div>
{:else}
	<p class="muted">No system offers {roles.length > 1 ? 'these roles' : 'this role'} yet.</p>
{/if}

<p class="more"><a href="/me">See all my roles →</a></p>

<style>
	.done {
		padding: 1.25rem 1.25rem 0.5rem;
		background: var(--card);
		border: 1px solid var(--line);
		border-left: 4px solid var(--ok);
		border-radius: 8px;
	}
	.done h1 {
		margin-bottom: 0.5rem;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 1rem;
	}
	.more {
		margin-top: 2rem;
	}
</style>
