<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>Settings</h1>

<h2>About</h2>
<table>
	<tbody>
		<tr><th>Version</th><td><code>{data.version}</code></td></tr>
		<tr><th>API</th><td><code>{data.apiBase}</code></td></tr>
	</tbody>
</table>

<h2>Account</h2>
<table>
	<tbody>
		<tr>
			<th>Signed in as</th>
			<td>{data.email}{#if data.root}{' '}<span class="badge">root</span>{/if}</td>
		</tr>
		<tr><th>API tokens</th><td><a href="/global#tokens">Manage on Global</a></td></tr>
	</tbody>
</table>

<h2>Roots</h2>
<p class="muted">
	<code>root</code> is the only built-in role: it implies every role of every system. It comes only from the
	<code>RBACR_ROOT_LIST</code> setting, never from grants.
</p>
{#if data.rootList}
	<table>
		<thead><tr><th>Root allow list</th></tr></thead>
		<tbody>
			{#each data.rootList as entry (entry)}
				<tr><td><code>{entry}</code>{entry.startsWith('@') ? ' (everyone at this domain)' : ''}</td></tr>
			{:else}
				<tr><td class="muted">Empty: nobody is a root.</td></tr>
			{/each}
		</tbody>
	</table>
{/if}
