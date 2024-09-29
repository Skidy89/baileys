import { AxiosRequestConfig } from 'axios'
import type { Logger } from 'pino'
import type { Readable } from 'stream'
import type { URL } from 'url'
import { WAE2E, WAProtocol, WAWeb } from '../../WAProto'
import { MEDIA_HKDF_KEY_MAPPING } from '../Defaults'
import { BinaryNode } from '../WABinary'
import type { GroupMetadata } from './GroupMetadata'
import { CacheStore } from './Socket'


export type WAMessage = WAWeb.IWebMessageInfo
export type WAMessageContent = WAE2E.IMessage
export type WAContactMessage = WAE2E.Message.IContactMessage
export type WAContactsArrayMessage = WAE2E.Message.IContactsArrayMessage
export type WAMessageKey = WAProtocol.IMessageKey
export type WATextMessage = WAE2E.Message.IExtendedTextMessage
export type WAContextInfo = WAE2E.IContextInfo
export type WALocationMessage = WAE2E.Message.ILocationMessage
export type WAGenericMediaMessage = WAE2E.Message.IVideoMessage | WAE2E.Message.IImageMessage | WAE2E.Message.IAudioMessage | WAE2E.Message.IDocumentMessage | WAE2E.Message.IStickerMessage
// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
export import WAMessageStubType = WAWeb.WebMessageInfo.StubType
// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
export import WAMessageStatus = WAWeb.WebMessageInfo.Status

export type WAMediaUpload = Buffer | { url: URL | string } | { stream: Readable }
/** Set of message types that are supported by the library */
export type MessageType = keyof WAE2E.Message

export type DownloadableMessage = { mediaKey?: Uint8Array | null, directPath?: string | null, url?: string | null }

export type MessageReceiptType = 'read' | 'read-self' | 'hist_sync' | 'peer_msg' | 'sender' | 'inactive' | 'played' | undefined

export type MediaConnInfo = {
    auth: string
    ttl: number
    hosts: { hostname: string, maxContentLengthBytes: number }[]
    fetchDate: Date
}

export interface WAUrlInfo {
    'canonical-url': string
    'matched-text': string
    title: string
    description?: string
    jpegThumbnail?: Buffer
    highQualityThumbnail?: WAE2E.Message.IImageMessage
    originalThumbnailUrl?: string
}

// types to generate WA messages
type Mentionable = {
    /** list of jids that are mentioned in the accompanying text */
    mentions?: string[]
}
type Contextable = {
    /** add contextInfo to the message */
    contextInfo?: WAE2E.IContextInfo
}
type ViewOnce = {
    viewOnce?: boolean
}
type Buttonable = {
    /** add buttons to the message  */
    buttons?: WAE2E.Message.ButtonsMessage.IButton[]
}
type Templatable = {
    /** add buttons to the message (conflicts with normal buttons)*/
    templateButtons?: WAE2E.IHydratedTemplateButton[]

    footer?: string
}
type Listable = {
    /** Sections of the List */
    sections?: WAE2E.Message.ListMessage.ISection[]

    /** Title of a List Message only */
    title?: string

    /** Text of the bnutton on the list (required) */
    buttonText?: string
}

type Editable = {
  edit?: WAMessageKey
}
type WithDimensions = {
    width?: number
    height?: number
}

export type PollMessageOptions = {
    name: string
    selectableCount?: number
    values: string[]
    /** 32 byte message secret to encrypt poll selections */
    messageSecret?: Uint8Array
    toAnnouncementGroup?: boolean
}

type SharePhoneNumber = {
    sharePhoneNumber: boolean
}

type RequestPhoneNumber = {
    requestPhoneNumber: boolean
}

export type MediaType = keyof typeof MEDIA_HKDF_KEY_MAPPING
export type AnyMediaMessageContent = (
    ({
        image: WAMediaUpload
        caption?: string
        jpegThumbnail?: string
    } & Mentionable & Contextable & Buttonable & Templatable & WithDimensions)
    | ({
        video: WAMediaUpload
        caption?: string
        gifPlayback?: boolean
        jpegThumbnail?: string
        /** if set to true, will send as a `video note` */
        ptv?: boolean
    } & Mentionable & Contextable & Buttonable & Templatable & WithDimensions)
    | {
        audio: WAMediaUpload
        /** if set to true, will send as a `voice note` */
        ptt?: boolean
        /** optionally tell the duration of the audio */
        seconds?: number
    }
    | ({
        sticker: WAMediaUpload
        isAnimated?: boolean
    } & WithDimensions) | ({
        document: WAMediaUpload
        mimetype: string
        fileName?: string
        caption?: string
    } & Contextable & Buttonable & Templatable))
    & { mimetype?: string } & Editable

export type ButtonReplyInfo = {
    displayText: string
    id: string
    index: number
}

export type GroupInviteInfo = {
    inviteCode: string
    inviteExpiration: number
    text: string
    jid: string
    subject: string
}

export type WASendableProduct = Omit<WAE2E.Message.ProductMessage.IProductSnapshot, 'productImage'> & {
    productImage: WAMediaUpload
}

export type AnyRegularMessageContent = (
    ({
	    text: string
        linkPreview?: WAUrlInfo | null
    }
    & Mentionable & Contextable & Editable)
    | AnyMediaMessageContent
    | ({
        poll: PollMessageOptions
    } & Mentionable & Contextable & Editable)
    | {
        contacts: {
            displayName?: string
            contacts: WAE2E.Message.IContactMessage[]
        }
    }
    | {
        location: WALocationMessage
    }
    | { react: WAE2E.Message.IReactionMessage }
    | {
        buttonReply: ButtonReplyInfo
        type: 'template' | 'plain'
    }
    | {
        groupInvite: GroupInviteInfo
    }
    | {
        listReply: Omit<WAE2E.Message.IListResponseMessage, 'contextInfo'>
    }
    | {
        pin: WAMessageKey
        type: WAWeb.PinInChat.Type
        /**
         * 24 hours, 7 days, 30 days
         */
        time?: 86400 | 604800 | 2592000
    }
    | {
        product: WASendableProduct
        businessOwnerJid?: string
        body?: string
        footer?: string
    } | SharePhoneNumber | RequestPhoneNumber
) & ViewOnce

export type AnyMessageContent = AnyRegularMessageContent | {
	forward: WAMessage
	force?: boolean
} | {
    /** Delete your message or anyone's message in a group (admin required) */
	delete: WAMessageKey
} | {
	disappearingMessagesInChat: boolean | number
}

export type GroupMetadataParticipants = Pick<GroupMetadata, 'participants'>

type MinimalRelayOptions = {
    /** override the message ID with a custom provided string */
    messageId?: string
    /** should we use group metadata cache, or fetch afresh from the server; default assumed to be "true" */
    useCachedGroupMetadata?: boolean
}

export type MessageRelayOptions = MinimalRelayOptions & {
    /** only send to a specific participant; used when a message decryption fails for a single user */
    participant?: { jid: string, count: number }
    /** additional attributes to add to the WA binary node */
    additionalAttributes?: { [_: string]: string }
    additionalNodes?: BinaryNode[]
    /** should we use the devices cache, or fetch afresh from the server; default assumed to be "true" */
    useUserDevicesCache?: boolean
    /** jid list of participants for status@broadcast */
    statusJidList?: string[]

}

export type MiscMessageGenerationOptions = MinimalRelayOptions & {
    /** optional, if you want to manually set the timestamp of the message */
	timestamp?: Date
    /** the message you want to quote */
	quoted?: WAMessage
    /** disappearing messages settings */
    ephemeralExpiration?: number | string
    /** timeout for media upload to WA server */
    mediaUploadTimeoutMs?: number
    /** jid list of participants for status@broadcast */
    statusJidList?: string[]
    /** backgroundcolor for status */
    backgroundColor?: string
    /** font type for status */
    font?: number
    /** if it is broadcast */
    broadcast?: boolean
}
export type MessageGenerationOptionsFromContent = MiscMessageGenerationOptions & {
	userJid: string
}

export type WAMediaUploadFunction = (readStream: Readable, opts: { fileEncSha256B64: string, mediaType: MediaType, timeoutMs?: number }) => Promise<{ mediaUrl: string, directPath: string }>

export type MediaGenerationOptions = {
	logger?: Logger
    mediaTypeOverride?: MediaType
    upload: WAMediaUploadFunction
    /** cache media so it does not have to be uploaded again */
    mediaCache?: CacheStore

    mediaUploadTimeoutMs?: number

    options?: AxiosRequestConfig

    backgroundColor?: string

    font?: number
}
export type MessageContentGenerationOptions = MediaGenerationOptions & {
	getUrlInfo?: (text: string) => Promise<WAUrlInfo | undefined>
    getProfilePicUrl?: (jid: string, type: 'image' | 'preview') => Promise<string | undefined>
}
export type MessageGenerationOptions = MessageContentGenerationOptions & MessageGenerationOptionsFromContent

/**
 * Type of message upsert
 * 1. notify => notify the user, this message was just received
 * 2. append => append the message to the chat history, no notification required
 */
export type MessageUpsertType = 'append' | 'notify'

export type MessageUserReceipt = WAWeb.IUserReceipt

export type WAMessageUpdate = { update: Partial<WAMessage>, key: WAProtocol.IMessageKey }

export type WAMessageCursor = { before: WAMessageKey | undefined } | { after: WAMessageKey | undefined }

export type MessageUserReceiptUpdate = { key: WAProtocol.IMessageKey, receipt: MessageUserReceipt }

export type MediaDecryptionKeyInfo = {
    iv: Buffer
    cipherKey: Buffer
    macKey?: Buffer
}

export type MinimalMessage = Pick<WAWeb.IWebMessageInfo, 'key' | 'messageTimestamp'>