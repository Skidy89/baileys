
import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults'
import { AnyMessageContent, MediaConnInfo, MessageReceiptType, MessageRelayOptions, MiscMessageGenerationOptions, SocketConfig, WAMessageKey } from '../Types'
import { aggregateMessageKeysNotFromMe, encodeNewsletterMessage, encodeSignedDeviceIdentity, encodeWAMessage, extractDeviceJids, generateMessageIDV2, generateWAMessage, getWAUploadToServer, normalizeMessageContent, parseAndInjectE2ESessions, unixTimestampSeconds } from '../Utils'
import { getUrlInfo } from '../Utils/link-preview'
import { areJidsSameUser, BinaryNode, BinaryNodeAttributes, getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isJidUser, jidDecode, jidEncode, jidNormalizedUser, JidWithDevice, S_WHATSAPP_NET } from '../WABinary'
import { makeGroupsSocket } from './groups'

const getTypeMessage = (msg: proto.IMessage) => {
	if(msg.viewOnceMessage) {
		return getTypeMessage(msg.viewOnceMessage.message!)
	} else if(msg.viewOnceMessageV2) {
		return getTypeMessage(msg.viewOnceMessageV2.message!)
	} else if(msg.viewOnceMessageV2Extension) {
		return getTypeMessage(msg.viewOnceMessageV2Extension.message!)
	} else if(msg.ephemeralMessage) {
		return getTypeMessage(msg.ephemeralMessage.message!)
	} else if(msg.documentWithCaptionMessage) {
		return getTypeMessage(msg.documentWithCaptionMessage.message!)
	} else if(msg.reactionMessage) {
		return 'reaction'
	} else if(msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3 || msg.pollUpdateMessage) {
		return 'reaction'
	} else if(getMediaType(msg)) {
		return 'media'
	} else {
		return 'text'
	}
}

const getMediaType = (message: proto.IMessage) => {
	if(message.imageMessage) {
		return 'image'
	} else if(message.videoMessage) {
		return message.videoMessage.gifPlayback ? 'gif' : 'video'
	} else if(message.audioMessage) {
		return message.audioMessage.ptt ? 'ptt' : 'audio'
	} else if(message.contactMessage) {
		return 'vcard'
	} else if(message.documentMessage) {
		return 'document'
	} else if(message.contactsArrayMessage) {
		return 'contact_array'
	} else if(message.liveLocationMessage) {
		return 'livelocation'
	} else if(message.stickerMessage) {
		return 'sticker'
	} else if(message.orderMessage) {
		return 'order'
	} else if(message.productMessage) {
		return 'product'
	} else if(message.interactiveResponseMessage) {
		return 'native_flow_response'
	} else if(message.groupInviteMessage) {
		return 'url'
	}
}

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: axiosOptions,
		patchMessageBeforeSending,
		cachedGroupMetadata,
	} = config
	const sock = makeGroupsSocket(config)
	const {
		ev,
		authState,
		processingMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		generateMessageTag,
		sendNode,
		groupMetadata,
		groupToggleEphemeral,
	} = sock

	const userDevicesCache = config.userDevicesCache || new NodeCache({
		stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
		useClones: false
	})

	let mediaConn: Promise<MediaConnInfo>
	const refreshMediaConn = async(forceGet = false) => {
		const media = await mediaConn
		if(!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
			mediaConn = (async() => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET,
					},
					content: [ { tag: 'media_conn', attrs: { } } ]
				})
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn')
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(
						({ attrs }) => ({
							hostname: attrs.hostname,
							maxContentLengthBytes: +attrs.maxContentLengthBytes,
						})
					),
					auth: mediaConnNode!.attrs.auth,
					ttl: +mediaConnNode!.attrs.ttl,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				return node
			})()
		}

		return mediaConn
	}

	/**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
	const sendReceipt = async(jid: string, participant: string | undefined, messageIds: string[], type: MessageReceiptType) => {
		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0],
			},
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if(isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString()
		}

		if(type === 'sender' && isJidUser(jid)) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if(participant) {
				node.attrs.participant = participant
			}
		}

		if(type) {
			node.attrs.type = type
		}

		const remainingMessageIds = messageIds.slice(1)
		if(remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: { },
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async(keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys)
		await Promise.all(recps.map(({ jid, participant, messageIds }) => sendReceipt(jid, participant, messageIds, type)))
	}

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async(keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings()
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
 	}

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async(jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => {
		const deviceResults: JidWithDevice[] = []

		if(!useCache) {
			logger.debug('not using cache for devices')
		}

		const users: BinaryNode[] = []
		jids = Array.from(new Set(jids))
		for(let jid of jids) {
			const user = jidDecode(jid)?.user
			jid = jidNormalizedUser(jid)

			const devices = await userDevicesCache.get<JidWithDevice[]>(user!)
			if(devices && useCache) {
				deviceResults.push(...devices)

				logger.trace({ user }, 'using cache for devices')
			} else {
				users.push({ tag: 'user', attrs: { jid } })
			}
		}

		if(!users.length) {
			return deviceResults
		}

		const iq: BinaryNode = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'usync',
			},
			content: [
				{
					tag: 'usync',
					attrs: {
						sid: generateMessageTag(),
						mode: 'query',
						last: 'true',
						index: '0',
						context: 'message',
					},
					content: [
						{
							tag: 'query',
							attrs: { },
							content: [
								{
									tag: 'devices',
									attrs: { version: '2' }
								}
							]
						},
						{ tag: 'list', attrs: { }, content: users }
					]
				},
			],
		}
		const result = await query(iq)
		const extracted = extractDeviceJids(result, authState.creds.me!.id, ignoreZeroDevices)
		const deviceMap: { [_: string]: JidWithDevice[] } = {}

		for(const item of extracted) {
			deviceMap[item.user] = deviceMap[item.user] || []
			deviceMap[item.user].push(item)

			deviceResults.push(item)
		}

		for(const key in deviceMap) {
			userDevicesCache.set(key, deviceMap[key])
		}

		return deviceResults
	}

	const assertSessions = async(jids: string[], force: boolean) => {
		let jidsRequiringFetch: string[] = force ? jids : []
    	if(!force) {
        	const addrs = jids.map(jid => signalRepository.jidToSignalProtocolAddress(jid))
        	const sessions = await authState.keys.get('session', addrs)
        	jidsRequiringFetch = jids.filter(jid => !sessions[signalRepository.jidToSignalProtocolAddress(jid)])
    	}

    	if(jidsRequiringFetch.length) {
        	logger.debug({ jidsRequiringFetch }, 'fetching sessions')
        	const result = await query({
            	tag: 'iq',
            	attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET },
            	content: [{ tag: 'key', attrs: {}, content: jidsRequiringFetch.map(jid => ({ tag: 'user', attrs: { jid } })) }]
        	})
			await parseAndInjectE2ESessions(result, signalRepository)
			return true
   		}

    	return false
	}

	const sendPeerDataOperationMessage = async(
		pdoMessage: proto.Message.IPeerDataOperationRequestMessage
	): Promise<string> => {
		//TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
		if(!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const protocolMessage: proto.IMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}

		const meJid = jidNormalizedUser(authState.creds.me.id)

		const msgId = await relayMessage(meJid, protocolMessage, {
			additionalAttributes: {
				category: 'peer',
				// eslint-disable-next-line camelcase
				push_priority: 'high_force',
			},
		})

		return msgId
	}

	const createParticipantNodes = async(
		jids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs']
	) => {
		const patched = await patchMessageBeforeSending(message, jids)
		const bytes = encodeWAMessage(patched)

		let shouldIncludeDeviceIdentity = false
		const nodes = await Promise.all(
			jids.map(
				async jid => {
					const { type, ciphertext } = await signalRepository
						.encryptMessage({ jid, data: bytes })
					if(type === 'pkmsg') {
						shouldIncludeDeviceIdentity = true
					}

					const node: BinaryNode = {
						tag: 'to',
						attrs: { jid },
						content: [{
							tag: 'enc',
							attrs: {
								v: '2',
								type,
								...extraAttrs || {}
							},
							content: ciphertext
						}]
					}
					return node
				}
			)
		)
		return { nodes, shouldIncludeDeviceIdentity }
	}


	const relayMessage = async(
		jid: string,
		message: proto.IMessage,
		{ messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList }: MessageRelayOptions
	) => {
		const meId = authState.creds.me!.id
		const { user, server } = jidDecode(jid)!
		const statusJid = 'status@broadcast'
		const isNewsletter = server === 'newsletter'
		const isGroup = server === 'g.us'
		const isStatus = jid === statusJid
		const isLid = server === 'lid'
		let shouldIncludeDeviceIdentity = false

		msgId = msgId || generateMessageIDV2(sock.user?.id)
		useUserDevicesCache = useUserDevicesCache !== false
		useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

		const participants: BinaryNode[] = []
		const destinationJid = (!isStatus) ? jidEncode(user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net') : statusJid
		const binaryNodeContent: BinaryNode[] = []
		const devices: JidWithDevice[] = []

		const meMsg: proto.IMessage = {
			deviceSentMessage: {
				destinationJid,
				message
			}
		}

		const extraAttrs = {}

		if(participant) {
			const { user, device } = jidDecode(participant.jid)!
			devices.push({ user, device })
		}

		await authState.keys.transaction(async() => {
			const mediaType = getMediaType(message)
			if(mediaType) {
				extraAttrs['mediatype'] = mediaType
			}

			if(normalizeMessageContent(message)?.pinInChatMessage) {
				extraAttrs['decrypt-fail'] = 'hide'
			}

			if(isGroup || isStatus) {
				const [groupData, senderKeyMap] = await Promise.all([
					(async() => {
						let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
						if(!groupData || !Array.isArray(groupData?.participants)) {
							groupData = await groupMetadata(jid)
						}

						return groupData
					})(),
					(async() => {
						if(!participant && !isStatus) {
							const result = await authState.keys.get('sender-key-memory', [jid])
							return result[jid] || {}
						}

						return {}
					})()
				])

				if(!participant) {
					const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : []
					if(isStatus && statusJidList) {
						participantsList.push(...statusJidList)
					}

					const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
					devices.push(...additionalDevices)
				}

				const patched = await patchMessageBeforeSending(message, devices.map(d => jidEncode(d.user, isLid ? 'lid' : 's.whatsapp.net', d.device)))
				const bytes = encodeWAMessage(patched)

				const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
					group: destinationJid,
					data: bytes,
					meId,
				})

				const senderKeyJids: string[] = []
				for(const { user, device } of devices) {
					const jid = jidEncode(user, isLid ? 'lid' : 's.whatsapp.net', device)
					if(!senderKeyMap[jid] || !!participant) {
						senderKeyJids.push(jid)
						senderKeyMap[jid] = true
					}
				}

				if(senderKeyJids.length) {
					const senderKeyMsg: proto.IMessage = {
						senderKeyDistributionMessage: {
							axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
							groupId: destinationJid
						}
					}

					await assertSessions(senderKeyJids, false)

					const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs)
					shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity

					participants.push(...result.nodes)
				}

				binaryNodeContent.push({
					tag: 'enc',
					attrs: { v: '2', type: 'skmsg' },
					content: ciphertext
				})

				await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
			} else if(isNewsletter) {
				if(message.protocolMessage?.editedMessage) {
					msgId = message.protocolMessage.key?.id!
					message = message.protocolMessage.editedMessage
				}

				if(message.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
					msgId = message.protocolMessage.key?.id!
					message = {}
				}

				const patched = await patchMessageBeforeSending(message, [])
				const bytes = encodeNewsletterMessage(patched)

				binaryNodeContent.push({
					tag: 'plaintext',
					attrs: mediaType ? { mediatype: mediaType } : {},
					content: bytes
				})
			} else {
				const { user: meUser } = jidDecode(meId)!

				if(!participant) {
					devices.push({ user })
					if(user !== meUser) {
						devices.push({ user: meUser })
					}

					if(additionalAttributes?.['category'] !== 'peer') {
						const additionalDevices = await getUSyncDevices([meId, jid], !!useUserDevicesCache, true)
						devices.push(...additionalDevices)
					}
				}

				const allJids: string[] = []
				const meJids: string[] = []
				const otherJids: string[] = []
				for(const { user, device } of devices) {
					const isMe = user === meUser
					const jid = jidEncode(isMe && isLid ? authState.creds?.me?.lid!.split(':')[0] || user : user, isLid ? 'lid' : 's.whatsapp.net', device)
					if(isMe) {
						meJids.push(jid)
					} else {
						otherJids.push(jid)
					}

					allJids.push(jid)
				}

				await assertSessions(allJids, false)

				const [
					{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
					{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }
				] = await Promise.all([
					createParticipantNodes(meJids, meMsg, extraAttrs),
					createParticipantNodes(otherJids, message, extraAttrs)
				])
				participants.push(...meNodes)
				participants.push(...otherNodes)

				shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
			}

			if(participants.length) {
				if(additionalAttributes?.['category'] === 'peer') {
					const peerNode = participants[0]?.content?.[0] as BinaryNode
					if(peerNode) {
						binaryNodeContent.push(peerNode)
					}
				} else {
					binaryNodeContent.push({
						tag: 'participants',
						attrs: {},
						content: participants
					})
				}
			}

			const stanza: BinaryNode = {
				tag: 'message',
				attrs: {
					id: msgId!,
					type: isNewsletter ? getTypeMessage(message) : 'text',
					...(additionalAttributes || {})
				},
				content: binaryNodeContent
			}

			if(participant) {
				if(isJidGroup(destinationJid)) {
					stanza.attrs.to = destinationJid
					stanza.attrs.participant = participant.jid
				} else if(areJidsSameUser(participant.jid, meId)) {
					stanza.attrs.to = participant.jid
					stanza.attrs.recipient = destinationJid
				} else {
					stanza.attrs.to = participant.jid
				}
			} else {
				stanza.attrs.to = destinationJid
			}

			if(shouldIncludeDeviceIdentity) {
				(stanza.content as BinaryNode[]).push({
					tag: 'device-identity',
					attrs: {},
					content: encodeSignedDeviceIdentity(authState.creds.account!, true)
				})

				logger.debug({ jid }, 'adding device identity')
			}

			if(additionalNodes && additionalNodes.length > 0) {
				(stanza.content as BinaryNode[]).push(...additionalNodes)
			}

			logger.debug({ msgId }, `sending message to ${participants.length} devices`)

			await sendNode(stanza)
		})

		return msgId
	}


	const getPrivacyTokens = async(jids: string[]) => {
		const t = unixTimestampSeconds().toString()
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'privacy'
			},
			content: [
				{
					tag: 'tokens',
					attrs: { },
					content: jids.map(
						jid => ({
							tag: 'token',
							attrs: {
								jid: jidNormalizedUser(jid),
								t,
								type: 'trusted_contact'
							}
						})
					)
				}
			]
		})

		return result
	}

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)


	return {
		...sock,
		getPrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		sendReceipts,
		readMessages,
		refreshMediaConn,
		waUploadToServer,
		fetchPrivacySettings,
		sendPeerDataOperationMessage,
		sendMessage: async(
			jid: string,
			content: AnyMessageContent,
			options: MiscMessageGenerationOptions = { }
		) => {
			const userJid = authState.creds.me!.id
			if(
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content
				const value = typeof disappearingMessagesInChat === 'boolean' ?
					(disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) :
					disappearingMessagesInChat
				await groupToggleEphemeral(jid, value)
			} else {
				const fullMsg = await generateWAMessage(
					jid,
					content,
					{
						logger,
						userJid,
						getUrlInfo: text => getUrlInfo(
							text,
							{
								thumbnailWidth: linkPreviewImageThumbnailWidth,
								fetchOpts: {
									timeout: 3_000,
									...axiosOptions || { }
								},
								logger,
								uploadImage: generateHighQualityLinkPreview
									? waUploadToServer
									: undefined
							},
						),
						//TODO: CACHE
						getProfilePicUrl: sock.profilePictureUrl,
						upload: waUploadToServer,
						mediaCache: config.mediaCache,
						options: config.options,
						messageId: generateMessageIDV2(sock.user?.id),
						useCachedGroupMetadata: options.useCachedGroupMetadata,
						...options,
					}
				)
				const isDeleteMsg = 'delete' in content && !!content.delete
				const isEditMsg = 'edit' in content && !!content.edit
				const isPinMsg = 'pin' in content && !!content.pin
				const additionalAttributes: BinaryNodeAttributes = { }
				// required for delete
				if(isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if(isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				} else if(isEditMsg) {
					additionalAttributes.edit = '1'
				} else if(isPinMsg) {
					additionalAttributes.edit = '2'
				}

				if('cachedGroupMetadata' in options) {
					console.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.')
				}

				await relayMessage(jid, fullMsg.message!, { messageId: fullMsg.key.id!, useCachedGroupMetadata: options.useCachedGroupMetadata, additionalAttributes, statusJidList: options.statusJidList })
				if(config.emitOwnEvents) {
					process.nextTick(() => {
						processingMutex.mutex(() => (
							upsertMessage(fullMsg, 'append')
						))
					})
				}

				return fullMsg
			}
		}
	}
}
