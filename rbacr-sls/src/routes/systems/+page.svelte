<script lang="ts">
	import { goto } from '$app/navigation';
	import { vpiFetch, VpiError } from '#lib/vpi.js';
	import RoleName from '#lib/RoleName.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let error = $state('');

	let name = $state('');
	/** The id a name makes: lower case, other characters as dashes (SPEC: system ids are slugs). */
	let id = $derived(
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_.:-]+/g, '-')
			.replace(/^[^a-z0-9]+|-+$/g, '')
	);

	/** Creates the system with no roles; they are added on its page. */
	async function onCreate(e: SubmitEvent) {
		e.preventDefault();
		try {
			const system = await vpiFetch<{ id: string }>(fetch, '/systems', { method: 'POST', body: { id, name: name.trim() } });
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
					<td>
						{#each system.roles as role, i (role)}{i ? ', ' : ''}<RoleName {role} url={system.url} />{/each}
					</td>
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
		<label>Name <input bind:value={name} placeholder="TabScan" required /></label>
		<button disabled={!id}>Create</button>
		{#if id}<span class="muted">id <code>{id}</code>; add its roles on the next page</span>{/if}
	</form>
	{#if error}<p class="error">{error}</p>{/if}
{/if}
