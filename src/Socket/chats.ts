import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, HISTORY_SYNC_PAUSED_TIMEOUT_MS, PROCESSABLE_HISTORY_TYPES } from '../Defaults'
import type {
	BotListInfo,
	CacheStore,
	ChatModification,
	ChatMutation,
	LTHashState,
	MessageUpsertType,
	PresenceData,
	SocketConfig,
	WAMediaUpload,
	WAMessage,
	WAPatchCreate,
	WAPatchName,
	WAPresence
} from '../Types'
import { ALL_WA_PATCH_NAMES } from '../Types'
import { SyncState } from '../Types/State'
import {
	chatModificationToAppPatch,
	type ChatMutationMap,
	decodePatches,
	decodeSyncdSnapshot,
	encodeSyncdPatch,
	ensureLTHashStateVersion,
	extractSyncdPatches,
	generateProfilePicture,
	getHistoryMsg,
	isAppStateSyncIrrecoverable,
	isMissingKeyError,
	MAX_SYNC_ATTEMPTS,
	newLTHashState,
	processSyncAction
} from '../Utils'
import { makeMutex } from '../Utils/make-mutex'
import processMessage from '../Utils/process-message'
import { buildTcTokenFromJid } from '../Utils/tc-token-utils'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isHostedLidUser,
	isHostedPnUser,
	isLidUser,
	isPnUser,
	jidDecode,
	jidNormalizedUser,
	reduceBinaryNodeToDictionary,
	S_WHATSAPP_NET
} from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { makeSocket } from './socket.js'

export const makeChatsSocket = (config: SocketConfig) => {
	const {
		logger,
		markOnlineOnConnect,
		fireInitQueries,
		appStateMacVerification,
		shouldIgnoreJid,
		shouldSyncHistoryMessage,
		getMessage
	} = config
	const sock = makeSocket(config)
	const {
		ev,
		ws,
		authState,
		generateMessageTag,
		sendNode,
		query,
		signalRepository,
		onUnexpectedError,
		sendUnifiedSession,
		registerSocketEndHandler
	} = sock

	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)

	let privacySettings: { [_: string]: string } | undefined

	/** Server-assigned AB props for protocol behavior. */
	const serverProps = {
		/** AB prop 10518: gate tctoken on 1:1 messages. Default true (safe: avoids 463). */
		privacyTokenOn1to1: true,
		/** AB prop 9666: gate tctoken on profile picture IQs. WA Web default: true. */
		profilePicPrivacyToken: true,
		/** AB prop 14303: issue tctokens to LID instead of PN. WA Web default: false. */
		lidTrustedTokenIssueToLid: false
	}

	let syncState: SyncState = SyncState.Connecting

	/** this mutex ensures that messages are processed in order */
	const messageMutex = makeMutex()

	/** this mutex ensures that receipts are processed in order */
	const receiptMutex = makeMutex()

	/** this mutex ensures that app state patches are processed in order */
	const appStatePatchMutex = makeMutex()

	/** this mutex ensures that notifications are processed in order */
	const notificationMutex = makeMutex()

	// Timeout for AwaitingInitialSync state
	let awaitingSyncTimeout: NodeJS.Timeout | undefined

	// In-memory history sync completion tracking (resets on reconnection)
	const historySyncStatus = {
		initialBootstrapComplete: false,
		recentSyncComplete: false
	}
	let historySyncPausedTimeout: NodeJS.Timeout | undefined

	// Collections blocked on missing app state sync keys (mirrors WA Web's "Blocked" state).
	// When a key arrives via APP_STATE_SYNC_KEY_SHARE, these are re-synced.
	const blockedCollections = new Set<WAPatchName>()

	const placeholderResendCache =
		config.placeholderResendCache ||
		(new NodeCache<number>({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false
		}) as CacheStore)

	/** helper function to fetch the given app state sync key */
	const getAppStateSyncKey = async (keyId: string) => {
		const { [keyId]: key } = await authState.keys.get('app-state-sync-key', [keyId])
		return key
	}

	const fetchPrivacySettings = async (force = false) => {
		if (!privacySettings || force) {
			const { content } = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'privacy',
					to: S_WHATSAPP_NET,
					type: 'get'
				},
				content: [{ tag: 'privacy', attrs: {} }]
			})
			privacySettings = reduceBinaryNodeToDictionary(content?.[0] as BinaryNode, 'category')
		}

		return privacySettings
	}

	const updateDefaultDisappearingMode = async (duration: number) => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'disappearing_mode',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'disappearing_mode',
					attrs: {
						duration: duration.toString()
					}
				}
			]
		})
	}

	const getBotListV2 = async () => {
		const resp = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'bot',
				to: S_WHATSAPP_NET,
				type: 'get'
			},
			content: [
				{
					tag: 'bot',
					attrs: {
						v: '2'
					}
				}
			]
		})

		const botNode = getBinaryNodeChild(resp, 'bot')

		const botList: BotListInfo[] = []
		for (const section of getBinaryNodeChildren(botNode, 'section')) {
			if (section.attrs.type === 'all') {
				for (const bot of getBinaryNodeChildren(section, 'bot')) {
					botList.push({
						jid: bot.attrs.jid!,
						personaId: bot.attrs['persona_id']!
					})
				}
			}
		}

		return botList
	}

	const fetchStatus = async (...jids: string[]) => {
		const usyncQuery = new USyncQuery().withStatusProtocol()

		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
		}

		const result = await sock.executeUSyncQuery(usyncQuery)
		if (result) {
			return result.list
		}
	}

	const fetchDisappearingDuration = async (...jids: string[]) => {
		const usyncQuery = new USyncQuery().withDisappearingModeProtocol()

		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
		}

		const result = await sock.executeUSyncQuery(usyncQuery)
		if (result) {
			return result.list
		}
	}

	/** update the profile picture for yourself or a group */
	const updateProfilePicture = async (
		jid: string,
		content: WAMediaUpload,
		dimensions?: { width: number; height: number }
	) => {
		let targetJid
		if (!jid) {
			throw new Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}

		if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me!.id)) {
			targetJid = jidNormalizedUser(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}

		const { img } = await generateProfilePicture(content, dimensions)
		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			},
			content: [
				{
					tag: 'picture',
					attrs: { type: 'image' },
					content: img
				}
			]
		})
	}

	/** remove the profile picture for yourself or a group */
	const removeProfilePicture = async (jid: string) => {
		let targetJid
		if (!jid) {
			throw new Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}

		if (jidNormalizedUser(jid) !== jidNormalizedUser(authState.creds.me!.id)) {
			targetJid = jidNormalizedUser(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}

		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			}
		})
	}

	/** update the profile status for yourself */
	const updateProfileStatus = async (status: string) => {
		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'status'
			},
			content: [
				{
					tag: 'status',
					attrs: {},
					content: Buffer.from(status, 'utf-8')
				}
			]
		})
	}

	const updateProfileName = async (name: string) => {
		await chatModify({ pushNameSetting: name }, '')
	}

	const fetchBlocklist = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: S_WHATSAPP_NET,
				type: 'get'
			}
		})

		const listNode = getBinaryNodeChild(result, 'list')
		return getBinaryNodeChildren(listNode, 'item').map(n => n.attrs.jid)
	}

	const updateBlockStatus = async (jid: string, action: 'block' | 'unblock') => {
		const normalizedJid = jidNormalizedUser(jid)
		let lid: string
		let pn_jid: string | undefined

		if (isLidUser(normalizedJid) || isHostedLidUser(normalizedJid)) {
			lid = normalizedJid

			if (action === 'block') {
				const pn = await signalRepository.lidMapping.getPNForLID(normalizedJid)
				if (!pn) {
					throw new Boom(`Unable to resolve PN JID for LID: ${jid}`, { statusCode: 400 })
				}

				pn_jid = jidNormalizedUser(pn)
			}
		} else if (isPnUser(normalizedJid) || isHostedPnUser(normalizedJid)) {
			const mapped = await signalRepository.lidMapping.getLIDForPN(normalizedJid)
			if (!mapped) {
				throw new Boom(`Unable to resolve LID for PN JID: ${jid}`, { statusCode: 400 })
			}

			lid = mapped

			if (action === 'block') {
				pn_jid = jidNormalizedUser(normalizedJid)
			}
		} else {
			throw new Boom(`Invalid jid: ${jid}`, { statusCode: 400 })
		}

		const itemAttrs: {
			action: 'block' | 'unblock'
			jid: string
			pn_jid?: string
		} = {
			action,
			jid: lid
		}

		if (action === 'block') {
			if (!pn_jid) {
				throw new Boom(`pn_jid required for block: ${jid}`, { statusCode: 400 })
			}

			itemAttrs.pn_jid = pn_jid
		}

		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'item',
					attrs: itemAttrs
				}
			]
		})
	}

	const cleanDirtyBits = async (type: 'account_sync' | 'groups', fromTimestamp?: number | string) => {
		if (logger) logger.info({ fromTimestamp }, 'clean dirty bits ' + type)
		await sendNode({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'urn:xmpp:whatsapp:dirty',
				id: generateMessageTag()
			},
			content: [
				{
					tag: 'clean',
					attrs: {
						type,
						...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null)
					}
				}
			]
		})
	}

	const newAppStateChunkHandler = (isInitialSync: boolean) => {
		return {
			onMutation(mutation: ChatMutation) {
				processSyncAction(
					mutation,
					ev,
					authState.creds.me!,
					isInitialSync ? { accountSettings: authState.creds.accountSettings } : undefined,
					logger
				)
			}
		}
	}

	const resyncAppState = ev.createBufferedFunction(
		async (collections: readonly WAPatchName[], isInitialSync: boolean) => {
			const appStateSyncKeyCache = new Map<string, proto.Message.IAppStateSyncKeyData | null>()

			const getCachedAppStateSyncKey = async (
				keyId: string
			): Promise<proto.Message.IAppStateSyncKeyData | null | undefined> => {
				if (appStateSyncKeyCache.has(keyId)) {
					return appStateSyncKeyCache.get(keyId) ?? undefined
				}

				const key = await getAppStateSyncKey(keyId)
				appStateSyncKeyCache.set(keyId, key ?? null)
				return key
			}

			// we use this to determine which events to fire
			// otherwise when we resync from scratch -- all notifications will fire
			const initialVersionMap: { [T in WAPatchName]?: number } = {}
			const globalMutationMap: ChatMutationMap = {}

			await authState.keys.transaction(async () => {
				const collectionsToHandle = new Set<string>(collections)
				// in case something goes wrong -- ensure we don't enter a loop that cannot be exited from
				const attemptsMap: { [T in WAPatchName]?: number } = {}
				// collections that failed and need a full snapshot on retry
				// mirrors WA Web's ErrorFatal -> force snapshot behavior
				const forceSnapshotCollections = new Set<WAPatchName>()
				// keep executing till all collections are done
				// sometimes a single patch request will not return all the patches (God knows why)
				// so we fetch till they're all done (this is determined by the "has_more_patches" flag)
				while (collectionsToHandle.size) {
					const states = {} as { [T in WAPatchName]: LTHashState }
					const nodes: BinaryNode[] = []

					for (const name of collectionsToHandle as Set<WAPatchName>) {
						const result = await authState.keys.get('app-state-sync-version', [name])
						let state = result[name]

						if (state) {
							state = ensureLTHashStateVersion(state)
							if (typeof initialVersionMap[name] === 'undefined') {
								initialVersionMap[name] = state.version
							}
						} else {
							state = newLTHashState()
						}

						states[name] = state

						const shouldForceSnapshot = forceSnapshotCollections.has(name)
						if (shouldForceSnapshot) {
							forceSnapshotCollections.delete(name)
						}

						if (logger)
							logger.info(`resyncing ${name} from v${state.version}${shouldForceSnapshot ? ' (forcing snapshot)' : ''}`)

						nodes.push({
							tag: 'collection',
							attrs: {
								name,
								version: state.version.toString(),
								// return snapshot if syncing from scratch or forcing after a failed attempt
								return_snapshot: (shouldForceSnapshot || !state.version).toString()
							}
						})
					}

					const result = await query({
						tag: 'iq',
						attrs: {
							to: S_WHATSAPP_NET,
							xmlns: 'w:sync:app:state',
							type: 'set'
						},
						content: [
							{
								tag: 'sync',
								attrs: {},
								content: nodes
							}
						]
					})

					// extract from binary node
					const decoded = await extractSyncdPatches(result, config?.options)
					for (const key in decoded) {
						const name = key as WAPatchName
						const { patches, hasMorePatches, snapshot } = decoded[name]
						try {
							if (snapshot) {
								const { state: newState, mutationMap } = await decodeSyncdSnapshot(
									name,
									snapshot,
									getCachedAppStateSyncKey,
									initialVersionMap[name],
									appStateMacVerification.snapshot,
									logger
								)
								states[name] = newState
								Object.assign(globalMutationMap, mutationMap)
								if (logger)
									logger.info(`restored state of ${name} from snapshot to v${newState.version} with mutations`)

								await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
							}

							// only process if there are syncd patches
							if (patches.length) {
								const { state: newState, mutationMap } = await decodePatches(
									name,
									patches,
									states[name],
									getCachedAppStateSyncKey,
									config.options,
									initialVersionMap[name],
									logger,
									appStateMacVerification.patch
								)

								await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
								if (logger) logger.info(`synced ${name} to v${newState.version}`)
								initialVersionMap[name] = newState.version

								Object.assign(globalMutationMap, mutationMap)
							}

							if (hasMorePatches) {
								if (logger) logger.info(`${name} has more patches...`)
							} else {
								// collection is done with sync
								collectionsToHandle.delete(name)
							}
						} catch (error: any) {
							attemptsMap[name] = (attemptsMap[name] || 0) + 1

							const logData = {
								name,
								attempt: attemptsMap[name],
								version: states[name].version,
								statusCode: error.output?.statusCode,
								errorType: error.name,
								error: error.stack
							}

							if (isMissingKeyError(error) && attemptsMap[name] >= MAX_SYNC_ATTEMPTS) {
								// WA Web treats missing keys as "Blocked" — park the collection
								// until the key arrives via APP_STATE_SYNC_KEY_SHARE.
								if (logger)
									logger.warn(
										logData,
										`${name} blocked on missing key from v${states[name].version}, parking after ${attemptsMap[name]} attempts`
									)
								blockedCollections.add(name)
								collectionsToHandle.delete(name)
							} else if (isMissingKeyError(error)) {
								// Retry with a snapshot which may use a different key.
								if (logger)
									logger.info(
										logData,
										`${name} blocked on missing key from v${states[name].version}, retrying with snapshot`
									)
								forceSnapshotCollections.add(name)
							} else if (isAppStateSyncIrrecoverable(error, attemptsMap[name])) {
								if (logger) logger.warn(logData, `failed to sync ${name} from v${states[name].version}, giving up`)
								collectionsToHandle.delete(name)
							} else {
								if (logger)
									logger.info(logData, `failed to sync ${name} from v${states[name].version}, forcing snapshot retry`)
								// force a full snapshot on retry to recover from
								// corrupted local state (e.g. LTHash MAC mismatch)
								forceSnapshotCollections.add(name)
							}
						}
					}
				}
			}, authState?.creds?.me?.id || 'resync-app-state')

			const { onMutation } = newAppStateChunkHandler(isInitialSync)
			for (const key in globalMutationMap) {
				onMutation(globalMutationMap[key]!)
			}
		}
	)

	/**
	 * fetch the profile picture of a user/group
	 * type = "preview" for a low res picture
	 * type = "image for the high res picture"
	 */
	const profilePictureUrl = async (jid: string, type: 'preview' | 'image' = 'preview', timeoutMs?: number) => {
		const baseContent: BinaryNode[] = [{ tag: 'picture', attrs: { type, query: 'url' } }]

		// WA Web only includes tctoken for user JIDs (not groups/newsletters)
		// and never for own profile pic (Chat model for self has no tcToken).
		// Including tctoken for own JID causes the server to never respond.
		const normalizedJid = jidNormalizedUser(jid)
		const isUserJid = isPnUser(normalizedJid) || isLidUser(normalizedJid)
		const me = authState.creds.me
		const isSelf =
			me && (normalizedJid === jidNormalizedUser(me.id) || (me.lid && normalizedJid === jidNormalizedUser(me.lid)))
		let content: BinaryNode[] | undefined = baseContent

		if (serverProps.profilePicPrivacyToken && isUserJid && !isSelf) {
			content = await buildTcTokenFromJid({
				authState,
				jid: normalizedJid,
				baseContent,
				getLIDForPN
			})
		}

		jid = jidNormalizedUser(jid)
		const result = await query(
			{
				tag: 'iq',
				attrs: {
					target: jid,
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'w:profile:picture'
				},
				content
			},
			timeoutMs
		)
		const child = getBinaryNodeChild(result, 'picture')
		return child?.attrs?.url
	}

	const createCallLink = async (type: 'audio' | 'video', event?: { startTime: number }, timeoutMs?: number) => {
		const result = await query(
			{
				tag: 'call',
				attrs: {
					id: generateMessageTag(),
					to: '@call'
				},
				content: [
					{
						tag: 'link_create',
						attrs: { media: type },
						content: event ? [{ tag: 'event', attrs: { start_time: String(event.startTime) } }] : undefined
					}
				]
			},
			timeoutMs
		)
		const child = getBinaryNodeChild(result, 'link_create')
		return child?.attrs?.token
	}

	const sendPresenceUpdate = async (type: WAPresence, toJid?: string) => {
		const me = authState.creds.me!
		const isAvailableType = type === 'available'
		if (isAvailableType || type === 'unavailable') {
			if (!me.name) {
				if (logger) logger.warn('no name present, ignoring presence update request...')
				return
			}

			ev.emit('connection.update', { isOnline: isAvailableType })

			if (isAvailableType) {
				void sendUnifiedSession()
			}

			await sendNode({
				tag: 'presence',
				attrs: {
					name: me.name.replace(/@/g, ''),
					type
				}
			})
		} else {
			const { server } = jidDecode(toJid)!
			const isLid = server === 'lid'

			await sendNode({
				tag: 'chatstate',
				attrs: {
					from: isLid ? me.lid! : me.id,
					to: toJid!
				},
				content: [
					{
						tag: type === 'recording' ? 'composing' : type,
						attrs: type === 'recording' ? { media: 'audio' } : {}
					}
				]
			})
		}
	}

	/**
	 * @param toJid the jid to subscribe to
	 * @param tcToken token for subscription, use if present
	 */
	const presenceSubscribe = async (toJid: string) => {
		// Only include tctoken for user JIDs — groups/newsletters don't use tctokens
		const normalizedToJid = jidNormalizedUser(toJid)
		const isUserJid = isPnUser(normalizedToJid) || isLidUser(normalizedToJid)
		const tcTokenContent = isUserJid
			? await buildTcTokenFromJid({ authState, jid: normalizedToJid, getLIDForPN })
			: undefined

		return sendNode({
			tag: 'presence',
			attrs: {
				to: toJid,
				id: generateMessageTag(),
				type: 'subscribe'
			},
			content: tcTokenContent
		})
	}

	const handlePresenceUpdate = ({ tag, attrs, content }: BinaryNode) => {
		let presence: PresenceData | undefined
		const jid = attrs.from
		const participant = attrs.participant || attrs.from

		if (shouldIgnoreJid(jid!) && jid !== S_WHATSAPP_NET) {
			return
		}

		if (tag === 'presence') {
			presence = {
				lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available',
				lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined,
				groupOnlineCount: attrs.count ? +attrs.count : undefined
			}
		} else if (Array.isArray(content)) {
			const [firstChild] = content
			let type = firstChild!.tag as WAPresence
			if (type === 'paused') {
				type = 'available'
			}

			if (firstChild!.attrs?.media === 'audio') {
				type = 'recording'
			}

			presence = { lastKnownPresence: type }
		} else {
			if (logger) logger.error({ tag, attrs, content }, 'recv invalid presence node')
		}

		if (presence) {
			ev.emit('presence.update', { id: jid!, presences: { [participant!]: presence } })
		}
	}

	const appPatch = async (patchCreate: WAPatchCreate) => {
		const name = patchCreate.type
		const myAppStateKeyId = authState.creds.myAppStateKeyId
		if (!myAppStateKeyId) {
			throw new Boom('App state key not present!', { statusCode: 400 })
		}

		let initial: LTHashState
		let encodeResult: { patch: proto.ISyncdPatch; state: LTHashState }

		await appStatePatchMutex.mutex(async () => {
			await authState.keys.transaction(async () => {
				if (logger) logger.debug({ patch: patchCreate }, 'applying app patch')

				await resyncAppState([name], false)

				const { [name]: currentSyncVersion } = await authState.keys.get('app-state-sync-version', [name])
				initial = currentSyncVersion ? ensureLTHashStateVersion(currentSyncVersion) : newLTHashState()

				encodeResult = await encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey)
				const { patch, state } = encodeResult

				const node: BinaryNode = {
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						xmlns: 'w:sync:app:state'
					},
					content: [
						{
							tag: 'sync',
							attrs: {},
							content: [
								{
									tag: 'collection',
									attrs: {
										name,
										version: (state.version - 1).toString(),
										return_snapshot: 'false'
									},
									content: [
										{
											tag: 'patch',
											attrs: {},
											content: proto.SyncdPatch.encode(patch).finish()
										}
									]
								}
							]
						}
					]
				}
				await query(node)

				await authState.keys.set({ 'app-state-sync-version': { [name]: state } })
			}, authState?.creds?.me?.id || 'app-patch')
		})

		if (config.emitOwnEvents) {
			const { onMutation } = newAppStateChunkHandler(false)
			const { mutationMap } = await decodePatches(
				name,
				[{ ...encodeResult!.patch, version: { version: encodeResult!.state.version } }],
				initial!,
				getAppStateSyncKey,
				config.options,
				undefined,
				logger
			)
			for (const key in mutationMap) {
				onMutation(mutationMap[key]!)
			}
		}
	}

	/** fetch AB props */
	const fetchProps = async () => {
		const resultNode = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				xmlns: 'abt',
				type: 'get'
			},
			content: [
				{
					tag: 'props',
					attrs: {
						protocol: '1',
						...(authState?.creds?.lastPropHash ? { hash: authState.creds.lastPropHash } : {})
					}
				}
			]
		})

		const propsNode = getBinaryNodeChild(resultNode, 'props')

		let props: { [_: string]: string } = {}
		if (propsNode) {
			if (propsNode.attrs?.hash) {
				// on some clients, the hash is returning as undefined
				authState.creds.lastPropHash = propsNode?.attrs?.hash
				ev.emit('creds.update', authState.creds)
			}

			props = reduceBinaryNodeToDictionary(propsNode, 'prop')
		}

		// Extract protocol-relevant AB props (only the ones we need)
		const privacyTokenProp = props['10518'] ?? props['privacy_token_sending_on_all_1_on_1_messages']
		if (privacyTokenProp !== undefined) {
			serverProps.privacyTokenOn1to1 = privacyTokenProp === 'true' || privacyTokenProp === '1'
		}

		const profilePicProp = props['9666'] ?? props['profile_scraping_privacy_token_in_photo_iq']
		if (profilePicProp !== undefined) {
			serverProps.profilePicPrivacyToken = profilePicProp === 'true' || profilePicProp === '1'
		}

		const lidIssueProp = props['14303'] ?? props['lid_trusted_token_issue_to_lid']
		if (lidIssueProp !== undefined) {
			serverProps.lidTrustedTokenIssueToLid = lidIssueProp === 'true' || lidIssueProp === '1'
		}

		if (logger) logger.debug({ serverProps }, 'fetched props')

		return props
	}

	/**
	 * modify a chat -- mark unread, read etc.
	 * lastMessages must be sorted in reverse chronologically
	 * requires the last messages till the last message received; required for archive & unread
	 */
	const chatModify = (mod: ChatModification, jid: string) => {
		const patch = chatModificationToAppPatch(mod, jid)
		return appPatch(patch)
	}

	/**
	 * queries need to be fired on connection open
	 * help ensure parity with WA Web
	 * */
	const executeInitQueries = async () => {
		await Promise.all([fetchProps(), fetchBlocklist(), fetchPrivacySettings()])
	}

	const upsertMessage = ev.createBufferedFunction(async (msg: WAMessage, type: MessageUpsertType) => {
		ev.emit('messages.upsert', { messages: [msg], type })

		if (!!msg.pushName) {
			let jid = msg.key.fromMe ? authState.creds.me!.id : msg.key.participant || msg.key.remoteJid
			jid = jidNormalizedUser(jid!)

			if (!msg.key.fromMe) {
				ev.emit('contacts.update', [{ id: jid, notify: msg.pushName, verifiedName: msg.verifiedBizName! }])
			}

			// update our pushname too
			if (msg.key.fromMe && msg.pushName && authState.creds.me?.name !== msg.pushName) {
				ev.emit('creds.update', { me: { ...authState.creds.me!, name: msg.pushName } })
			}
		}

		const historyMsg = getHistoryMsg(msg.message!)
		const shouldProcessHistoryMsg = historyMsg
			? shouldSyncHistoryMessage(historyMsg) &&
				PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType! as proto.HistorySync.HistorySyncType)
			: false

		if (historyMsg && shouldProcessHistoryMsg) {
			const syncType = historyMsg.syncType as proto.HistorySync.HistorySyncType

			// INITIAL_BOOTSTRAP — fire immediately, no progress check (same as WA Web K function)
			if (
				syncType === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP &&
				!historySyncStatus.initialBootstrapComplete
			) {
				historySyncStatus.initialBootstrapComplete = true
				ev.emit('messaging-history.status', {
					syncType,
					status: 'complete',
					explicit: true
				})
			}

			// RECENT with progress === 100 — explicit completion
			if (
				syncType === proto.HistorySync.HistorySyncType.RECENT &&
				historyMsg.progress === 100 &&
				!historySyncStatus.recentSyncComplete
			) {
				historySyncStatus.recentSyncComplete = true
				clearTimeout(historySyncPausedTimeout)
				historySyncPausedTimeout = undefined
				ev.emit('messaging-history.status', {
					syncType,
					status: 'complete',
					explicit: true
				})
			}

			// Reset 120s paused timeout on any RECENT chunk (like WA Web's handleChunkProgress)
			if (syncType === proto.HistorySync.HistorySyncType.RECENT && !historySyncStatus.recentSyncComplete) {
				clearTimeout(historySyncPausedTimeout)
				historySyncPausedTimeout = setTimeout(() => {
					if (!historySyncStatus.recentSyncComplete) {
						historySyncStatus.recentSyncComplete = true
						ev.emit('messaging-history.status', {
							syncType: proto.HistorySync.HistorySyncType.RECENT,
							status: 'paused',
							explicit: false
						})
					}

					historySyncPausedTimeout = undefined
				}, HISTORY_SYNC_PAUSED_TIMEOUT_MS)
			}
		}

		// State machine: decide on sync and flush
		if (historyMsg && syncState === SyncState.AwaitingInitialSync) {
			if (awaitingSyncTimeout) {
				clearTimeout(awaitingSyncTimeout)
				awaitingSyncTimeout = undefined
			}

			if (shouldProcessHistoryMsg) {
				syncState = SyncState.Syncing
				if (logger) logger.info('Transitioned to Syncing state')
				// Let doAppStateSync handle the final flush after it's done
			} else {
				syncState = SyncState.Online
				if (logger) logger.info('History sync skipped, transitioning to Online state and flushing buffer')
				ev.flush()
			}
		}

		const doAppStateSync = async () => {
			if (syncState === SyncState.Syncing) {
				// All collections will be synced, so clear any blocked ones
				blockedCollections.clear()
				if (logger) logger.info('Doing app state sync')
				await resyncAppState(ALL_WA_PATCH_NAMES, true)

				// Sync is complete, go online and flush everything
				syncState = SyncState.Online
				if (logger) logger.info('App state sync complete, transitioning to Online state and flushing buffer')
				ev.flush()

				const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
				ev.emit('creds.update', { accountSyncCounter })
			}
		}

		await Promise.all([
			(async () => {
				if (shouldProcessHistoryMsg) {
					await doAppStateSync()
				}
			})(),
			processMessage(msg, {
				signalRepository,
				shouldProcessHistoryMsg,
				placeholderResendCache,
				ev,
				creds: authState.creds,
				keyStore: authState.keys,
				logger,
				options: config.options,
				getMessage
			})
		])

		// If the app state key arrives and we are waiting to sync, trigger the sync now.
		if (msg.message?.protocolMessage?.appStateSyncKeyShare && syncState === SyncState.Syncing) {
			if (logger) logger.info('App state sync key arrived, triggering app state sync')
			await doAppStateSync()
		}
	})

	ws.on('CB:presence', handlePresenceUpdate)
	ws.on('CB:chatstate', handlePresenceUpdate)

	ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		const type = attrs.type
		switch (type) {
			case 'account_sync':
				if (attrs.timestamp) {
					let { lastAccountSyncTimestamp } = authState.creds
					if (lastAccountSyncTimestamp) {
						await cleanDirtyBits('account_sync', lastAccountSyncTimestamp)
					}

					lastAccountSyncTimestamp = +attrs.timestamp
					ev.emit('creds.update', { lastAccountSyncTimestamp })
				}

				break
			case 'groups':
				// handled in groups.ts
				break
			default:
				if (logger) logger.info({ node }, 'received unknown sync')
				break
		}
	})

	ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
		if (connection === 'close') {
			blockedCollections.clear()
			clearTimeout(historySyncPausedTimeout)
			historySyncPausedTimeout = undefined
		}

		if (connection === 'open') {
			if (fireInitQueries) {
				executeInitQueries().catch(error => onUnexpectedError(error, 'init queries'))
			}

			sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable').catch(error =>
				onUnexpectedError(error, 'presence update requests')
			)
		}

		if (!receivedPendingNotifications || syncState !== SyncState.Connecting) {
			return
		}

		historySyncStatus.initialBootstrapComplete = false
		historySyncStatus.recentSyncComplete = false
		clearTimeout(historySyncPausedTimeout)
		historySyncPausedTimeout = undefined

		syncState = SyncState.AwaitingInitialSync
		if (logger) logger.info('Connection is now AwaitingInitialSync, buffering events')
		ev.buffer()

		const willSyncHistory = shouldSyncHistoryMessage(
			proto.Message.HistorySyncNotification.create({
				syncType: proto.HistorySync.HistorySyncType.RECENT
			})
		)

		if (!willSyncHistory) {
			if (logger)
				logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.')
			syncState = SyncState.Online
			setTimeout(() => ev.flush(), 0)
			return
		}

		// On reconnection (accountSyncCounter > 0), the server does not push
		// history sync notifications — the device already has its data.
		// Skip the 20s wait and go online immediately.
		if (authState.creds.accountSyncCounter > 0) {
			if (logger)
				logger.info('Reconnection with existing sync data, skipping history sync wait. Transitioning to Online.')
			syncState = SyncState.Online
			setTimeout(() => ev.flush(), 0)
			return
		}

		if (logger) logger.info('First connection, awaiting history sync notification with a 20s timeout.')

		if (awaitingSyncTimeout) {
			clearTimeout(awaitingSyncTimeout)
		}

		awaitingSyncTimeout = setTimeout(() => {
			if (syncState === SyncState.AwaitingInitialSync) {
				if (logger) logger.warn('Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer')
				syncState = SyncState.Online
				ev.flush()

				// Increment so subsequent reconnections skip the 20s wait.
				// Late-arriving history is still processed via processMessage
				// regardless of the state machine phase.
				const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
				ev.emit('creds.update', { accountSyncCounter })
			}
		}, 20_000)
	})

	// When an app state sync key arrives (myAppStateKeyId is set) and there are
	// collections blocked on a missing key, trigger a re-sync for just those collections.
	// This mirrors WA Web's Blocked → retry-on-key-arrival behavior.
	ev.on('creds.update', ({ myAppStateKeyId }) => {
		if (!myAppStateKeyId || blockedCollections.size === 0) {
			return
		}

		// If we're in the middle of a full sync, doAppStateSync handles all collections
		if (syncState === SyncState.Syncing) {
			blockedCollections.clear()
			return
		}

		const collections = [...blockedCollections] as WAPatchName[]
		blockedCollections.clear()
		if (logger) logger.info({ collections }, 'app state sync key arrived, re-syncing blocked collections')
		resyncAppState(collections, false).catch(error => onUnexpectedError(error, 'blocked collections resync'))
	})

	ev.on('lid-mapping.update', async ({ lid, pn }) => {
		try {
			await signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn }])
		} catch (error) {
			if (logger) logger.warn({ lid, pn, error }, 'Failed to store LID-PN mapping')
		}
	})

	registerSocketEndHandler(() => {
		if (awaitingSyncTimeout) {
			clearTimeout(awaitingSyncTimeout)
			awaitingSyncTimeout = undefined
		}

		if (!config.placeholderResendCache && placeholderResendCache.close) {
			placeholderResendCache.close()
		}

		syncState = SyncState.Connecting
		privacySettings = undefined
	})

	return {
		...sock,
		serverProps,
		createCallLink,
		getBotListV2,
		messageMutex,
		receiptMutex,
		appStatePatchMutex,
		notificationMutex,
		fetchPrivacySettings,
		upsertMessage,
		appPatch,
		sendPresenceUpdate,
		presenceSubscribe,
		profilePictureUrl,
		fetchBlocklist,
		fetchStatus,
		fetchDisappearingDuration,
		updateProfilePicture,
		removeProfilePicture,
		updateProfileStatus,
		updateProfileName,
		updateBlockStatus,
		updateDefaultDisappearingMode,
		resyncAppState,
		chatModify,
		cleanDirtyBits,
		placeholderResendCache
	}
}
