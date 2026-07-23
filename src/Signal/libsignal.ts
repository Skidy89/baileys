// @ts-ignore
import * as libsignal from 'libsignal'
// @ts-ignore
import { PreKeyWhisperMessage } from 'libsignal/src/protobufs'
import { LRUCache } from 'lru-cache'
import type { LIDMapping, SignalAuthState, SignalKeyStoreWithTransaction } from '../Types'
import type { SignalRepositoryWithLIDStore } from '../Types/Signal'
import { generateSignalPubKey } from '../Utils'
import type { ILogger } from '../Utils/logger'
import {
	isHostedLidUser,
	isHostedPnUser,
	isLidUser,
	isPnUser,
	jidDecode,
	transferDevice,
	WAJIDDomains
} from '../WABinary'
import type { SenderKeyStore } from './Group/group_cipher'
import { SenderKeyName } from './Group/sender-key-name'
import { SenderKeyRecord } from './Group/sender-key-record'
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group'
import { LIDMappingStore } from './lid-mapping'
import { makeMutex } from '../Utils/make-mutex'

/** Extract identity key from PreKeyWhisperMessage for identity change detection */
function extractIdentityFromPkmsg(ciphertext: Uint8Array): Uint8Array | undefined {
	try {
		if (!ciphertext || ciphertext.length < 2) {
			return undefined
		}

		// Version byte check (version 3)
		const version = ciphertext[0]!
		if ((version & 0xf) !== 3) {
			return undefined
		}

		// Parse protobuf (skip version byte)
		const preKeyProto = PreKeyWhisperMessage.decode(ciphertext.slice(1))
		if (preKeyProto.identityKey?.length === 33) {
			return new Uint8Array(preKeyProto.identityKey)
		}

		return undefined
	} catch {
		return undefined
	}
}
export function makeLibSignalRepository(
	auth: SignalAuthState,
	logger: ILogger | undefined,
	pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>,
	getUSyncDevices?: (jid: string) => Promise<string[]>
): SignalRepositoryWithLIDStore {
	const lidMapping = new LIDMappingStore(auth.keys as SignalKeyStoreWithTransaction, logger, pnToLIDFunc)
	const storage = signalStorage(auth, lidMapping)

	const parsedKeys = auth.keys as SignalKeyStoreWithTransaction
	const migratedSessionCache = new LRUCache<string, true>({
		max: 100_000,
		ttl: 3 * 24 * 60 * 60 * 1000,
		ttlAutopurge: true,
		updateAgeOnGet: true
	})
	const migrationMutex = makeMutex()
	const migrationAttemptCache = new LRUCache<string, { migrated: number; skipped: number; total: number }>({
		max: 10_000,
		ttl: 5 * 60 * 1000,
		ttlAutopurge: true
	})

	const ensureSenderKeyAndCreateSkdm = async (group: string, meId: string) => {
		const senderName = jidToSignalSenderKeyName(group, meId)
		const senderNameStr = senderName.toString()
		const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
		if (!senderKey) {
			await storage.storeSenderKey(senderName, new SenderKeyRecord())
		}

		const skdm = await new GroupSessionBuilder(storage).create(senderName)
		return { senderName, skdm }
	}

	const repository: SignalRepositoryWithLIDStore = {
		decryptGroupMessage({ group, authorJid, msg }) {
			const senderName = jidToSignalSenderKeyName(group, authorJid)
			const cipher = new GroupCipher(storage, senderName)

			// Use transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				return cipher.decrypt(msg)
			}, group)
		},
		async processSenderKeyDistributionMessage({ item, authorJid }) {
			const builder = new GroupSessionBuilder(storage)
			if (!item.groupId) {
				throw new Error('Group ID is required for sender key distribution message')
			}

			const senderName = jidToSignalSenderKeyName(item.groupId, authorJid)

			const senderMsg = new SenderKeyDistributionMessage(
				null,
				null,
				null,
				null,
				item.axolotlSenderKeyDistributionMessage
			)
			const senderNameStr = senderName.toString()
			const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
			if (!senderKey) {
				await storage.storeSenderKey(senderName, new SenderKeyRecord())
			}

			return parsedKeys.transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				await builder.process(senderName, senderMsg)
			}, item.groupId)
		},
		async decryptMessage({ jid, type, ciphertext }) {
			const addr = jidToSignalProtocolAddress(jid)
			const session = new libsignal.SessionCipher(storage, addr)

			// Extract and save sender's identity key before decryption for identity change detection
			if (type === 'pkmsg') {
				const identityKey = extractIdentityFromPkmsg(ciphertext)
				if (identityKey) {
					const addrStr = addr.toString()
					const identityChanged = await storage.saveIdentity(addrStr, identityKey)
					if (identityChanged) {
						if (logger)
							logger.info({ jid, addr: addrStr }, 'identity key changed or new contact, session will be re-established')
					}
				}
			}

			async function doDecrypt() {
				let result: Buffer
				switch (type) {
					case 'pkmsg':
						result = await session.decryptPreKeyWhisperMessage(ciphertext)
						break
					case 'msg':
						result = await session.decryptWhisperMessage(ciphertext)
						break
				}

				return result
			}

			// If it's not a sync message, we need to ensure atomicity
			// For regular messages, we use a transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				return await doDecrypt()
			}, jid)
		},

		async encryptMessage({ jid, data }) {
			const addr = jidToSignalProtocolAddress(jid)
			const cipher = new libsignal.SessionCipher(storage, addr)

			// Use transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				const { type: sigType, body } = await cipher.encrypt(data)
				const type = sigType === 3 ? 'pkmsg' : 'msg'
				return { type, ciphertext: Buffer.from(body, 'binary') }
			}, jid)
		},

		async encryptGroupMessage({ group, meId, data }) {
			return parsedKeys.transaction(async () => {
				const { senderName, skdm } = await ensureSenderKeyAndCreateSkdm(group, meId)
				const ciphertext = await new GroupCipher(storage, senderName).encrypt(data)
				return { ciphertext, senderKeyDistributionMessage: skdm.serialize() }
			}, group)
		},

		async getSenderKeyDistributionMessage({ group, meId }) {
			return parsedKeys.transaction(async () => {
				const { skdm } = await ensureSenderKeyAndCreateSkdm(group, meId)
				return skdm.serialize()
			}, group)
		},

		async hasSenderKey({ group, meId }) {
			const senderName = jidToSignalSenderKeyName(group, meId).toString()
			const { [senderName]: key } = await auth.keys.get('sender-key', [senderName])
			return !!key
		},

		async getSessionInfo(jid) {
			const addr = jidToSignalProtocolAddress(jid).toString()
			const session = (await storage.loadSession(addr)) as {
				getOpenSession?: () => { indexInfo?: { baseKey?: Buffer }; registrationId?: number } | undefined
			} | null
			if (!session) {
				return null
			}

			const open = session.getOpenSession?.()
			const baseKey = open?.indexInfo?.baseKey
			const registrationId = open?.registrationId
			if (!baseKey || typeof registrationId !== 'number') {
				return null
			}

			return { baseKey: new Uint8Array(baseKey), registrationId }
		},

		async injectE2ESession({ jid, session }) {
			if (logger) logger.trace({ jid }, 'injecting E2EE session')
			const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid))
			return parsedKeys.transaction(async () => {
				// libsignal runtime accepts an absent prekey (initOutgoing checks `device.preKey && ...`)
				// but the bundled .d.ts marks it required.
				await cipher.initOutgoing(session as unknown as Parameters<typeof cipher.initOutgoing>[0])
			}, jid)
		},
		jidToSignalProtocolAddress(jid) {
			return jidToSignalProtocolAddress(jid).toString()
		},

		// Optimized direct access to LID mapping store
		lidMapping,

		async validateSession(jid: string) {
			try {
				const addr = jidToSignalProtocolAddress(jid)
				const session = await storage.loadSession(addr.toString())

				if (!session) {
					return { exists: false, reason: 'no session' }
				}

				if (!session.haveOpenSession()) {
					return { exists: false, reason: 'no open session' }
				}

				return { exists: true }
			} catch (error) {
				return { exists: false, reason: 'validation error' }
			}
		},

		async deleteSession(jids: string[]) {
			if (!jids.length) return

			// Convert JIDs to signal addresses and prepare for bulk deletion
			const sessionUpdates: { [key: string]: null } = {}
			jids.forEach(jid => {
				const addr = jidToSignalProtocolAddress(jid)
				sessionUpdates[addr.toString()] = null
			})

			// Single transaction for all deletions
			return parsedKeys.transaction(async () => {
				await auth.keys.set({ session: sessionUpdates })
			}, `delete-${jids.length}-sessions`)
		},

		close() {
			migratedSessionCache.clear()
			migrationAttemptCache.clear()
			lidMapping.close()
		},

		async migrateSession(
			fromJid: string,
			toJid: string
		): Promise<{ migrated: number; skipped: number; total: number }> {
			if (!fromJid || (!isLidUser(toJid) && !isHostedLidUser(toJid))) return { migrated: 0, skipped: 0, total: 0 }

			// Only support PN to LID migration
			if (!isPnUser(fromJid) && !isHostedPnUser(fromJid)) {
				return { migrated: 0, skipped: 0, total: 1 }
			}

			return migrationMutex.mutex(async () => {
				const { user, device: fromDevice } = jidDecode(fromJid)!
				const lidUser = jidDecode(toJid)!.user
				const migrationKey = `${user}.${lidUser}`
				const cachedResult = migrationAttemptCache.get(migrationKey)
				if (cachedResult) {
					return cachedResult
				}

				const syncedDevices = getUSyncDevices ? await getUSyncDevices(fromJid) : [fromJid]
				logger?.debug({ fromJid, toJid, user, fromDevice, syncedDevices }, 'starting session migration from PN to LID')
				const userDevices = new Set<string>([fromDevice?.toString() || '0'])
				for (const jid of syncedDevices) {
					const decoded = jidDecode(jid)
					if (decoded?.user === user && (isPnUser(jid) || isHostedPnUser(jid))) {
						userDevices.add(decoded.device?.toString() || '0')
					}
				}

				const uncachedDevices = [...userDevices].filter(device => {
					const deviceKey = `${user}.${device}`
					return !migratedSessionCache.has(deviceKey)
				})
				const deviceJids = uncachedDevices.map(device => {
					if (device === '99') return `${user}:99@hosted`
					return device === '0' ? `${user}@s.whatsapp.net` : `${user}:${device}@s.whatsapp.net`
				})

				if (logger)
					logger.debug(
						{
							fromJid,
							totalDevices: userDevices.size
						},
						'loaded devices for session migration from USync'
					)
				if (deviceJids.length === 0) {
					const result = { migrated: 0, skipped: 0, total: 0 }
					migrationAttemptCache.set(migrationKey, result)
					return result
				}

				const BATCH_SIZE = 10
				const totalOps = deviceJids.length
				let totalMigrated = 0

				for (let i = 0; i < deviceJids.length; i += BATCH_SIZE) {
					const batchJids = deviceJids.slice(i, i + BATCH_SIZE)

					const result = await parsedKeys.transaction(
						async (): Promise<{ migrated: number; skipped: number; total: number }> => {
							const migrationOps = batchJids.map(jid => {
								const lidWithDevice = transferDevice(jid, toJid)
								const fromDecoded = jidDecode(jid)!
								const toDecoded = jidDecode(lidWithDevice)!
								return {
									fromJid: jid,
									toJid: lidWithDevice,
									pnUser: fromDecoded.user,
									lidUser: toDecoded.user,
									deviceId: fromDecoded.device || 0,
									fromAddr: jidToSignalProtocolAddress(jid),
									toAddr: jidToSignalProtocolAddress(lidWithDevice)
								}
							})

							const pnAddrStrings = Array.from(new Set(migrationOps.map(op => op.fromAddr.toString())))
							const pnSessionsBatch = await parsedKeys.get('session', pnAddrStrings)
							logger?.debug({ batchJids, pnSessionsBatch }, 'loaded PN sessions for migration batch')
							const sessionUpdatesBatch: { [key: string]: Uint8Array | null } = {}
							const migratedInBatch: string[] = []

							for (const op of migrationOps) {
								const pnAddrStr = op.fromAddr.toString()
								const lidAddrStr = op.toAddr.toString()
								const pnSession = pnSessionsBatch[pnAddrStr]
								if (pnSession) {
									const fromSession = libsignal.SessionRecord.deserialize(pnSession)
									if (fromSession.haveOpenSession()) {
										logger?.debug({ fromJid: op.fromJid, toJid: op.toJid }, 'migrating session from PN to LID')
										sessionUpdatesBatch[lidAddrStr] = fromSession.serialize()
										sessionUpdatesBatch[pnAddrStr] = null
										migratedInBatch.push(`${op.pnUser}.${op.deviceId}`)
									}
								}
							}

							if (Object.keys(sessionUpdatesBatch).length > 0) {
								await parsedKeys.set({ session: sessionUpdatesBatch })
								for (const deviceKey of migratedInBatch) {
									logger?.debug({ deviceKey }, 'migrated session from PN to LID')
									migratedSessionCache.set(deviceKey, true)
								}
							}

							return {
								migrated: migratedInBatch.length,
								skipped: batchJids.length - migratedInBatch.length,
								total: batchJids.length
							}
						},
						`migrate-batch-${i / BATCH_SIZE}-${jidDecode(toJid)?.user}`
					)

					totalMigrated += result.migrated
				}

				const result = { migrated: totalMigrated, skipped: totalOps - totalMigrated, total: totalOps }
				migrationAttemptCache.set(migrationKey, result)
				if (logger) {
					logger.debug({ migratedSessions: totalMigrated }, 'bulk session migration complete')
				}
				return result
			})
		}
	}

	return repository
}

const jidToSignalProtocolAddress = (jid: string): libsignal.ProtocolAddress => {
	const decoded = jidDecode(jid)!
	const { user, device, server, domainType } = decoded

	if (!user) {
		throw new Error(
			`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`
		)
	}

	const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
	const finalDevice = device || 0

	if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
		throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid)
	}

	return new libsignal.ProtocolAddress(signalUser, finalDevice)
}

const jidToSignalSenderKeyName = (group: string, user: string): SenderKeyName => {
	return new SenderKeyName(group, jidToSignalProtocolAddress(user))
}

function signalStorage(
	{ creds, keys }: SignalAuthState,
	lidMapping: LIDMappingStore
): SenderKeyStore &
	libsignal.SignalStorage & {
		loadIdentityKey(id: string): Promise<Uint8Array | undefined>
		saveIdentity(id: string, identityKey: Uint8Array): Promise<boolean>
	} {
	// Shared function to resolve PN signal address to LID if mapping exists
	const resolveLIDSignalAddress = async (id: string): Promise<string> => {
		if (id.includes('.')) {
			const [deviceId, device] = id.split('.')
			const [user, domainType_] = deviceId!.split('_')
			const domainType = parseInt(domainType_ || '0')

			if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id

			const pnJid = `${user!}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`

			const lidForPN = await lidMapping.getLIDForPN(pnJid)
			if (lidForPN) {
				const lidAddr = jidToSignalProtocolAddress(lidForPN)
				return lidAddr.toString()
			}
		}

		return id
	}

	return {
		loadSession: async (id: string) => {
			try {
				const wireJid = await resolveLIDSignalAddress(id)
				const { [wireJid]: sess } = await keys.get('session', [wireJid])

				if (sess) {
					return libsignal.SessionRecord.deserialize(sess)
				}
			} catch (e) {
				return null
			}

			return null
		},
		storeSession: async (id: string, session: libsignal.SessionRecord) => {
			const wireJid = await resolveLIDSignalAddress(id)
			await keys.set({ session: { [wireJid]: session.serialize() } })
		},
		isTrustedIdentity: () => {
			return true // TOFU - Trust on First Use (same as WhatsApp Web)
		},
		loadIdentityKey: async (id: string) => {
			const wireJid = await resolveLIDSignalAddress(id)
			const { [wireJid]: key } = await keys.get('identity-key', [wireJid])
			return key || undefined
		},
		saveIdentity: async (id: string, identityKey: Uint8Array): Promise<boolean> => {
			const wireJid = await resolveLIDSignalAddress(id)
			const { [wireJid]: existingKey } = await keys.get('identity-key', [wireJid])

			const keysMatch =
				existingKey?.length === identityKey.length && existingKey.every((byte, i) => byte === identityKey[i])

			if (existingKey && !keysMatch) {
				// Identity changed - clear session and update key
				await keys.set({
					session: { [wireJid]: null },
					'identity-key': { [wireJid]: identityKey }
				})
				return true
			}

			if (!existingKey) {
				// New contact - Trust on First Use (TOFU)
				await keys.set({ 'identity-key': { [wireJid]: identityKey } })
				return true
			}

			return false
		},
		loadPreKey: async (id: number | string) => {
			const keyId = id.toString()
			const { [keyId]: key } = await keys.get('pre-key', [keyId])
			if (key) {
				return {
					privKey: Buffer.from(key.private),
					pubKey: Buffer.from(key.public)
				}
			}
		},
		removePreKey: (id: number) => keys.set({ 'pre-key': { [id]: null } }),
		loadSignedPreKey: () => {
			const key = creds.signedPreKey
			return {
				privKey: Buffer.from(key.keyPair.private),
				pubKey: Buffer.from(key.keyPair.public)
			}
		},
		loadSenderKey: async (senderKeyName: SenderKeyName) => {
			const keyId = senderKeyName.toString()
			const { [keyId]: key } = await keys.get('sender-key', [keyId])
			if (key) {
				return SenderKeyRecord.deserialize(key)
			}

			return new SenderKeyRecord()
		},
		storeSenderKey: async (senderKeyName: SenderKeyName, key: SenderKeyRecord) => {
			const keyId = senderKeyName.toString()
			await keys.set({ 'sender-key': { [keyId]: key.serialize() } })
		},
		getOurRegistrationId: () => creds.registrationId,
		getOurIdentity: () => {
			const { signedIdentityKey } = creds
			return {
				privKey: Buffer.from(signedIdentityKey.private),
				pubKey: Buffer.from(generateSignalPubKey(signedIdentityKey.public))
			}
		}
	}
}
