import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_JAPANESE_SETTINGS, parseJapaneseSettings, type JapaneseSettings } from "../../core/japanese.ts";

export function createJapaneseSettingsStore(directory: string) {
	const file = path.join(directory, "settings.json");
	return {
		read(): JapaneseSettings {
			try { return parseJapaneseSettings(JSON.parse(fs.readFileSync(file, "utf8"))); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_JAPANESE_SETTINGS, interests: [] };
				throw new Error("Japanese preferences could not be read");
			}
		},
		write(value: unknown): JapaneseSettings {
			const settings = parseJapaneseSettings(value);
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				fs.writeFileSync(temporary, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
				fs.renameSync(temporary, file);
			} catch {
				fs.rmSync(temporary, { force: true });
				throw new Error("Japanese preferences could not be saved");
			}
			return settings;
		},
	};
}
