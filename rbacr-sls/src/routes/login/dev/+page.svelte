<script lang="ts">
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<h1>Development sign-in</h1>
<p class="muted">Signs in as any address without Google. Only available under <code>vite dev</code>.</p>
<form method="post" class="row">
	<input name="email" type="email" placeholder="you@example.com" required />
	<button>Sign in</button>
</form>
{#if form?.error}<p class="error">{form.error}</p>{/if}
