import path from "node:path";
import { AUTH_FILE, PATHS } from "../../config.ts";
import { parseJapaneseSettings, type JapaneseProfile } from "../core/japanese.ts";
import { createJapaneseSettingsStore } from "../store/japanese/settings.ts";
import { WaniKaniConnection } from "../store/japanese/wanikani-connection.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

/** One owner survives Next's route-module reloads; the credential path follows
 * LH_AUTH_FILE and never enters the model-facing profile or settings response. */
export function createJapaneseService(
	connection: WaniKaniConnection,
	settings: ReturnType<typeof createJapaneseSettingsStore>,
	now: () => number = Date.now,
) {
	let lastAttempt = -Infinity;
	let refreshing: Promise<void> | undefined;
	async function refresh(force = false): Promise<void> {
		if (refreshing) return refreshing;
		if (!force && now() - lastAttempt < 15 * 60_000) return;
		lastAttempt = now();
		refreshing = connection.refresh().then(() => {}).finally(() => { refreshing = undefined; });
		return refreshing;
	}
	return {
		async status() { await refresh(); return { settings: settings.read(), wanikani: connection.status() }; },
		async profile(): Promise<JapaneseProfile | undefined> {
			const preferences = settings.read();
			if (!preferences.enabled) return undefined;
			await refresh();
			return { ...preferences, wanikaniContext: connection.context() };
		},
		async command(body: unknown) {
			if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Invalid Japanese command");
			const value = body as Record<string, unknown>;
			switch (value.action) {
				case "settings": settings.write(parseJapaneseSettings(value.settings)); break;
				case "connect":
					if (typeof value.token !== "string") throw new Error("Enter a WaniKani personal access token");
					await connection.connect(value.token);
					lastAttempt = now();
					break;
				case "refresh": await refresh(true); break;
				case "disconnect": await connection.disconnect(); lastAttempt = now(); break;
				default: throw new Error("Unknown Japanese command");
			}
			return { settings: settings.read(), wanikani: connection.status() };
		},
	};
}

type Service = ReturnType<typeof createJapaneseService>;
const runtime = globalThis as typeof globalThis & { __lhJapanese?: { identity: string; service: Service } };
function service(): Service {
	const identity = `${PATHS.data}\0${AUTH_FILE}`;
	if (runtime.__lhJapanese?.identity !== identity) {
		const directory = path.join(PATHS.data, "japanese");
		runtime.__lhJapanese = { identity, service: createJapaneseService(new WaniKaniConnection({
			cwd: directory,
			cacheDir: path.join(directory, "wanikani"),
			credentialsDir: path.join(path.dirname(AUTH_FILE), ".japanese-credentials"),
		}), createJapaneseSettingsStore(directory)) };
	}
	return runtime.__lhJapanese!.service;
}

export const japaneseTurnProfile = () => service().profile();

export async function japaneseResponse(request: Request): Promise<Response> {
	if (!desktopAPIAuthorized(request.headers)) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (request.method === "GET") {
		try { return Response.json(await service().status(), { headers: { "Cache-Control": "no-store" } }); }
		catch { return Response.json({ error: "Japanese settings could not be loaded" }, { status: 503 }); }
	}
	// A custom header + same-origin JSON keep browser cross-origin forms away
	// from credential changes, in the same trusted-local model as upstream.
	const origin = request.headers.get("origin");
	if (request.headers.get("x-learnharness-japanese") !== "1"
		|| !request.headers.get("content-type")?.startsWith("application/json")
		|| !origin || origin !== subscriptionRequestOrigin(request)
		|| request.headers.get("sec-fetch-site") === "cross-site") {
		return Response.json({ error: "Use the Japanese settings panel on this server" }, { status: 403 });
	}
	const raw = await request.text();
	if (raw.length > 4096) return Response.json({ error: "Japanese request is too large" }, { status: 413 });
	try { return Response.json(await service().command(JSON.parse(raw))); }
	catch { return Response.json({ error: "Japanese settings could not be updated; check the supplied preferences" }, { status: 400 }); }
}
