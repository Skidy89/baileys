import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'

import { KEY_BUNDLE_TYPE } from '../Defaults'
import type { AuthenticationCreds, SignalCreds, SocketConfig } from '../Types'
import { BinaryNode, getBinaryNodeChild, jidDecode, S_WHATSAPP_NET } from '../WABinary'
import { Curve, hmacSign } from './crypto'
import { encodeBigEndian } from './generics'
import { createSignalIdentity } from './signal'
import { WAAdv, WACompanionReg, WAWa6 } from '../../WAProto'

const getUserAgent = (config: SocketConfig): WAWa6.ClientPayload.IUserAgent => {
	const osVersion = config.mobile ? '15.3.1' : '0.1'
	const version = config.mobile ? [2, 24, 6] : config.version
	const device = config.mobile ? 'iPhone_7' : 'Desktop'
	const manufacturer = config.mobile ? 'Apple' : ''
	const platform = config.mobile ? WAWa6.ClientPayload.UserAgent.Platform.IOS : WAWa6.ClientPayload.UserAgent.Platform.WEB
	const phoneId = config.mobile ? { phoneId: config.auth.creds.phoneId } : {}

	return {
		appVersion: {
			primary: version[0],
			secondary: version[1],
			tertiary: version[2],
		},
		platform,
		releaseChannel: WAWa6.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
		mcc:  '000',
		mnc:  '000',
		osVersion: osVersion,
		manufacturer,
		device,
		osBuildNumber: osVersion,
		localeLanguageIso6391: 'en',
		localeCountryIso31661Alpha2: 'US',
		...phoneId
	}
}

const PLATFORM_MAP = {
	'Mac OS': WAWa6.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
	'Windows': WAWa6.ClientPayload.WebInfo.WebSubPlatform.WIN32
}

const getWebInfo = (config: SocketConfig): WAWa6.ClientPayload.IWebInfo => {
	let webSubPlatform = WAWa6.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
	if(config.syncFullHistory && PLATFORM_MAP[config.browser[0]]) {
		webSubPlatform = PLATFORM_MAP[config.browser[0]]
	}

	return { webSubPlatform }
}


const getClientPayload = (config: SocketConfig) => {
	const payload: WAWa6.IClientPayload = {
		connectType: WAWa6.ClientPayload.ConnectType.WIFI_UNKNOWN,
		connectReason: WAWa6.ClientPayload.ConnectReason.USER_ACTIVATED,
		userAgent: getUserAgent(config),
	}

	if(!config.mobile) {
		payload.webInfo = getWebInfo(config)
	}

	return payload
}

export const generateMobileNode = (config: SocketConfig): WAWa6.IClientPayload => {
	if(!config.auth.creds) {
		throw new Boom('No registration data found', { data: config })
	}

	const payload: WAWa6.IClientPayload = {
		...getClientPayload(config),
		sessionId: Math.floor(Math.random() * 999999999 + 1),
		shortConnect: true,
		connectAttemptCount: 0,
		device: 0,
		dnsSource: {
			appCached: false,
			dnsMethod: WAWa6.ClientPayload.DNSSource.DNSResolutionMethod.SYSTEM,
		},
		passive: false, // XMPP heartbeat setting (false: server actively pings) (true: client actively pings)
		pushName: 'test',
	}
	return WAWa6.ClientPayload.fromObject(payload)
}

export const generateLoginNode = (userJid: string, config: SocketConfig): WAWa6.IClientPayload => {
	const { user, device } = jidDecode(userJid)!
	const payload: WAWa6.IClientPayload = {
		...getClientPayload(config),
		passive: true,
		username: +user,
		device: device,
	}
	return WAWa6.ClientPayload.fromObject(payload)
}

const getPlatformType = (platform: string): WACompanionReg.DeviceProps.PlatformType => {
	const platformType = platform.toUpperCase()
	return WACompanionReg.DeviceProps.PlatformType[platformType] || WACompanionReg.DeviceProps.PlatformType.DESKTOP
}

export const generateRegistrationNode = (
	{ registrationId, signedPreKey, signedIdentityKey }: SignalCreds,
	config: SocketConfig
) => {
	// the app version needs to be md5 hashed
	// and passed in
	const appVersionBuf = createHash('md5')
		.update(config.version.join('.')) // join as string
		.digest()

	const companion: WACompanionReg.IDeviceProps = {
		os: config.browser[0],
		platformType: getPlatformType(config.browser[1]),
		requireFullSync: config.syncFullHistory,
	}

	const companionProto = WACompanionReg.DeviceProps.encode(companion).finish()

	const registerPayload: WAWa6.IClientPayload = {
		...getClientPayload(config),
		passive: false,
		devicePairingData: {
			buildHash: appVersionBuf,
			deviceProps: companionProto,
			eRegid: encodeBigEndian(registrationId),
			eKeytype: KEY_BUNDLE_TYPE,
			eIdent: signedIdentityKey.public,
			eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
			eSkeyVal: signedPreKey.keyPair.public,
			eSkeySig: signedPreKey.signature,
		},
	}

	return WAWa6.ClientPayload.fromObject(registerPayload)
}

export const configureSuccessfulPairing = (
	stanza: BinaryNode,
	{ advSecretKey, signedIdentityKey, signalIdentities }: Pick<AuthenticationCreds, 'advSecretKey' | 'signedIdentityKey' | 'signalIdentities'>
) => {
	const msgId = stanza.attrs.id

	const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success')

	const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity')
	const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform')
	const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device')
	const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz')

	if(!deviceIdentityNode || !deviceNode) {
		throw new Boom('Missing device-identity or device in pair success node', { data: stanza })
	}

	const bizName = businessNode?.attrs.name
	const jid = deviceNode.attrs.jid

	const { details, hmac } = WAAdv.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content as Buffer)
	// check HMAC matches
	const advSign = hmacSign(details, Buffer.from(advSecretKey, 'base64'))
	if(Buffer.compare(hmac, advSign) !== 0) {
		throw new Boom('Invalid account signature')
	}

	const account = WAAdv.ADVSignedDeviceIdentity.decode(details)
	const { accountSignature, accountSignatureKey, details: deviceDetails } = account
	// verify the device signature matches
	const accountMsg = Buffer.concat([ Buffer.from([6, 0]), deviceDetails, signedIdentityKey.public ])
	if(!Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
		throw new Boom('Failed to verify account signature')
	}

	// sign the details with our identity key
	const deviceMsg = Buffer.concat([ Buffer.from([6, 1]), deviceDetails, signedIdentityKey.public, accountSignatureKey ])
	account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg)

	const identity = createSignalIdentity(jid, accountSignatureKey)
	const accountEnc = encodeSignedDeviceIdentity(account, false)

	const deviceIdentity = WAAdv.ADVDeviceIdentity.decode(account.details)

	const reply: BinaryNode = {
		tag: 'iq',
		attrs: {
			to: S_WHATSAPP_NET,
			type: 'result',
			id: msgId,
		},
		content: [
			{
				tag: 'pair-device-sign',
				attrs: { },
				content: [
					{
						tag: 'device-identity',
						attrs: { 'key-index': deviceIdentity.keyIndex.toString() },
						content: accountEnc
					}
				]
			}
		]
	}

	const authUpdate: Partial<AuthenticationCreds> = {
		account,
		me: { id: jid, name: bizName },
		signalIdentities: [
			...(signalIdentities || []),
			identity
		],
		platform: platformNode?.attrs.name
	}

	return {
		creds: authUpdate,
		reply
	}
}

export const encodeSignedDeviceIdentity = (
	account: WAAdv.IADVSignedDeviceIdentity,
	includeSignatureKey: boolean
) => {
	account = { ...account }
	// set to null if we are not to include the signature key
	// or if we are including the signature key but it is empty
	if(!includeSignatureKey || !account.accountSignatureKey?.length) {
		account.accountSignatureKey = null
	}

	return WAAdv.ADVSignedDeviceIdentityHMAC
		.encode(account)
		.finish()
}
