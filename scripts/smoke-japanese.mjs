/** Built-app gate: real HTTP routes, two server processes, disposable credentials,
 * simulated WaniKani only. All other external requests are refused. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const standalone = path.join(root, ".next/standalone");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "lh-japanese-smoke-"));
const modeFile = path.join(scratch, "fixture-mode");
const token = "fake-japanese-smoke-token-never-real";
const data = path.join(scratch, "data");
await fs.mkdir(data, { mode: 0o700 });
await fs.writeFile(modeFile, "first");
const preload = path.join(scratch, "fixture-fetch.mjs");
await fs.writeFile(preload, `import fs from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return original(input, init);
 if (url.origin !== 'https://api.wanikani.com') throw new Error('Offline Japanese gate forbids external requests');
 const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8');
 if (mode === 'offline') throw new Error('Simulated offline failure');
 if (new Headers(init?.headers).get('authorization') !== ${JSON.stringify("Bearer " + token)}) return Response.json({error:'invalid'}, {status:401});
 const id = mode === 'first' ? 1 : 2, characters = id === 1 ? '寄る' : '帰る', now = new Date().toISOString();
 if (url.pathname === '/v2/user') return Response.json({object:'user',data:{id:'fixture',level:19,subscription:{max_level_granted:60}}});
 let rows = [];
 if (url.pathname === '/v2/assignments') rows = [{object:'assignment',data:{subject_id:id,subject_type:'vocabulary',srs_stage:2,hidden:false,started_at:now,available_at:now,burned_at:null}}];
 if (url.pathname === '/v2/subjects') rows = [{id,object:'vocabulary',data:{characters,level:1,hidden_at:null,meanings:[{meaning:'fixture meaning',accepted_answer:true,primary:true}],readings:[{reading:'よる',accepted_answer:true,primary:true}]}}];
 return Response.json({object:'collection',data:rows,pages:{next_url:null}});
};\n`, { mode: 0o600 });

async function freePort() {
	const server = createServer();
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function start() {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	let output = "";
	const child = spawn(process.execPath, [path.join(standalone, "server.js")], {
		cwd: standalone,
		env: { PATH: process.env.PATH, PORT: String(port), HOSTNAME: "127.0.0.1", TMPDIR: os.tmpdir(), LH_DATA_DIR: data, LH_AUTH_FILE: path.join(scratch, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const receive = (chunk) => { output += chunk.toString(); };
	child.stdout.on("data", receive); child.stderr.on("data", receive);
	const exited = new Promise((resolve) => child.once("exit", resolve));
	let startupError;
	child.once("error", (error) => { startupError = error; });
	try {
		const deadline = Date.now() + 60_000;
		while (!output.includes("Ready in")) {
			if (startupError) throw startupError;
			if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Japanese smoke server did not become ready: ${output.slice(-3000)}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	} catch (error) { child.kill("SIGTERM"); throw error; }
	return {
		origin,
		async request(command, headers = {}) {
			const response = await fetch(`${origin}/api/japanese`, { ...(command ? { method: "POST", body: JSON.stringify(command), headers: { origin, "content-type": "application/json", "x-learnharness-japanese": "1", ...headers } } : {}), signal: AbortSignal.timeout(20_000) });
			const text = await response.text();
			assert(!text.includes(token), "HTTP responses must never disclose the token");
			return { response, value: JSON.parse(text) };
		},
		async stop() {
			child.kill("SIGTERM");
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
			if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
			assert(!output.includes(token), "server logs must never disclose the token");
		},
	};
}

const checks = [];
let server;
try {
	server = await start();
	let state = await server.request();
	assert.equal(state.value.settings.enabled, true);
	assert.equal(state.value.wanikani.connected, false);
	checks.push("Japanese enabled by default, WaniKani optional");
	const settings = { enabled: true, defaultMinutes: 15, interests: ["ゲーム", "音楽"] };
	assert.equal((await server.request({ action: "settings", settings })).response.status, 200);
	assert.equal((await server.request({ action: "connect", token }, { origin: "https://unrelated.invalid" })).response.status, 403);
	assert.equal((await server.request({ action: "connect", token })).value.wanikani.state, "ready");
	const privateFile = path.join(scratch, ".japanese-credentials/credentials.json");
	assert.equal((await fs.stat(privateFile)).mode & 0o777, 0o600);
	assert(!JSON.stringify((await server.request()).value).includes(token));
	checks.push("private token entry, same-origin control, safe status");
	await server.stop(); server = undefined;
	await fs.writeFile(modeFile, "second");
	server = await start();
	state = await server.request();
	assert.deepEqual(state.value.settings, settings);
	assert.equal(state.value.wanikani.state, "ready");
	const cached = JSON.parse(await fs.readFile(path.join(data, "japanese/wanikani/cache.json"), "utf8"));
	assert.equal(cached.cache.subjects[0].characters, "帰る");
	assert(!JSON.stringify(cached).includes(token));
	checks.push("saved preferences and token survive restart; startup fetches new vocabulary");
	await fs.writeFile(modeFile, "offline");
	assert.equal((await server.request({ action: "refresh" })).value.wanikani.state, "stale");
	assert.equal((await server.request({ action: "settings", settings: { ...settings, enabled: false } })).value.settings.enabled, false);
	assert.equal((await server.request({ action: "disconnect" })).value.wanikani.connected, false);
	assert.equal(JSON.parse(await fs.readFile(privateFile, "utf8")).token, null);
	checks.push("offline recovery, original-behavior switch, and disconnect");
	await server.stop(); server = undefined;
	await fs.writeFile(path.join(scratch, "verification.json"), JSON.stringify({ passed: true, simulated: true, checks }, null, 2));
	console.log(`PASS: ${checks.join("; ")}.\nArtifacts: ${scratch}`);
} finally { if (server) await server.stop(); }
