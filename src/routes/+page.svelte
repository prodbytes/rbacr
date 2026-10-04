<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>Role manager</h1>
<p class="muted">Sign in to see the roles you hold in each system.</p>
<p><a href="/login/google" data-sveltekit-reload><button>Sign in with Google</button></a></p>
{#if data.devLogin}
	<p><a href="/login/dev">Development sign-in</a></p>
{/if}
