/** Fork preferences live separately from upstream's settings and chat schemas. */
export interface JapaneseSettings {
	enabled: boolean;
	defaultMinutes: number;
	interests: string[];
}

export interface JapaneseProfile extends JapaneseSettings {
	wanikaniContext?: string;
}

export interface WaniKaniStatus {
	connected: boolean;
	state: "disconnected" | "ready" | "stale" | "unavailable";
	syncedAt?: string;
	level?: number;
	activeItemCount?: number;
	mistakeSignalCount?: number;
	message?: string;
}

export interface JapaneseStatus {
	settings: JapaneseSettings;
	wanikani: WaniKaniStatus;
}

export const DEFAULT_JAPANESE_SETTINGS: JapaneseSettings = {
	enabled: true,
	defaultMinutes: 20,
	interests: [],
};

export function parseJapaneseSettings(value: unknown): JapaneseSettings {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Japanese preferences");
	const v = value as Record<string, unknown>;
	if (Object.keys(v).some((key) => !["enabled", "defaultMinutes", "interests"].includes(key))
		|| typeof v.enabled !== "boolean"
		|| typeof v.defaultMinutes !== "number" || !Number.isInteger(v.defaultMinutes) || v.defaultMinutes < 5 || v.defaultMinutes > 90
		|| !Array.isArray(v.interests) || v.interests.length > 10
		|| !v.interests.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 100)) {
		throw new Error("Use an enabled flag, 5–90 minutes, and up to 10 interests (100 characters each)");
	}
	return { enabled: v.enabled, defaultMinutes: v.defaultMinutes, interests: v.interests.map((item: string) => item.trim()) };
}
