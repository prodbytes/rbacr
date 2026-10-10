<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { formatDate, formValues, utcIso, vpiFetch, VpiError } from '#lib/vpi.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let base = $derived(`/systems/${encodeURIComponent(data.system.id)}`);
	let error = $state('');
	let created = $state('');

	/** Calls /vpi, refreshes the page data, and shows any error. */
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

	async function addRole(e: SubmitEvent) {
		const form = e.currentTarget as HTMLFormElement;
		const { role } = formValues(e);
		await call(`${base}/roles`, 'POST', { role });
		if (!error) form.reset();
	}
	async function removeRole(e: SubmitEvent) {
		const { role } = formValues(e);
		if (confirm(`Remove ${role} and all its grants and vouchers?`)) {
			await call(`${base}/roles/${encodeURIComponent(role)}`, 'DELETE');
		}
	}
	let implRole = $state('');
	let implied = $state<string[]>([]);
	// Start from the selected role's current implications.
	$effect(() => {
		implied = [...(data.system.implies[implRole] ?? [])];
	});
	async function setImplications(e: SubmitEvent) {
		e.preventDefault();
		await call(`${base}/roles/${encodeURIComponent(implRole)}`, 'PUT', { implies: implied });
	}
	async function setSubscriberRole(e: SubmitEvent) {
		const { subscriberRole } = formValues(e);
		await call(base, 'PATCH', { subscriberRole: subscriberRole || null });
	}
	async function grant(e: SubmitEvent) {
		const form = e.currentTarget as HTMLFormElement;
		const { grantee, role, startsAt, endsAt } = formValues(e);
		await call(`${base}/grants`, 'POST', { grantee, role, startsAt: utcIso(startsAt), endsAt: utcIso(endsAt) });
		if (!error) form.reset();
	}
	const revoke = (role: string, grantee: string) => call(`${base}/grants`, 'DELETE', { role, grantee });
	async function createVoucher(e: SubmitEvent) {
		const v = formValues(e);
		const res = (await call(`${base}/vouchers`, 'POST', {
			role: v.role,
			discountPercent: v.discountPercent,
			startsAt: utcIso(v.startsAt),
			endsAt: utcIso(v.endsAt),
			maxUses: v.maxUses || null
		})) as { code: string } | undefined;
		if (res) created = res.code;
	}
	const disable = (code: string) => call(`/vouchers/${encodeURIComponent(code)}`, 'DELETE');
	async function deleteSystem() {
		if (!confirm(`Delete ${data.system.id} with all its roles, grants and vouchers?`)) return;
		try {
			// No invalidateAll() here: it would reload the deleted system.
			await vpiFetch(fetch, base, { method: 'DELETE' });
			await goto('/systems');
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			error = err.message;
		}
	}
</script>

<p><a href="/systems">← Systems</a></p>
<h1>{data.system.name} <code class="muted">{data.system.id}</code></h1>

{#if error}<p class="error">{error}</p>{/if}

<h2>Roles</h2>
<p>
	{#each data.system.roles as role (role)}
		<span class="badge">{role}</span>{' '}
	{/each}
</p>
{#each Object.entries(data.system.implies) as [role, implies] (role)}
	<p class="muted"><span class="badge">{role}</span> implies {implies.join(', ')}</p>
{/each}
{#if data.root}
	<div class="row">
		<form class="row" onsubmit={addRole}>
			<input name="role" placeholder="new role" required />
			<button>Add role</button>
		</form>
		<form class="row" onsubmit={removeRole}>
			<select name="role">
				{#each data.system.roles as role (role)}<option>{role}</option>{/each}
			</select>
			<button class="danger">Remove role</button>
		</form>
	</div>
	<form class="row" onsubmit={setImplications}>
		<label>
			Role
			<select bind:value={implRole} required>
				<option value="" disabled>choose…</option>
				{#each data.system.roles as role (role)}<option>{role}</option>{/each}
			</select>
		</label>
		{#if implRole}
			implies
			{#each data.system.roles.filter((r) => r !== implRole) as role (role)}
				<label><input type="checkbox" value={role} bind:group={implied} /> {role}</label>
			{/each}
		{/if}
		<button disabled={!implRole}>Set implied roles</button>
	</form>
{/if}

<h2>Substack subscribers</h2>
<p class="muted">
	Paying subscribers of the newsletter hold this role here for their current billing period.
	{#if data.system.subscriberRole}Now: <span class="badge">{data.system.subscriberRole}</span>{:else}Now: none.{/if}
</p>
{#if data.root}
	<form class="row" onsubmit={setSubscriberRole}>
		<label>
			Role for subscribers
			<select name="subscriberRole" value={data.system.subscriberRole ?? ''}>
				<option value="">none</option>
				{#each data.system.roles as role (role)}<option>{role}</option>{/each}
			</select>
		</label>
		<button>Save</button>
	</form>
{/if}

<h2>Grants</h2>
<form class="row" onsubmit={grant}>
	<label>
		E-mail or domain
		<input name="grantee" placeholder="ana@example.com or example.com" required />
	</label>
	<label>
		Role
		<select name="role">
			{#each data.system.roles as role (role)}<option>{role}</option>{/each}
		</select>
	</label>
	<label>Valid from (UTC, optional) <input type="datetime-local" name="startsAt" /></label>
	<label>Valid until (UTC, optional) <input type="datetime-local" name="endsAt" /></label>
	<button>Grant</button>
</form>

{#if data.grants.length}
	<table class="spaced">
		<thead><tr><th>Grantee</th><th>Role</th><th>Also gives</th><th>Status</th><th>From</th><th>Until</th><th>By</th><th>When</th><th></th></tr></thead>
		<tbody>
			{#each data.grants as g (g.role + g.grantee)}
				<tr>
					<td>{g.grantee}</td>
					<td>{g.role}</td>
					<td class="muted">{g.impliedRoles.join(', ') || '—'}</td>
					<td><span class="badge">{g.status}</span></td>
					<td class="muted">{formatDate(g.startsAt)}</td>
					<td class="muted">{formatDate(g.endsAt)}</td>
					<td class="muted">{g.grantedBy}{g.voucherCode ? ' (voucher)' : ''}</td>
					<td class="muted">{formatDate(g.grantedAt)}</td>
					<td>
						{#if data.root}
							<button class="danger" onclick={() => revoke(g.role, g.grantee)}>Revoke</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{:else}
	<p class="muted">No grants yet.</p>
{/if}

<h2>Vouchers</h2>
<form class="row" onsubmit={createVoucher}>
	<label>
		Role
		<select name="role">
			{#each data.system.roles as role (role)}<option>{role}</option>{/each}
		</select>
	</label>
	<label>Discount % <input type="number" name="discountPercent" min="0" max="100" step="1" value="100" class="narrow" /></label>
	<label>Valid from (UTC, optional) <input type="datetime-local" name="startsAt" /></label>
	<label>Valid until (UTC, optional) <input type="datetime-local" name="endsAt" /></label>
	<label>Max uses (optional) <input type="number" name="maxUses" min="1" step="1" class="narrow" /></label>
	<button>Create voucher</button>
</form>
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
	<p class="muted">No vouchers yet.</p>
{/if}

{#if data.root}
	<h2>Danger zone</h2>
	<button class="danger" onclick={deleteSystem}>Delete system</button>
{/if}
