import {
    SingletonAction,
    action,
    type KeyAction,
    type KeyDownEvent,
    type WillAppearEvent,
    type WillDisappearEvent,
    type DidReceiveSettingsEvent,
} from "@elgato/streamdeck";

type PublicIPSettings = {
    [key: string]: string | number | boolean | null | undefined;
    refreshInterval?: number;
    refreshUnit?: "seconds" | "minutes" | "hours";
};

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MIN_REFRESH_INTERVAL = 10 * 1000;        // 10 seconds
const MAX_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

interface InstanceState {
	timer?: NodeJS.Timeout;
	lastIP?: string;
	lastChange?: Date;
	warningActive?: boolean;
	refreshInterval: number;
}

const LOG_FILE = path.join(
	process.cwd(),
	"logs",
	"ip-history.log"
);

const instances = new Map<string, InstanceState>();

@action({ UUID: "com.robin-edgar.ip-change-viewer.public-ip-monitor" })
export class PublicIPAction
	extends SingletonAction<PublicIPSettings> {

	override async onWillAppear(
		ev: WillAppearEvent<PublicIPSettings>
	): Promise<void> {

		const context = ev.action.id;

		const interval = getRefreshInterval(
			ev.payload.settings
		);

		const state: InstanceState = {
			refreshInterval: interval,
		};

		instances.set(context, state);

		const keyAction = ev.action as KeyAction;

		await this.updateIP(keyAction, false);

		this.startTimer(keyAction, state);
	}

	override onWillDisappear(
		ev: WillDisappearEvent
	): void {

		const context = ev.action.id;
		const state = instances.get(context);

		if (state?.timer) {
			clearInterval(state.timer);
		}

		instances.delete(context);
	}

	override async onDidReceiveSettings(
		ev: DidReceiveSettingsEvent<PublicIPSettings>
	): Promise<void> {

		const context = ev.action.id;
		const state = instances.get(context);

		if (!state) {
			return;
		}

		const newInterval = getRefreshInterval(
			ev.payload.settings
		);

		if (newInterval !== state.refreshInterval) {

			state.refreshInterval = newInterval;

			if (state.timer) {
				clearInterval(state.timer);
			}

			this.startTimer(
				ev.action as KeyAction,
				state
			);
		}
	}

	override async onKeyDown(
		ev: KeyDownEvent<PublicIPSettings>
	): Promise<void> {

		const context = ev.action.id;
		const state = instances.get(context);

		if (state) {
			state.warningActive = false;
		}

		await this.updateIP(
			ev.action as KeyAction,
			true
		);
	}

	private startTimer(
		action: KeyAction,
		state: InstanceState
	): void {

		state.timer = setInterval(() => {
			void this.updateIP(action, false);
		}, state.refreshInterval);
	}

	private async updateIP(
		keyAction: KeyAction,
		manual: boolean
	): Promise<void> {

		const context = keyAction.id;

		let state = instances.get(context);

		if (!state) {
			state = {
				refreshInterval: DEFAULT_REFRESH_INTERVAL,
			};

			instances.set(context, state);
		}

		try {
			await keyAction.setTitle(
				manual ? "REFRESH..." : "LOADING"
			);

			const ip = await fetchPublicIP();
			const previousIP = state.lastIP;

			/*
			 * First successful lookup.
			 */
			if (!previousIP) {

				state.lastChange = new Date();

				await logInitialIP(ip);

			/*
			 * IP has changed.
			 */
			} else if (previousIP !== ip) {

				state.lastChange = new Date();
				state.warningActive = true;

				await logIPChange(
					previousIP,
					ip
				);
			}

			state.lastIP = ip;

			/*
			 * Warning remains active until
			 * the user presses the key.
			 */
			if (state.warningActive) {
				await keyAction.setState(1);
			} else {
				await keyAction.setState(0);
			}

			const title =
				formatIP(ip) +
				"\n" +
				formatChangeTime(state.lastChange);

			await keyAction.setTitle(title);

		} catch (error) {

			console.error(
				"Unable to retrieve public IP:",
				error
			);

			/*
			 * Network failure is not an IP change.
			 * Preserve an existing warning.
			 */
			if (state.warningActive) {
				await keyAction.setState(1);
			} else {
				await keyAction.setState(0);
			}

			await keyAction.setTitle("ERROR");

			await keyAction.showAlert();
		}
	}
}

function getRefreshInterval(
	settings?: PublicIPSettings
): number {

	if (!settings?.refreshInterval) {
		return DEFAULT_REFRESH_INTERVAL;
	}

	const value = Number(settings.refreshInterval);

	if (!Number.isFinite(value) || value <= 0) {
		return DEFAULT_REFRESH_INTERVAL;
	}

	let multiplier = 60 * 1000;

	switch (settings.refreshUnit) {

		case "seconds":
			multiplier = 1000;
			break;

		case "hours":
			multiplier = 60 * 60 * 1000;
			break;

		case "minutes":
		default:
			multiplier = 60 * 1000;
			break;
	}

	const interval = value * multiplier;

	return Math.min(
		MAX_REFRESH_INTERVAL,
		Math.max(
			MIN_REFRESH_INTERVAL,
			interval
		)
	);
}

async function fetchPublicIP(): Promise<string> {

	const response = await fetch(
		"https://api.ipify.org?format=json"
	);

	if (!response.ok) {
		throw new Error(
			`IP service returned HTTP ${response.status}`
		);
	}

	const data = await response.json() as {
		ip?: string;
	};

	if (!data.ip) {
		throw new Error(
			"IP service returned no IP address"
		);
	}

	return data.ip;
}

async function writeHistory(
	line: string
): Promise<void> {

	try {

		await fs.mkdir(
			path.dirname(LOG_FILE),
			{ recursive: true }
		);

		await fs.appendFile(
			LOG_FILE,
			line + "\n",
			"utf8"
		);

	} catch (error) {

		console.error(
			"Unable to write IP history:",
			error
		);
	}
}

async function logInitialIP(
	ip: string
): Promise<void> {

	await writeHistory(
		`${new Date().toISOString()} | INITIAL | ${ip}`
	);
}

async function logIPChange(
	oldIP: string,
	newIP: string
): Promise<void> {

	await writeHistory(
		`${new Date().toISOString()} | CHANGED | ${oldIP} -> ${newIP}`
	);
}

function formatIP(ip: string): string {

	const parts = ip.split(".");

	if (parts.length === 4) {
		return `${parts[0]}.${parts[1]}\n${parts[2]}.${parts[3]}`;
	}

	return ip;
}

function formatChangeTime(
	date?: Date
): string {

	if (!date) {
		return "";
	}

	const now = new Date();

	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();

	const hours = String(
		date.getHours()
	).padStart(2, "0");

	const minutes = String(
		date.getMinutes()
	).padStart(2, "0");

	const time = `${hours}:${minutes}`;

	if (sameDay) {
		return time;
	}

	const months = [
		"Jan", "Feb", "Mar", "Apr",
		"May", "Jun", "Jul", "Aug",
		"Sep", "Oct", "Nov", "Dec"
	];

	return `${time}\n${date.getDate()} ${months[date.getMonth()]}`;
}