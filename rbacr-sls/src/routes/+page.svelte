<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let query = $derived(data.next ? `?next=${encodeURIComponent(data.next)}` : '');
</script>

<h1>Role manager</h1>
{#if data.next?.startsWith('/redeem/')}
	<p>Sign in to redeem your voucher. You'll come straight back to get its roles.</p>
{:else}
	<p class="muted">Sign in to see the roles you hold in each system.</p>
{/if}
<p><a href="/login/google{query}" data-sveltekit-reload><button>Sign in with Google</button></a></p>
{#if data.devLogin}
	<p><a href="/login/dev{query}">Development sign-in</a></p>
{/if}
