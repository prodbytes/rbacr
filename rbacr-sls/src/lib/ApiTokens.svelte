<!--
	A person's API tokens (SPEC T1-T5): create one (shown once), list them,
	revoke them. Anyone signed in manages their own.
-->
<script lang="ts" module>
	export interface Token {
		id: string;
		name: string;
		prefix: string;
		createdAt: string;
		expiresAt: string | null;
		lastUsedAt: string | null;
		revokedAt: string | null;
	}
</script>

<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatDate, formValues, vpiFetch, VpiError } from '#lib/vpi.js';

	let { tokens }: { tokens: Token[] } = $props();
	let tokenMsg = $state<{ created?: string; error?: string }>({});

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

	const tokenStatus = (t: Token) =>
		t.revokedAt ? 'revoked' : t.expiresAt && new Date(t.expiresAt) <= new Date() ? 'expired' : 'active';
</script>

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

{#if tokens.length}
	<table class="spaced">
		<thead><tr><th>Name</th><th>Token</th><th>Status</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead>
		<tbody>
			{#each tokens as t (t.id)}
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
