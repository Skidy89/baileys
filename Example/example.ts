import { Boom } from '@hapi/boom'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, getHistoryMsg, GroupMetadata, isJidBot, isJidBroadcast, isJidMetaAI, isJidNewsletter, jidDecode, makeCacheableSignalKeyStore, normalizeMessageContent, PatchedMessageWithRecipientJID, proto, useMultiFileAuthState, WAMessageContent, migrateAuthState, useSqliteAuthState } from '../src'
import P from 'pino'

import qrcode from 'qrcode-terminal'
const logger = P({
  level: "debug",
  
})


const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts

const groups = new Map<string, GroupMetadata>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// start a connection
const startSock = async() => {
	const d1 = await useMultiFileAuthState('baileys_auth_info')
	
	const d2 = await useSqliteAuthState({ dbPath: 'baileys_auth_info2.sqlite' })
	const d = await migrateAuthState({
		from: d1.state,
		to: d2.state,
		skipExisting: true,
		verify: true,
		logger
	})
	console.log('migrateAuthState result: ', d)
	
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger: logger,
		auth: {creds: d2.state.creds, keys: d2.state.keys},
		enableRecentMessageCache: false,
        waWebSocketUrl: "wss://web.whatsapp.com/ws/chat?ED=CAgIAg==",
		shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidMetaAI(jid) || isJidNewsletter(jid),
		cachedGroupMetadata: async (jid) => {
			if (groups.has(jid)) {
				return groups.get(jid)
			} else {
				const metadata = await sock.groupMetadata(jid).catch(() => null)
				if (metadata) {
					groups.set(jid, metadata)
				}
				return metadata!
			}
		}
	})




	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		// todo move to QR event
		const phoneNumber = await question('Please enter your phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update
				if (qr) {
					qrcode.generate(qr, { small: true })
				}
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
					}
				}
				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await d2.saveCreds()
			}

			if(events['labels.association']) {
				console.log(events['labels.association'])
			}


			if(events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					console.log('received on-demand history sync, messages=', messages)
				}
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
			}

			// received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

        if (!!upsert.requestId) {
          console.log("placeholder message received for request of id=" + upsert.requestId, upsert)
        }



        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
                console.log('requested placeholder resync, id=', messageId)
              }
			  console.log(msg)
              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
                console.log('requested on-demand sync, id=', messageId)
              }
			  if (text == "test") {
				console.time("test")
				const p = Date.now()
				const result = await sock.sendMessage(msg.key.remoteJid!, { text: 'Hello there!' })
				console.timeEnd("test")
				const end = Date.now()
				const toMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2)
				await sock.sendMessage(msg.key.remoteJid!, { text: `Response time: ${end - p}ms
					memory Usage:
					rss: ${toMB(process.memoryUsage().rss)} MB
					heapTotal: ${toMB(process.memoryUsage().heapTotal)} MB
					heapUsed: ${toMB(process.memoryUsage().heapUsed)} MB`, edit: result?.key })
			  }

              if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {

                console.log('replying to', msg.key.remoteJid)
                await sock!.readMessages([msg.key])
                await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
              }
            }
          }
        }
      }

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				console.log(
					JSON.stringify(events['messages.update'], undefined, 2)
				)

				for(const { key, update } of events['messages.update']) {
					if(update.pollUpdates) {
						const pollCreation: proto.IMessage = {} // get the poll creation message somehow
						if(pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

		}
	)

	return sock
}

startSock()

