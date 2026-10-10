<script lang="ts">
	import { goto } from '$app/navigation';
	import { formValues, vpiFetch, VpiError } from '#lib/vpi.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let error = $state('');

	async function onCreate(e: SubmitEvent) {
		const { id, name, roles } = formValues(e);
		try {
			const system = await vpiFetch<{ id: string }>(fetch, '/systems', { method: 'POST', body: { id, name, roles } });
			await goto(`/systems/${system.id}`);
		} catch (err) {
			if (!(err instanceof VpiError)) throw err;
			error = err.message;
		}
	}
</script>

<h1>Systems</h1>

{#if data.systems.length}
	<table>
		<thead><tr><th>Id</th><th>Name</th><th>Roles</th></tr></thead>
		<tbody>
			{#each data.systems as system (system.id)}
				<tr>
					<td><a href="/systems/{system.id}"><code>{system.id}</code></a></td>
					<td>{system.name}</td>
					<td>{system.roles.join(', ')}</td>
				</tr>
			{/each}
		</tbody>
	</table>
{:else}
	<p class="muted">No systems yet.</p>
{/if}

{#if data.root}
	<h2>New system</h2>
	<form class="row" onsubmit={onCreate}>
		<label>Id <input name="id" placeholder="billing" required /></label>
		<label>Name <input name="name" placeholder="Billing" /></label>
		<label>Roles (besides admin) <input name="roles" placeholder="viewer, editor" /></label>
		<button>Create</button>
	</form>
	{#if error}<p class="error">{error}</p>{/if}
{/if}
