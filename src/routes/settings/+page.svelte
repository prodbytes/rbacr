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
		<tr><th>API tokens</th><td><a href="/me#tokens">Manage on My roles</a></td></tr>
	</tbody>
</table>
