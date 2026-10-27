"use client";

import { useEffect, useState } from "react";
import type { JapaneseSettings, JapaneseStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { isComposingKey } from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

export function JapaneseSection() {
	const [state, setState] = useState<JapaneseStatus | null>(null);
	const [draft, setDraft] = useState<JapaneseSettings | null>(null);
	const [interests, setInterests] = useState("");
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	useEffect(() => {
		let current = true;
		fetch("/api/japanese", { cache: "no-store" }).then(async (response) => {
			if (!response.ok) throw new Error("Japanese settings could not be loaded");
			return response.json() as Promise<JapaneseStatus>;
		}).then((value) => {
			if (!current) return;
			setState(value); setDraft(value.settings); setInterests(value.settings.interests.join(", "));
		}).catch(() => { if (current) setError("Japanese settings could not be loaded. Reopen this panel to retry."); });
		return () => { current = false; };
	}, []);

	async function command(body: object): Promise<void> {
		setBusy(true); setError(null); setSaved(false);
		try {
			const response = await fetch("/api/japanese", {
				method: "POST",
				headers: { "content-type": "application/json", "x-learnharness-japanese": "1" },
				body: JSON.stringify(body),
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error ?? "Japanese settings could not be updated");
			setState(result as JapaneseStatus);
			if ((body as { action?: string }).action === "settings") setSaved(true);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Japanese settings could not be updated");
		} finally { setBusy(false); }
	}

	if (!state || !draft) return <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">{error ?? "Loading Japanese settings…"}</p>;
	const progress = state.wanikani;
	return (
		<div data-testid="japanese-settings">
			<SettingsGroup label="Japanese tutor">
				<SettingsRow label="Japanese mode" hint="Practical language use, short diagnostics, and contextual feedback.">
					<Toggle label="Japanese mode" checked={draft.enabled} disabled={busy} onChange={(enabled) => { setDraft({ ...draft, enabled }); setSaved(false); }} />
				</SettingsRow>
				<p className="text-xs text-muted-foreground">Turning this off restores the original tutor for subsequent turns.</p>
				<form className="mt-3 flex flex-col gap-3" onKeyDown={(event) => { if (isComposingKey(event)) event.stopPropagation(); }} onSubmit={(event) => {
					event.preventDefault();
					void command({ action: "settings", settings: { ...draft, interests: interests.split(",").map((item) => item.trim()).filter(Boolean) } });
				}}>
					<label className="flex items-center justify-between gap-3 text-sm">Session length (minutes)
						<input aria-label="Session length in minutes" type="number" min={5} max={90} required value={draft.defaultMinutes} onChange={(event) => { setDraft({ ...draft, defaultMinutes: Number(event.target.value) }); setSaved(false); }} className="lh-input w-20 rounded border border-border px-2 py-1" />
					</label>
					<label className="flex flex-col gap-1 text-sm">Interests
						<input aria-label="Japanese learning interests" value={interests} onChange={(event) => { setInterests(event.target.value); setSaved(false); }} maxLength={1000} placeholder="Games, music, everyday conversation" className="lh-input rounded border border-border px-2 py-1" />
						<span className="text-xs text-muted-foreground">Separate up to 10 interests with commas.</span>
					</label>
					<div className="flex items-center gap-3"><Button type="submit" disabled={busy}>Save preferences</Button>{saved && <span role="status" className="text-xs text-muted-foreground">Saved</span>}</div>
				</form>
			</SettingsGroup>
			<SettingsGroup label="WaniKani">
				<p role="status" data-testid="wanikani-status" className="text-sm">
					{progress.state === "ready" ? "Connected · up to date" : progress.state === "stale" ? "Connected · saved data is stale" : progress.connected ? "Connected · progress unavailable" : "Not connected"}
				</p>
				{progress.level !== undefined && <p className="mt-1 text-xs text-muted-foreground">Level {progress.level} · {progress.activeItemCount ?? 0} active items</p>}
				{progress.syncedAt && <p className="mt-1 text-xs text-muted-foreground">Last refreshed: {new Date(progress.syncedAt).toLocaleString()}</p>}
				{progress.message && <p role="status" className="mt-2 text-sm text-muted-foreground">{progress.message}</p>}
				<p className="mt-3 text-sm text-muted-foreground">Use your active words and kanji in natural sentences and conversations. Your lesson goal stays in charge.</p>
				<form className="mt-3 flex flex-col gap-2" onSubmit={(event) => {
					event.preventDefault();
					const value = token;
					setToken("");
					void command({ action: "connect", token: value });
				}}>
					<label className="text-sm" htmlFor="wanikani-token">{progress.connected ? "Replace personal access token" : "Personal access token"}</label>
					<input id="wanikani-token" aria-label="WaniKani personal access token" type="password" autoComplete="off" spellCheck={false} maxLength={512} value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (isComposingKey(event)) event.preventDefault(); }} className="lh-input rounded border border-border px-2 py-1" />
					<p className="text-xs text-muted-foreground">Read access is enough. Saved privately on this machine; the token is never sent to your tutor model. The selected vocabulary summary is sent to your chosen model provider.</p>
					<a href="https://www.wanikani.com/settings/personal_access_tokens" target="_blank" rel="noreferrer" className="w-fit text-xs underline">Create a WaniKani token</a>
					<div className="mt-2 flex flex-wrap gap-2">
						<Button type="submit" disabled={busy || !token.trim()}>{busy ? "Working…" : progress.connected ? "Replace token" : "Connect WaniKani"}</Button>
						{progress.connected && <><Button type="button" disabled={busy} onClick={() => void command({ action: "refresh" })}>Refresh progress</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void command({ action: "disconnect" })}>Disconnect</Button></>}
					</div>
				</form>
				<p className="mt-3 text-xs text-muted-foreground">Progress refreshes automatically. Mistake candidates are approximate; WaniKani stages do not prove language ability. Sessions continue when WaniKani is unavailable.</p>
			</SettingsGroup>
			{error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
		</div>
	);
}
