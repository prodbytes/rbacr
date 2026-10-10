<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatDate, vpiFetch, VpiError } from '#lib/vpi.js';
	import type { Notification } from './+page.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let error = $state('');

	const open = $derived(data.notifications.filter((n) => n.status === 'open'));
	const earlier = $derived(data.notifications.filter((n) => n.status !== 'open'));

	async function call(path: string, method: string): Promise<void> {
		error = '';
		try {
			await vpiFetch(fetch, path, { method });
			await invalidateAll();
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			error = err.message;
		}
	}
	const check = () => call('/notifications/check', 'POST');
	const dismiss = (id: string) => call(`/notifications/${encodeURIComponent(id)}`, 'DELETE');
	const where = (n: Notification) => (n.systemId === null ? '/global' : `/systems/${encodeURIComponent(n.systemId)}`);
</script>

<h1>Notifications</h1>
<p class="muted">
	Warnings for roots, raised by rbacr's checks each time a root signs in: for now, vouchers ending within a week
	that no other voucher of the same system (or global) replaces for their roles. A warning clears itself once
	its cause is gone.
</p>

{#if error}<p class="error">{error}</p>{/if}

<div class="row"><button onclick={check}>Check now</button></div>

<table class="spaced">
	<thead><tr><th>Warning</th><th>Raised</th><th></th></tr></thead>
	<tbody>
		{#each open as n (n.id)}
			<tr>
				<td>
					<span class="badge warning">{n.severity}</span>
					{n.message}
					<a href={where(n)}>{n.systemId ?? 'Global vouchers'}</a>
				</td>
				<td>{formatDate(n.raisedAt)}</td>
				<td><button class="danger" onclick={() => dismiss(n.id)}>Dismiss</button></td>
			</tr>
		{:else}
			<tr><td colspan="3" class="muted">Nothing needs attention.</td></tr>
		{/each}
	</tbody>
</table>

{#if earlier.length}
	<h2>Earlier</h2>
	<table>
		<thead><tr><th>Warning</th><th>Raised</th><th>Closed</th></tr></thead>
		<tbody>
			{#each earlier as n (n.id)}
				<tr class="muted">
					<td>{n.message}</td>
					<td>{formatDate(n.raisedAt)}</td>
					<td>
						{#if n.status === 'dismissed'}
							Dismissed by {n.dismissedBy}, {formatDate(n.dismissedAt)}
						{:else}
							Resolved {formatDate(n.resolvedAt)}
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	.badge.warning {
		border-color: var(--warn);
		color: var(--warn);
	}
</style>
