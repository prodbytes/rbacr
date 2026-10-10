<!--
	A role name, linked to its system's URL in a new tab when the system has
	one (SPEC R10), so a role can be followed into the system.
-->
<script lang="ts">
	let { role, url = null }: { role: string; url?: string | null } = $props();
</script>

{#if url}<a href={url} target="_blank" rel="noopener noreferrer" title="Open in a new tab">{role}</a>{:else}{role}{/if}
