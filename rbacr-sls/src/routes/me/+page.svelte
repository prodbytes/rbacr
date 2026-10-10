<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { formatDate, formValues, vpiFetch, VpiError, type Payment } from '#lib/vpi.js';
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
	let tokenMsg = $state<{ created?: string; error?: string }>({});

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

	async function onCreateToken(e: SubmitEvent) {
		const form = e.currentTarget as HTMLFormElement;
		const { name, expiresInDays } = formValues(e);
		try {
			const res = await vpiFetch<{ token: string }>(fetch, '/tokens', {
				method: 'POST',
				body: { name, expiresInDays: expiresInDays || null }
			});
			tokenMsg = { created: res.token };
			form.reset();
			await invalidateAll();
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			tokenMsg = { error: err.message };
		}
	}

	async function revoke(id: string) {
		await vpiFetch(fetch, `/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
		await invalidateAll();
	}

	const tokenStatus = (t: PageProps['data']['tokens'][number]) =>
		t.revokedAt ? 'revoked' : t.expiresAt && new Date(t.expiresAt) <= new Date() ? 'expired' : 'active';
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

<h2 id="tokens">API tokens</h2>
<p class="muted">
	For scripts and other applications calling <code>/api</code> as you:
	<code>Authorization: Bearer rbacr_…</code>. A token can do what you can do, now and as your roles change.
</p>
<form class="row" onsubmit={onCreateToken}>
	<label>Name <input name="name" placeholder="billing sync" required maxlength="100" /></label>
	<label>Expires in days (empty: never) <input type="number" name="expiresInDays" min="1" max="3650" value="90" class="narrow" /></label>
	<button>Create token</button>
</form>
{#if tokenMsg.error}<p class="error">{tokenMsg.error}</p>{/if}
{#if tokenMsg.created}
	<p class="ok">Copy your new token now; it won't be shown again:</p>
	<p><code class="secret">{tokenMsg.created}</code></p>
{/if}

{#if data.tokens.length}
	<table class="spaced">
		<thead><tr><th>Name</th><th>Token</th><th>Status</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
		<tbody>
			{#each data.tokens as t (t.id)}
				<tr>
					<td>{t.name}</td>
					<td><code>{t.prefix}…</code></td>
					<td><span class="badge">{tokenStatus(t)}</span></td>
					<td class="muted">{formatDate(t.createdAt)}</td>
					<td class="muted">{t.expiresAt ? formatDate(t.expiresAt) : 'never'}</td>
					<td class="muted">{formatDate(t.lastUsedAt)}</td>
					<td>{#if tokenStatus(t) === 'active'}<button class="danger" onclick={() => revoke(t.id)}>Revoke</button>{/if}</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 1rem;
	}
</style>
