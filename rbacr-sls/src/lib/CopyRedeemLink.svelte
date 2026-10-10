<!--
	Copies a voucher's redeem link (SPEC V8) to the clipboard: opening it
	signs the visitor in if needed, then redeems the voucher.
-->
<script lang="ts">
	import { redeemPath } from '#lib/next.js';

	let { code }: { code: string } = $props();
	let copied = $state<boolean | null>(null);
	let href = $derived(redeemPath(code));

	async function copy() {
		try {
			await navigator.clipboard.writeText(new URL(href, location.origin).href);
			copied = true;
		} catch {
			copied = false;
		}
		setTimeout(() => (copied = null), 2000);
	}
</script>

<button type="button" class="link" title="Copy the link that redeems {code}" onclick={copy}>
	{copied ? 'Copied' : 'Copy link'}
</button>
{#if copied === false}<a class="muted" {href}>(copy failed: right-click to copy)</a>{/if}
