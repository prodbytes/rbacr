<!--
	A voucher's uses, expandable into its RedeemEvents (SPEC V7): who redeemed
	it, when, from where, and what it did to each role. Loaded on first open.
-->
<script lang="ts">
	import { formatDate, vpiFetch, VpiError } from '#lib/vpi.js';

	interface RedeemEvent {
		id: string | null;
		email: string;
		redeemedAt: string;
		via: 'api' | 'page' | null;
		grants: {
			role: string;
			outcome: 'granted' | 'kept' | 'replaced';
			replaced: { grantedBy: string; endsAt: string | null } | null;
		}[];
	}

	let { code, uses, maxUses }: { code: string; uses: number; maxUses: number | null } = $props();
	let events = $state<RedeemEvent[] | null>(null);
	let error = $state('');

	async function load(e: Event) {
		if (!(e.currentTarget as HTMLDetailsElement).open || events) return;
		try {
			events = (await vpiFetch<{ redemptions: RedeemEvent[] }>(fetch, `/vouchers/${encodeURIComponent(code)}/redemptions`))
				.redemptions;
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			error = err.message;
		}
	}

	const outcome = (g: RedeemEvent['grants'][number]) =>
		g.outcome === 'replaced' && g.replaced
			? `${g.role} (replaced ${g.replaced.grantedBy}'s grant${g.replaced.endsAt ? ` ending ${formatDate(g.replaced.endsAt)}` : ''})`
			: g.outcome === 'kept'
				? `${g.role} (already held)`
				: g.role;
</script>

{#if uses}
	<details ontoggle={load}>
		<summary>{uses}{maxUses !== null ? ` / ${maxUses}` : ''}</summary>
		{#if error}
			<p class="error">{error}</p>
		{:else if !events}
			<p class="muted">Loading…</p>
		{:else}
			<ul class="redemptions">
				{#each events as e (e.id ?? e.email)}
					<li>
						<strong>{e.email}</strong>
						<span class="muted">{formatDate(e.redeemedAt)}{e.via ? `, via ${e.via === 'page' ? 'the page' : 'the API'}` : ''}</span>
						{#if e.grants.length}<br /><span class="muted">{e.grants.map(outcome).join('; ')}</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</details>
{:else}
	0{maxUses !== null ? ` / ${maxUses}` : ''}
{/if}

<style>
	.redemptions {
		margin: 4px 0 0;
		padding-left: 18px;
		font-size: 0.85rem;
	}
</style>
