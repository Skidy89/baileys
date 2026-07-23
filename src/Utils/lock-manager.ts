import { makeKeyedMutex } from './make-mutex'

/**
 * One unit of locking — a (namespace, id) pair. The `namespace` is usually a
 * {@link SignalDataType} when locking a real record, but the lock manager also
 * accepts internal-use namespaces (e.g. `'__type__'` for per-type batched
 * writes, `'__legacy__'` for backwards compatibility with the string-keyed
 * `transaction(work, key)` API). Internal namespaces are deliberately prefixed
 * to avoid collision with `SignalDataType` values.
 */
export type LockRef = {
	namespace: string
	id: string
}

const refKey = (r: LockRef): string => `${r.namespace}${r.id}`

const compareRefs = (a: LockRef, b: LockRef): number => {
	const ak = refKey(a)
	const bk = refKey(b)
	return ak < bk ? -1 : ak > bk ? 1 : 0
}

export type LockManager = {
	/** Run `work` while holding the lock on a single ref. */
	withLock<T>(ref: LockRef, work: () => Promise<T> | T): Promise<T>
	/**
	 * Run `work` while holding locks on every ref in `refs`. Locks are acquired
	 * in a deterministic order (sorted by `namespace\0id`) so two callers asking
	 * for an overlapping set never deadlock against each other. Duplicate refs
	 * are coalesced — passing the same ref twice acquires the lock once.
	 */
	withLocks<T>(refs: readonly LockRef[], work: () => Promise<T> | T): Promise<T>
	/**
	 * For diagnostics / tests: true if any work is currently holding a lock on
	 * the given ref. Not for production decision-making — it races with the lock
	 * acquisition path itself.
	 */
	isLocked(ref: LockRef): boolean
}

/**
 * Build a {@link LockManager} on top of the existing {@link makeKeyedMutex}
 * primitive (which already implements correct identity-checked refcount
 * cleanup at `src/Utils/make-mutex.ts:34`). This module is the canonical
 * lock-acquisition surface for the auth/transaction layer — no other module
 * should instantiate per-key mutexes or `PQueue` maps directly.
 */
export const makeLockManager = (): LockManager => {
	const km = makeKeyedMutex()

	// Track in-flight keys for `isLocked` (a thin counter, not load-bearing).
	const heldCounts = new Map<string, number>()
	const noteHeld = (key: string) => heldCounts.set(key, (heldCounts.get(key) ?? 0) + 1)
	const noteReleased = (key: string) => {
		const next = (heldCounts.get(key) ?? 1) - 1
		if (next <= 0) heldCounts.delete(key)
		else heldCounts.set(key, next)
	}

	const withSingleLock = async <T>(ref: LockRef, work: () => Promise<T> | T): Promise<T> => {
		const key = refKey(ref)
		return km.mutex(key, async () => {
			noteHeld(key)
			try {
				return await work()
			} finally {
				noteReleased(key)
			}
		})
	}

	return {
		withLock: withSingleLock,
		withLocks<T>(refs: readonly LockRef[], work: () => Promise<T> | T): Promise<T> {
			if (refs.length === 0) return Promise.resolve().then(work)

			// De-duplicate and sort to enforce a global acquisition order across
			// all callers — this is what prevents `withLocks([a, b])` from
			// deadlocking against `withLocks([b, a])`.
			const seen = new Set<string>()
			const sorted = [...refs].sort(compareRefs).filter(r => {
				const k = refKey(r)
				if (seen.has(k)) return false
				seen.add(k)
				return true
			})

			// Acquire by recursive nesting — each level holds its own lock for the
			// duration of the inner acquisitions and the final `work()` call. This
			// is the natural shape over `runExclusive`-style mutexes.
			const acquire = (i: number): Promise<T> => {
				if (i === sorted.length) return Promise.resolve().then(work)
				return withSingleLock(sorted[i]!, () => acquire(i + 1))
			}

			return acquire(0)
		},
		isLocked(ref: LockRef): boolean {
			return heldCounts.has(refKey(ref))
		}
	}
}
