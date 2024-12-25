import NodeCache from '@cacheable/node-cache'
import { randomBytes } from 'crypto'
import type { Logger } from 'pino'
import { DEFAULT_CACHE_TTLS } from '../Defaults'
import type { AuthenticationCreds, CacheStore, SignalDataSet, SignalDataTypeMap, SignalKeyStore, SignalKeyStoreWithTransaction, TransactionCapabilityOptions } from '../Types'
import { Curve, signedKeyPair } from './crypto'
import { delay, generateRegistrationId } from './generics'


/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
export function makeCacheableSignalKeyStore(
	store: SignalKeyStore,
	logger: Logger,
	_cache?: CacheStore
): SignalKeyStore {
	const cache = _cache ?? new NodeCache({
		stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, // 5 minutes
		useClones: false,
		deleteOnExpire: true,
	})

	const getUniqueId = (type: string, id: string) => `${type}.${id}`

	return {
		async get(type, ids) {
			const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
			const idsToFetch: string[] = []

			for(const id of ids) {
				const uniqueId = getUniqueId(type, id)
				const item = cache.get<SignalDataTypeMap[typeof type]>(uniqueId)
				if(item !== undefined) {
					data[id] = await item
				} else {
					idsToFetch.push(id)
				}
			}

			if(idsToFetch.length) {
				logger.trace({ items: idsToFetch.length }, 'loading from store')
				const fetched = await store.get(type, idsToFetch)
				for(const id of idsToFetch) {
					const item = fetched[id]
					if(item) {
						data[id] = item
						cache.set(getUniqueId(type, id), item)
					}
				}
			}

			return data
		},
		async set(data) {
			let keys = 0
			for(const type in data) {
				for(const id in data[type]) {
					cache.set(getUniqueId(type, id), data[type][id])
					keys += 1
				}
			}

			logger.trace({ keys }, 'updated cache')

			await store.set(data)
		},
		async clear() {
			cache.flushAll()
			await store.clear?.()
		}
	}
}

/**
 * Adds DB like transaction capability (https://en.wikipedia.org/wiki/Database_transaction) to the SignalKeyStore,
 * this allows batch read & write operations & improves the performance of the lib
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
export const addTransactionCapability = (
	state: SignalKeyStore,
	logger: Logger,
	{ maxCommitRetries, delayBetweenTriesMs }: TransactionCapabilityOptions
): SignalKeyStoreWithTransaction => {
	let dbQueriesInTransaction = 0
	let transactionCache: SignalDataSet = {}
	let mutations: SignalDataSet = {}

	let transactionsInProgress = 0

	const isInTransaction = () => transactionsInProgress > 0

	return {
		async get(type, ids) {
			if(isInTransaction()) {
				const dict = transactionCache[type] ?? {}
				const idsRequiringFetch = ids.filter(id => dict[id] === undefined)

				if(idsRequiringFetch.length) {
					dbQueriesInTransaction += 1
					const result = await state.get(type, idsRequiringFetch)
					transactionCache[type] ||= {}
					Object.assign(transactionCache[type]!, result)
				}

				return ids.reduce((acc, id) => {
					const value = transactionCache[type]?.[id]
					if(value) {
						acc[id] = value
					}

					return acc
				}, {})
			} else {
				return state.get(type, ids)
			}
		},
		async set(data) {
			if(isInTransaction()) {
				logger.trace({ types: Object.keys(data) }, 'caching in transaction')
				for(const key in data) {
					transactionCache[key] = { ...transactionCache[key], ...data[key] }
					mutations[key] = { ...mutations[key], ...data[key] }
				}
			} else {
				await state.set(data)
			}
		},
		isInTransaction,
		async transaction(work) {
			let result: Awaited<ReturnType<typeof work>>
			transactionsInProgress += 1
			if(transactionsInProgress === 1) {
				logger.trace('entering transaction')
			}

			try {
				result = await work()
				if(transactionsInProgress === 1 && Object.keys(mutations).length) {
					logger.trace('committing transaction')
					let tries = maxCommitRetries
					while(tries) {
						tries -= 1
						try {
							await state.set(mutations)
							logger.trace({ dbQueriesInTransaction }, 'committed transaction')
							break
						} catch(error) {
							logger.warn(`failed to commit ${Object.keys(mutations).length} mutations, tries left=${tries}`)
							await delay(delayBetweenTriesMs)
						}
					}
				} else if(!Object.keys(mutations).length) {
					logger.trace('no mutations in transaction')
				}
			} finally {
				transactionsInProgress -= 1
				if(transactionsInProgress === 0) {
					transactionCache = {}
					mutations = {}
					dbQueriesInTransaction = 0
				}
			}

			return result
		}
	}
}

export const initAuthCreds = (): AuthenticationCreds => {
	const identityKey = Curve.generateKeyPair()
	return {
		noiseKey: Curve.generateKeyPair(),
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		signedIdentityKey: identityKey,
		signedPreKey: signedKeyPair(identityKey, 1),
		registrationId: generateRegistrationId(),
		advSecretKey: randomBytes(32).toString('base64'),
		processedHistoryMessages: [],
		nextPreKeyId: 1,
		firstUnuploadedPreKeyId: 1,
		accountSyncCounter: 0,
		accountSettings: {
			unarchiveChats: false
		},
		registered: false,
		pairingCode: undefined,
		lastPropHash: undefined,
		routingInfo: undefined,
	}
}