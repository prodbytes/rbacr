<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { formatDate, formValues, utcIso, vpiFetch, VpiError } from '#lib/vpi.js';
	import VoucherRedemptions from '#lib/VoucherRedemptions.svelte';
	import VoucherForm, { type VoucherBody } from '#lib/VoucherForm.svelte';
	import CopyRedeemLink from '#lib/CopyRedeemLink.svelte';
	import SystemCard from '#lib/SystemCard.svelte';
	import RoleName from '#lib/RoleName.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let base = $derived(`/systems/${encodeURIComponent(data.system.id)}`);
	let error = $state('');

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
	async function removeRole(role: string) {
		if (confirm(`Remove ${role} and all its grants and vouchers?`)) {
			await call(`${base}/roles/${encodeURIComponent(role)}`, 'DELETE');
		}
	}
	/** Replaces the roles `role` implies (R7). */
	const setImplied = (role: string, implies: string[]) =>
		call(`${base}/roles/${encodeURIComponent(role)}`, 'PUT', { implies });
	async function addImplied(e: SubmitEvent, role: string, implies: string[]) {
		const { implied } = formValues(e);
		await setImplied(role, [...implies, implied]);
	}
	/** Every identity holds `role` here, or stops holding it through this (R9). */
	const setEveryone = (role: string, everyone: boolean) =>
		call(`${base}/roles/${encodeURIComponent(role)}`, 'PUT', { everyone });
	/** In maintenance, role queries give nobody any role in this system (R11). */
	async function setMaintenance(on: boolean) {
		const what = on
			? `Put ${data.system.id} in maintenance? Its application will see no roles for anyone, roots included, until you turn it off.`
			: `Take ${data.system.id} out of maintenance? Its roles will be given again.`;
		if (confirm(what)) await call(base, 'PATCH', { maintenance: on });
	}
	async function setUrl(e: SubmitEvent) {
		const { url } = formValues(e);
		await call(base, 'PATCH', { url: url.trim() || null });
	}
	// The card's fields, previewed as they're typed (R13).
	let description = $state('');
	let screenshotUrl = $state('');
	$effect.pre(() => {
		description = data.system.description ?? '';
		screenshotUrl = data.system.screenshotUrl ?? '';
	});
	async function setCard(e: SubmitEvent) {
		e.preventDefault();
		await call(base, 'PATCH', { description: description.trim() || null, screenshotUrl: screenshotUrl.trim() || null });
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
	const createVoucher = (body: VoucherBody) => call(`${base}/vouchers`, 'POST', body) as Promise<{ code: string } | undefined>;
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
<p class="muted">
	{#if data.system.url}
		Role names link to <a href={data.system.url} target="_blank" rel="noopener noreferrer">{data.system.url}</a>.
	{:else}
		No URL: role names aren't linked to the system.
	{/if}
</p>
{#if data.system.maintenance}
	<p class="error">
		<strong>Maintenance mode is on:</strong> the API gives nobody any role in this system (empty lists, every check
		denied), roots included. Grants are kept and count again when it's turned off.
	</p>
{/if}
{#if data.root}
	<label class="row">
		<input
			type="checkbox"
			checked={data.system.maintenance}
			onchange={(e) => {
				const on = e.currentTarget.checked;
				// The page redraws from the server's answer; a cancelled confirm reverts the box.
				e.currentTarget.checked = data.system.maintenance;
				setMaintenance(on);
			}}
		/>
		Maintenance mode (no roles are given while it's on)
	</label>
	<form class="row" onsubmit={setUrl}>
		<label>
			System URL (opens in a new tab)
			<input type="url" name="url" value={data.system.url ?? ''} placeholder="https://presence.example.com" />
		</label>
		<button>Save URL</button>
	</form>
{/if}

{#if error}<p class="error">{error}</p>{/if}

<h2>Card</h2>
<p class="muted">What people see of this system on their roles page and after redeeming a voucher for it.</p>
<div class="card-editor">
	{#if data.root}
		<form onsubmit={setCard}>
			<label>
				Description (plain text)
				<textarea bind:value={description} rows="5" maxlength="1000" placeholder="What the system is for, in a sentence or two"
				></textarea>
			</label>
			<label>
				Screenshot URL (an image)
				<input type="url" bind:value={screenshotUrl} placeholder="https://presence.example.com/screenshot.png" />
			</label>
			<button>Save card</button>
		</form>
	{/if}
	<div class="preview">
		<SystemCard
			card={{ ...data.system, description: description.trim() || null, screenshotUrl: screenshotUrl.trim() || null }}
			roles={data.system.roles.slice(0, 3)}
		/>
	</div>
</div>

<h2>Roles</h2>
{#if data.system.roles.length}
	<table class="spaced">
		<thead><tr><th>Role</th><th>Everyone</th><th>Implies</th>{#if data.root}<th></th>{/if}</tr></thead>
		<tbody>
			{#each data.system.roles as role (role)}
				{@const implies = data.system.implies[role] ?? []}
				{@const addable = data.system.roles.filter((r) => r !== role && !implies.includes(r))}
				<tr>
					<td><span class="badge"><RoleName {role} url={data.system.url} /></span></td>
					<td>
						<label title="Every signed-in identity holds this role">
							<input
								type="checkbox"
								checked={data.system.everyone.includes(role)}
								disabled={!data.root}
								onchange={(e) => setEveryone(role, e.currentTarget.checked)}
							/>
							all users
						</label>
					</td>
					<td>
						<div class="row">
							{#each implies as implied (implied)}
								<span class="badge"
									><RoleName role={implied} url={data.system.url} />{#if data.root}
										<button
											class="link"
											title="Stop {role} implying {implied}"
											onclick={() => setImplied(role, implies.filter((r) => r !== implied))}>×</button
										>{/if}</span
								>
							{:else}
								<span class="muted">—</span>
							{/each}
							{#if data.root && addable.length}
								<form class="row" onsubmit={(e) => addImplied(e, role, implies)}>
									<select name="implied" aria-label="Role {role} also gives">
										{#each addable as r (r)}<option>{r}</option>{/each}
									</select>
									<button>Add implied role</button>
								</form>
							{/if}
						</div>
					</td>
					{#if data.root}
						<td><button class="danger" onclick={() => removeRole(role)}>Remove</button></td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
{:else}
	<p class="muted">No roles yet.</p>
{/if}
{#if data.root}
	<form class="row" onsubmit={addRole}>
		<input name="role" placeholder="role name" aria-label="New role name" required />
		<button>Add role</button>
	</form>
{/if}

<h2>Substack subscribers</h2>
<p class="muted">
	Paying subscribers of the newsletter hold this role here for their current billing period.
	{#if data.system.subscriberRole}Now: <span class="badge"><RoleName role={data.system.subscriberRole} url={data.system.url} /></span
		>{:else}Now: none.{/if}
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
					<td><RoleName role={g.role} url={data.system.url} /></td>
					<td class="muted">
						{#each g.impliedRoles as role, i (role)}{i ? ', ' : ''}<RoleName {role} url={data.system.url} />{:else}—{/each}
					</td>
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
<VoucherForm roles={data.system.roles} empty="Add roles to this system first." create={createVoucher} />

{#if data.vouchers.length}
	<table class="spaced">
		<thead><tr><th>Code</th><th>Roles</th><th>Discount</th><th>Status</th><th>Uses</th><th>From</th><th>Until</th><th>By</th><th></th></tr></thead>
		<tbody>
			{#each data.vouchers as v (v.code)}
				<tr>
					<td>
						<code>{v.code}</code>
						{#if v.status === 'active' || v.status === 'not-started'}<br /><CopyRedeemLink code={v.code} />{/if}
					</td>
					<td>
						{#each v.roles as role, i (role)}{i ? ', ' : ''}<RoleName {role} url={data.system.url} />{/each}
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
	<p class="muted">No vouchers yet.</p>
{/if}

{#if data.root}
	<h2>Danger zone</h2>
	<button class="danger" onclick={deleteSystem}>Delete system</button>
{/if}

<style>
	.card-editor {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
		gap: 1.25rem;
		align-items: start;
	}
	.card-editor form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.card-editor label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.card-editor button {
		align-self: start;
	}
	textarea {
		font: inherit;
		color: var(--fg);
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 5px;
		padding: 0.4rem 0.6rem;
		resize: vertical;
	}
	@media (max-width: 640px) {
		.card-editor {
			grid-template-columns: 1fr;
		}
	}
</style>
