<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// The app is interactive: let forms submit (see the guard in app.html).
	$effect(() => {
		document.documentElement.dataset.ready = 'true';
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>rbacr</title>
</svelte:head>

<header>
	<a href="/" class="brand">rbacr</a>
	{#if data.user}
		<nav>
			<a href="/me">My roles</a>
			{#if data.user.root}<a href="/systems">Systems</a>{/if}
			{#if data.user.root}<a href="/global">Global</a>{/if}
			{#if data.user.root}
				<a href="/notifications">
					Notifications{#if data.user.openNotifications}{' '}<span class="badge alert">{data.user.openNotifications}</span>{/if}
				</a>
			{/if}
			<a href="/settings">Settings</a>
		</nav>
		<span class="who">
			{data.user.email}
			{#if data.user.root}<span class="badge">root</span>{/if}
		</span>
		<form method="post" action="/logout"><button class="link">Sign out</button></form>
	{/if}
</header>

<main>
	{@render children()}
</main>

<style>
	/* Gruvbox soft dark. */
	:global(:root) {
		--bg: #32302f; /* bg0_s */
		--fg: #ebdbb2; /* fg */
		--muted: #a89984; /* fg4 */
		--line: #504945; /* bg2 */
		--card: #3c3836; /* bg1 */
		--accent: #83a598; /* blue */
		--accent-fg: #32302f; /* bg0_s */
		--brand: #fe8019; /* orange */
		--warn: #fabd2f; /* yellow */
		--danger: #fb4934; /* red */
		--ok: #b8bb26; /* green */
		color-scheme: dark;
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--fg);
		font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
	}
	:global(a) {
		color: var(--accent);
	}
	:global(h1) {
		font-size: 1.5rem;
		margin: 0 0 1rem;
	}
	:global(h2) {
		font-size: 1.1rem;
		margin: 2rem 0 0.75rem;
	}
	:global(table) {
		width: 100%;
		border-collapse: collapse;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 6px;
	}
	:global(th),
	:global(td) {
		text-align: left;
		padding: 0.45rem 0.7rem;
		border-bottom: 1px solid var(--line);
		vertical-align: top;
	}
	:global(th) {
		font-weight: 600;
		color: var(--muted);
		font-size: 0.85rem;
	}
	:global(input),
	:global(select),
	:global(button) {
		font: inherit;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 5px;
		background: var(--card);
		color: var(--fg);
	}
	:global(button) {
		cursor: pointer;
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-fg);
		font-weight: 600;
	}
	:global(button:hover) {
		filter: brightness(1.1);
	}
	:global(:focus-visible) {
		outline: 2px solid var(--warn);
		outline-offset: 1px;
	}
	:global(::selection) {
		background: var(--line);
	}
	:global(button.link) {
		font-weight: normal;
		background: none;
		border: none;
		color: var(--accent);
		padding: 0;
	}
	:global(button.danger) {
		background: none;
		border-color: var(--danger);
		color: var(--danger);
		padding: 0.15rem 0.5rem;
	}
	:global(.row) {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: end;
	}
	:global(.row label) {
		display: flex;
		flex-direction: column;
		font-size: 0.8rem;
		color: var(--muted);
		gap: 0.2rem;
	}
	:global(table.spaced) {
		margin-top: 0.75rem;
	}
	:global(input.narrow) {
		width: 7rem;
	}
	:global(.muted) {
		color: var(--muted);
	}
	:global(.error) {
		color: var(--danger);
	}
	:global(.ok) {
		color: var(--ok);
	}
	:global(code) {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.9em;
	}
	:global(.badge) {
		display: inline-block;
		font-size: 0.75rem;
		padding: 0 0.45rem;
		border-radius: 999px;
		border: 1px solid var(--line);
		color: var(--muted);
	}
	:global(.who .badge) {
		border-color: var(--warn);
		color: var(--warn);
	}
	.badge.alert {
		border-color: var(--warn);
		color: var(--warn);
	}
	header {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--line);
		background: var(--card);
		flex-wrap: wrap;
	}
	.brand {
		font-weight: 700;
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		text-decoration: none;
		color: var(--brand);
	}
	nav {
		display: flex;
		gap: 1rem;
	}
	.who {
		margin-left: auto;
		color: var(--muted);
		font-size: 0.9rem;
	}
	main {
		max-width: 960px;
		margin: 0 auto;
		padding: 1.5rem 1rem 4rem;
	}
	.who + form {
		margin: 0;
	}
	@media (max-width: 600px) {
		.who {
			margin-left: 0;
			width: 100%;
		}
	}
</style>
