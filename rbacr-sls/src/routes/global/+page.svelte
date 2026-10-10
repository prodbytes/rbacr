<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { formatDate, formValues, utcInputValue, utcIso, vpiFetch, VpiError } from '#lib/vpi.js';
	import { quarterOf, suggestVoucherCode } from '#lib/vouchers.js';
	import VoucherRedemptions from '#lib/VoucherRedemptions.svelte';
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
	// A new voucher defaults to this quarter: its code and its validity (V2).
	const quarter = quarterOf(new Date());
	let voucherRoles = $state<string[]>([]);
	let voucherCode = $state('');
	// Made up in the browser, so server rendering doesn't pick a different one.
	onMount(() => (voucherCode = suggestVoucherCode()));
	async function createVoucher(e: SubmitEvent) {
		const v = formValues(e);
		const res = (await call('/global/vouchers', 'POST', {
			roles: voucherRoles,
			code: voucherCode,
			discountPercent: v.discountPercent,
			startsAt: utcIso(v.startsAt),
			endsAt: utcIso(v.endsAt),
			maxUses: v.maxUses || null
		})) as { code: string } | undefined;
		if (res) {
			created = res.code;
			voucherCode = suggestVoucherCode();
		}
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
	<label>
		Role
		<select name="role" required>
			{#each data.roleNames as role (role)}<option>{role}</option>{/each}
		</select>
	</label>
	<label>Valid from (UTC, optional) <input type="datetime-local" name="startsAt" /></label>
	<label>Valid until (UTC, optional) <input type="datetime-local" name="endsAt" /></label>
	<button disabled={!data.roleNames.length}>Grant</button>
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
	<fieldset class="row">
		<legend>Roles it grants (in every system that has them)</legend>
		{#each data.roleNames as role (role)}
			<label><input type="checkbox" value={role} bind:group={voucherRoles} /> {role}</label>
		{:else}
			<span class="muted">No system has roles yet.</span>
		{/each}
	</fieldset>
	<label>
		Code
		<span class="row">
			<input name="code" bind:value={voucherCode} required />
			<button type="button" class="link" onclick={() => (voucherCode = suggestVoucherCode())}>new code</button>
		</span>
	</label>
	<label>Discount % <input type="number" name="discountPercent" min="0" max="100" step="1" value="100" class="narrow" /></label>
	<label>Valid from (UTC) <input type="datetime-local" name="startsAt" value={utcInputValue(quarter.start)} /></label>
	<label>Valid until (UTC) <input type="datetime-local" name="endsAt" value={utcInputValue(quarter.end)} /></label>
	<label>Max uses (optional) <input type="number" name="maxUses" min="1" step="1" class="narrow" /></label>
	<button disabled={!voucherRoles.length}>Create voucher</button>
</form>
<p class="muted">100% vouchers grant their roles on redemption. Lower discounts will require payment (not available yet).</p>
{#if created}<p class="ok">Voucher created: <code>{created}</code></p>{/if}

{#if data.vouchers.length}
	<table class="spaced">
		<thead><tr><th>Code</th><th>Roles</th><th>Discount</th><th>Status</th><th>Uses</th><th>From</th><th>Until</th><th>By</th><th></th></tr></thead>
		<tbody>
			{#each data.vouchers as v (v.code)}
				<tr>
					<td><code>{v.code}</code></td>
					<td>{v.roles.join(', ')}</td>
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
