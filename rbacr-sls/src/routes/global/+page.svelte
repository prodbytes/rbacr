<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatDate, formValues, utcIso, vpiFetch, VpiError } from '#lib/vpi.js';
	import VoucherRedemptions from '#lib/VoucherRedemptions.svelte';
	import VoucherForm, { type VoucherBody } from '#lib/VoucherForm.svelte';
	import CopyRedeemLink from '#lib/CopyRedeemLink.svelte';
	import ApiTokens from '#lib/ApiTokens.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	// Roots only; null for anyone else, who sees just their tokens.
	let global = $derived(data.global);
	let error = $state('');

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
	const createVoucher = (body: VoucherBody) => call('/global/vouchers', 'POST', body) as Promise<{ code: string } | undefined>;
	const disable = (code: string) => call(`/vouchers/${encodeURIComponent(code)}`, 'DELETE');
</script>

<h1>Global</h1>

{#if global}
	<h2>Global grants</h2>
	<p class="muted">
		A global grant gives its role in <strong>every system</strong> whose catalog has a role of that name, including
		systems created later.
	</p>

	{#if error}<p class="error">{error}</p>{/if}

	<form class="row" onsubmit={grant}>
		<label>E-mail or domain <input name="grantee" placeholder="ana@example.com or example.com" required /></label>
		<label>
			Role
			<select name="role" required>
				{#each global.roleNames as role (role)}<option>{role}</option>{/each}
			</select>
		</label>
		<label>Valid from (UTC, optional) <input type="datetime-local" name="startsAt" /></label>
		<label>Valid until (UTC, optional) <input type="datetime-local" name="endsAt" /></label>
		<button disabled={!global.roleNames.length}>Grant</button>
	</form>

	{#if global.grants.length}
		<table class="spaced">
			<thead><tr><th>Grantee</th><th>Role</th><th>Status</th><th>From</th><th>Until</th><th>By</th><th>When</th><th></th></tr></thead>
			<tbody>
				{#each global.grants as g (g.role + g.grantee)}
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
	<VoucherForm systems={global.systems} rolesHint="Pick roles of any systems; each is granted in its own system." empty="No system has roles yet." create={createVoucher} />

	{#if global.vouchers.length}
		<table class="spaced">
			<thead><tr><th>Code</th><th>Roles</th><th>Discount</th><th>Status</th><th>Uses</th><th>From</th><th>Until</th><th>By</th><th></th></tr></thead>
			<tbody>
				{#each global.vouchers as v (v.code)}
					<tr>
						<td>
							<code>{v.code}</code>
							{#if v.status === 'active' || v.status === 'not-started'}<br /><CopyRedeemLink code={v.code} />{/if}
						</td>
						<td>
							{#if v.grants}
								{#each v.grants as g, i (`${g.systemId}#${g.role}`)}{i ? ', ' : ''}<span class="muted">{g.systemId} /</span> {g.role}{/each}
							{:else}
								{v.roles.join(', ')} <span class="muted">(in every system that has {v.roles.length > 1 ? 'them' : 'it'})</span>
							{/if}
						</td>
						<td>{v.discountPercent}%</td>
						<td><span class="badge">{v.status}</span></td>
						<td><VoucherRedemptions code={v.code} uses={v.uses} maxUses={v.maxUses} /></td>
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
{/if}

<ApiTokens tokens={data.tokens} />
