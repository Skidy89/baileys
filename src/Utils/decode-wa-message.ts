import { Boom } from '@hapi/boom'
import { Logger } from 'pino'
import { proto } from '../../WAProto'
import { SignalRepository, WAMessageKey } from '../Types'
import { areJidsSameUser, BinaryNode, binaryNodeToString, getBinaryNodeChild, isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, isJidUser, isLidUser, jidNormalizedUser } from '../WABinary'
import { unpadRandomMax16 } from './generics'
import { decryptBotMessage } from './process-message'

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'

type MessageType = 'chat' | 'peer_broadcast' | 'other_broadcast' | 'group' | 'direct_peer_status' | 'other_status' | 'newsletter'
enum editType {
	"first",
	"inner",
	"last"
}
const saveMessageSecrets = new Map<string, Uint8Array>()
/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(
	stanza: BinaryNode,
	meId: string,
	meLid: string
) {
	let msgType: MessageType
	let chatId: string
	let author: string

	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant: string | undefined = stanza.attrs.participant
	const recipient: string | undefined = stanza.attrs.recipient

	const isMe = (jid: string) => areJidsSameUser(jid, meId)
	const isMeLid = (jid: string) => areJidsSameUser(jid, meLid)

	if(isJidUser(from)) {
		if(recipient) {
			if(!isMe(from)) {
				throw new Boom('receipient present, but msg not from me', { data: stanza })
			}

			chatId = recipient
		} else {
			chatId = from
		}

		msgType = 'chat'
		author = from
	} else if(isLidUser(from)) {
		if(recipient) {
			if(!isMeLid(from)) {
				throw new Boom('receipient present, but msg not from me', { data: stanza })
			}

			chatId = recipient
		} else {
			chatId = from
		}

		msgType = 'chat'
		author = from
	} else if(isJidGroup(from)) {
		if(!participant) {
			throw new Boom('No participant in group message')
		}

		msgType = 'group'
		author = participant
		chatId = from
	} else if(isJidBroadcast(from)) {
		if(!participant) {
			throw new Boom('No participant in group message')
		}

		const isParticipantMe = isMe(participant)
		if(isJidStatusBroadcast(from)) {
			msgType = isParticipantMe ? 'direct_peer_status' : 'other_status'
		} else {
			msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
		}

		chatId = from
		author = participant
	} else if(isJidNewsletter(from)) {
		msgType = 'newsletter'
		chatId = from
		author = from
	} else {
		throw new Boom('Unknown message type', { data: stanza })
	}

	const fromMe = (isLidUser(from) ? isMeLid : isMe)(stanza.attrs.participant || stanza.attrs.from)
	const pushname = stanza?.attrs?.notify

	const key: WAMessageKey = {
		remoteJid: chatId,
		fromMe,
		id: msgId,
		participant
	}

	const fullMessage: proto.IWebMessageInfo = {
		key,
		messageTimestamp: +stanza.attrs.t,
		pushName: pushname,
		broadcast: isJidBroadcast(from)
	}

	if(key.fromMe) {
		fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
	}

	return {
		fullMessage,
		author,
		sender: msgType === 'chat' ? author : chatId,
		msgId
	}
}

export const decryptMessageNode = (
	stanza: BinaryNode,
	meId: string,
	meLid: string,
	repository: SignalRepository,
	logger: Logger
) => {
	const { fullMessage, author, sender, msgId } = decodeMessageNode(stanza, meId, meLid)
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if(Array.isArray(stanza.content)) {
				for(const { tag, attrs, content } of stanza.content) {
					if(tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = proto.VerifiedNameCertificate.decode(content)
						const details = proto.VerifiedNameCertificate.Details.decode(cert.details!)
						fullMessage.verifiedBizName = details.verifiedName
					}
					if (fullMessage?.messageSecret || fullMessage.message?.messageContextInfo?.messageSecret) {
						console.log("Message secret found")
						console.log(fullMessage.key.id)
						saveMessageSecrets.set(fullMessage.key.id!, fullMessage.messageSecret || fullMessage.message?.messageContextInfo?.messageSecret!)
					}

					if(tag !== 'enc' && tag !== 'plaintext') {
						continue
					}

					if(!(content instanceof Uint8Array)) {
						continue
					}

					decryptables += 1

					let msgBuffer: Uint8Array

					try {
						const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
						switch (e2eType) {
						case 'skmsg':
							msgBuffer = await repository.decryptGroupMessage({
								group: sender,
								authorJid: author,
								msg: content
							})
							break
						case 'pkmsg':
						case 'msg':
							const user = isJidUser(sender) ? sender : author
							msgBuffer = await repository.decryptMessage({
								jid: user,
								type: e2eType,
								ciphertext: content
							})
							break
						case 'plaintext':
							msgBuffer = content
							break
						case 'msmsg':
							const node = getBinaryNodeChild(stanza, 'meta')
							const bot = getBinaryNodeChild(stanza, 'bot')
							const from = stanza.attrs.from
							if(!node || !bot) {
								throw new Error('missing meta or bot node')
							}
							let messageId = node.attrs.target_id
							let targetSenderJid
							let targetSenderId
							if (bot.attrs.edit === editType[editType.inner] || bot.attrs.edit === editType[editType.last]) {
								targetSenderId = bot.attrs.edit_target_id
							} else {
								targetSenderId = msgId
							}
							if (node.attrs.target_sender_jid === undefined || node.attrs.target_sender_jid === "" || node.attrs.target_sender_jid === null) {
								// if target_sender_jid is not present, then the message is sent by the ourselves
								targetSenderJid = jidNormalizedUser(meId)
							} else {
								targetSenderJid = node.attrs.target_sender_jid
							}
							console.log("Target Sender JID: " + targetSenderJid)
							console.log("Target Sender ID: " + targetSenderId)
							console.log("Author: " + jidNormalizedUser(from))
							console.log("Message ID: " + messageId)
							console.log("edit: " + bot.attrs.edit)
							const secret = saveMessageSecrets.get(messageId)
							if (!secret) {
								throw new Error('Message secret not found')
							}
							const msg = proto.MessageSecretMessage.decode(content)
							msgBuffer = decryptBotMessage(msg, { targetSenderJid, targetSenderId, messageID: messageId, sender: jidNormalizedUser(from), messageSecret: secret! })
							break

						default:
							throw new Error(`Unknown e2e type: ${e2eType}`)
						}

						let msg: proto.IMessage = proto.Message.decode(e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer)
						msg = msg.deviceSentMessage?.message || msg
						if(msg.senderKeyDistributionMessage) {
						    try {
								await repository.processSenderKeyDistributionMessage({
									authorJid: author,
									item: msg.senderKeyDistributionMessage
								})
							} catch(err) {
								logger.error({ key: fullMessage.key, err }, 'failed to decrypt message')
						        }
						}


						if(fullMessage.message) {
							Object.assign(fullMessage.message, msg)
						} else {
							fullMessage.message = msg
						}
					} catch(err) {
						logger.error(
							{ key: fullMessage.key, err },
							'failed to decrypt message'
						)
						fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = [err.message]
					}
				}
			}

			// if nothing was found to decrypt
			if(!decryptables) {
				fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}
