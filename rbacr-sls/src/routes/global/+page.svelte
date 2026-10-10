<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatDate, formValues, utcIso, vpiFetch, VpiError } from '#lib/vpi.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let error = $state('');
	let created = $state('');

	async function call(path: string, method: string, body?: unknown): Promise<unknown> {
		error = '';
		try {
			const result = await vpiFetch(fetch, path, { method, body });
			await invalidateAll();
			return result;
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			error = err.message;
			return undefined;
		}
	}

	async function grant(e: SubmitEvent) {
		const form = e.currentTarget as HTMLFormElement;
		const { grantee, role, startsAt, endsAt } = formValues(e);
		await call('/global/grants', 'POST', { grantee, role, startsAt: utcIso(startsAt), endsAt: utcIso(endsAt) });
		if (!error) form.reset();
	}
	const revoke = (role: string, grantee: string) => call('/global/grants', 'DELETE', { role, grantee });
	async function createVoucher(e: SubmitEvent) {
		const v = formValues(e);
		const res = (await call('/global/vouchers', 'POST', {
			role: v.role,
			discountPercent: v.discountPercent,
			startsAt: utcIso(v.startsAt),
			endsAt: utcIso(v.endsAt),
			maxUses: v.maxUses || null
		})) as { code: string } | undefined;
		if (res) created = res.code;
	}
	const disable = (code: string) => call(`/vouchers/${encodeURIComponent(code)}`, 'DELETE');
</script>

<h1>Global roles</h1>
<p class="muted">
	A global grant gives its role in <strong>every system</strong> whose catalog has a role of that name, including
	systems created later.
</p>

{#if error}<p class="error">{error}</p>{/if}

<h2>Global grants</h2>
<form class="row" onsubmit={grant}>
	<label>E-mail or domain <input name="grantee" placeholder="ana@example.com or example.com" required /></label>
	<label>Role <input name="role" placeholder="pro" required /></label>
	<label>Valid from (UTC, optional) <input type="datetime-local" name="startsAt" /></label>
	<label>Valid until (UTC, optional) <input type="datetime-local" name="endsAt" /></label>
	<button>Grant</button>
</form>

{#if data.grants.length}
	<table class="spaced">
		<thead><tr><th>Grantee</th><th>Role</th><th>Status</th><th>From</th><th>Until</th><th>By</th><th>When</th><th></th></tr></thead>
		<tbody>
			{#each data.grants as g (g.role + g.grantee)}
				<tr>
					<td>{g.grantee}</td>
					<td>{g.role}</td>
					<td><span class="badge">{g.status}</span></td>
					<td class="muted">{formatDate(g.startsAt)}</td>
					<td class="muted">{formatDate(g.endsAt)}</td>
					<td class="muted">{g.grantedBy}{g.voucherCode ? ' (voucher)' : ''}</td>
					<td class="muted">{formatDate(g.grantedAt)}</td>
					<td><button class="danger" onclick={() => revoke(g.role, g.grantee)}>Revoke</button></td>
				</tr>
			{/each}
		</tbody>
	</table>
{:else}
	<p class="muted">No global grants yet.</p>
{/if}

<h2>Global vouchers</h2>
<form class="row" onsubmit={createVoucher}>
	<label>Role <input name="role" placeholder="pro" required /></label>
	<label>Discount % <input type="number" name="discountPercent" min="0" max="100" step="1" value="100" class="narrow" /></label>
	<label>Valid from (UTC, optional) <input type="datetime-local" name="startsAt" /></label>
	<label>Valid until (UTC, optional) <input type="datetime-local" name="endsAt" /></label>
	<label>Max uses (optional) <input type="number" name="maxUses" min="1" step="1" class="narrow" /></label>
	<button>Create voucher</button>
</form>
<p class="muted">100% vouchers grant the role on redemption. Lower discounts will require payment (not available yet).</p>
{#if created}<p class="ok">Voucher created: <code>{created}</code></p>{/if}

{#if data.vouchers.length}
	<table class="spaced">
		<thead><tr><th>Code</th><th>Role</th><th>Discount</th><th>Status</th><th>Uses</th><th>From</th><th>Until</th><th>By</th><th></th></tr></thead>
		<tbody>
			{#each data.vouchers as v (v.code)}
				<tr>
					<td><code>{v.code}</code></td>
					<td>{v.role}</td>
					<td>{v.discountPercent}%</td>
					<td><span class="badge">{v.status}</span></td>
					<td>{v.uses}{v.maxUses !== null ? ` / ${v.maxUses}` : ''}</td>
					<td class="muted">{formatDate(v.startsAt)}</td>
					<td class="muted">{formatDate(v.endsAt)}</td>
					<td class="muted">{v.createdBy}</td>
					<td>
						{#if v.disabledAt}
							<span class="muted">Disabled by {v.disabledBy ?? '—'}, {formatDate(v.disabledAt)}</span>
						{:else}
							<button class="danger" onclick={() => disable(v.code)}>Disable</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{:else}
	<p class="muted">No global vouchers yet.</p>
{/if}
