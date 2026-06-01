/* Single-instance guard.
 *
 * The daemon owns exclusive resources (MIDI ports, OSC UDP sockets), so two
 * copies can't run at once. This lets a launcher fire freely (e.g. a Max
 * loadbang on every patch open) — a duplicate start detects the live instance
 * and exits cleanly instead of crashing on a port bind.
 *
 * Mechanism: an exclusive-create lockfile holding the owner PID. A stale lock
 * (owner no longer alive, e.g. after a hard kill) is taken over. This survives
 * crashes because liveness is re-checked, unlike a naive "file exists" lock.
 */

import { openSync, writeSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"

export interface LockResult {
	acquired: boolean
	/** PID of the live instance currently holding the lock (when acquired === false). */
	holderPid?: number
}

/** True if a process with this PID currently exists. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		// ESRCH = no such process; EPERM = exists but not ours to signal (still alive).
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * Try to acquire the lock at lockPath for `pid`. Pure (no process.exit) so it
 * is testable; the caller decides what to do when acquired === false.
 */
export function tryAcquireLock(lockPath: string, pid: number = process.pid): LockResult {
	try {
		const fd = openSync(lockPath, "wx") // wx = create exclusively, fail if exists
		writeSync(fd, String(pid))
		closeSync(fd)
		return { acquired: true }
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
		const holder = Number(readFileSync(lockPath, "utf8").trim())
		if (Number.isInteger(holder) && holder > 0 && holder !== pid && isProcessAlive(holder)) {
			return { acquired: false, holderPid: holder }
		}
		// Stale (owner dead) or already ours — take it over.
		writeFileSync(lockPath, String(pid))
		return { acquired: true }
	}
}

export function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath)
	} catch {
		// already gone
	}
}
