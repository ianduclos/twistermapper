import { describe, it, expect, afterEach } from "vitest"
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tryAcquireLock, releaseLock, isProcessAlive } from "../src/util/singleInstance.js"

const lockPath = () => join(tmpdir(), `tm-test-${process.pid}-${Math.random().toString(36).slice(2)}.lock`)

let paths: string[] = []
afterEach(() => {
	for (const p of paths) releaseLock(p)
	paths = []
})
function newLock() {
	const p = lockPath()
	paths.push(p)
	return p
}

describe("singleInstance", () => {
	it("acquires a fresh lock and writes the pid", () => {
		const p = newLock()
		expect(tryAcquireLock(p)).toEqual({ acquired: true })
		expect(Number(readFileSync(p, "utf8"))).toBe(process.pid)
	})

	it("refuses when held by a different live process", () => {
		const p = newLock()
		tryAcquireLock(p) // held by this (alive) process
		// Another would-be instance with a different pid sees a live holder.
		const res = tryAcquireLock(p, process.pid + 1)
		expect(res).toEqual({ acquired: false, holderPid: process.pid })
	})

	it("takes over a stale lock (dead owner)", () => {
		const p = newLock()
		writeFileSync(p, "999999999") // a pid that does not exist
		const res = tryAcquireLock(p)
		expect(res.acquired).toBe(true)
		expect(Number(readFileSync(p, "utf8"))).toBe(process.pid)
	})

	it("releaseLock removes the file", () => {
		const p = newLock()
		tryAcquireLock(p)
		expect(existsSync(p)).toBe(true)
		releaseLock(p)
		expect(existsSync(p)).toBe(false)
	})

	it("isProcessAlive: true for self, false for a nonexistent pid", () => {
		expect(isProcessAlive(process.pid)).toBe(true)
		expect(isProcessAlive(999999999)).toBe(false)
	})
})
